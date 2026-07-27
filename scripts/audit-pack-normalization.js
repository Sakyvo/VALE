const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const {
  computeRegistryDigest,
  readJson,
  sourceKey,
  writeJsonAtomic,
} = require('./lib/pack-content-index');
const { fingerprintPack } = require('./lib/pack-content-fingerprint');
const {
  NORMALIZATION_SCHEMA_VERSION,
  normalizePack,
  sha256File,
} = require('./lib/pack-normalizer');
const { getPackIdFromZipName } = require('./pack-utils');

const ROOT = path.join(__dirname, '..');
const DEFAULTS = {
  registryPath: path.join(ROOT, 'data', 'pack-registry.json'),
  siteIndexPath: path.join(ROOT, 'data', 'index.json'),
  listsPath: path.join(ROOT, 'l', 'lists.json'),
  extractedPath: path.join(ROOT, 'data', 'extracted.json'),
  contentIndexPath: path.join(ROOT, 'data', 'internal', 'pack-content-index.json'),
  manifestPath: path.join(ROOT, 'data', 'internal', 'pack-normalization-manifest.json'),
  auditPath: path.join(ROOT, 'data', 'internal', 'pack-normalization-audit.json'),
  summaryPath: path.join(ROOT, 'data', 'internal', 'PACK_NORMALIZATION_AUDIT.md'),
  workdir: path.join(os.tmpdir(), 'vale-pack-normalization-audit'),
};
const GITHUB_FILE_LIMIT = 100 * 1024 * 1024;
const execFileAsync = promisify(execFile);
let githubTokenPromise;

async function downloadWithGhApi(endpoint, destination) {
  githubTokenPromise ||= execFileAsync('gh', ['auth', 'token'], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 30000,
  }).then(result => result.stdout.trim());
  const token = await githubTokenPromise;
  const output = destination.replaceAll('\\', '/').replaceAll('"', '\\"');
  const config = [
    'fail', 'location', 'silent', 'show-error', 'http1.1',
    'retry = 4', 'retry-all-errors', 'retry-delay = 2',
    'connect-timeout = 30', 'max-time = 900',
    'header = "Accept: application/vnd.github.raw+json"',
    `header = "Authorization: Bearer ${token}"`,
    `output = "${output}"`,
    `url = "https://api.github.com/${endpoint}"`,
  ].join('\n');
  await new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl', ['--config', '-'], {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `GitHub API curl exited with code ${code}`));
    });
    child.stdin.end(config);
  });
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function digest(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function resolveOptions(options = {}) {
  return { ...DEFAULTS, ...options };
}

function rawUrl(file, registryEntry) {
  return `https://raw.githubusercontent.com/Sakyvo/${encodeURIComponent(registryEntry.repo)}/main/resourcepacks/${encodeURIComponent(file)}`;
}

async function downloadArchive({ file, registryEntry, destination }) {
  const url = rawUrl(file, registryEntry);
  const endpoint = `repos/Sakyvo/${encodeURIComponent(registryEntry.repo)}/contents/resourcepacks/${encodeURIComponent(file)}`;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    fs.rmSync(destination, { force: true });
    try {
      await execFileAsync(process.platform === 'win32' ? 'curl.exe' : 'curl', [
        '--fail', '--location', '--silent', '--show-error', '--http1.1',
        '--retry', '1', '--retry-all-errors', '--retry-delay', '2',
        '--connect-timeout', '15', '--max-time', '180',
        '--output', destination,
        url,
      ], { windowsHide: true, timeout: 4 * 60 * 1000 });
      return;
    } catch (error) {
      lastError = error;
    }
    fs.rmSync(destination, { force: true });
    try {
      await downloadWithGhApi(endpoint, destination);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 5000 * (attempt + 1)));
    }
  }
  fs.rmSync(destination, { force: true });
  throw new Error(
    `Remote download failed for ${registryEntry.repo}/${file}: ${lastError.stderr || lastError.message}`,
    { cause: lastError }
  );
}

function visibilityFor(file, siteIndex, lists, extracted) {
  const packId = getPackIdFromZipName(file);
  const publicItem = (siteIndex.items || []).find(item => item.name === packId) || null;
  const listNames = lists
    .filter(list => (list.packs || []).includes(packId))
    .map(list => list.name)
    .sort((a, b) => a.localeCompare(b));
  const extractedRecord = extracted.find(row =>
    row.packId === packId || `${row.originalName}.zip` === file
  ) || null;
  const isPublic = Boolean(publicItem);
  return {
    packId,
    public: isPublic,
    lists: listNames,
    extracted: Boolean(extractedRecord),
    registryOnly: !isPublic && !listNames.length && !extractedRecord,
  };
}

function effectsFor(classification, productCount, visibility) {
  if (classification === 'normal') {
    return { catalog: 'unchanged', registry: 'unchanged', remote: 'unchanged', visibility: 'preserve' };
  }
  if (classification === 'repairable' && productCount === 1) {
    return {
      catalog: visibility.public ? 'rebuild_preserving_identity' : 'preserve_non_public',
      registry: 'switch_after_staged_verification',
      remote: 'stage_same_filename_then_delete_old',
      visibility: 'preserve',
    };
  }
  if (classification === 'repairable' && productCount > 1) {
    return {
      catalog: 'retire_parent_and_publish_products',
      registry: 'replace_parent_with_products',
      remote: 'stage_products_then_delete_parent',
      visibility: 'inherit',
    };
  }
  if (classification === 'illegal') {
    return {
      catalog: 'retire_before_remote_cleanup',
      registry: 'remove_after_site_preparation',
      remote: 'delete_after_deployment_verification',
      visibility: 'retire',
    };
  }
  return { catalog: 'defer', registry: 'unchanged', remote: 'unchanged', visibility: 'preserve' };
}

function indexedSourceFingerprint(context, file, source) {
  const current = context.contentIndex && context.contentIndex.packs && context.contentIndex.packs[file];
  if (!current || current.sourceKey !== source.sourceKey ||
      current.archiveSha256 !== source.archiveSha256 ||
      Number(current.size) !== Number(source.size) || !current.visualContentHash) {
    return null;
  }
  return current;
}

async function auditEntry(file, registryEntry, context, cachedEntry = null) {
  const entryWorkdir = fs.mkdtempSync(path.join(context.workdir, 'entry-'));
  const sourcePath = path.join(entryWorkdir, 'source.zip');
  try {
    await context.download({
      file,
      repo: registryEntry.repo,
      repoNum: Number(registryEntry.repoNum),
      registryEntry,
      destination: sourcePath,
    });
    const actualSize = fs.statSync(sourcePath).size;
    const archiveSha256 = await sha256File(sourcePath);
    const source = {
      file,
      repo: registryEntry.repo,
      repoNum: Number(registryEntry.repoNum),
      size: actualSize,
      registrySize: Number(registryEntry.size),
      archiveSha256,
      sourceKey: sourceKey(file, registryEntry),
    };
    const blockers = [];
    if (actualSize !== Number(registryEntry.size)) {
      blockers.push({ code: 'remote_size_changed', expected: Number(registryEntry.size), actual: actualSize });
    }
    if (registryEntry.archiveSha256 && registryEntry.archiveSha256 !== archiveSha256) {
      blockers.push({ code: 'remote_hash_changed', expected: registryEntry.archiveSha256, actual: archiveSha256 });
    }

    if (cachedEntry && cachedEntry.source &&
        cachedEntry.source.sourceKey === source.sourceKey &&
        cachedEntry.source.archiveSha256 === source.archiveSha256 &&
        cachedEntry.normalization &&
        cachedEntry.normalization.schemaVersion === NORMALIZATION_SCHEMA_VERSION) {
      return {
        ...cachedEntry,
        source: { ...cachedEntry.source, size: actualSize, archiveSha256 },
        lifecycle: { status: 'planned' },
      };
    }

    const normalized = await normalizePack(sourcePath, {
      outputDir: path.join(entryWorkdir, 'normalized'),
      limits: context.normalizationLimits,
    });
    const indexedSource = indexedSourceFingerprint(context, file, source);
    const products = [];
    for (const product of normalized.products) {
      const useIndexed = normalized.classification === 'normal' && normalized.products.length === 1 && indexedSource;
      const fingerprint = useIndexed ? indexedSource : await fingerprintPack(product.path);
      const size = fs.statSync(product.path).size;
      const productFile = normalized.products.length === 1 ? file : path.basename(product.path);
      products.push({
        file: productFile,
        normalizedFile: path.basename(product.path),
        packId: getPackIdFromZipName(productFile),
        size,
        archiveSha256: fingerprint.archiveSha256,
        visualContentHash: fingerprint.visualContentHash,
        visualEntryCount: fingerprint.visualEntryCount,
        fingerprintSource: useIndexed ? 'content_index' : 'computed',
        classification: product.classification,
        oversize: size > context.githubFileLimit,
      });
    }
    if (normalized.classification === 'blocked') {
      blockers.push({ code: 'blocked_archive_limits', cause: normalized.causes[0] });
    }
    if (products.some(product => product.oversize)) {
      blockers.push({ code: 'blocked_oversize' });
    }
    if (normalized.classification === 'repairable' && products.length === 1) {
      try {
        const sourceFingerprint = indexedSource || await fingerprintPack(sourcePath, { normalizationSource: true });
        if (sourceFingerprint.visualContentHash !== products[0].visualContentHash) {
          blockers.push({ code: 'blocked_normalization_content_change' });
        }
      } catch (error) {
        blockers.push({ code: 'blocked_source_fingerprint', cause: error.code || error.message });
      }
    }
    if (context.contentIndex && context.contentIndex.packs) {
      for (const product of products) {
        const current = context.contentIndex.packs[product.file];
        if (current && current.visualContentHash && current.visualContentHash !== product.visualContentHash) {
          blockers.push({ code: 'normalization_content_change', file: product.file });
        }
        const duplicateMatches = Object.entries(context.contentIndex.packs)
          .filter(([existingFile, existing]) => existingFile !== product.file &&
            existing && existing.visualContentHash === product.visualContentHash)
          .map(([existingFile, existing]) => ({ file: existingFile, packId: existing.packId }));
        if (duplicateMatches.length) {
          blockers.push({ code: 'content_duplicate_conflict', productFile: product.file, matches: duplicateMatches });
        }
      }
    }

    const visibility = visibilityFor(file, context.siteIndex, context.lists, context.extracted);
    return {
      file,
      source,
      visibility,
      normalization: {
        schemaVersion: normalized.schemaVersion,
        classification: normalized.classification,
        collection: products.length > 1,
        causes: normalized.causes,
        products,
      },
      effects: effectsFor(normalized.classification, products.length, visibility),
      blockers,
      reviewRequired: normalized.classification === 'illegal' ||
        normalized.classification === 'blocked' || blockers.length > 0,
      decision: null,
      lifecycle: { status: 'planned' },
    };
  } finally {
    fs.rmSync(entryWorkdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function categoryOf(entry) {
  if (entry.decision && entry.decision.action === 'defer') return 'deferred';
  if (entry.blockers.some(blocker => blocker.code === 'blocked_archive_limits')) return 'safety-blocked';
  if (entry.blockers.some(blocker => blocker.code === 'blocked_oversize')) return 'oversize';
  if (entry.blockers.some(blocker => /conflict|duplicate/.test(blocker.code))) return 'conflict';
  if (entry.normalization.classification === 'illegal') return 'illegal';
  if (entry.normalization.collection) return 'collection';
  return entry.normalization.classification;
}

function summarize(entries) {
  const counts = {
    normal: 0,
    repairable: 0,
    collection: 0,
    illegal: 0,
    oversize: 0,
    'safety-blocked': 0,
    conflict: 0,
    deferred: 0,
  };
  for (const entry of entries) counts[categoryOf(entry)] += 1;
  return counts;
}

function renderSummary(manifest) {
  const labels = [
    ['normal', 'Normal'],
    ['repairable', 'Repairable'],
    ['collection', 'Collection'],
    ['illegal', 'Illegal material'],
    ['oversize', 'Oversize'],
    ['safety-blocked', 'Safety blocked'],
    ['conflict', 'Conflict'],
    ['deferred', 'Deferred'],
  ];
  const lines = [
    '# Pack Normalization Audit',
    '',
    `Registry digest: \`${manifest.registryDigest}\``,
    `Normalization schema: \`${manifest.normalizationSchemaVersion}\``,
    `Entries: ${manifest.entries.length}`,
  ];
  for (const [key, title] of labels) {
    lines.push('', `## ${title} (${manifest.summary[key]})`, '');
    const rows = manifest.entries.filter(entry => categoryOf(entry) === key);
    if (!rows.length) lines.push('- None');
    else for (const entry of rows) lines.push(`- \`${entry.file}\`: ${entry.normalization.causes.join(', ') || key}`);
  }
  return `${lines.join('\n')}\n`;
}

function writeAuditLedger(filePath, manifest) {
  const existing = readJson(filePath, { schemaVersion: 1, entries: [] });
  if (existing.schemaVersion !== 1 || !Array.isArray(existing.entries)) {
    throw new Error('Normalization audit must have schemaVersion=1 and an entries array');
  }
  const now = new Date().toISOString();
  const entries = existing.entries.filter(entry => !entry.remoteIdentity);
  for (const entry of manifest.entries) {
    const key = `remote:${entry.file}:${entry.source.archiveSha256}`;
    const prior = existing.entries.find(row => row.key === key);
    entries.push({
      key,
      remoteIdentity: entry.source,
      visibility: entry.visibility,
      classification: entry.normalization.classification,
      causes: entry.normalization.causes,
      products: entry.normalization.products,
      blockers: entry.blockers,
      lifecycle: entry.lifecycle,
      firstSeenAt: prior ? prior.firstSeenAt : now,
      updatedAt: now,
    });
  }
  entries.sort((a, b) => a.key.localeCompare(b.key));
  writeJsonAtomic(filePath, {
    schemaVersion: 1,
    normalizationSchemaVersion: NORMALIZATION_SCHEMA_VERSION,
    registryDigest: manifest.registryDigest,
    entries,
  });
}

async function auditRegistry(options = {}, services = {}) {
  const resolved = resolveOptions(options);
  const registry = readJson(resolved.registryPath, {});
  const siteIndex = readJson(resolved.siteIndexPath, { items: [] });
  const lists = readJson(resolved.listsPath, []);
  const extracted = readJson(resolved.extractedPath, []);
  const download = services.remote && services.remote.downloadArchive
    ? request => services.remote.downloadArchive(request)
    : downloadArchive;
  if (fs.existsSync(resolved.workdir)) {
    throw new Error(`Audit workspace already exists: ${resolved.workdir}`);
  }
  fs.mkdirSync(resolved.workdir, { recursive: true });
  try {
    const context = {
      workdir: resolved.workdir,
      siteIndex,
      lists,
      extracted,
      contentIndex: readJson(resolved.contentIndexPath, null),
      download,
      normalizationLimits: resolved.normalizationLimits,
      githubFileLimit: Number.isFinite(resolved.githubFileLimit) ? resolved.githubFileLimit : GITHUB_FILE_LIMIT,
    };
    const entries = [];
    const files = Object.keys(registry).sort((a, b) => a.localeCompare(b));
    const registryDigest = computeRegistryDigest(registry);
    const checkpoint = resolved.checkpointPath ? readJson(resolved.checkpointPath, null) : null;
    const checkpointEntries = checkpoint && checkpoint.schemaVersion === 1 &&
      checkpoint.normalizationSchemaVersion === NORMALIZATION_SCHEMA_VERSION &&
      checkpoint.registryDigest === registryDigest &&
      checkpoint.catalogDigest === resolved.catalogDigest &&
      checkpoint.entries && typeof checkpoint.entries === 'object'
      ? checkpoint.entries
      : {};
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      entries.push(await auditEntry(file, registry[file], context, checkpointEntries[file] || null));
      if (resolved.checkpointPath) {
        writeJsonAtomic(resolved.checkpointPath, {
          schemaVersion: 1,
          normalizationSchemaVersion: NORMALIZATION_SCHEMA_VERSION,
          registryDigest,
          catalogDigest: resolved.catalogDigest || null,
          entries: Object.fromEntries(entries.map(row => [row.file, row])),
        });
      }
      if (typeof services.onProgress === 'function') {
        await services.onProgress({ completed: index + 1, total: files.length, file, resumed: Boolean(checkpointEntries[file]) });
      }
    }
    const manifest = {
      schemaVersion: 1,
      normalizationSchemaVersion: NORMALIZATION_SCHEMA_VERSION,
      registryDigest,
      generatedAt: new Date().toISOString(),
      selectedCount: entries.length,
      evidenceDigest: digest(entries.map(entry => ({ file: entry.file, source: entry.source, normalization: entry.normalization }))),
      executable: entries.every(entry => !entry.reviewRequired && entry.blockers.length === 0),
      summary: summarize(entries),
      entries,
    };
    writeJsonAtomic(resolved.manifestPath, manifest);
    writeAuditLedger(resolved.auditPath, manifest);
    const summaryMarkdown = renderSummary(manifest);
    fs.mkdirSync(path.dirname(resolved.summaryPath), { recursive: true });
    fs.writeFileSync(resolved.summaryPath, summaryMarkdown);
    return { manifest, summaryMarkdown };
  } finally {
    fs.rmSync(resolved.workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function validateAuditManifest(manifest, options = {}) {
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries)) {
    throw new Error('Invalid normalization audit manifest');
  }
  const registry = readJson(options.registryPath, {});
  const currentDigest = computeRegistryDigest(registry);
  if (currentDigest !== manifest.registryDigest) {
    throw new Error(`Stale normalization manifest registry digest: expected=${manifest.registryDigest} actual=${currentDigest}`);
  }
  let decisions = [];
  if (options.decisionsPath) {
    const decisionFile = readJson(options.decisionsPath, null);
    if (!decisionFile || decisionFile.schemaVersion !== 1 || !Array.isArray(decisionFile.decisions) ||
        decisionFile.registryDigest !== manifest.registryDigest) {
      throw new Error('Normalization decisions are stale or invalid for this registry manifest');
    }
    decisions = decisionFile.decisions;
  }
  const decisionByFile = new Map(decisions.map(decision => [decision.file, decision]));
  const entries = [];
  const unresolvedBlockers = [];
  for (const original of manifest.entries) {
    const current = registry[original.file];
    if (!current || current.repo !== original.source.repo ||
        Number(current.repoNum) !== Number(original.source.repoNum) ||
        Number(current.size) !== Number(original.source.registrySize)) {
      throw new Error(`Stale normalization manifest registry source changed: ${original.file}`);
    }
    if (options.remote && options.remote.getArchiveIdentity) {
      const identity = await options.remote.getArchiveIdentity({ file: original.file, registryEntry: current });
      if (!identity || Number(identity.size) !== Number(original.source.size) ||
          identity.archiveSha256 !== original.source.archiveSha256) {
        throw new Error(`Remote archive changed after audit: ${original.file}`);
      }
    }
    const decision = decisionByFile.get(original.file) || null;
    if (decision && !['defer', 'name_override', 'keep_existing', 'keep_incoming'].includes(decision.action)) {
      throw new Error(`Unknown normalization decision action for ${original.file}`);
    }
    const entry = { ...original, decision };
    if (entry.reviewRequired && !decision) unresolvedBlockers.push({ file: entry.file, blockers: entry.blockers });
    entries.push(entry);
  }
  return {
    ...manifest,
    entries,
    executable: unresolvedBlockers.length === 0,
    unresolvedBlockers,
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {};
  const paths = {
    '--registry': 'registryPath',
    '--site-index': 'siteIndexPath',
    '--lists': 'listsPath',
    '--extracted': 'extractedPath',
    '--content-index': 'contentIndexPath',
    '--manifest': 'manifestPath',
    '--audit': 'auditPath',
    '--summary': 'summaryPath',
    '--workdir': 'workdir',
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (paths[arg]) options[paths[arg]] = path.resolve(argv[++index]);
    else if (arg === '--github-file-limit') options.githubFileLimit = Number(argv[++index]);
    else if (arg === '--max-entries') options.normalizationLimits = { ...(options.normalizationLimits || {}), maxEntries: Number(argv[++index]) };
    else if (arg === '--max-entry-bytes') options.normalizationLimits = { ...(options.normalizationLimits || {}), maxEntryBytes: Number(argv[++index]) };
    else if (arg === '--max-total-bytes') options.normalizationLimits = { ...(options.normalizationLimits || {}), maxTotalBytes: Number(argv[++index]) };
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const result = await auditRegistry(parseArgs(argv));
  console.log(JSON.stringify(result.manifest.summary, null, 2));
  console.log('Read-only audit complete. Review the manifest and Markdown summary before execution.');
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  auditRegistry,
  categoryOf,
  parseArgs,
  renderSummary,
  validateAuditManifest,
  visibilityFor,
};
