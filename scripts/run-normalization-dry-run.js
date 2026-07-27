const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { auditRegistry } = require('./audit-pack-normalization');
const {
  readJson,
  validateContentIndex,
  writeJsonAtomic,
} = require('./lib/pack-content-index');
const { SCHEMA_VERSION: FINGERPRINT_SCHEMA_VERSION, stableStringify } = require('./lib/pack-content-fingerprint');
const { NORMALIZATION_SCHEMA_VERSION } = require('./lib/pack-normalizer');

const ROOT = path.join(__dirname, '..');
const MAX_REPO_SIZE = 5 * 1024 * 1024 * 1024;
const GITHUB_FILE_LIMIT = 100 * 1024 * 1024;
const DEFAULTS = {
  registryPath: path.join(ROOT, 'data', 'pack-registry.json'),
  siteIndexPath: path.join(ROOT, 'data', 'index.json'),
  listsPath: path.join(ROOT, 'l', 'lists.json'),
  extractedPath: path.join(ROOT, 'data', 'extracted.json'),
  contentIndexPath: path.join(ROOT, 'data', 'internal', 'pack-content-index.json'),
  manifestPath: path.join(ROOT, 'data', 'internal', 'pack-normalization-manifest.json'),
  auditPath: path.join(ROOT, 'data', 'internal', 'pack-normalization-audit.json'),
  summaryPath: path.join(ROOT, 'data', 'internal', 'PACK_NORMALIZATION_AUDIT.md'),
  reviewPath: path.join(ROOT, 'data', 'internal', 'pack-normalization-review.json'),
  repoStatePath: path.join(ROOT, 'data', 'internal', 'pack-repository-state.json'),
  workdir: path.join(os.tmpdir(), 'vale-pack-normalization-audit'),
  checkpointPath: path.join(os.tmpdir(), 'vale-pack-normalization-checkpoint.json'),
};

function digest(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function fileDigest(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function catalogSnapshot(options) {
  return Object.fromEntries([
    options.registryPath,
    options.siteIndexPath,
    options.listsPath,
    options.extractedPath,
    options.contentIndexPath,
  ].map(file => [path.resolve(file), fileDigest(file)]));
}

function assertSameSnapshot(before, after) {
  if (stableStringify(before) !== stableStringify(after)) {
    throw new Error('Read-only normalization audit changed protected catalog state');
  }
}

function defaultCheckAuth() {
  execFileSync('gh', ['api', 'user', '--jq', '.login'], {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true,
    timeout: 30000,
  });
  return true;
}

function defaultTrackedArchives() {
  const output = execFileSync('git', ['ls-files', '-z', '--', '*.zip', 'resourcepacks/**'], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  return output.split('\0').filter(Boolean);
}

function isSafeStaleAuditWorkspace(workdir) {
  const walk = (directory, depth) => {
    for (const name of fs.readdirSync(directory)) {
      const target = path.join(directory, name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) return false;
      if (stat.isDirectory()) {
        if ((depth === 0 && !/^entry-[A-Za-z0-9_-]+$/.test(name)) ||
            (depth > 0 && name !== 'normalized')) return false;
        if (!walk(target, depth + 1)) return false;
      } else if (depth === 1 ? name !== 'source.zip' : !name.toLowerCase().endsWith('.zip')) {
        return false;
      }
    }
    return true;
  };
  return walk(workdir, 0);
}

async function runPreflight(options, services) {
  const registry = readJson(options.registryPath, null);
  if (!registry || Array.isArray(registry)) throw new Error('Pack registry is missing or invalid');
  const contentIndex = validateContentIndex(
    readJson(options.contentIndexPath, null),
    registry,
    FINGERPRINT_SCHEMA_VERSION
  );
  if (fs.existsSync(options.workdir)) {
    const tempRoot = path.resolve(os.tmpdir()) + path.sep;
    const workspace = path.resolve(options.workdir);
    const stat = fs.lstatSync(options.workdir);
    const knownWorkspace = stat.isDirectory() && isSafeStaleAuditWorkspace(options.workdir);
    if (!knownWorkspace || !workspace.startsWith(tempRoot) || stat.isSymbolicLink()) {
      throw new Error(`Audit workspace already exists: ${options.workdir}`);
    }
    fs.rmSync(options.workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  const parent = path.dirname(path.resolve(options.workdir));
  if (!fs.existsSync(parent) || fs.lstatSync(parent).isSymbolicLink()) {
    throw new Error(`Audit workspace parent is unsafe: ${parent}`);
  }
  const authenticated = await (services.checkAuth || defaultCheckAuth)();
  if (!authenticated) throw new Error('GitHub authentication preflight failed');
  const trackedArchives = await (services.listTrackedArchives || defaultTrackedArchives)();
  if (!Array.isArray(trackedArchives)) throw new Error('Tracked archive preflight returned invalid data');
  if (trackedArchives.length) {
    throw new Error(`Main repository tracks archive content: ${trackedArchives.slice(0, 5).join(', ')}`);
  }
  return {
    registryCount: Object.keys(registry).length,
    contentIndexCount: Object.keys(contentIndex.packs || {}).length,
    registryDigest: contentIndex.registryDigest,
    authenticated: true,
    workspaceSafe: true,
    trackedArchiveCount: 0,
  };
}

function repositoryPlanner(registry, options) {
  const usage = {};
  for (const entry of Object.values(registry)) {
    const repoNum = Number(entry.repoNum);
    if (!Number.isInteger(repoNum)) continue;
    usage[repoNum] = (usage[repoNum] || 0) + Number(entry.size || 0);
  }
  const state = readJson(options.repoStatePath, { schemaVersion: 1, fullRepoNums: [] });
  if (!state || state.schemaVersion !== 1 || !Array.isArray(state.fullRepoNums)) {
    throw new Error('Pack repository state is invalid');
  }
  const full = new Set(state.fullRepoNums.map(Number).filter(Number.isInteger));
  const nums = Object.keys(usage).map(Number).filter(Number.isInteger);
  const highest = nums.length ? Math.max(...nums) : 0;
  for (let num = 1; num < highest; num++) full.add(num);
  for (const [num, bytes] of Object.entries(usage)) {
    if (bytes >= options.maxRepoSize) full.add(Number(num));
  }

  function allocate(size, oldRepoNum) {
    for (let repoNum = 1; repoNum < 10000; repoNum++) {
      if (full.has(repoNum) || repoNum === Number(oldRepoNum)) continue;
      const used = usage[repoNum] || 0;
      if (used + size > options.maxRepoSize) {
        full.add(repoNum);
        continue;
      }
      usage[repoNum] = used + size;
      return { targetRepo: `packs-${String(repoNum).padStart(3, '0')}`, targetRepoNum: repoNum, plannedBytes: size };
    }
    throw new Error('No capacity-eligible pack repository could be planned');
  }
  return { allocate, full, usage };
}

function actionFor(entry) {
  const classification = entry.normalization.classification;
  if (classification === 'blocked' || entry.blockers.length) return 'review_required';
  if (classification === 'normal') return 'unchanged';
  if (classification === 'illegal') return 'retire';
  if (entry.normalization.collection) return 'split';
  if (classification === 'repairable') return 'migrate';
  return 'review_required';
}

function reconcileCatalog(manifest, options) {
  const knownPackIds = new Set(manifest.entries.map(entry => entry.visibility.packId));
  const lists = readJson(options.listsPath, []);
  const duplicates = [];
  const dangling = [];
  for (const list of lists) {
    const counts = new Map();
    for (const packId of list.packs || []) {
      counts.set(packId, (counts.get(packId) || 0) + 1);
    }
    for (const [packId, count] of counts) {
      if (count > 1) duplicates.push({ list: list.name, packId, count, plannedAction: 'deduplicate' });
      if (!knownPackIds.has(packId)) dangling.push({ list: list.name, packId, decision: null });
    }
  }
  const compare = (a, b) => a.list.localeCompare(b.list) || a.packId.localeCompare(b.packId);
  duplicates.sort(compare);
  dangling.sort(compare);
  const normalPackConflicts = manifest.entries
    .filter(entry => entry.normalization.classification === 'normal' && entry.blockers.length)
    .map(entry => ({ file: entry.file, blockers: entry.blockers.map(row => row.code).sort() }))
    .sort((a, b) => a.file.localeCompare(b.file));
  return {
    reviewRequired: dangling.length > 0 || normalPackConflicts.length > 0,
    listReferences: { duplicates, dangling },
    normalPackConflicts,
  };
}

function buildReview(manifest, registry, preflight, options) {
  const planner = repositoryPlanner(registry, options);
  const entries = manifest.entries.map(entry => {
    const action = actionFor(entry);
    const products = entry.normalization.products.map(product => ({
      file: product.file,
      packId: product.packId,
      size: product.size,
      archiveSha256: product.archiveSha256,
      visualContentHash: product.visualContentHash,
    }));
    let storagePlan = null;
    if (action === 'migrate') storagePlan = planner.allocate(products[0].size, entry.source.repoNum);
    else if (action === 'split') {
      storagePlan = {
        products: products.map(product => ({ ...product, ...planner.allocate(product.size, entry.source.repoNum) })),
      };
    }
    return {
      file: entry.file,
      sourceArchiveSha256: entry.source.archiveSha256,
      sourceSize: entry.source.size,
      classification: entry.normalization.classification,
      causes: entry.normalization.causes,
      blockers: entry.blockers,
      action,
      products,
      storagePlan,
      visibility: entry.visibility,
      listEffects: entry.effects,
      decision: null,
    };
  });
  const base = {
    schemaVersion: 1,
    normalizationSchemaVersion: NORMALIZATION_SCHEMA_VERSION,
    registryDigest: manifest.registryDigest,
    manifestEvidenceDigest: manifest.evidenceDigest,
    reviewed: false,
    preflight,
    catalogReconciliation: reconcileCatalog(manifest, options),
    entries,
  };
  return { ...base, reviewDigest: digest(base) };
}

function renderReviewSummary(review, manifest) {
  const deferred = review.entries.filter(entry => entry.decision && entry.decision.action === 'defer').length;
  const lines = [
    '# Pack normalization dry-run',
    '',
    `Registry digest: \`${review.registryDigest}\``,
    `Evidence digest: \`${review.manifestEvidenceDigest}\``,
    `Review digest: \`${review.reviewDigest}\``,
    '',
    review.reviewed
      ? `Execution is approved as artifact \`${review.approvalDigest}\`.`
      : 'Execution is blocked until this exact artifact and its proposed decisions are explicitly approved.',
    `Proposed deferred entries: ${deferred}`,
    '',
    '| File | Classification | Action | Decision | Blockers | Target |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const entry of review.entries) {
    const decision = entry.decision ? entry.decision.action : '-';
    const blockers = entry.blockers.map(row => row.code).join(', ') || '-';
    const target = entry.storagePlan && entry.storagePlan.targetRepo
      ? entry.storagePlan.targetRepo
      : entry.storagePlan && entry.storagePlan.products
        ? entry.storagePlan.products.map(row => row.targetRepo).join(', ')
        : '-';
    lines.push(`| \`${entry.file}\` | ${entry.classification} | ${entry.action} | ${decision} | ${blockers} | ${target} |`);
  }
  const reconciliation = review.catalogReconciliation;
  lines.push('', `## Normal-pack conflicts (${reconciliation.normalPackConflicts.length})`, '');
  if (!reconciliation.normalPackConflicts.length) lines.push('- None');
  else for (const entry of reconciliation.normalPackConflicts) {
    lines.push(`- \`${entry.file}\`: ${entry.blockers.join(', ')}`);
  }
  lines.push('', `## Dangling List references (${reconciliation.listReferences.dangling.length})`, '');
  if (!reconciliation.listReferences.dangling.length) lines.push('- None');
  else for (const entry of reconciliation.listReferences.dangling) {
    const decision = entry.decision && entry.decision.action === 'replace'
      ? `replace with \`${entry.decision.targetPackId}\` (${entry.decision.reason})`
      : entry.decision && entry.decision.action === 'remove'
        ? `remove (${entry.decision.reason})`
        : 'decision required';
    lines.push(`- \`${entry.list}\` / \`${entry.packId}\`: ${decision}`);
  }
  lines.push('', `## Duplicate List references (${reconciliation.listReferences.duplicates.length})`, '');
  if (!reconciliation.listReferences.duplicates.length) lines.push('- None');
  else for (const entry of reconciliation.listReferences.duplicates) {
    lines.push(`- \`${entry.list}\` / \`${entry.packId}\`: ${entry.plannedAction} (${entry.count} copies)`);
  }
  lines.push('', `Entries: ${manifest.entries.length}`, '');
  return lines.join('\n');
}

async function runNormalizationDryRun(options = {}, services = {}) {
  const resolved = {
    ...DEFAULTS,
    maxRepoSize: MAX_REPO_SIZE,
    githubFileLimit: GITHUB_FILE_LIMIT,
    ...options,
  };
  const preflight = await runPreflight(resolved, services);
  const before = catalogSnapshot(resolved);
  resolved.catalogDigest = digest(before);
  const result = await auditRegistry(resolved, {
    remote: services.remote,
    onProgress: services.onProgress,
  });
  assertSameSnapshot(before, catalogSnapshot(resolved));
  if (fs.existsSync(resolved.workdir)) throw new Error(`Audit workspace was not cleaned: ${resolved.workdir}`);
  const registry = readJson(resolved.registryPath, {});
  if (result.manifest.entries.length !== Object.keys(registry).length) {
    throw new Error('Normalization dry-run omitted registry entries');
  }
  const review = buildReview(result.manifest, registry, preflight, resolved);
  writeJsonAtomic(resolved.reviewPath, review);
  fs.mkdirSync(path.dirname(resolved.summaryPath), { recursive: true });
  fs.writeFileSync(resolved.summaryPath, renderReviewSummary(review, result.manifest));
  if (resolved.checkpointPath) fs.rmSync(resolved.checkpointPath, { force: true });
  return { manifest: result.manifest, review, executionEligible: false };
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {};
  const paths = {
    '--registry': 'registryPath', '--site-index': 'siteIndexPath', '--lists': 'listsPath',
    '--extracted': 'extractedPath', '--content-index': 'contentIndexPath', '--manifest': 'manifestPath',
    '--audit': 'auditPath', '--summary': 'summaryPath', '--review': 'reviewPath',
    '--repo-state': 'repoStatePath', '--workdir': 'workdir',
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (paths[arg]) options[paths[arg]] = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const result = await runNormalizationDryRun(parseArgs(argv), {
    onProgress({ completed, total, file }) {
      console.log(`Audited ${completed}/${total}: ${file}`);
    },
  });
  console.log(JSON.stringify({ entries: result.review.entries.length, reviewDigest: result.review.reviewDigest }, null, 2));
  console.log('Dry-run complete. No migration is authorized until the review artifact is approved.');
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  buildReview,
  reconcileCatalog,
  parseArgs,
  renderReviewSummary,
  runNormalizationDryRun,
  runPreflight,
};
