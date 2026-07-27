const fs = require('node:fs');
const path = require('node:path');
const {
  computeRegistryDigest,
  readJson,
  refreshContentIndexMetadata,
  validateContentIndex,
  writeJsonAtomic,
} = require('./lib/pack-content-index');
const { SCHEMA_VERSION: FINGERPRINT_SCHEMA_VERSION } = require('./lib/pack-content-fingerprint');
const { NORMALIZATION_SCHEMA_VERSION } = require('./lib/pack-normalizer');

const STATUS_ORDER = ['planned', 'site_prepared', 'deployed_verified', 'remote_deleted', 'complete'];

function statusIndex(status) {
  return STATUS_ORDER.indexOf(status);
}

function advance(entry, status) {
  if (entry.status === status) return;
  if (statusIndex(status) < statusIndex(entry.status)) {
    throw new Error(`Refusing non-monotonic illegal retirement transition ${entry.status} -> ${status}`);
  }
  entry.status = status;
  entry.lifecycle = entry.lifecycle || {};
  entry.lifecycle[status] = new Date().toISOString();
}

function assertManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 ||
      manifest.normalizationSchemaVersion !== NORMALIZATION_SCHEMA_VERSION ||
      !manifest.registryDigest || !manifest.evidenceDigest || !Array.isArray(manifest.entries)) {
    throw new Error('Invalid or incompatible normalization audit manifest');
  }
}

function safeRemoveChild(root, name, suffix = '') {
  if (!root || !name) return;
  const rootPath = path.resolve(root) + path.sep;
  const target = path.resolve(root, `${name}${suffix}`);
  if (!target.startsWith(rootPath)) throw new Error(`Refusing to remove path outside root: ${target}`);
  fs.rmSync(target, { recursive: true, force: true });
}

function initializeState(manifest) {
  return {
    schemaVersion: 1,
    normalizationSchemaVersion: NORMALIZATION_SCHEMA_VERSION,
    manifestEvidenceDigest: manifest.evidenceDigest,
    manifestRegistryDigest: manifest.registryDigest,
    reviewedArtifactDigest: manifest.reviewedArtifactDigest || null,
    entries: manifest.entries
      .filter(entry => entry.normalization.classification === 'illegal')
      .map(entry => ({
        file: entry.file,
        packId: entry.visibility.packId,
        causes: [...entry.normalization.causes],
        status: entry.decision && entry.decision.action === 'defer' ? 'deferred' : 'planned',
        deferReason: entry.decision && entry.decision.action === 'defer' ? entry.decision.reason || 'reviewed_defer' : null,
        source: {
          file: entry.file,
          repo: entry.source.repo,
          repoNum: Number(entry.source.repoNum),
          size: Number(entry.source.size),
          registrySize: Number(entry.source.registrySize),
          archiveSha256: entry.source.archiveSha256,
          sourceKey: entry.source.sourceKey,
        },
        visibility: { ...entry.visibility },
        lifecycle: { planned: new Date().toISOString() },
      })),
  };
}

function loadState(manifest, options) {
  if (!fs.existsSync(options.statePath)) return initializeState(manifest);
  const state = readJson(options.statePath, null);
  if (!state || state.schemaVersion !== 1 || !Array.isArray(state.entries) ||
      state.normalizationSchemaVersion !== NORMALIZATION_SCHEMA_VERSION ||
      state.manifestEvidenceDigest !== manifest.evidenceDigest ||
      state.manifestRegistryDigest !== manifest.registryDigest ||
      (manifest.reviewedArtifactDigest && state.reviewedArtifactDigest !== manifest.reviewedArtifactDigest)) {
    throw new Error('Illegal retirement state does not match the reviewed manifest');
  }
  return state;
}

function writeState(options, state) {
  writeJsonAtomic(options.statePath, state);
}

function upsertTombstones(options, state) {
  const ledger = readJson(options.tombstonePath, { schemaVersion: 1, entries: [] });
  if (!ledger || ledger.schemaVersion !== 1 || !Array.isArray(ledger.entries)) {
    throw new Error('Invalid illegal-material tombstone ledger');
  }
  for (const entry of state.entries) {
    if (entry.status === 'deferred') continue;
    const tombstone = {
      file: entry.file,
      packId: entry.packId,
      label: '非法材质',
      causes: entry.causes,
      source: entry.source,
      priorVisibility: entry.visibility,
      normalizationSchemaVersion: NORMALIZATION_SCHEMA_VERSION,
      status: entry.status,
      lifecycle: entry.lifecycle,
    };
    const index = ledger.entries.findIndex(row => row.file === entry.file &&
      row.source && row.source.archiveSha256 === entry.source.archiveSha256);
    if (index >= 0) ledger.entries[index] = tombstone;
    else ledger.entries.push(tombstone);
  }
  ledger.entries.sort((a, b) => a.file.localeCompare(b.file));
  writeJsonAtomic(options.tombstonePath, ledger);
}

async function assertRemoteIdentity(remote, entry, label) {
  const expected = { ...entry.source, file: entry.file };
  const actual = await remote.getArchiveIdentity(expected);
  if (!actual || Number(actual.size) !== Number(entry.source.size) ||
      actual.archiveSha256 !== entry.source.archiveSha256) {
    throw new Error(`${label} illegal archive changed or is missing: ${entry.source.repo}/${entry.file}`);
  }
  return actual;
}

function removeFromSbi(filePath, packId) {
  if (!filePath || !fs.existsSync(filePath)) return;
  const value = readJson(filePath, {});
  if (value && value.packs && typeof value.packs === 'object' && !Array.isArray(value.packs)) delete value.packs[packId];
  else if (value && typeof value === 'object') delete value[packId];
  writeJsonAtomic(filePath, value);
}

function assertNoLocalReferences(entry, options) {
  const registry = readJson(options.registryPath, {});
  const contentIndex = readJson(options.contentIndexPath, { packs: {} });
  const siteIndex = readJson(options.siteIndexPath, { items: [] });
  const lists = readJson(options.listsPath, []);
  const extracted = readJson(options.extractedPath, []);
  if (registry[entry.file] || (contentIndex.packs || {})[entry.file] ||
      (siteIndex.items || []).some(row => row.name === entry.packId) ||
      lists.some(list => (list.packs || []).includes(entry.packId)) ||
      extracted.some(row => row.packId === entry.packId || `${row.originalName}.zip` === entry.file)) {
    throw new Error(`Local catalog still references illegal material: ${entry.file}`);
  }
}

async function prepareSite(state, options, services) {
  const retiring = state.entries.filter(entry => entry.status === 'planned');
  if (!retiring.length) {
    for (const entry of state.entries) {
      if (entry.status !== 'deferred') assertNoLocalReferences(entry, options);
    }
    upsertTombstones(options, state);
    return;
  }
  const registry = readJson(options.registryPath, {});
  if (computeRegistryDigest(registry) !== state.manifestRegistryDigest) {
    throw new Error('Reviewed illegal retirement manifest is stale for the current registry');
  }
  const contentIndex = validateContentIndex(
    readJson(options.contentIndexPath, null),
    registry,
    FINGERPRINT_SCHEMA_VERSION
  );
  const siteIndex = readJson(options.siteIndexPath, { items: [] });
  const lists = readJson(options.listsPath, []);
  const extracted = readJson(options.extractedPath, []);
  for (const entry of retiring) {
    const current = registry[entry.file];
    if (!current || current.repo !== entry.source.repo ||
        Number(current.repoNum) !== Number(entry.source.repoNum) ||
        Number(current.size) !== Number(entry.source.registrySize)) {
      throw new Error(`Registry changed before illegal retirement: ${entry.file}`);
    }
    await assertRemoteIdentity(services.remote, entry, 'Source');
  }
  const retiringFiles = new Set(retiring.map(entry => entry.file));
  const retiringIds = new Set(retiring.map(entry => entry.packId));
  for (const entry of retiring) {
    delete registry[entry.file];
    delete contentIndex.packs[entry.file];
    safeRemoveChild(options.thumbnailsRoot, entry.packId);
    safeRemoveChild(options.packDataRoot, entry.packId, '.json');
    safeRemoveChild(options.packPageRoot, entry.packId);
    removeFromSbi(options.sbiPath, entry.packId);
    advance(entry, 'site_prepared');
  }
  siteIndex.items = (siteIndex.items || []).filter(row => !retiringIds.has(row.name));
  for (const list of lists) list.packs = (list.packs || []).filter(packId => !retiringIds.has(packId));
  const nextExtracted = extracted.filter(row =>
    !retiringIds.has(row.packId) && !retiringFiles.has(`${row.originalName}.zip`)
  );
  refreshContentIndexMetadata(contentIndex, registry);
  writeJsonAtomic(options.registryPath, registry);
  writeJsonAtomic(options.contentIndexPath, contentIndex);
  writeJsonAtomic(options.siteIndexPath, siteIndex);
  writeJsonAtomic(options.listsPath, lists);
  writeJsonAtomic(options.extractedPath, nextExtracted);
  writeState(options, state);
  upsertTombstones(options, state);
}

async function verifyDeployment(state, options, services) {
  if (typeof services.verifyDeployment !== 'function') throw new Error('Deployment verification service is required');
  for (const entry of state.entries) {
    if (entry.status === 'deferred' || statusIndex(entry.status) >= statusIndex('deployed_verified')) continue;
    if (entry.status !== 'site_prepared') throw new Error(`Prepare illegal retirement before deployment verification: ${entry.file}`);
    assertNoLocalReferences(entry, options);
    if (!await services.verifyDeployment(entry)) throw new Error(`Illegal retirement deployment verification failed: ${entry.file}`);
    advance(entry, 'deployed_verified');
  }
  writeState(options, state);
  upsertTombstones(options, state);
}

async function cleanup(state, options, services) {
  for (const entry of state.entries) {
    if (entry.status === 'deferred' || entry.status === 'complete') continue;
    if (entry.status !== 'deployed_verified' && entry.status !== 'remote_deleted') {
      throw new Error(`Verify deployment before illegal remote cleanup: ${entry.file}`);
    }
    assertNoLocalReferences(entry, options);
    const identity = await services.remote.getArchiveIdentity({ ...entry.source, file: entry.file });
    if (entry.status !== 'remote_deleted' && identity) {
      if (Number(identity.size) !== Number(entry.source.size) ||
          identity.archiveSha256 !== entry.source.archiveSha256) {
        throw new Error(`Illegal remote archive changed before cleanup: ${entry.file}`);
      }
      await services.remote.deleteArchive({ ...entry.source, file: entry.file });
      const remaining = await services.remote.getArchiveIdentity({ ...entry.source, file: entry.file });
      if (remaining) throw new Error(`Illegal remote archive remains after cleanup: ${entry.file}`);
    }
    advance(entry, 'remote_deleted');
    writeState(options, state);
    upsertTombstones(options, state);
    advance(entry, 'complete');
    writeState(options, state);
    upsertTombstones(options, state);
  }
}

async function runIllegalRetirement(options, services = {}) {
  const manifest = options.manifest || readJson(options.manifestPath, null);
  assertManifest(manifest);
  if (!services.remote || typeof services.remote.getArchiveIdentity !== 'function') {
    throw new Error('Illegal retirement requires a remote adapter');
  }
  const state = loadState(manifest, options);
  if (options.phase === 'prepare-site') await prepareSite(state, options, services);
  else if (options.phase === 'verify-deployment') await verifyDeployment(state, options, services);
  else if (options.phase === 'cleanup') await cleanup(state, options, services);
  else throw new Error(`Unknown illegal retirement phase: ${options.phase}`);
  writeState(options, state);
  return state;
}

module.exports = {
  STATUS_ORDER,
  advance,
  runIllegalRetirement,
};
