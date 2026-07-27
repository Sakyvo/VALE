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
const { getPackIdFromZipName } = require('./pack-utils');

const GITHUB_FILE_LIMIT = 100 * 1024 * 1024;
const STATUS_ORDER = [
  'planned',
  'staged_verified',
  'site_prepared',
  'deployed_verified',
  'old_deleted',
  'complete',
];
const MANAGED_LISTS = new Set(['Overlay', 'Conquest']);

function statusIndex(status) {
  return STATUS_ORDER.indexOf(status);
}

function advance(entry, status) {
  if (entry.status === 'deferred' || entry.status === status) return;
  if (statusIndex(status) < statusIndex(entry.status)) {
    throw new Error(`Refusing non-monotonic collection migration transition ${entry.status} -> ${status}`);
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

function writeState(options, state) {
  writeJsonAtomic(options.statePath, state);
}

function safeRemoveChild(root, name, suffix = '') {
  if (!root || !name) return;
  const rootPath = path.resolve(root) + path.sep;
  const target = path.resolve(root, `${name}${suffix}`);
  if (!target.startsWith(rootPath)) throw new Error(`Refusing to remove path outside root: ${target}`);
  fs.rmSync(target, { recursive: true, force: true });
}

function captureSiteSnapshot(manifestEntry, options) {
  const siteIndex = readJson(options.siteIndexPath, { items: [] });
  const lists = readJson(options.listsPath, []);
  const packId = manifestEntry.visibility.packId;
  return {
    packId,
    public: Boolean(manifestEntry.visibility.public),
    registryOnly: Boolean(manifestEntry.visibility.registryOnly),
    lists: lists.filter(list => (list.packs || []).includes(packId)).map(list => list.name).sort(),
    item: (siteIndex.items || []).find(row => row.name === packId) || null,
    extracted: readJson(options.extractedPath, []).find(row =>
      row.packId === packId || `${row.originalName}.zip` === manifestEntry.file
    ) || null,
  };
}

function initializeState(manifest, options) {
  const entries = manifest.entries
    .filter(entry => entry.normalization.classification === 'repairable' && entry.normalization.collection)
    .map(entry => {
      const deferred = entry.decision && entry.decision.action === 'defer';
      return {
        file: entry.file,
        packId: entry.visibility.packId,
        status: deferred ? 'deferred' : 'planned',
        deferReason: deferred ? (entry.decision.reason || 'reviewed_defer') : null,
        old: {
          repo: entry.source.repo,
          repoNum: Number(entry.source.repoNum),
          size: Number(entry.source.registrySize || entry.source.size),
          archiveSha256: entry.source.archiveSha256,
        },
        plannedProducts: entry.normalization.products.map(product => ({ ...product })),
        products: [],
        visibility: { ...entry.visibility },
        siteSnapshot: captureSiteSnapshot(entry, options),
        lifecycle: { planned: new Date().toISOString() },
        orphans: [],
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
    throw new Error('Collection migration state does not match the reviewed manifest');
  }
  return state;
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

function productDecision(manifestEntry, planned) {
  const decision = manifestEntry.decision || null;
  if (!decision) return null;
  const candidates = [
    ...(Array.isArray(decision.products) ? decision.products : []),
    ...(Array.isArray(decision.overrides) ? decision.overrides : []),
    ...(Array.isArray(decision.nameOverrides) ? decision.nameOverrides : []),
  ];
  const candidate = candidates.find(row =>
    row.file === planned.file || row.productFile === planned.file ||
    row.normalizedFile === planned.normalizedFile ||
    row.visualContentHash === planned.visualContentHash
  );
  if (candidate) return { ...decision, ...candidate, action: candidate.action || decision.action };
  return candidates.length ? null : decision;
}

function targetName(planned, decision) {
  const value = decision && (decision.to || decision.targetFile || decision.retainedFile);
  if (!value || decision.action !== 'name_override') return planned.file;
  return String(value).endsWith('.zip') ? String(value) : `${value}.zip`;
}

function packIdFromFile(file) {
  return getPackIdFromZipName(file);
}

function findExistingContent(contentIndex, product, parentFile) {
  return Object.entries((contentIndex && contentIndex.packs) || {})
    .filter(([file, row]) => file !== parentFile && row && row.visualContentHash === product.visualContentHash)
    .map(([file, row]) => ({ file, ...row }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

function findProduct(normalized, planned) {
  return normalized.products.find(product =>
    product.archiveSha256 === planned.archiveSha256 ||
    path.basename(product.path) === planned.normalizedFile ||
    product.name === planned.name
  );
}

function assertDecisionBound(decision, planned) {
  if (!decision || !['name_override', 'keep_existing', 'keep_incoming'].includes(decision.action)) return;
  if (decision.archiveSha256 !== planned.archiveSha256 ||
      decision.visualContentHash !== planned.visualContentHash) {
    throw new Error(`Reviewed collection decision is not hash-bound to ${planned.file}`);
  }
}

function findIdentityCollision(registry, contentIndex, file, packId, parentFile) {
  const fileKey = Object.keys(registry).find(existing =>
    existing !== parentFile && existing.toLowerCase() === file.toLowerCase()
  );
  if (fileKey) return { type: 'filename', file: fileKey };
  const packMatch = Object.entries((contentIndex && contentIndex.packs) || {}).find(([existingFile, row]) =>
    existingFile !== parentFile && row && row.packId && row.packId.toLowerCase() === packId.toLowerCase()
  );
  return packMatch ? { type: 'pack_id', file: packMatch[0], packId: packMatch[1].packId } : null;
}

function resolveTargetRepo(options, services, product, index, oldRepo) {
  let target;
  if (typeof services.allocateRepo === 'function') target = services.allocateRepo(product, index, options);
  else if (Array.isArray(options.targetRepos)) target = options.targetRepos[index] || options.targetRepos[options.targetRepos.length - 1];
  else target = options.targetRepo;
  if (!target || !target.repo || !target.repoNum) throw new Error('A capacity-eligible target repository is required for collection staging');
  if (target.repo === oldRepo) throw new Error(`Replacement must use a different repository than ${oldRepo}`);
  return { repo: target.repo, repoNum: Number(target.repoNum) };
}

function recordOrphan(entry, target, reason, state, options) {
  entry.orphans = entry.orphans || [];
  entry.orphans.push({ ...target, reason: reason.message || String(reason), recordedAt: new Date().toISOString() });
  writeState(options, state);
}

async function verifyStagedProduct(product, services) {
  await services.remote.verifyArchive(product);
  await assertRemoteIdentity(services.remote, product, 'Staged product');
}

async function stageEntry(entry, manifestEntry, options, services, state) {
  if (entry.status === 'deferred') return;
  if (statusIndex(entry.status) >= statusIndex('staged_verified')) {
    for (const product of entry.products) {
      await assertRemoteIdentity(services.remote, product, product.reused ? 'Reused product' : 'Staged product');
    }
    return;
  }
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
    const downloaded = { size: fs.statSync(sourcePath).size, archiveSha256: await sha256File(sourcePath) };
    if (downloaded.size !== entry.old.size || downloaded.archiveSha256 !== entry.old.archiveSha256) {
      throw new Error(`Downloaded collection source changed: ${entry.file}`);
    }
    const normalized = await normalizePack(sourcePath, { outputDir: path.join(work, 'normalized') });
    if (normalized.classification !== 'repairable' || normalized.products.length !== entry.plannedProducts.length) {
      throw new Error(`Reviewed collection no longer reproduces: ${entry.file}`);
    }
    const registry = readJson(options.registryPath, {});
    const contentIndex = validateContentIndex(
      readJson(options.contentIndexPath, null),
      registry,
      FINGERPRINT_SCHEMA_VERSION
    );
    const staged = [];
    const candidates = [];
    for (let index = 0; index < entry.plannedProducts.length; index++) {
      const planned = entry.plannedProducts[index];
      const product = findProduct(normalized, planned);
      if (!product) throw new Error(`Normalized collection product is missing: ${planned.file}`);
      const fingerprint = await fingerprintPack(product.path);
      if (fingerprint.archiveSha256 !== planned.archiveSha256 ||
          fingerprint.visualContentHash !== planned.visualContentHash ||
          Number(fs.statSync(product.path).size) !== Number(planned.size)) {
        throw new Error(`Normalized collection product evidence changed: ${planned.file}`);
      }
      if (fs.statSync(product.path).size > (options.githubFileLimit || GITHUB_FILE_LIMIT)) {
        entry.status = 'deferred';
        entry.deferReason = 'product_oversize';
        writeState(options, state);
        return;
      }
      const decision = productDecision(manifestEntry, planned);
      assertDecisionBound(decision, planned);
      if (decision && decision.action === 'defer') {
        entry.status = 'deferred';
        entry.deferReason = decision.reason || 'reviewed_defer';
        writeState(options, state);
        return;
      }
      const matches = findExistingContent(contentIndex, planned, entry.file);
      const retainedFile = decision && decision.action === 'keep_existing'
        ? decision.retainedFile
        : decision && decision.action === 'keep_incoming'
          ? null
          : matches[0] && matches[0].file;
      if (retainedFile) {
        const retained = matches.find(match => match.file === retainedFile);
        if (!retained) throw new Error(`Reviewed retained product is not an exact match: ${retainedFile}`);
        candidates.push({
          file: retained.file,
          packId: retained.packId || packIdFromFile(retained.file),
          repo: retained.repo,
          repoNum: Number(retained.repoNum),
          size: Number(retained.size),
          archiveSha256: retained.archiveSha256,
          visualContentHash: retained.visualContentHash,
          visualEntryCount: retained.visualEntryCount,
          swords: retained.swords,
          reused: true,
          sourceProductFile: planned.file,
        });
        continue;
      }
      const file = targetName(planned, decision);
      const packId = packIdFromFile(file);
      const collision = findIdentityCollision(registry, contentIndex, file, packId, entry.file);
      if (collision) {
        throw new Error(`Collection product published identity conflict for ${file}: ${collision.file}`);
      }
      const targetRepo = resolveTargetRepo(options, services, { ...planned, file, packId }, index, entry.old.repo);
      candidates.push({
        ...targetRepo,
        file,
        packId,
        size: fs.statSync(product.path).size,
        archiveSha256: fingerprint.archiveSha256,
        visualContentHash: fingerprint.visualContentHash,
        visualEntryCount: fingerprint.visualEntryCount,
        swords: fingerprint.swords,
        sourceProductFile: planned.file,
        path: product.path,
      });
    }
    for (const candidate of candidates) {
      if (candidate.reused) {
        await assertRemoteIdentity(services.remote, candidate, 'Reused product');
        staged.push(candidate);
        continue;
      }
      const { path: productPath, ...target } = candidate;
      const existingTarget = await services.remote.getArchiveIdentity(target);
      if (existingTarget) {
        if (Number(existingTarget.size) !== target.size || existingTarget.archiveSha256 !== target.archiveSha256) {
          recordOrphan(entry, target, new Error(`Unproven staged artifact already exists: ${target.repo}/${target.file}`), state, options);
          throw new Error(`Unproven staged artifact already exists: ${target.repo}/${target.file}`);
        }
      } else {
        await services.remote.publishArchive({ ...target, path: productPath });
      }
      try {
        await verifyStagedProduct(target, services);
      } catch (error) {
        recordOrphan(entry, target, error, state, options);
        throw error;
      }
      staged.push(target);
    }
    entry.products = staged;
    advance(entry, 'staged_verified');
    writeState(options, state);
  } finally {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function assertVisibilityUnchanged(entry, options) {
  const siteIndex = readJson(options.siteIndexPath, { items: [] });
  const lists = readJson(options.listsPath, []);
  const item = (siteIndex.items || []).find(row => row.name === entry.packId) || null;
  const listNames = lists.filter(list => (list.packs || []).includes(entry.packId)).map(list => list.name).sort();
  if (JSON.stringify(item) !== JSON.stringify(entry.siteSnapshot.item) ||
      JSON.stringify(listNames) !== JSON.stringify(entry.siteSnapshot.lists)) {
    throw new Error(`Collection visibility changed before migration: ${entry.file}`);
  }
}

function productExtraction(product, entry, options, services) {
  if (typeof services.extractProduct === 'function') {
    return services.extractProduct(product, { entry, options });
  }
  const base = entry.siteSnapshot.extracted ? { ...entry.siteSnapshot.extracted } : {};
  delete base.originalName;
  delete base.packId;
  return { ...base, originalName: path.basename(product.file, '.zip'), packId: product.packId };
}

function insertProductsAtParent(list, parentId, productIds) {
  const out = [];
  let inserted = false;
  for (const id of list || []) {
    if (id === parentId) {
      if (!inserted) out.push(...productIds);
      inserted = true;
    } else if (!out.includes(id)) out.push(id);
  }
  return inserted ? out : out;
}

function removeParentFromSbi(filePath, parentId, productIds, services) {
  if (!filePath || !fs.existsSync(filePath)) return;
  const sbi = readJson(filePath, {});
  if (typeof services.updateSbi === 'function') {
    const next = services.updateSbi(sbi, { parentId, productIds });
    writeJsonAtomic(filePath, next);
    return;
  }
  if (sbi && typeof sbi === 'object' && sbi.packs && !Array.isArray(sbi.packs)) delete sbi.packs[parentId];
  else if (sbi && typeof sbi === 'object') delete sbi[parentId];
  writeJsonAtomic(filePath, sbi);
}

function prepareSiteEntry(entry, manifestEntry, options, services, state) {
  if (entry.status === 'deferred' || statusIndex(entry.status) >= statusIndex('site_prepared')) return;
  if (entry.status !== 'staged_verified') throw new Error(`Stage collection ${entry.file} before site preparation`);
  assertVisibilityUnchanged(entry, options);
  return (async () => {
    for (const product of entry.products) {
      await assertRemoteIdentity(services.remote, product, product.reused ? 'Reused product' : 'Staged product');
    }
    const registry = readJson(options.registryPath, {});
    const contentIndex = validateContentIndex(
      readJson(options.contentIndexPath, null),
      registry,
      FINGERPRINT_SCHEMA_VERSION
    );
    const current = registry[entry.file];
    if (!current || current.repo !== entry.old.repo || Number(current.size) !== Number(entry.old.size)) {
      throw new Error(`Registry changed before collection site preparation: ${entry.file}`);
    }
    const lists = readJson(options.listsPath, []);
    const extracted = readJson(options.extractedPath, []);
    const siteIndex = readJson(options.siteIndexPath, { items: [] });
    const parentItem = entry.siteSnapshot.item;
    const productIds = entry.products.map(product => product.packId);
    const productFiles = new Set(entry.products.map(product => product.file));

    delete registry[entry.file];
    delete contentIndex.packs[entry.file];
    for (const product of entry.products) {
      if (!product.reused) {
        registry[product.file] = { repo: product.repo, repoNum: product.repoNum, size: product.size };
        contentIndex.packs[product.file] = {
          packId: product.packId,
          repo: product.repo,
          repoNum: product.repoNum,
          size: product.size,
          sourceKey: sourceKey(product.file, product),
          archiveSha256: product.archiveSha256,
          visualContentHash: product.visualContentHash,
          visualEntryCount: product.visualEntryCount,
          swords: product.swords,
        };
      }
    }

    for (const list of lists) {
      const original = list.packs || [];
      if (MANAGED_LISTS.has(list.name)) {
        list.packs = original.filter(packId => packId !== entry.packId && !productFiles.has(`${packId}.zip`));
        const managed = typeof services.classifyManagedLists === 'function'
          ? entry.products.filter(product => services.classifyManagedLists(product).includes(list.name)).map(product => product.packId)
          : [];
        for (const id of managed) if (!list.packs.includes(id)) list.packs.push(id);
      } else {
        list.packs = insertProductsAtParent(original, entry.packId, productIds);
      }
      const seen = new Set();
      list.packs = list.packs.filter(id => !seen.has(id) && seen.add(id));
    }

    const parentRows = extracted.filter(row => row.packId === entry.packId || `${row.originalName}.zip` === entry.file);
    const keptExtracted = extracted.filter(row => !parentRows.includes(row));
    if (entry.visibility.public || (entry.siteSnapshot.extracted && !entry.visibility.registryOnly)) {
      for (const product of entry.products) keptExtracted.push(productExtraction(product, entry, options, services));
    }
    const nextExtracted = keptExtracted.filter((row, index, rows) =>
      rows.findIndex(other => other.packId === row.packId) === index
    );

    const existingItems = (siteIndex.items || []).filter(row => row.name !== entry.packId && !productIds.includes(row.name));
    if (entry.visibility.public && parentItem) {
      const parentIndex = (siteIndex.items || []).findIndex(row => row.name === entry.packId);
      const children = entry.products.map(product => ({
        ...parentItem,
        name: product.packId,
        id: product.packId,
        route: `/p/${encodeURIComponent(product.packId)}/`,
      }));
      const insertion = parentIndex < 0 ? existingItems.length : Math.min(parentIndex, existingItems.length);
      existingItems.splice(insertion, 0, ...children);
    }
    siteIndex.items = existingItems;

    safeRemoveChild(options.thumbnailsRoot, entry.packId);
    safeRemoveChild(options.packDataRoot, entry.packId, '.json');
    safeRemoveChild(options.packPageRoot, entry.packId);
    removeParentFromSbi(options.sbiPath, entry.packId, productIds, services);
    refreshContentIndexMetadata(contentIndex, registry);
    writeJsonAtomic(options.registryPath, registry);
    writeJsonAtomic(options.contentIndexPath, contentIndex);
    writeJsonAtomic(options.listsPath, lists);
    writeJsonAtomic(options.extractedPath, nextExtracted);
    writeJsonAtomic(options.siteIndexPath, siteIndex);
    advance(entry, 'site_prepared');
    writeState(options, state);
    return state;
  })();
}

async function verifyDeployment(state, options, services) {
  if (typeof services.verifyDeployment !== 'function') throw new Error('Deployment verification service is required');
  for (const entry of state.entries) {
    if (entry.status === 'deferred' || statusIndex(entry.status) >= statusIndex('deployed_verified')) continue;
    if (entry.status !== 'site_prepared') throw new Error(`Prepare collection ${entry.file} before deployment verification`);
    for (const product of entry.products) {
      await assertRemoteIdentity(services.remote, product, product.reused ? 'Reused product' : 'Staged product');
    }
    if (!await services.verifyDeployment(entry)) throw new Error(`Collection deployment verification failed: ${entry.file}`);
    advance(entry, 'deployed_verified');
  }
  writeState(options, state);
}

async function cleanup(state, options, services) {
  for (const entry of state.entries) {
    if (entry.status === 'deferred' || entry.status === 'complete') continue;
    if (entry.status !== 'deployed_verified' && entry.status !== 'old_deleted') {
      throw new Error(`Verify collection deployment before old archive cleanup: ${entry.file}`);
    }
    for (const product of entry.products) {
      await assertRemoteIdentity(services.remote, product, product.reused ? 'Reused product' : 'Retained product');
    }
    const old = await services.remote.getArchiveIdentity({ ...entry.old, file: entry.file });
    if (entry.status === 'old_deleted' || !old) {
      advance(entry, 'old_deleted');
      advance(entry, 'complete');
      writeState(options, state);
      continue;
    }
    if (Number(old.size) !== Number(entry.old.size) || old.archiveSha256 !== entry.old.archiveSha256) {
      throw new Error(`Parent collection archive changed before cleanup: ${entry.file}`);
    }
    await services.remote.deleteArchive({ ...entry.old, file: entry.file });
    const gone = await services.remote.getArchiveIdentity({ ...entry.old, file: entry.file });
    if (gone) throw new Error(`Parent collection archive remains after cleanup: ${entry.file}`);
    advance(entry, 'old_deleted');
    writeState(options, state);
    advance(entry, 'complete');
    writeState(options, state);
  }
}

async function runCollectionMigration(options, services = {}) {
  const manifest = options.manifest || readJson(options.manifestPath, null);
  assertManifest(manifest);
  if (!services.remote || typeof services.remote.getArchiveIdentity !== 'function') {
    throw new Error('Collection migration requires a remote adapter');
  }
  const resolved = {
    githubFileLimit: GITHUB_FILE_LIMIT,
    workdir: path.join(os.tmpdir(), 'vale-pack-collection-migration'),
    ...options,
  };
  const state = loadState(manifest, resolved);
  if (resolved.phase === 'stage') {
    const registry = readJson(resolved.registryPath, {});
    if (computeRegistryDigest(registry) !== manifest.registryDigest) {
      throw new Error('Reviewed collection manifest is stale for the current registry');
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
    for (const entry of state.entries) {
      const manifestEntry = manifest.entries.find(row => row.file === entry.file);
      await prepareSiteEntry(entry, manifestEntry, resolved, services, state);
    }
  } else if (resolved.phase === 'verify-deployment') {
    await verifyDeployment(state, resolved, services);
  } else if (resolved.phase === 'cleanup') {
    await cleanup(state, resolved, services);
  } else {
    throw new Error(`Unknown collection migration phase: ${resolved.phase}`);
  }
  writeState(resolved, state);
  return { ...state, entries: state.entries };
}

module.exports = {
  STATUS_ORDER,
  advance,
  runCollectionMigration,
};
