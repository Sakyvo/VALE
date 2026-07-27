const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  computeRegistryDigest,
  readJson,
  refreshContentIndexMetadata,
  sourceKey,
  validateContentIndex,
  writeJsonAtomic,
} = require('./lib/pack-content-index');
const { SCHEMA_VERSION: FINGERPRINT_SCHEMA_VERSION, fingerprintPack } = require('./lib/pack-content-fingerprint');
const { NORMALIZATION_SCHEMA_VERSION, normalizePack, sha256File } = require('./lib/pack-normalizer');

const GITHUB_FILE_LIMIT = 100 * 1024 * 1024;
const STATUS_ORDER = [
  'planned',
  'staged_verified',
  'site_prepared',
  'deployed_verified',
  'old_deleted',
  'complete',
];

function statusIndex(status) {
  return STATUS_ORDER.indexOf(status);
}

function advance(entry, status) {
  if (statusIndex(status) < statusIndex(entry.status)) {
    throw new Error(`Refusing non-monotonic migration transition ${entry.status} -> ${status}`);
  }
  if (entry.status === status) return;
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

function captureSiteSnapshot(manifestEntry, options) {
  const siteIndex = readJson(options.siteIndexPath, { items: [] });
  const lists = readJson(options.listsPath, []);
  const item = (siteIndex.items || []).find(row => row.name === manifestEntry.visibility.packId) || null;
  return {
    packId: manifestEntry.visibility.packId,
    public: manifestEntry.visibility.public,
    registryOnly: manifestEntry.visibility.registryOnly,
    lists: lists.filter(list => (list.packs || []).includes(manifestEntry.visibility.packId)).map(list => list.name).sort(),
    item,
  };
}

function initializeState(manifest, options) {
  const entries = manifest.entries
    .filter(entry => entry.normalization.classification === 'repairable' &&
      entry.normalization.products.length === 1 && !entry.normalization.collection)
    .map(entry => {
      const deferred = entry.decision && entry.decision.action === 'defer';
      const oversize = entry.blockers.some(blocker => blocker.code === 'blocked_oversize');
      return {
      file: entry.file,
      packId: entry.visibility.packId,
      status: deferred || oversize ? 'deferred' : 'planned',
      deferReason: deferred ? entry.decision.reason || 'reviewed_defer' : oversize ? 'online_oversize' : null,
      old: {
        repo: entry.source.repo,
        repoNum: entry.source.repoNum,
        size: entry.source.size,
        archiveSha256: entry.source.archiveSha256,
      },
      plannedProduct: entry.normalization.products[0],
      target: null,
      visibility: entry.visibility,
      siteSnapshot: captureSiteSnapshot(entry, options),
      lifecycle: { planned: new Date().toISOString() },
      orphans: [],
      reviewedArtifactDigest: manifest.reviewedArtifactDigest || null,
      };
    });
  return {
    schemaVersion: 1,
    normalizationSchemaVersion: NORMALIZATION_SCHEMA_VERSION,
    manifestEvidenceDigest: manifest.evidenceDigest,
    manifestRegistryDigest: manifest.registryDigest,
    reviewedArtifactDigest: manifest.reviewedArtifactDigest || null,
    entries,
  };
}

function loadState(manifest, options) {
  if (!fs.existsSync(options.statePath)) return initializeState(manifest, options);
  const state = readJson(options.statePath, null);
  if (!state || state.schemaVersion !== 1 || !Array.isArray(state.entries) ||
      state.normalizationSchemaVersion !== NORMALIZATION_SCHEMA_VERSION ||
      state.manifestEvidenceDigest !== manifest.evidenceDigest ||
      state.manifestRegistryDigest !== manifest.registryDigest ||
      (manifest.reviewedArtifactDigest && state.reviewedArtifactDigest !== manifest.reviewedArtifactDigest)) {
    throw new Error('Migration state does not match the reviewed manifest');
  }
  return state;
}

function writeState(options, state) {
  writeJsonAtomic(options.statePath, state);
}

async function assertRemoteIdentity(remote, expected, label) {
  const actual = await remote.getArchiveIdentity(expected);
  if (!actual || Number(actual.size) !== Number(expected.size) ||
      actual.archiveSha256 !== expected.archiveSha256) {
    throw new Error(`${label} remote archive changed or is missing: ${expected.repo}/${expected.file}`);
  }
  return actual;
}

function ensureWorkdir(workdir) {
  if (fs.existsSync(workdir)) throw new Error(`Migration workspace already exists: ${workdir}`);
  fs.mkdirSync(workdir, { recursive: true });
}

async function stageEntry(entry, manifestEntry, options, services, state) {
  if (entry.status === 'deferred' || statusIndex(entry.status) >= statusIndex('staged_verified')) {
    if (entry.target) await assertRemoteIdentity(services.remote, entry.target, 'Staged');
    return;
  }
  const targetRepo = typeof services.allocateRepo === 'function'
    ? services.allocateRepo(entry, manifestEntry, options)
    : options.targetRepo;
  if (!targetRepo || !targetRepo.repo || !targetRepo.repoNum) throw new Error('A capacity-eligible targetRepo is required for staging');
  if (targetRepo.repo === entry.old.repo) throw new Error(`Replacement for ${entry.file} must use a different repository`);
  const work = fs.mkdtempSync(path.join(options.workdir, 'entry-'));
  try {
    await assertRemoteIdentity(services.remote, { ...entry.old, file: entry.file }, 'Source');
    const sourcePath = path.join(work, 'source.zip');
    await services.remote.downloadArchive({
      repo: entry.old.repo,
      file: entry.file,
      registryEntry: entry.old,
      destination: sourcePath,
    });
    const downloaded = {
      size: fs.statSync(sourcePath).size,
      archiveSha256: await sha256File(sourcePath),
    };
    if (downloaded.size !== Number(entry.old.size) || downloaded.archiveSha256 !== entry.old.archiveSha256) {
      throw new Error(`Downloaded source archive changed: ${entry.file}`);
    }
    const normalized = await normalizePack(sourcePath, { outputDir: path.join(work, 'normalized') });
    if (normalized.classification !== 'repairable' || normalized.products.length !== 1 ||
        normalized.products[0].classification !== 'normal') {
      throw new Error(`Reviewed one-product repair no longer reproduces: ${entry.file}`);
    }
    const product = normalized.products[0];
    const fingerprint = await fingerprintPack(product.path);
    if (fingerprint.archiveSha256 !== entry.plannedProduct.archiveSha256 ||
        fingerprint.visualContentHash !== entry.plannedProduct.visualContentHash) {
      throw new Error(`Normalized product evidence changed: ${entry.file}`);
    }
    const size = fs.statSync(product.path).size;
    if (Number(entry.plannedProduct.size) !== size) {
      throw new Error(`Normalized product size evidence changed: ${entry.file}`);
    }
    if (size > (options.githubFileLimit || GITHUB_FILE_LIMIT)) {
      entry.status = 'deferred';
      entry.deferReason = 'online_oversize';
      writeState(options, state);
      return;
    }
    const target = {
      repo: targetRepo.repo,
      repoNum: Number(targetRepo.repoNum),
      file: entry.file,
      size,
      archiveSha256: fingerprint.archiveSha256,
      visualContentHash: fingerprint.visualContentHash,
      visualEntryCount: fingerprint.visualEntryCount,
      swords: fingerprint.swords,
    };
    const existingTarget = await services.remote.getArchiveIdentity(target);
    if (existingTarget) {
      if (Number(existingTarget.size) !== size || existingTarget.archiveSha256 !== target.archiveSha256) {
        entry.orphans.push({ ...target, reason: 'unproven_existing_target', recordedAt: new Date().toISOString() });
        writeState(options, state);
        throw new Error(`Unproven staged artifact already exists: ${target.repo}/${target.file}`);
      }
    } else {
      await services.remote.publishArchive({ ...target, path: product.path });
    }
    try {
      await services.remote.verifyArchive(target);
      await assertRemoteIdentity(services.remote, target, 'Staged');
    } catch (error) {
      entry.orphans.push({ ...target, reason: error.message, recordedAt: new Date().toISOString() });
      writeState(options, state);
      throw error;
    }
    entry.target = target;
    advance(entry, 'staged_verified');
    writeState(options, state);
  } finally {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function assertVisibilityUnchanged(entry, options) {
  const siteIndex = readJson(options.siteIndexPath, { items: [] });
  const lists = readJson(options.listsPath, []);
  const currentItem = (siteIndex.items || []).find(row => row.name === entry.packId) || null;
  assertSameJson(currentItem, entry.siteSnapshot.item, `Public identity changed before migration: ${entry.packId}`);
  const currentLists = lists.filter(list => (list.packs || []).includes(entry.packId)).map(list => list.name).sort();
  assertSameJson(currentLists, entry.siteSnapshot.lists, `List membership changed before migration: ${entry.packId}`);
}

function assertSameJson(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message);
}

async function prepareSite(state, options, services) {
  const registry = readJson(options.registryPath, {});
  const contentIndex = validateContentIndex(
    readJson(options.contentIndexPath, null),
    registry,
    FINGERPRINT_SCHEMA_VERSION
  );
  for (const entry of state.entries) {
    if (entry.status === 'deferred' || statusIndex(entry.status) >= statusIndex('site_prepared')) continue;
    if (entry.status !== 'staged_verified') throw new Error(`Stage ${entry.file} before site preparation`);
    assertVisibilityUnchanged(entry, options);
    await assertRemoteIdentity(services.remote, entry.target, 'Staged');
    const current = registry[entry.file];
    if (!current || current.repo !== entry.old.repo || Number(current.size) !== Number(entry.old.size)) {
      throw new Error(`Registry changed before site preparation: ${entry.file}`);
    }
    registry[entry.file] = {
      repo: entry.target.repo,
      repoNum: entry.target.repoNum,
      size: entry.target.size,
    };
    contentIndex.packs[entry.file] = {
      ...(contentIndex.packs[entry.file] || {}),
      packId: entry.packId,
      repo: entry.target.repo,
      repoNum: entry.target.repoNum,
      size: entry.target.size,
      archiveSha256: entry.target.archiveSha256,
      visualContentHash: entry.target.visualContentHash,
      visualEntryCount: entry.target.visualEntryCount,
      swords: entry.target.swords,
    };
    contentIndex.packs[entry.file].sourceKey = sourceKey(entry.file, registry[entry.file]);
    advance(entry, 'site_prepared');
  }
  refreshContentIndexMetadata(contentIndex, registry);
  writeJsonAtomic(options.registryPath, registry);
  writeJsonAtomic(options.contentIndexPath, contentIndex);
  writeState(options, state);
}

async function verifyDeployment(state, options, services) {
  if (typeof services.verifyDeployment !== 'function') throw new Error('Deployment verification service is required');
  for (const entry of state.entries) {
    if (entry.status === 'deferred' || statusIndex(entry.status) >= statusIndex('deployed_verified')) continue;
    if (entry.status !== 'site_prepared') throw new Error(`Prepare site state before deployment verification: ${entry.file}`);
    await assertRemoteIdentity(services.remote, entry.target, 'Staged');
    if (!await services.verifyDeployment(entry)) throw new Error(`Deployment verification failed: ${entry.file}`);
    advance(entry, 'deployed_verified');
  }
  writeState(options, state);
}

async function cleanup(state, options, services) {
  for (const entry of state.entries) {
    if (entry.status === 'deferred' || entry.status === 'complete') continue;
    if (entry.status !== 'deployed_verified' && entry.status !== 'old_deleted') {
      throw new Error(`Verify deployment before old archive cleanup: ${entry.file}`);
    }
    await assertRemoteIdentity(services.remote, entry.target, 'Staged');
    const oldIdentity = await services.remote.getArchiveIdentity({ ...entry.old, file: entry.file });
    if (entry.status === 'old_deleted' || !oldIdentity) {
      advance(entry, 'old_deleted');
      advance(entry, 'complete');
      writeState(options, state);
      continue;
    }
    if (Number(oldIdentity.size) !== Number(entry.old.size) || oldIdentity.archiveSha256 !== entry.old.archiveSha256) {
      throw new Error(`Source remote archive changed before cleanup: ${entry.file}`);
    }
    await services.remote.deleteArchive({ ...entry.old, file: entry.file });
    const remaining = await services.remote.getArchiveIdentity({ ...entry.old, file: entry.file });
    if (remaining) throw new Error(`Old archive remains after cleanup: ${entry.file}`);
    advance(entry, 'old_deleted');
    writeState(options, state);
    advance(entry, 'complete');
    writeState(options, state);
  }
}

async function runMigration(options, services = {}) {
  const manifest = options.manifest || readJson(options.manifestPath, null);
  assertManifest(manifest);
  const unresolved = manifest.entries.filter(entry =>
    entry.normalization.classification === 'repairable' &&
    entry.normalization.products.length === 1 &&
    entry.reviewRequired &&
    !entry.blockers.some(blocker => blocker.code === 'blocked_oversize') &&
    (!entry.decision || entry.decision.action !== 'defer')
  );
  if (unresolved.length) {
    throw new Error(`Reviewed manifest has unresolved migration blockers: ${unresolved.map(entry => entry.file).join(', ')}`);
  }
  if (!services.remote || typeof services.remote.getArchiveIdentity !== 'function') {
    throw new Error('Migration requires a remote adapter');
  }
  const resolved = {
    githubFileLimit: GITHUB_FILE_LIMIT,
    workdir: path.join(os.tmpdir(), 'vale-pack-normalization-migration'),
    ...options,
  };
  let state = loadState(manifest, resolved);
  if (resolved.phase === 'stage') {
    const registry = readJson(resolved.registryPath, {});
    if (computeRegistryDigest(registry) !== manifest.registryDigest) {
      throw new Error('Reviewed migration manifest is stale for the current registry');
    }
    ensureWorkdir(resolved.workdir);
    try {
      for (const entry of state.entries) {
        const manifestEntry = manifest.entries.find(row => row.file === entry.file);
        await stageEntry(entry, manifestEntry, resolved, services, state);
      }
    } finally {
      fs.rmSync(resolved.workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  } else if (resolved.phase === 'prepare-site') {
    await prepareSite(state, resolved, services);
  } else if (resolved.phase === 'verify-deployment') {
    await verifyDeployment(state, resolved, services);
  } else if (resolved.phase === 'cleanup') {
    await cleanup(state, resolved, services);
  } else {
    throw new Error(`Unknown migration phase: ${resolved.phase}`);
  }
  state = readJson(resolved.statePath, state);
  return state;
}

module.exports = {
  STATUS_ORDER,
  advance,
  runMigration,
};
