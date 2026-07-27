const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getPackIdFromZipName } = require('./pack-utils');
const { SCHEMA_VERSION: FINGERPRINT_SCHEMA_VERSION, fingerprintPack } = require('./lib/pack-content-fingerprint');
const { NORMALIZATION_SCHEMA_VERSION, normalizePack } = require('./lib/pack-normalizer');
const { isJunkName } = require('./lib/pack-normalizer');
const {
  buildVisualHashLookup,
  refreshContentIndexMetadata,
  sourceKey,
  validateContentIndex,
  writeJsonAtomic,
} = require('./lib/pack-content-index');

const REPO_OWNER = 'Sakyvo';
const REPO_PREFIX = 'packs-';
const MAX_REPO_SIZE = 5 * 1024 * 1024 * 1024;
const GITHUB_FILE_LIMIT = 100 * 1024 * 1024;
const BATCH_SIZE = 500 * 1024 * 1024;
const FULL_MARKER = '!  FULL  !';

const ROOT = path.join(__dirname, '..');
const REGISTRY_PATH = path.join(ROOT, 'data', 'pack-registry.json');
const INDEX_PATH = path.join(ROOT, 'data', 'index.json');
const LISTS_PATH = path.join(ROOT, 'l', 'lists.json');
const LIST_PAGE_TEMPLATE = path.join(ROOT, 'l', 'test', 'index.html');
const CONTENT_INDEX_PATH = path.join(ROOT, 'data', 'internal', 'pack-content-index.json');
const CONTENT_ALIASES_PATH = path.join(ROOT, 'data', 'internal', 'pack-content-aliases.json');
const PENDING_REPLACEMENTS_PATH = path.join(ROOT, 'data', 'internal', 'pending-pack-replacements.json');
const NORMALIZATION_AUDIT_PATH = path.join(ROOT, 'data', 'internal', 'pack-normalization-audit.json');
const REPO_STATE_PATH = path.join(ROOT, 'data', 'internal', 'pack-repository-state.json');

function parseArgs(argv) {
  const out = {
    source: null,
    list: 'Sakyvo',
    workdir: path.join(ROOT, '..', '.vale-pack-upload'),
    manifest: null,
    registryPath: REGISTRY_PATH,
    siteIndexPath: INDEX_PATH,
    listsPath: LISTS_PATH,
    contentIndex: CONTENT_INDEX_PATH,
    contentAliases: CONTENT_ALIASES_PATH,
    duplicateResolutions: null,
    pendingReplacements: PENDING_REPLACEMENTS_PATH,
    normalizationAudit: NORMALIZATION_AUDIT_PATH,
    repoState: REPO_STATE_PATH,
    execute: false,
    skipBlockers: false,
    onlyRepoNum: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--source') out.source = argv[++i];
    else if (arg === '--list') out.list = argv[++i];
    else if (arg === '--workdir') out.workdir = argv[++i];
    else if (arg === '--manifest') out.manifest = argv[++i];
    else if (arg === '--registry') out.registryPath = path.resolve(argv[++i]);
    else if (arg === '--site-index') out.siteIndexPath = path.resolve(argv[++i]);
    else if (arg === '--lists') out.listsPath = path.resolve(argv[++i]);
    else if (arg === '--content-index') out.contentIndex = path.resolve(argv[++i]);
    else if (arg === '--content-aliases') out.contentAliases = path.resolve(argv[++i]);
    else if (arg === '--duplicate-resolutions') out.duplicateResolutions = path.resolve(argv[++i]);
    else if (arg === '--pending-replacements') out.pendingReplacements = path.resolve(argv[++i]);
    else if (arg === '--normalization-audit') out.normalizationAudit = path.resolve(argv[++i]);
    else if (arg === '--repo-state') out.repoState = path.resolve(argv[++i]);
    else if (arg === '--execute') out.execute = true;
    else if (arg === '--dry-run') out.execute = false;
    else if (arg === '--skip-blockers') out.skipBlockers = true;
    else if (arg === '--only-repo') {
      const raw = argv[++i];
      out.onlyRepoNum = Number(String(raw).replace(/^packs-/, ''));
    }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!out.source) throw new Error('Usage: node scripts/upload-folder.js --source <folder> [--list Sakyvo] [--execute]');
  return out;
}

function repoName(n) {
  return `${REPO_PREFIX}${String(n).padStart(3, '0')}`;
}

function run(cmd, args, opts = {}) {
  const output = execFileSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    encoding: 'utf-8',
    stdio: opts.stdio || 'pipe',
    timeout: opts.timeout || 600000,
  });
  return typeof output === 'string' ? output.trim() : '';
}

function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : fallback;
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getSourceFiles(source) {
  return fs.readdirSync(source, { withFileTypes: true })
    .filter(entry => !isJunkName(entry.name))
    .map(entry => {
      const file = entry.name;
      const fullPath = path.join(source, file);
      const stat = fs.lstatSync(fullPath);
      return {
        file,
        path: fullPath,
        size: stat.size,
        mtime: stat.mtimeMs,
        packId: getPackIdFromZipName(file),
      };
    })
    .sort((a, b) => a.mtime - b.mtime || a.file.localeCompare(b.file));
}

async function normalizeSourceFiles(sourceFiles, opts, services = {}) {
  const root = opts.normalizationWorkdir || path.join(opts.workdir, '.normalized');
  const normalize = services.normalizePack || normalizePack;
  const fingerprintFn = services.fingerprintPack || fingerprintPack;
  const products = [];
  const outcomes = [];
  for (let index = 0; index < sourceFiles.length; index++) {
    const source = sourceFiles[index];
    const result = await normalize(source.path, {
      outputDir: path.join(root, String(index)),
      limits: opts.normalizationLimits,
    });
    const outcome = {
      sourceFile: source.file,
      sourceType: result.sourceType,
      sourceArchiveSha256: result.sourceArchiveSha256,
      classification: result.classification,
      collection: Boolean(result.collection),
      causes: result.causes,
      products: result.products.map(product => ({
        file: path.basename(product.path),
        archiveSha256: product.archiveSha256,
      })),
    };
    outcomes.push(outcome);
    if (result.classification !== 'repairable' && result.classification !== 'normal') continue;
    const sourceFingerprint = result.classification === 'normal' || result.products.length !== 1 || !fs.lstatSync(source.path).isFile()
      ? null
      : compactFingerprint(await fingerprintFn(source.path, { normalizationSource: true }));
    for (const product of result.products) {
      const stat = fs.statSync(product.path);
      products.push({
        ...source,
        file: path.basename(product.path),
        path: product.path,
        size: stat.size,
        packId: getPackIdFromZipName(path.basename(product.path)),
        sourceFile: source.file,
        sourcePath: source.path,
        normalization: {
          schemaVersion: result.schemaVersion,
          classification: result.classification,
          collection: Boolean(result.collection),
          productClassification: product.classification,
          productArchiveSha256: product.archiveSha256,
          causes: result.causes,
          sourceArchiveSha256: result.sourceArchiveSha256,
          sourceVisualContentHash: sourceFingerprint && sourceFingerprint.visualContentHash,
        },
      });
    }
  }
  return { products, outcomes };
}

function getNormalizationAuditPath(opts) {
  if (opts.normalizationAudit === false) return null;
  if (opts.normalizationAudit) return opts.normalizationAudit;
  if (opts.registryPath && path.resolve(opts.registryPath) !== path.resolve(REGISTRY_PATH)) {
    return path.join(path.dirname(opts.registryPath), 'pack-normalization-audit.json');
  }
  return NORMALIZATION_AUDIT_PATH;
}

function getRepoStatePath(opts) {
  if (opts.repoState === false) return null;
  if (opts.repoState) return opts.repoState;
  if (opts.registryPath && path.resolve(opts.registryPath) !== path.resolve(REGISTRY_PATH)) {
    return path.join(path.dirname(opts.registryPath), 'pack-repository-state.json');
  }
  return REPO_STATE_PATH;
}

function loadRepoState(filePath) {
  const state = filePath ? readJson(filePath, { schemaVersion: 1, fullRepoNums: [] }) : { schemaVersion: 1, fullRepoNums: [] };
  if (state.schemaVersion !== 1 || !Array.isArray(state.fullRepoNums)) {
    throw new Error('Pack repository state must have schemaVersion=1 and a fullRepoNums array');
  }
  return {
    schemaVersion: 1,
    fullRepoNums: [...new Set(state.fullRepoNums.map(Number).filter(Number.isInteger))].sort((a, b) => a - b),
  };
}

function persistRepoState(filePath, fullRepoNums) {
  if (!filePath) return;
  const state = loadRepoState(filePath);
  state.fullRepoNums = [...new Set([...state.fullRepoNums, ...fullRepoNums])].sort((a, b) => a - b);
  writeJsonAtomic(filePath, state);
}

function persistNormalizationAudit(filePath, outcomes, provenance = []) {
  if (!filePath || !outcomes.length) return;
  const audit = readJson(filePath, { schemaVersion: 1, entries: [] });
  if (audit.schemaVersion !== 1 || !Array.isArray(audit.entries)) {
    throw new Error('Normalization audit must have schemaVersion=1 and an entries array');
  }
  const now = new Date().toISOString();
  for (const outcome of outcomes) {
    const key = `${outcome.sourceType}:${outcome.sourceFile}:${outcome.sourceArchiveSha256 || ''}`;
    const existingIndex = audit.entries.findIndex(entry => entry.key === key);
    const existing = existingIndex >= 0 ? audit.entries[existingIndex] : null;
    const productMappings = provenance.filter(item => item.sourceFile === outcome.sourceFile);
    const row = {
      key,
      sourceFile: outcome.sourceFile,
      sourceType: outcome.sourceType,
      sourceArchiveSha256: outcome.sourceArchiveSha256,
      normalizationSchemaVersion: NORMALIZATION_SCHEMA_VERSION,
      classification: outcome.classification,
      label: outcome.classification === 'illegal' ? '非法材质' : null,
      causes: outcome.causes,
      products: outcome.products.map(product => ({
        ...product,
        ...(productMappings.find(item =>
          item.productFile === product.file || item.originalProductFile === product.file
        ) || {}),
      })),
      status: outcome.classification === 'illegal' ? 'rejected' : 'planned',
      firstSeenAt: existing ? existing.firstSeenAt : now,
      updatedAt: now,
    };
    if (existingIndex >= 0) audit.entries[existingIndex] = row;
    else audit.entries.push(row);
  }
  audit.entries.sort((a, b) => a.key.localeCompare(b.key));
  writeJsonAtomic(filePath, audit);
}

function summarize(entries) {
  const counts = {};
  for (const entry of entries) counts[entry.action] = (counts[entry.action] || 0) + 1;
  return counts;
}

function compactFingerprint(fingerprint) {
  return {
    schemaVersion: fingerprint.schemaVersion,
    archiveSha256: fingerprint.archiveSha256,
    visualContentHash: fingerprint.visualContentHash,
    visualEntryCount: fingerprint.visualEntryCount,
    swords: fingerprint.swords,
  };
}

function loadAliases(filePath) {
  const value = readJson(filePath, { schemaVersion: 1, entries: [] });
  return value && value.schemaVersion === 1 && Array.isArray(value.entries)
    ? value
    : { schemaVersion: 1, entries: [] };
}

function findAlias(aliases, fingerprint, matches) {
  const files = new Set(matches.map(match => match.file));
  return aliases.entries.find(entry =>
    entry.archiveSha256 === fingerprint.archiveSha256 &&
    entry.visualContentHash === fingerprint.visualContentHash &&
    files.has(entry.retainedFile)
  ) || null;
}

function loadResolutions(filePath) {
  if (!filePath) return null;
  const value = readJson(filePath, null);
  if (!value || value.schemaVersion !== 1 ||
      (value.decisions != null && !Array.isArray(value.decisions)) ||
      (value.nameOverrides != null && !Array.isArray(value.nameOverrides))) {
    throw new Error('Resolution manifest must have schemaVersion=1 and array decisions/nameOverrides fields');
  }
  const resolutions = {
    ...value,
    decisions: value.decisions || [],
    nameOverrides: value.nameOverrides || [],
  };
  for (const override of resolutions.nameOverrides) {
    if (!override || !override.sourceArchiveSha256 || !override.productArchiveSha256 ||
        typeof override.file !== 'string' || path.basename(override.file) !== override.file ||
        !override.file.endsWith('.zip') || !getPackIdFromZipName(override.file)) {
      throw new Error('Each name override must bind source/product SHA-256 values to one safe .zip filename');
    }
  }
  return resolutions;
}

function findResolution(resolutions, fingerprint) {
  if (!resolutions) return null;
  return resolutions.decisions.find(decision =>
    decision.archiveSha256 === fingerprint.archiveSha256 &&
    decision.visualContentHash === fingerprint.visualContentHash
  ) || null;
}

function findNameOverride(resolutions, source) {
  if (!resolutions || !source.normalization.collection) return null;
  return resolutions.nameOverrides.find(override =>
    override.sourceArchiveSha256 === source.normalization.sourceArchiveSha256 &&
    override.productArchiveSha256 === source.normalization.productArchiveSha256
  ) || null;
}

function appendNonCanonicalEntries(entries, files, canonical) {
  files.filter(file => file !== canonical).forEach(file => entries.push({
    file: file.file,
    packId: canonical.packId,
    size: file.size,
    action: 'skip_source_duplicate',
    reason: 'same_pack_id_as_group_canonical',
  }));
}

function buildProvenance(source, fingerprint, action, extra = {}) {
  return {
    sourceFile: source.sourceFile,
    sourceArchiveSha256: source.normalization.sourceArchiveSha256,
    productFile: source.file,
    originalProductFile: source.normalization.originalProductFile || source.file,
    productPackId: source.packId,
    productArchiveSha256: fingerprint.archiveSha256,
    visualContentHash: fingerprint.visualContentHash,
    action,
    ...extra,
  };
}

async function buildPlan(opts, services = {}) {
  if (!fs.existsSync(opts.source)) throw new Error(`Source folder not found: ${opts.source}`);

  const registryPath = opts.registryPath || REGISTRY_PATH;
  const siteIndexPath = opts.siteIndexPath || INDEX_PATH;
  const contentIndexPath = opts.contentIndex || CONTENT_INDEX_PATH;
  const contentAliasesPath = opts.contentAliases || CONTENT_ALIASES_PATH;
  const githubFileLimit = Number.isFinite(opts.githubFileLimit) ? opts.githubFileLimit : GITHUB_FILE_LIMIT;
  const maxRepoSize = Number.isFinite(opts.maxRepoSize) ? opts.maxRepoSize : MAX_REPO_SIZE;
  const registry = readJson(registryPath, {});
  const index = readJson(siteIndexPath, { items: [] });
  const existingIds = new Map(index.items.map(p => [p.name.toLowerCase(), p.name]));
  const sourceFiles = getSourceFiles(opts.source);
  const normalized = await normalizeSourceFiles(sourceFiles, opts, services);
  const normalizedFiles = normalized.products;
  const fingerprintFn = services.fingerprintPack || fingerprintPack;
  const groups = new Map();
  const aliases = loadAliases(contentAliasesPath);
  let resolutions = null;
  let resolutionError = null;
  try {
    resolutions = loadResolutions(opts.duplicateResolutions);
  } catch (error) {
    resolutionError = error.message;
  }
  let contentIndex = null;
  let contentIndexError = null;
  try {
    contentIndex = validateContentIndex(readJson(contentIndexPath, null), registry, FINGERPRINT_SCHEMA_VERSION);
  } catch (error) {
    contentIndexError = { code: error.code || 'content_index_invalid', message: error.message };
  }
  const visualLookup = contentIndex ? buildVisualHashLookup(contentIndex) : new Map();
  if (resolutions && (!contentIndex || resolutions.registryDigest !== contentIndex.registryDigest)) {
    resolutionError = 'Duplicate resolution manifest registryDigest does not match the current content index';
    resolutions = null;
  }

  const appliedNameOverrides = [];
  for (const source of normalizedFiles) {
    const override = findNameOverride(resolutions, source);
    if (!override) continue;
    const from = source.file;
    source.file = override.file;
    source.packId = getPackIdFromZipName(override.file);
    source.normalization = {
      ...source.normalization,
      originalProductFile: from,
      nameOverride: { from, to: override.file, reason: override.reason || 'reviewed' },
    };
    appliedNameOverrides.push({
      sourceFile: source.sourceFile,
      sourceArchiveSha256: source.normalization.sourceArchiveSha256,
      productArchiveSha256: source.normalization.productArchiveSha256,
      from,
      to: override.file,
      packId: source.packId,
      reason: override.reason || 'reviewed',
    });
  }

  for (const source of normalizedFiles) {
    const key = source.packId.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(source);
  }

  const repoUsed = {};
  for (const entry of Object.values(registry)) {
    if (!entry || !entry.repoNum || !entry.size) continue;
    repoUsed[entry.repoNum] = (repoUsed[entry.repoNum] || 0) + entry.size;
  }

  const existingRepoNums = Object.keys(repoUsed).map(Number).filter(Number.isInteger);
  const highestRepoNum = existingRepoNums.length ? Math.max(...existingRepoNums) : 0;
  const repoState = loadRepoState(getRepoStatePath(opts));
  const fullRepoNums = new Set(repoState.fullRepoNums);
  for (let num = 1; num < highestRepoNum; num++) fullRepoNums.add(num);
  for (const [num, size] of Object.entries(repoUsed)) {
    if (size >= maxRepoSize) fullRepoNums.add(Number(num));
  }
  let repoNum = 1;
  while (fullRepoNums.has(repoNum)) repoNum += 1;
  let used = repoUsed[repoNum] || 0;
  const illegalEntries = normalized.outcomes
    .filter(outcome => outcome.classification === 'illegal')
    .map(outcome => ({
      file: outcome.sourceFile,
      sourceFile: outcome.sourceFile,
      packId: null,
      size: sourceFiles.find(source => source.file === outcome.sourceFile)?.size || 0,
      action: 'illegal_material',
      classification: 'illegal',
      label: '非法材质',
      reason: outcome.causes[0],
      causes: outcome.causes,
    }));
  const limitEntries = normalized.outcomes
    .filter(outcome => outcome.classification === 'blocked')
    .map(outcome => ({
      file: outcome.sourceFile,
      sourceFile: outcome.sourceFile,
      packId: null,
      size: sourceFiles.find(source => source.file === outcome.sourceFile)?.size || 0,
      action: 'blocked_archive_limits',
      classification: 'blocked',
      reason: outcome.causes[0],
      causes: outcome.causes,
    }));
  const entries = [...illegalEntries, ...limitEntries];
  const listPackIds = [];
  const uploadEntries = [];
  const extractPackIds = [];
  const aliasUpdates = [];
  const replacements = [];
  const provenance = [];
  let contentIndexBlockerAdded = false;
  let resolutionBlockerAdded = false;

  for (const files of groups.values()) {
    const first = files[0];
    const existingId = existingIds.get(first.packId.toLowerCase());
    const finalPackId = existingId || first.packId;
    const registered = files.find(f => registry[f.file]);
    const uploadable = files.find(f => f.size <= githubFileLimit);
    const canonical = uploadable || first;

    if (!contentIndex) {
      if (!contentIndexBlockerAdded) {
        entries.push({
          file: null,
          packId: null,
          size: 0,
          action: 'blocked_content_index',
          reason: contentIndexError.code,
          detail: contentIndexError.message,
        });
        contentIndexBlockerAdded = true;
      }
      entries.push({
        file: canonical.file,
        packId: finalPackId,
        size: canonical.size,
        action: 'blocked_content_index_required',
        reason: 'content_identity_cannot_be_checked',
      });
      appendNonCanonicalEntries(entries, files, canonical);
      continue;
    }

    let fingerprint;
    try {
      fingerprint = compactFingerprint(await fingerprintFn(canonical.path));
    } catch (error) {
      entries.push({
        file: canonical.file,
        packId: finalPackId,
        size: canonical.size,
        action: 'blocked_content_fingerprint',
        reason: error.code || 'content_fingerprint_failed',
        detail: error.message,
      });
      appendNonCanonicalEntries(entries, files, canonical);
      continue;
    }

    if (canonical.normalization.sourceVisualContentHash &&
        canonical.normalization.sourceVisualContentHash !== fingerprint.visualContentHash) {
      entries.push({
        file: canonical.file,
        sourceFile: canonical.sourceFile,
        packId: finalPackId,
        size: canonical.size,
        action: 'blocked_normalization_content_change',
        reason: 'normalization_changed_visual_content',
        fingerprint,
        sourceVisualContentHash: canonical.normalization.sourceVisualContentHash,
      });
      appendNonCanonicalEntries(entries, files, canonical);
      continue;
    }

    const matches = visualLookup.get(fingerprint.visualContentHash) || [];
    if (existingId) {
      const retained = matches.find(match => match.packId && match.packId.toLowerCase() === existingId.toLowerCase());
      if (!retained) {
        entries.push({
          file: canonical.file,
          packId: finalPackId,
          size: canonical.size,
          action: 'blocked_pack_id_content_conflict',
          reason: 'pack_id_exists_with_different_visual_content',
          fingerprint,
          existingPackId: existingId,
          exactContentMatches: matches.map(match => ({ file: match.file, packId: match.packId, repo: match.repo })),
        });
        appendNonCanonicalEntries(entries, files, canonical);
        continue;
      }
      listPackIds.push(existingId);
      if (canonical.file !== retained.file || fingerprint.archiveSha256 !== retained.archiveSha256) {
        aliasUpdates.push({
          sourceFile: canonical.file,
          sourcePackId: finalPackId,
          archiveSha256: fingerprint.archiveSha256,
          visualContentHash: fingerprint.visualContentHash,
          retainedFile: retained.file,
          retainedPackId: retained.packId,
          reason: 'existing_pack_id_exact_content',
        });
      }
      entries.push({
        file: canonical.file,
        packId: existingId,
        size: canonical.size,
        action: 'skip_existing_pack_id_exact_content',
        reason: 'pack_id_and_visual_content_already_exist',
        retainedFile: retained.file,
        fingerprint,
      });
      if (canonical.normalization.collection) {
        provenance.push(buildProvenance(canonical, fingerprint, 'reuse_collection_product_exact_content', {
          productPackId: existingId,
          retainedFile: retained.file,
          retainedPackId: retained.packId,
        }));
      }
      appendNonCanonicalEntries(entries, files, canonical);
      continue;
    }

    if (registered) {
      const retained = matches.find(match => match.file === registered.file);
      if (!retained) {
        entries.push({
          file: canonical.file,
          packId: finalPackId,
          size: canonical.size,
          action: 'blocked_registry_filename_content_conflict',
          reason: 'registered_filename_has_different_visual_content',
          fingerprint,
        });
        appendNonCanonicalEntries(entries, files, canonical);
        continue;
      }
      listPackIds.push(finalPackId);
      extractPackIds.push(finalPackId);
      entries.push({
        file: canonical.file,
        packId: finalPackId,
        size: canonical.size,
        action: 'skip_exact_registry_extract',
        reason: 'zip_filename_and_visual_content_already_registered',
        repo: registry[registered.file].repo,
        repoNum: registry[registered.file].repoNum,
        fingerprint,
      });
      if (canonical.normalization.collection) {
        provenance.push(buildProvenance(canonical, fingerprint, 'reuse_collection_product_exact_content', {
          productPackId: finalPackId,
          retainedFile: retained.file,
          retainedPackId: retained.packId,
        }));
      }
      appendNonCanonicalEntries(entries, files, canonical);
      continue;
    }

    if (canonical.normalization.collection && matches.length) {
      const retained = matches[0];
      listPackIds.push(retained.packId);
      aliasUpdates.push({
        sourceFile: canonical.file,
        sourcePackId: finalPackId,
        archiveSha256: fingerprint.archiveSha256,
        visualContentHash: fingerprint.visualContentHash,
        retainedFile: retained.file,
        retainedPackId: retained.packId,
        reason: 'collection_product_exact_content',
      });
      entries.push({
        file: canonical.file,
        sourceFile: canonical.sourceFile,
        packId: retained.packId,
        size: canonical.size,
        action: 'reuse_collection_product_exact_content',
        reason: 'exact_visual_content_reused_without_deletion',
        retainedFile: retained.file,
        retainedPackId: retained.packId,
        fingerprint,
      });
      provenance.push(buildProvenance(canonical, fingerprint, 'reuse_collection_product_exact_content', {
        productPackId: retained.packId,
        retainedFile: retained.file,
        retainedPackId: retained.packId,
      }));
      appendNonCanonicalEntries(entries, files, canonical);
      continue;
    }

    let keepIncoming = false;
    if (matches.length) {
      const alias = findAlias(aliases, fingerprint, matches);
      const decision = alias ? {
        keep: 'existing',
        retainedFile: alias.retainedFile,
        reason: 'resolved_alias',
      } : findResolution(resolutions, fingerprint);

      if (resolutionError && !alias && !resolutionBlockerAdded) {
        entries.push({
          file: null,
          packId: null,
          size: 0,
          action: 'blocked_duplicate_resolution_manifest',
          reason: 'invalid_or_stale_resolution_manifest',
          detail: resolutionError,
        });
        resolutionBlockerAdded = true;
      }

      if (!decision) {
        entries.push({
          file: canonical.file,
          packId: finalPackId,
          size: canonical.size,
          action: 'blocked_content_duplicate',
          reason: 'exact_visual_content_match_requires_retain_decision',
          fingerprint,
          matches: matches.map(match => ({ file: match.file, packId: match.packId, repo: match.repo })),
        });
        appendNonCanonicalEntries(entries, files, canonical);
        continue;
      }

      if (decision.keep === 'existing') {
        const retained = matches.find(match => match.file === decision.retainedFile);
        if (!retained) {
          entries.push({
            file: canonical.file,
            packId: finalPackId,
            size: canonical.size,
            action: 'blocked_content_duplicate_resolution',
            reason: 'retained_file_is_not_a_current_exact_match',
            retainedFile: decision.retainedFile || null,
          });
          appendNonCanonicalEntries(entries, files, canonical);
          continue;
        }
        listPackIds.push(retained.packId);
        aliasUpdates.push({
          sourceFile: canonical.file,
          sourcePackId: finalPackId,
          archiveSha256: fingerprint.archiveSha256,
          visualContentHash: fingerprint.visualContentHash,
          retainedFile: retained.file,
          retainedPackId: retained.packId,
          reason: decision.reason || 'keep_existing',
        });
        entries.push({
          file: canonical.file,
          packId: retained.packId,
          size: canonical.size,
          action: 'skip_content_duplicate_keep_existing',
          reason: decision.reason || 'keep_existing',
          retainedFile: retained.file,
          retainedPackId: retained.packId,
          fingerprint,
        });
        appendNonCanonicalEntries(entries, files, canonical);
        continue;
      }

      if (decision.keep !== 'incoming') {
        entries.push({
          file: canonical.file,
          packId: finalPackId,
          size: canonical.size,
          action: 'blocked_content_duplicate_resolution',
          reason: 'decision_keep_must_be_existing_or_incoming',
        });
        appendNonCanonicalEntries(entries, files, canonical);
        continue;
      }
      keepIncoming = true;
    }

    if (!uploadable) {
      entries.push({
        file: canonical.file,
        packId: finalPackId,
        size: canonical.size,
        action: 'blocked_oversize',
        reason: 'github_git_file_limit_100mb',
        fingerprint,
      });
      appendNonCanonicalEntries(entries, files, canonical);
      continue;
    }

    while (fullRepoNums.has(repoNum) || used + uploadable.size > maxRepoSize) {
      fullRepoNums.add(repoNum);
      repoNum += 1;
      while (fullRepoNums.has(repoNum)) repoNum += 1;
      used = repoUsed[repoNum] || 0;
    }

    const upload = {
      file: uploadable.file,
      path: uploadable.path,
      sourceFile: uploadable.sourceFile,
      packId: finalPackId,
      size: uploadable.size,
      action: 'upload_new',
      repo: repoName(repoNum),
      repoNum,
      fingerprint,
      normalization: uploadable.normalization,
    };
    used += uploadable.size;
    repoUsed[repoNum] = used;
    listPackIds.push(finalPackId);
    extractPackIds.push(finalPackId);
    uploadEntries.push(upload);
    entries.push(upload);
    provenance.push(buildProvenance(uploadable, fingerprint, 'upload_new', {
      productPackId: finalPackId,
      targetRepo: upload.repo,
      targetRepoNum: upload.repoNum,
    }));
    if (keepIncoming) {
      replacements.push({
        incomingFile: upload.file,
        incomingPackId: upload.packId,
        incomingArchiveSha256: fingerprint.archiveSha256,
        incomingSize: upload.size,
        visualContentHash: fingerprint.visualContentHash,
        existing: matches.map(match => ({
          file: match.file,
          packId: match.packId,
          repo: match.repo,
          repoNum: match.repoNum,
          size: match.size,
          archiveSha256: match.archiveSha256,
        })),
      });
    }

    appendNonCanonicalEntries(entries, files, uploadable);
  }

  const blockers = entries.filter(e => e.action.startsWith('blocked_'));
  const hardBlockers = blockers.filter(entry =>
    entry.action.includes('content_') ||
    entry.action.includes('duplicate_resolution') ||
    entry.action === 'blocked_archive_limits' ||
    entry.action === 'blocked_normalization_content_change'
  );
  const plan = {
    source: opts.source,
    list: opts.list,
    normalizationSchemaVersion: NORMALIZATION_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    summary: {
      sourceFiles: sourceFiles.length,
      uniquePackIds: groups.size,
      listPackIds: listPackIds.length,
      uploadFiles: uploadEntries.length,
      uploadBytes: uploadEntries.reduce((sum, e) => sum + e.size, 0),
      blockers: blockers.length,
      hardBlockers: hardBlockers.length,
      actions: summarize(entries),
      fullRepoNums: [...fullRepoNums].sort((a, b) => a - b),
      normalization: normalized.outcomes.reduce((counts, outcome) => {
        counts[outcome.classification] = (counts[outcome.classification] || 0) + 1;
        return counts;
      }, { normal: 0, repairable: 0, illegal: 0, blocked: 0 }),
    },
    listPackIds,
    extractPackIds,
    uploadEntries,
    illegalEntries,
    blockers,
    hardBlockers,
    aliasUpdates,
    replacements,
    provenance,
    appliedNameOverrides,
    contentIndexDigest: contentIndex ? contentIndex.registryDigest : null,
    entries,
  };
  persistNormalizationAudit(getNormalizationAuditPath(opts), normalized.outcomes, provenance);
  return plan;
}

function ensureRepo(workdir, num) {
  fs.mkdirSync(workdir, { recursive: true });
  const name = repoName(num);
  const dir = path.join(workdir, name);
  if (fs.existsSync(path.join(dir, '.git'))) {
    const status = run('git', ['status', '--short'], { cwd: dir });
    if (!status) run('git', ['pull', '--ff-only'], { cwd: dir, stdio: 'inherit' });
    else throw new Error(`${name}: temporary clone has pending changes; clean it before upload.`);
    return dir;
  }

  try {
    run('git', ['clone', `https://github.com/${REPO_OWNER}/${name}.git`, dir], { stdio: 'inherit' });
  } catch (cloneErr) {
    fs.mkdirSync(dir, { recursive: true });
    run('git', ['init'], { cwd: dir });
    run('git', ['remote', 'add', 'origin', `https://github.com/${REPO_OWNER}/${name}.git`], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\nResource pack storage for VALE.\n`);
    fs.mkdirSync(path.join(dir, 'resourcepacks'), { recursive: true });
    run('git', ['add', '.'], { cwd: dir });
    run('git', ['commit', '-m', 'init'], { cwd: dir });
    run('git', ['branch', '-M', 'main'], { cwd: dir });
    run('gh', ['repo', 'create', `${REPO_OWNER}/${name}`, '--public', '-y'], { cwd: dir, stdio: 'inherit' });
    run('git', ['push', '-u', 'origin', 'main'], { cwd: dir, stdio: 'inherit' });
  }
  try {
    run('git', ['branch', '-M', 'main'], { cwd: dir });
  } catch {}
  return dir;
}

function cleanupTemporaryRepo(repoDir, workdir) {
  const root = path.resolve(workdir) + path.sep;
  const target = path.resolve(repoDir);
  if (!target.startsWith(root)) throw new Error(`Refusing to clean repository outside upload workdir: ${target}`);
  fs.rmSync(target, { recursive: true, force: true });
  if (fs.existsSync(workdir) && fs.readdirSync(workdir).length === 0) fs.rmSync(workdir, { recursive: true, force: true });
}

function commitRepoBatches(repoDir, repo, files, markFull) {
  const rpDir = path.join(repoDir, 'resourcepacks');
  fs.mkdirSync(rpDir, { recursive: true });

  let batch = [];
  let batchSize = 0;
  let batchNum = 0;
  const flush = () => {
    if (!batch.length) return;
    batchNum += 1;
    for (const item of batch) {
      run('git', ['add', '--', path.join('resourcepacks', item.file)], { cwd: repoDir });
    }
    if (markFull && fs.existsSync(path.join(repoDir, FULL_MARKER))) {
      run('git', ['add', '--', FULL_MARKER], { cwd: repoDir });
    }
    const status = run('git', ['status', '--short'], { cwd: repoDir });
    if (status) {
      run('git', ['commit', '-m', `add Sakyvo packs batch ${batchNum}`], { cwd: repoDir, stdio: 'inherit' });
      run('git', ['push', 'origin', 'main'], { cwd: repoDir, stdio: 'inherit', timeout: 1200000 });
    }
    batch = [];
    batchSize = 0;
  };

  for (const item of files) {
    fs.copyFileSync(item.path, path.join(rpDir, item.file));
    batch.push(item);
    batchSize += item.size;
    if (batchSize >= BATCH_SIZE) flush();
  }
  if (markFull) fs.writeFileSync(path.join(repoDir, FULL_MARKER), 'This repository has reached its storage limit.\n');
  flush();
  if (markFull) {
    run('git', ['add', '--', FULL_MARKER], { cwd: repoDir });
    const status = run('git', ['status', '--short'], { cwd: repoDir });
    if (status) {
      run('git', ['commit', '-m', 'mark pack repository full'], { cwd: repoDir, stdio: 'inherit' });
      run('git', ['push', 'origin', 'main'], { cwd: repoDir, stdio: 'inherit', timeout: 1200000 });
    }
  }
}

function updateLists(listName, packIds, replacements = [], listsPath = LISTS_PATH) {
  const lists = readJson(listsPath, []);
  const replacementMap = new Map();
  for (const replacement of replacements) {
    for (const existing of replacement.existing) replacementMap.set(existing.packId, replacement.incomingPackId);
  }
  if (replacementMap.size) {
    for (const entry of lists) {
      const seen = new Set();
      entry.packs = (entry.packs || []).map(packId => replacementMap.get(packId) || packId).filter(packId => {
        if (seen.has(packId)) return false;
        seen.add(packId);
        return true;
      });
    }
  }
  let list = lists.find(l => l.name === listName);
  if (!list) {
    list = { name: listName, cover: '', description: '', packs: [] };
    lists.push(list);
  }
  for (const packId of packIds) {
    if (!list.packs.includes(packId)) list.packs.push(packId);
  }
  writeJson(listsPath, lists);

  const listRoot = path.dirname(listsPath);
  const listDir = path.join(listRoot, listName);
  const pagePath = path.join(listDir, 'index.html');
  if (!fs.existsSync(pagePath)) {
    const localTemplate = path.join(listRoot, 'test', 'index.html');
    const templatePath = fs.existsSync(localTemplate) ? localTemplate
      : fs.existsSync(LIST_PAGE_TEMPLATE) ? LIST_PAGE_TEMPLATE
        : path.join(ROOT, 'l', 'index.html');
    const template = fs.readFileSync(templatePath, 'utf-8');
    fs.mkdirSync(listDir, { recursive: true });
    fs.writeFileSync(pagePath, template);
  }
}

function verifyRemoteUpload(item) {
  const endpoint = `repos/${REPO_OWNER}/${encodeURIComponent(item.repo)}/contents/resourcepacks/${encodeURIComponent(item.file)}?ref=main`;
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const remoteSize = Number(run('gh', ['api', endpoint, '--jq', '.size'], { timeout: 120000 }));
      if (remoteSize !== item.size) {
        throw new Error(`remote_size_mismatch expected=${item.size} actual=${remoteSize}`);
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 5) run(process.execPath, ['-e', `setTimeout(() => {}, ${attempt * 1000})`], { timeout: attempt * 1000 + 5000 });
    }
  }
  throw new Error(`Remote verification failed for ${item.repo}/${item.file}: ${lastError.message}`);
}

function persistAliasUpdates(filePath, updates) {
  if (!updates.length) return;
  const aliases = loadAliases(filePath);
  for (const update of updates) {
    const existingIndex = aliases.entries.findIndex(entry =>
      entry.archiveSha256 === update.archiveSha256 && entry.visualContentHash === update.visualContentHash
    );
    const row = { ...update, resolvedAt: new Date().toISOString() };
    if (existingIndex >= 0) aliases.entries[existingIndex] = row;
    else aliases.entries.push(row);
  }
  aliases.entries.sort((a, b) => a.sourceFile.localeCompare(b.sourceFile));
  writeJsonAtomic(filePath, aliases);
}

function persistPendingReplacements(filePath, replacements, uploads) {
  const uploadedFiles = new Set(uploads.map(item => item.file));
  const selected = replacements.filter(replacement => uploadedFiles.has(replacement.incomingFile));
  if (!selected.length) return;
  const pending = readJson(filePath, { schemaVersion: 1, entries: [] });
  if (pending.schemaVersion !== 1 || !Array.isArray(pending.entries)) throw new Error('Invalid pending replacement state');
  for (const replacement of selected) {
    const row = {
      ...replacement,
      status: 'uploaded_pending_site_verification',
      createdAt: new Date().toISOString(),
    };
    const index = pending.entries.findIndex(entry => entry.incomingFile === replacement.incomingFile);
    if (index >= 0) pending.entries[index] = row;
    else pending.entries.push(row);
  }
  writeJsonAtomic(filePath, pending);
}

function executePlan(opts, plan, services = {}) {
  if (plan.hardBlockers.length) {
    throw new Error(`Dry-run has ${plan.hardBlockers.length} non-bypassable content blocker(s).`);
  }
  if (plan.blockers.length && !opts.skipBlockers) {
    throw new Error(`Dry-run has ${plan.blockers.length} blocker(s); resolve them before --execute.`);
  }

  const registryPath = opts.registryPath || REGISTRY_PATH;
  const listsPath = opts.listsPath || LISTS_PATH;
  const contentIndexPath = opts.contentIndex || CONTENT_INDEX_PATH;
  const contentAliasesPath = opts.contentAliases || CONTENT_ALIASES_PATH;
  const pendingReplacementsPath = opts.pendingReplacements || PENDING_REPLACEMENTS_PATH;
  const registry = readJson(registryPath, {});
  const contentIndex = validateContentIndex(readJson(contentIndexPath, null), registry, FINGERPRINT_SCHEMA_VERSION);
  if (contentIndex.registryDigest !== plan.contentIndexDigest) throw new Error('Content index changed after dry-run; rebuild the upload plan.');
  const byRepo = new Map();
  const executedUploads = plan.uploadEntries.filter(item => !opts.onlyRepoNum || item.repoNum === opts.onlyRepoNum);
  for (const item of executedUploads) {
    if (!byRepo.has(item.repoNum)) byRepo.set(item.repoNum, []);
    byRepo.get(item.repoNum).push(item);
  }

  const repoNums = new Set([...byRepo.keys(), ...plan.summary.fullRepoNums]);
  for (const num of [...repoNums].sort((a, b) => a - b)) {
    if (opts.onlyRepoNum && num !== opts.onlyRepoNum) continue;
    const files = byRepo.get(num) || [];
    const markFull = plan.summary.fullRepoNums.includes(num);
    if (services.remote) {
      if (files.length || markFull) {
        services.remote.publishBatch({ repo: repoName(num), repoNum: num, files, markFull });
        for (const item of files) services.remote.verifyArchive(item);
      }
      continue;
    }
    const expectedRepoDir = path.join(opts.workdir, repoName(num));
    const existedBefore = fs.existsSync(expectedRepoDir);
    let repoDir = null;
    try {
      repoDir = ensureRepo(opts.workdir, num);
      if (files.length || markFull) {
        commitRepoBatches(repoDir, repoName(num), files, markFull);
        for (const item of files) verifyRemoteUpload(item);
      }
    } finally {
      if (repoDir || (!existedBefore && fs.existsSync(expectedRepoDir))) {
        cleanupTemporaryRepo(repoDir || expectedRepoDir, opts.workdir);
      }
    }
  }
  persistRepoState(getRepoStatePath(opts), plan.summary.fullRepoNums);

  for (const item of executedUploads) {
    registry[item.file] = { repo: item.repo, repoNum: item.repoNum, size: item.size };
    contentIndex.packs[item.file] = {
      packId: item.packId,
      repo: item.repo,
      repoNum: item.repoNum,
      size: item.size,
      sourceKey: sourceKey(item.file, registry[item.file]),
      archiveSha256: item.fingerprint.archiveSha256,
      visualContentHash: item.fingerprint.visualContentHash,
      visualEntryCount: item.fingerprint.visualEntryCount,
      swords: item.fingerprint.swords,
    };
  }
  writeJson(registryPath, registry);
  refreshContentIndexMetadata(contentIndex, registry);
  writeJsonAtomic(contentIndexPath, contentIndex);

  const allUploadIds = new Set(plan.uploadEntries.map(item => item.packId));
  const executedUploadIds = new Set(executedUploads.map(item => item.packId));
  const listPackIds = plan.listPackIds.filter(packId => !allUploadIds.has(packId) || executedUploadIds.has(packId));
  const executedReplacements = plan.replacements.filter(replacement => executedUploadIds.has(replacement.incomingPackId));
  updateLists(opts.list, listPackIds, executedReplacements, listsPath);
  persistAliasUpdates(contentAliasesPath, plan.aliasUpdates);
  persistPendingReplacements(pendingReplacementsPath, executedReplacements, executedUploads);
}

async function runIngestion(opts, services = {}) {
  const workdir = path.resolve(opts.workdir || path.join(ROOT, '..', '.vale-pack-upload'));
  const normalizationWorkdir = path.join(workdir, '.normalized');
  const runOpts = { ...opts, workdir, normalizationWorkdir };
  try {
    const plan = await buildPlan(runOpts, services);
    if (opts.manifest) writeJson(path.resolve(opts.manifest), plan);
    if (opts.execute) executePlan(runOpts, plan, services);
    return plan;
  } finally {
    fs.rmSync(normalizationWorkdir, { recursive: true, force: true });
    if (fs.existsSync(workdir) && fs.readdirSync(workdir).length === 0) {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  }
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const plan = await runIngestion(opts);

  console.log(JSON.stringify(plan.summary, null, 2));
  if (plan.blockers.length) {
    console.log('\nBlockers:');
    for (const b of plan.blockers) {
      console.log(`  ${b.file} (${(b.size / 1024 / 1024).toFixed(1)} MB): ${b.reason}`);
    }
  }

  if (!opts.execute) {
    console.log('\nDry-run only. Re-run with --execute after reviewing the manifest.');
    return;
  }
  console.log('\nUpload/List update complete.');
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  buildPlan,
  executePlan,
  parseArgs,
  runIngestion,
  updateLists,
};
