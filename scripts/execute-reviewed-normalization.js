const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  computeRegistryDigest,
  readJson,
  retryWindowsFileOperation,
  validateContentIndex,
  writeJsonAtomic,
} = require('./lib/pack-content-index');
const { SCHEMA_VERSION: FINGERPRINT_SCHEMA_VERSION, stableStringify } = require('./lib/pack-content-fingerprint');
const { NORMALIZATION_SCHEMA_VERSION } = require('./lib/pack-normalizer');
const { runMigration } = require('./migrate-pack-normalization');
const { runCollectionMigration } = require('./migrate-pack-collection');
const { runIllegalRetirement } = require('./retire-illegal-pack');
const { reconcileCatalog } = require('./run-normalization-dry-run');

const ROOT = path.join(__dirname, '..');
const DEFAULTS = {
  registryPath: path.join(ROOT, 'data', 'pack-registry.json'),
  manifestPath: path.join(ROOT, 'data', 'internal', 'pack-normalization-manifest.json'),
  reviewPath: path.join(ROOT, 'data', 'internal', 'pack-normalization-review.json'),
  contentIndexPath: path.join(ROOT, 'data', 'internal', 'pack-content-index.json'),
  siteIndexPath: path.join(ROOT, 'data', 'index.json'),
  listsPath: path.join(ROOT, 'l', 'lists.json'),
  extractedPath: path.join(ROOT, 'data', 'extracted.json'),
  statePath: path.join(ROOT, 'data', 'internal', 'pack-normalization-execution.json'),
  singleStatePath: path.join(ROOT, 'data', 'internal', 'pack-normalization-single-state.json'),
  collectionStatePath: path.join(ROOT, 'data', 'internal', 'pack-normalization-collection-state.json'),
  illegalStatePath: path.join(ROOT, 'data', 'internal', 'pack-normalization-illegal-state.json'),
  workdir: path.join(require('node:os').tmpdir(), 'vale-reviewed-normalization'),
};
const PHASE_STATES = {
  stage: ['reviewed', 'staged_verified'],
  'prepare-site': ['staged_verified', 'site_prepared'],
  'verify-deployment': ['site_prepared', 'deployed_verified'],
  cleanup: ['deployed_verified', 'complete'],
};

function digest(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function draftReviewPayload(review) {
  const payload = clone(review);
  delete payload.reviewDigest;
  delete payload.approvalDigest;
  payload.reviewed = false;
  for (const entry of payload.entries || []) entry.decision = null;
  for (const entry of payload.catalogReconciliation?.listReferences?.dangling || []) {
    entry.decision = null;
  }
  return payload;
}

function computeReviewDigest(review) {
  return digest(draftReviewPayload(review));
}

function computeApprovalDigest(review) {
  const payload = clone(review);
  delete payload.approvalDigest;
  return digest(payload);
}

function sameJson(actual, expected, label) {
  if (stableStringify(actual) !== stableStringify(expected)) {
    throw new Error(`Reviewed normalization ${label} mismatch`);
  }
}

function expectedAction(entry) {
  if (entry.blockers.length || entry.normalization.classification === 'blocked') return 'review_required';
  if (entry.normalization.classification === 'normal') return 'unchanged';
  if (entry.normalization.classification === 'illegal') return 'retire';
  if (entry.normalization.collection) return 'split';
  if (entry.normalization.classification === 'repairable') return 'migrate';
  return 'review_required';
}

function assertProductBinding(reviewEntry, manifestEntry) {
  const expected = manifestEntry.normalization.products.map(product => ({
    file: product.file,
    packId: product.packId,
    size: product.size,
    archiveSha256: product.archiveSha256,
    visualContentHash: product.visualContentHash,
  }));
  sameJson(reviewEntry.products, expected, `products for ${reviewEntry.file}`);
  if (!reviewEntry.products.length && expected.length) {
    throw new Error(`Reviewed normalization products missing for ${reviewEntry.file}`);
  }
}

function assertStoragePlan(reviewEntry, manifestEntry) {
  const assertTarget = (plan, label) => {
    const repoNum = Number(plan && plan.targetRepoNum);
    const expectedRepo = Number.isInteger(repoNum) && repoNum > 0
      ? `packs-${String(repoNum).padStart(3, '0')}`
      : null;
    if (!plan || plan.targetRepo !== expectedRepo) {
      throw new Error(`Reviewed normalization storage repository is invalid for ${label}`);
    }
  };
  if (reviewEntry.action === 'migrate') {
    const plan = reviewEntry.storagePlan;
    assertTarget(plan, reviewEntry.file);
    if (!plan || !plan.targetRepo || !Number.isInteger(Number(plan.targetRepoNum)) ||
        Number(plan.plannedBytes) !== Number(reviewEntry.products[0].size)) {
      throw new Error(`Reviewed normalization storage plan missing for ${reviewEntry.file}`);
    }
    if (plan.targetRepo === manifestEntry.source.repo) {
      throw new Error(`Reviewed normalization replacement reuses source repository for ${reviewEntry.file}`);
    }
    return;
  }
  if (reviewEntry.action !== 'split') return;
  const plans = reviewEntry.storagePlan && reviewEntry.storagePlan.products;
  if (!Array.isArray(plans) || plans.length !== reviewEntry.products.length) {
    throw new Error(`Reviewed collection storage plan missing for ${reviewEntry.file}`);
  }
  const seen = new Set();
  for (const product of reviewEntry.products) {
    const plan = plans.find(row => row.file === product.file && row.packId === product.packId);
    assertTarget(plan, `${reviewEntry.file}/${product.file}`);
    if (!plan || seen.has(plan.file) || Number(plan.size) !== Number(product.size) ||
        Number(plan.plannedBytes) !== Number(product.size) ||
        plan.archiveSha256 !== product.archiveSha256 ||
        plan.visualContentHash !== product.visualContentHash || plan.targetRepo === manifestEntry.source.repo) {
      throw new Error(`Reviewed collection storage plan is invalid for ${reviewEntry.file}`);
    }
    seen.add(plan.file);
  }
}

function assertDecision(entry, manifestEntry) {
  const decision = entry.decision;
  if (manifestEntry.normalization.classification === 'illegal' && entry.action === 'retire' && !decision) {
    return;
  }
  if (!manifestEntry.reviewRequired && !manifestEntry.blockers.length) {
    if (decision) throw new Error(`Unexpected reviewed decision for ${entry.file}`);
    return;
  }
  if (!decision || typeof decision !== 'object') {
    throw new Error(`Reviewed decision missing for ${entry.file}`);
  }
  if (!['defer', 'name_override', 'keep_existing', 'keep_incoming'].includes(decision.action)) {
    throw new Error(`Unknown reviewed decision for ${entry.file}`);
  }
  if (decision.action === 'defer' && !String(decision.reason || '').trim()) {
    throw new Error(`Reviewed defer reason missing for ${entry.file}`);
  }
  const products = manifestEntry.normalization.products;
  const candidates = [
    ...(Array.isArray(decision.products) ? decision.products : []),
    ...(Array.isArray(decision.overrides) ? decision.overrides : []),
    ...(Array.isArray(decision.nameOverrides) ? decision.nameOverrides : []),
  ];
  for (const candidate of candidates) {
    const planned = products.find(product =>
      product.file === candidate.file || product.file === candidate.productFile ||
      product.visualContentHash === candidate.visualContentHash
    );
    if (!planned || candidate.archiveSha256 !== planned.archiveSha256 ||
        candidate.visualContentHash !== planned.visualContentHash) {
      throw new Error(`Reviewed decision is not hash-bound for ${entry.file}`);
    }
  }
}

function assertCatalogDecisions(review, manifest) {
  const reconciliation = review.catalogReconciliation;
  if (!reconciliation || !reconciliation.listReferences ||
      !Array.isArray(reconciliation.listReferences.dangling) ||
      !Array.isArray(reconciliation.listReferences.duplicates)) {
    throw new Error('Reviewed catalog reconciliation is missing');
  }
  const knownPackIds = new Set();
  for (const entry of manifest.entries) {
    knownPackIds.add(entry.visibility.packId);
    for (const product of entry.normalization.products) knownPackIds.add(product.packId);
  }
  for (const entry of reconciliation.listReferences.dangling) {
    const decision = entry.decision;
    if (!decision || !['replace', 'remove'].includes(decision.action)) {
      throw new Error(`List decision missing for dangling pack ID ${entry.list}/${entry.packId}`);
    }
    if (!String(decision.reason || '').trim()) {
      throw new Error(`List decision reason missing for ${entry.list}/${entry.packId}`);
    }
    if (decision.action === 'replace') {
      if (!decision.targetPackId || !knownPackIds.has(decision.targetPackId) ||
          decision.targetPackId === entry.packId) {
        throw new Error(`List replacement target is invalid for ${entry.list}/${entry.packId}`);
      }
    }
  }
}

function assertReviewedArtifact(manifest, review, options = {}) {
  if (!manifest || manifest.schemaVersion !== 1 ||
      manifest.normalizationSchemaVersion !== NORMALIZATION_SCHEMA_VERSION ||
      !Array.isArray(manifest.entries) || !manifest.registryDigest || !manifest.evidenceDigest) {
    throw new Error('Invalid normalization migration manifest');
  }
  if (!review || review.schemaVersion !== 1 ||
      review.normalizationSchemaVersion !== NORMALIZATION_SCHEMA_VERSION ||
      !review.reviewed || !review.reviewDigest || !review.approvalDigest ||
      !Array.isArray(review.entries)) {
    throw new Error('Normalization review is not approved');
  }
  if (computeReviewDigest(review) !== review.reviewDigest) {
    throw new Error('Reviewed normalization draft digest mismatch');
  }
  if (computeApprovalDigest(review) !== review.approvalDigest) {
    throw new Error('Reviewed normalization approval digest mismatch');
  }
  if (review.registryDigest !== manifest.registryDigest ||
      review.manifestEvidenceDigest !== manifest.evidenceDigest) {
    throw new Error('Reviewed normalization manifest digest mismatch');
  }
  if (review.entries.length !== manifest.entries.length) {
    throw new Error('Reviewed normalization entry count mismatch');
  }
  const registry = options.registry || readJson(options.registryPath, {});
  if (!options.allowMigratedRegistry && computeRegistryDigest(registry) !== manifest.registryDigest) {
    throw new Error('Reviewed normalization registry digest is stale');
  }
  if (!options.allowMigratedRegistry) {
    const expectedReconciliation = reconcileCatalog(manifest, options);
    const reviewedReconciliation = clone(review.catalogReconciliation);
    for (const entry of reviewedReconciliation.listReferences.dangling) entry.decision = null;
    sameJson(reviewedReconciliation, expectedReconciliation, 'catalog reconciliation');
  }
  assertCatalogDecisions(review, manifest);
  for (let index = 0; index < manifest.entries.length; index++) {
    const source = manifest.entries[index];
    const current = registry[source.file];
    const entry = review.entries[index];
    if (!entry || entry.file !== source.file) throw new Error(`Reviewed normalization entry order mismatch at ${index}`);
    if (!options.allowMigratedRegistry && (!current || current.repo !== source.source.repo ||
        Number(current.repoNum) !== Number(source.source.repoNum) ||
        Number(current.size) !== Number(source.source.registrySize))) {
      throw new Error(`Reviewed normalization source registry mismatch for ${source.file}`);
    }
    if (entry.sourceArchiveSha256 !== source.source.archiveSha256 ||
        Number(entry.sourceSize) !== Number(source.source.size) ||
        entry.classification !== source.normalization.classification) {
      throw new Error(`Reviewed normalization source evidence mismatch for ${source.file}`);
    }
    sameJson(entry.causes, source.normalization.causes, `causes for ${source.file}`);
    sameJson(entry.blockers, source.blockers, `blockers for ${source.file}`);
    sameJson(entry.visibility, source.visibility, `visibility for ${source.file}`);
    sameJson(entry.listEffects, source.effects, `List effects for ${source.file}`);
    assertProductBinding(entry, source);
    if (entry.action !== expectedAction(source)) throw new Error(`Reviewed normalization action mismatch for ${source.file}`);
    assertStoragePlan(entry, source);
    assertDecision(entry, source);
  }
  return { manifest, review, registry };
}

function loadBoundState(filePath, approvalDigest, label) {
  const state = readJson(filePath, null);
  if (!state) return { entries: [] };
  if (!Array.isArray(state.entries) || state.reviewedArtifactDigest !== approvalDigest) {
    throw new Error(`${label} state does not match the reviewed artifact`);
  }
  return state;
}

function sitePrepared(status) {
  return ['site_prepared', 'deployed_verified', 'old_deleted', 'remote_deleted', 'complete'].includes(status);
}

function assertStateTarget(actual, expected, label) {
  if (!actual || actual.repo !== expected.repo || Number(actual.repoNum) !== Number(expected.repoNum) ||
      actual.file !== expected.file || Number(actual.size) !== Number(expected.size) ||
      actual.archiveSha256 !== expected.archiveSha256 || actual.visualContentHash !== expected.visualContentHash) {
    throw new Error(`${label} state target does not match the reviewed artifact`);
  }
}

function assertExecutionRegistry(manifest, review, registry, options) {
  const reviewByFile = new Map(review.entries.map(entry => [entry.file, entry]));
  const manifestByFile = new Map(manifest.entries.map(entry => [entry.file, entry]));
  const expected = Object.fromEntries(manifest.entries.map(entry => [entry.file, {
    repo: entry.source.repo,
    repoNum: Number(entry.source.repoNum),
    size: Number(entry.source.registrySize),
  }]));
  const single = loadBoundState(options.singleStatePath, review.approvalDigest, 'Single-pack migration');
  for (const stateEntry of single.entries) {
    const planned = manifestByFile.get(stateEntry.file);
    const plan = reviewByFile.get(stateEntry.file);
    if (!planned || !plan) throw new Error(`Unknown single-pack migration state entry: ${stateEntry.file}`);
    if (stateEntry.target) {
      assertStateTarget(stateEntry.target, {
        repo: plan.storagePlan.targetRepo,
        repoNum: plan.storagePlan.targetRepoNum,
        file: stateEntry.file,
        ...planned.normalization.products[0],
      }, `Single-pack ${stateEntry.file}`);
    }
    if (sitePrepared(stateEntry.status)) {
      expected[stateEntry.file] = {
        repo: stateEntry.target.repo,
        repoNum: Number(stateEntry.target.repoNum),
        size: Number(stateEntry.target.size),
      };
    }
  }
  const collection = loadBoundState(options.collectionStatePath, review.approvalDigest, 'Collection migration');
  for (const stateEntry of collection.entries) {
    const planned = manifestByFile.get(stateEntry.file);
    const reviewEntry = reviewByFile.get(stateEntry.file);
    if (!planned || !reviewEntry) throw new Error(`Unknown collection migration state entry: ${stateEntry.file}`);
    for (const product of stateEntry.products || []) {
      const productPlan = planned.normalization.products.find(row => row.file === product.sourceProductFile) ||
        planned.normalization.products.find(row => row.visualContentHash === product.visualContentHash);
      if (!productPlan) throw new Error(`Unknown reviewed collection product in state: ${product.file}`);
      if (!product.reused) {
        const repository = reviewEntry.storagePlan.products.find(row =>
          row.file === productPlan.file || row.visualContentHash === productPlan.visualContentHash
        );
        assertStateTarget(product, {
          repo: repository.targetRepo,
          repoNum: repository.targetRepoNum,
          file: product.file,
          size: productPlan.size,
          archiveSha256: productPlan.archiveSha256,
          visualContentHash: productPlan.visualContentHash,
        }, `Collection product ${product.file}`);
      }
    }
    if (sitePrepared(stateEntry.status)) {
      delete expected[stateEntry.file];
      for (const product of stateEntry.products || []) {
        if (!product.reused) expected[product.file] = {
          repo: product.repo,
          repoNum: Number(product.repoNum),
          size: Number(product.size),
        };
      }
    }
  }
  const illegal = loadBoundState(options.illegalStatePath, review.approvalDigest, 'Illegal retirement');
  for (const stateEntry of illegal.entries) {
    const planned = manifestByFile.get(stateEntry.file);
    if (!planned || stateEntry.source.archiveSha256 !== planned.source.archiveSha256) {
      throw new Error(`Illegal retirement state source mismatch: ${stateEntry.file}`);
    }
    if (sitePrepared(stateEntry.status)) delete expected[stateEntry.file];
  }
  if (computeRegistryDigest(expected) !== computeRegistryDigest(registry)) {
    throw new Error('Current registry does not match the reviewed migration state');
  }
  return { single, collection, illegal };
}

function cleanupEmptyWorkdir(workdir) {
  if (fs.existsSync(workdir) && fs.statSync(workdir).isDirectory() && fs.readdirSync(workdir).length === 0) {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

function fileDigest(filePath) {
  return fs.existsSync(filePath)
    ? crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
    : null;
}

function catalogSnapshot(options) {
  const paths = options.catalogPaths || [
    options.registryPath,
    options.contentIndexPath,
    options.siteIndexPath,
    options.listsPath,
    options.extractedPath,
  ];
  return paths.filter(Boolean).map(filePath => ({ path: path.resolve(filePath), digest: fileDigest(filePath) }));
}

function catalogDiff(before, after) {
  const beforeByPath = new Map((before || []).map(entry => [entry.path, entry.digest]));
  const afterByPath = new Map((after || []).map(entry => [entry.path, entry.digest]));
  return [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].sort().map(filePath => ({
    path: filePath,
    before: beforeByPath.get(filePath) || null,
    after: afterByPath.get(filePath) || null,
    changed: beforeByPath.get(filePath) !== afterByPath.get(filePath),
  }));
}

function catalogTransactionFiles(options) {
  return [...new Set([
    options.registryPath,
    options.contentIndexPath,
    options.siteIndexPath,
    options.listsPath,
    options.extractedPath,
    options.statePath,
    options.singleStatePath,
    options.collectionStatePath,
    options.illegalStatePath,
    options.tombstonePath,
    options.auditPath,
    options.legacySbiPath,
  ].filter(Boolean).map(filePath => path.resolve(filePath)))];
}

function catalogTransactionDirectories(options) {
  return [...new Set([
    options.thumbnailsRoot,
    options.packDataRoot,
    options.packPageRoot,
    options.pagesRoot,
    options.sbiShardRoot,
  ].filter(Boolean).map(directoryPath => path.resolve(directoryPath)))];
}

function catalogBackupDir(options) {
  return path.resolve(options.catalogBackupDir || path.join(path.dirname(options.statePath), '.pack-normalization-catalog-backup'));
}

function beginCatalogTransaction(options, approvalDigest) {
  const backupDir = catalogBackupDir(options);
  if (fs.existsSync(backupDir)) throw new Error(`Catalog transaction backup already exists: ${backupDir}`);
  fs.mkdirSync(backupDir, { recursive: true });
  try {
    const files = catalogTransactionFiles(options).map((filePath, index) => {
      const exists = fs.existsSync(filePath);
      const backup = `file-${index}`;
      if (exists) fs.copyFileSync(filePath, path.join(backupDir, backup));
      return { filePath, backup, exists };
    });
    const directories = catalogTransactionDirectories(options).map((directoryPath, index) => {
      const exists = fs.existsSync(directoryPath);
      const backup = `directory-${index}`;
      if (exists) fs.cpSync(directoryPath, path.join(backupDir, backup), { recursive: true });
      return { directoryPath, backup, exists };
    });
    writeJsonAtomic(path.join(backupDir, 'transaction.json'), {
      schemaVersion: 2,
      reviewedArtifactDigest: approvalDigest,
      files,
      directories,
    });
    return backupDir;
  } catch (error) {
    fs.rmSync(backupDir, { recursive: true, force: true });
    throw error;
  }
}

function restoreFileAtomic(sourcePath, targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.restore.tmp`;
  fs.copyFileSync(sourcePath, tempPath);
  try {
    fs.renameSync(tempPath, targetPath);
  } catch {
    retryWindowsFileOperation(() => fs.rmSync(targetPath, { force: true }));
    retryWindowsFileOperation(() => fs.renameSync(tempPath, targetPath));
  }
}

function restoreCatalogTransaction(options, approvalDigest) {
  const backupDir = catalogBackupDir(options);
  if (!fs.existsSync(backupDir)) return false;
  const state = readJson(options.statePath, null);
  const transaction = readJson(path.join(backupDir, 'transaction.json'), null);
  if ((!transaction || !Array.isArray(transaction.files)) && state?.status !== 'site_preparing') {
    fs.rmSync(backupDir, { recursive: true, force: true });
    return false;
  }
  const expected = catalogTransactionFiles(options);
  const expectedDirectories = catalogTransactionDirectories(options);
  if (!transaction || transaction.schemaVersion !== 2 ||
      transaction.reviewedArtifactDigest !== approvalDigest || !Array.isArray(transaction.files) ||
      !Array.isArray(transaction.directories) ||
      stableStringify(transaction.files.map(entry => entry.filePath)) !== stableStringify(expected) ||
      stableStringify(transaction.directories.map(entry => entry.directoryPath)) !== stableStringify(expectedDirectories)) {
    throw new Error('Catalog transaction backup does not match the reviewed artifact or configured paths');
  }
  if (!state || state.reviewedArtifactDigest !== approvalDigest) {
    throw new Error('Catalog transaction backup exists without matching site_preparing state');
  }
  if (state.status !== 'site_preparing') {
    fs.rmSync(backupDir, { recursive: true, force: true });
    return false;
  }
  for (const entry of transaction.files) {
    if (entry.exists) {
      const backupPath = path.join(backupDir, entry.backup);
      if (!fs.existsSync(backupPath)) throw new Error(`Catalog transaction backup is unreadable: ${entry.backup}`);
      restoreFileAtomic(backupPath, entry.filePath);
    } else {
      fs.rmSync(entry.filePath, { force: true });
    }
  }
  for (const entry of transaction.directories) {
    fs.rmSync(entry.directoryPath, { recursive: true, force: true });
    if (entry.exists) {
      const backupPath = path.join(backupDir, entry.backup);
      if (!fs.existsSync(backupPath)) throw new Error(`Catalog directory backup is unreadable: ${entry.backup}`);
      fs.cpSync(backupPath, entry.directoryPath, { recursive: true });
    }
  }
  fs.rmSync(backupDir, { recursive: true, force: true });
  return true;
}

function discardCatalogTransaction(options) {
  const backupDir = catalogBackupDir(options);
  if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
}

function loadExecutionState(options, manifest, review) {
  const state = readJson(options.statePath, null);
  if (!state) return {
    schemaVersion: 1,
    normalizationSchemaVersion: NORMALIZATION_SCHEMA_VERSION,
    manifestRegistryDigest: manifest.registryDigest,
    manifestEvidenceDigest: manifest.evidenceDigest,
    reviewedArtifactDigest: review.approvalDigest,
    status: 'reviewed',
    catalogBefore: null,
    catalogAfter: null,
    catalogDiff: [],
    lifecycle: { reviewed: new Date().toISOString() },
  };
  if (state.schemaVersion !== 1 || state.normalizationSchemaVersion !== NORMALIZATION_SCHEMA_VERSION ||
      state.manifestRegistryDigest !== manifest.registryDigest ||
      state.manifestEvidenceDigest !== manifest.evidenceDigest ||
      state.reviewedArtifactDigest !== review.approvalDigest) {
    throw new Error('Normalization execution state does not match the reviewed artifact');
  }
  return state;
}

function assertExecutionPhase(state, phase) {
  const allowed = PHASE_STATES[phase];
  if (!allowed) throw new Error(`Unknown reviewed normalization phase: ${phase || '(missing)'}`);
  if (!allowed.includes(state.status)) {
    throw new Error(`Reviewed normalization ${phase} requires execution state ${allowed[0]}; current state is ${state.status}`);
  }
}

function assertFunction(target, name, label) {
  if (!target || typeof target[name] !== 'function') {
    throw new Error(`Reviewed normalization ${label} requires ${name}`);
  }
}

function assertPhaseServices(phase, services) {
  assertFunction(services.remote, 'getArchiveIdentity', 'remote adapter');
  if (phase === 'stage') {
    for (const name of ['downloadArchive', 'publishArchive', 'verifyArchive']) {
      assertFunction(services.remote, name, 'stage remote adapter');
    }
  } else if (phase === 'prepare-site') {
    if (typeof services.prepareAssets !== 'function' || typeof services.generateCatalog !== 'function') {
      throw new Error('Asset preparation and catalog generator services are required before site preparation');
    }
  } else if (phase === 'verify-deployment') {
    assertFunction(services, 'verifyCatalogDeployment', 'deployment verification');
    assertFunction(services, 'verifyDeployment', 'deployment verification');
  } else if (phase === 'cleanup') {
    assertFunction(services.remote, 'deleteArchive', 'cleanup remote adapter');
  }
}

function componentStatus(manifestEntry, reviewEntry, states, terminalStatus) {
  for (const state of [states.single, states.collection, states.illegal]) {
    const match = state && state.entries && state.entries.find(entry => entry.file === manifestEntry.file);
    if (match) return { status: match.status, lifecycle: match.lifecycle || {} };
  }
  if (reviewEntry.decision && reviewEntry.decision.action === 'defer') return { status: 'deferred', lifecycle: {} };
  if (manifestEntry.normalization.classification === 'normal') {
    return { status: terminalStatus === 'complete' ? 'complete' : 'unchanged', lifecycle: {} };
  }
  return { status: 'planned', lifecycle: {} };
}

function updateAuditLifecycle(options, manifest, review, states, terminalStatus) {
  if (!options.auditPath || !fs.existsSync(options.auditPath)) return;
  const audit = readJson(options.auditPath, null);
  if (!audit || audit.schemaVersion !== 1 || !Array.isArray(audit.entries)) {
    throw new Error('Invalid normalization audit ledger during execution');
  }
  const reviewByFile = new Map(review.entries.map(entry => [entry.file, entry]));
  const now = new Date().toISOString();
  for (const manifestEntry of manifest.entries) {
    const ledgerEntry = audit.entries.find(entry => entry.remoteIdentity &&
      entry.remoteIdentity.file === manifestEntry.file &&
      entry.remoteIdentity.archiveSha256 === manifestEntry.source.archiveSha256);
    if (!ledgerEntry) throw new Error(`Normalization audit entry missing during execution: ${manifestEntry.file}`);
    const lifecycle = componentStatus(manifestEntry, reviewByFile.get(manifestEntry.file), states, terminalStatus);
    ledgerEntry.decision = reviewByFile.get(manifestEntry.file).decision || null;
    ledgerEntry.reviewedArtifactDigest = review.approvalDigest;
    ledgerEntry.lifecycle = { ...ledgerEntry.lifecycle, ...lifecycle.lifecycle, status: lifecycle.status };
    ledgerEntry.updatedAt = now;
  }
  audit.registryDigest = computeRegistryDigest(readJson(options.registryPath, {}));
  audit.reviewedArtifactDigest = review.approvalDigest;
  writeJsonAtomic(options.auditPath, audit);
}

function finishExecutionPhase(options, manifest, review, executionState, status, states) {
  executionState.status = status;
  executionState.lifecycle[status] = new Date().toISOString();
  executionState.updatedAt = executionState.lifecycle[status];
  updateAuditLifecycle(options, manifest, review, states, status);
  writeJsonAtomic(options.statePath, executionState);
  return executionState;
}

function applyCatalogDecisions(review, options) {
  const decisions = new Map(review.catalogReconciliation.listReferences.dangling.map(entry => [
    `${entry.list}\0${entry.packId}`,
    entry.decision,
  ]));
  const lists = readJson(options.listsPath, []);
  for (const list of lists) {
    const next = [];
    const seen = new Set();
    for (const packId of list.packs || []) {
      const decision = decisions.get(`${list.name}\0${packId}`);
      if (decision && decision.action === 'remove') continue;
      const resolved = decision && decision.action === 'replace' ? decision.targetPackId : packId;
      if (!seen.has(resolved)) {
        seen.add(resolved);
        next.push(resolved);
      }
    }
    list.packs = next;
  }
  writeJsonAtomic(options.listsPath, lists);
  return lists;
}

async function reconcileFinalState(options, services) {
  const registry = readJson(options.registryPath, {});
  const contentIndex = validateContentIndex(
    readJson(options.contentIndexPath, null),
    registry,
    FINGERPRINT_SCHEMA_VERSION
  );
  if (Object.keys(contentIndex.packs || {}).length !== Object.keys(registry).length) {
    throw new Error('Final content index does not cover the registry');
  }
  const knownPackIds = new Set(Object.values(contentIndex.packs).map(entry => entry.packId));
  const lists = readJson(options.listsPath, []);
  for (const list of lists) {
    const seen = new Set();
    for (const packId of list.packs || []) {
      if (seen.has(packId)) throw new Error(`Final List ${list.name} contains duplicate pack ID: ${packId}`);
      if (!knownPackIds.has(packId)) throw new Error(`Final List ${list.name} references missing pack ID: ${packId}`);
      seen.add(packId);
    }
  }
  let generatedPackCount = 0;
  if (options.packDataRoot || options.packPageRoot) {
    const siteIndex = readJson(options.siteIndexPath, { items: [] });
    const owner = options.repoOwner || 'Sakyvo';
    for (const item of siteIndex.items || []) {
      const dataPath = safeGeneratedPath(options.packDataRoot, `${item.name}.json`);
      const routePath = safeGeneratedPath(options.packPageRoot, item.name, 'index.html');
      const pack = readJson(dataPath, null);
      const originalName = item.id || (pack && pack.id);
      const file = `${originalName}.zip`;
      const registryEntry = registry[file];
      if (!pack || !registryEntry) throw new Error(`Generated pack data is missing registry coverage: ${item.name}`);
      const expectedUrl = `https://raw.githubusercontent.com/${owner}/${registryEntry.repo}/main/resourcepacks/${encodeURIComponent(originalName)}.zip`;
      if (!pack.downloads || pack.downloads.github !== expectedUrl) {
        throw new Error(`Generated download URL mismatch for ${item.name}`);
      }
      if (!fs.existsSync(routePath)) throw new Error(`Generated pack route is missing: ${item.name}`);
      generatedPackCount++;
    }
  }
  let sbiShardCount = 0;
  if (options.sbiShardRoot) {
    const meta = readJson(options.sbiMetaPath || path.join(options.sbiShardRoot, 'meta.json'), null);
    if (!meta || !meta.shards || typeof meta.shards !== 'object') throw new Error('SBI shard metadata is missing');
    const seenFiles = new Set();
    const limit = Number(options.maxSbiShardBytes) || 32 * 1024 * 1024;
    for (const shard of Object.values(meta.shards)) {
      for (const bucket of shard.buckets || []) {
        if (seenFiles.has(bucket.file)) continue;
        seenFiles.add(bucket.file);
        const shardPath = path.join(options.sbiShardRoot, bucket.file);
        if (!fs.existsSync(shardPath)) throw new Error(`SBI shard is missing: ${bucket.file}`);
        const bytes = fs.statSync(shardPath).size;
        if (Number(bucket.bytes) !== bytes) throw new Error(`SBI shard byte metadata mismatch: ${bucket.file}`);
        if (bytes > limit) throw new Error(`SBI shard exceeds limit: ${bucket.file}`);
        sbiShardCount++;
      }
    }
  }
  const retained = Object.entries(registry);
  const reconciliationDigest = digest({
    registry,
    packs: Object.fromEntries(retained.map(([file]) => [file, contentIndex.packs[file].archiveSha256])),
  });
  const checkpointPath = options.finalReconciliationStatePath;
  let checkpoint = {
    schemaVersion: 1,
    reconciliationDigest,
    repoReferences: {},
    verified: {},
  };
  if (checkpointPath) {
    if (typeof services.remote.getRepositoryReference !== 'function') {
      throw new Error('Final reconciliation checkpoint requires repository references');
    }
    const saved = readJson(checkpointPath, null);
    if (saved && saved.schemaVersion === 1 && saved.reconciliationDigest === reconciliationDigest &&
        saved.repoReferences && saved.verified) {
      checkpoint = saved;
    }
    const repos = [...new Set(retained.map(([, entry]) => entry.repo))].sort();
    for (const repo of repos) {
      const reference = await services.remote.getRepositoryReference(repo);
      if (checkpoint.repoReferences[repo] !== reference) {
        for (const [file, proof] of Object.entries(checkpoint.verified)) {
          if (proof.repo === repo) delete checkpoint.verified[file];
        }
        checkpoint.repoReferences[repo] = reference;
      }
    }
    writeJsonAtomic(checkpointPath, checkpoint);
  }
  const expectedProof = (file, registryEntry) => ({
    repo: registryEntry.repo,
    reference: checkpoint.repoReferences[registryEntry.repo],
    size: Number(registryEntry.size),
    archiveSha256: contentIndex.packs[file].archiveSha256,
  });
  const isVerified = (file, registryEntry) => {
    if (!checkpointPath) return false;
    return stableStringify(checkpoint.verified[file]) === stableStringify(expectedProof(file, registryEntry));
  };
  const pending = retained.filter(([file, registryEntry]) => !isVerified(file, registryEntry));
  let cursor = 0;
  let remoteVerified = retained.length - pending.length;
  let remoteFailure = null;
  const workers = Array.from({
    length: Math.max(1, Math.min(Number(options.finalReconciliationConcurrency) || 6, pending.length || 1)),
  }, async () => {
    while (!remoteFailure) {
      const index = cursor++;
      if (index >= pending.length) return;
      const [file, registryEntry] = pending[index];
      try {
        const indexed = contentIndex.packs[file];
        const actual = await services.remote.getArchiveIdentity({ file, ...registryEntry });
        if (!actual || Number(actual.size) !== Number(registryEntry.size) ||
            actual.archiveSha256 !== indexed.archiveSha256) {
          throw new Error(`Final retained remote archive mismatch: ${registryEntry.repo}/${file}`);
        }
        if (checkpointPath) {
          checkpoint.verified[file] = expectedProof(file, registryEntry);
          writeJsonAtomic(checkpointPath, checkpoint);
        }
        const done = ++remoteVerified;
        if (typeof options.onFinalReconciliationProgress === 'function') {
          options.onFinalReconciliationProgress(done, retained.length, { file, ...registryEntry });
        }
      } catch (error) {
        remoteFailure = error;
      }
    }
  });
  await Promise.all(workers);
  if (remoteFailure) throw remoteFailure;
  if (checkpointPath) {
    for (const [repo, reference] of Object.entries(checkpoint.repoReferences)) {
      const current = await services.remote.getRepositoryReference(repo, { refresh: true });
      if (current !== reference) {
        throw new Error(`Pack repository changed during final reconciliation: ${repo}`);
      }
    }
    fs.rmSync(checkpointPath, { force: true });
  }
  if (options.legacySbiPath && fs.existsSync(options.legacySbiPath)) {
    throw new Error(`Legacy monolithic SBI artifact remains: ${options.legacySbiPath}`);
  }
  return {
    registryCount: Object.keys(registry).length,
    contentIndexCount: Object.keys(contentIndex.packs).length,
    listCount: lists.length,
    generatedPackCount,
    sbiShardCount,
    remoteVerified,
  };
}

function safeGeneratedPath(root, ...segments) {
  const base = path.resolve(root) + path.sep;
  const target = path.resolve(root, ...segments);
  if (!target.startsWith(base)) throw new Error(`Generated pack path escapes its root: ${segments.join('/')}`);
  return target;
}

async function preflightSourceIdentities(manifest, remote, concurrency = 6, onProgress = null) {
  let cursor = 0;
  let completed = 0;
  let failure = null;
  const workers = Array.from({ length: Math.max(1, Math.min(Number(concurrency) || 1, manifest.entries.length || 1)) }, async () => {
    while (!failure) {
      const index = cursor++;
      if (index >= manifest.entries.length) return;
      const entry = manifest.entries[index];
      try {
        const actual = await remote.getArchiveIdentity({
          file: entry.file,
          repo: entry.source.repo,
          repoNum: entry.source.repoNum,
          size: entry.source.size,
          archiveSha256: entry.source.archiveSha256,
        });
        if (!actual || Number(actual.size) !== Number(entry.source.size) ||
            actual.archiveSha256 !== entry.source.archiveSha256) {
          throw new Error(`Reviewed source changed or is missing: ${entry.source.repo}/${entry.file}`);
        }
        const done = ++completed;
        if (typeof onProgress === 'function') onProgress(done, manifest.entries.length, entry);
      } catch (error) {
        failure = error;
      }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
  return manifest.entries.length;
}

async function runReviewedMigration(options = {}, services = {}) {
  const resolved = { ...DEFAULTS, ...options };
  const phase = resolved.phase;
  if (!PHASE_STATES[phase]) throw new Error(`Unknown reviewed normalization phase: ${phase || '(missing)'}`);
  const manifest = resolved.manifest || readJson(resolved.manifestPath, null);
  const review = resolved.review || readJson(resolved.reviewPath, null);
  let validated = assertReviewedArtifact(manifest, review, {
    ...resolved,
    registry: resolved.registry,
    allowMigratedRegistry: resolved.phase !== 'stage',
  });
  if (phase !== 'stage' && restoreCatalogTransaction(resolved, review.approvalDigest)) {
    validated = assertReviewedArtifact(manifest, review, {
      ...resolved,
      registry: readJson(resolved.registryPath, {}),
      allowMigratedRegistry: true,
    });
  }
  const currentStates = assertExecutionRegistry(validated.manifest, review, validated.registry, resolved);
  const reviewedArtifactDigest = review.approvalDigest;
  const reviewByFile = new Map(review.entries.map(entry => [entry.file, entry]));
  const approvedManifest = {
    ...validated.manifest,
    reviewedArtifactDigest,
    entries: validated.manifest.entries.map((entry, index) => ({
      ...entry,
      decision: review.entries[index].decision || null,
      storagePlan: review.entries[index].storagePlan || null,
    })),
  };
  const executionState = loadExecutionState(resolved, approvedManifest, review);
  assertExecutionPhase(executionState, phase);
  assertPhaseServices(phase, services);
  if (phase === 'stage' || phase === 'prepare-site') {
    await preflightSourceIdentities(
      approvedManifest,
      services.remote,
      resolved.sourcePreflightConcurrency,
      resolved.onSourcePreflightProgress
    );
  }
  if (phase === 'stage') {
    const allocateSingle = (entry, manifestEntry) => {
      const plan = reviewByFile.get(manifestEntry.file).storagePlan;
      if (!plan || !plan.targetRepo) throw new Error(`Reviewed target repository missing for ${manifestEntry.file}`);
      return { repo: plan.targetRepo, repoNum: Number(plan.targetRepoNum) };
    };
    const allocateCollection = (product, index, phaseOptions) => {
      const parent = phaseOptions.__reviewEntry;
      const plans = parent && parent.storagePlan && parent.storagePlan.products;
      const planned = (plans || []).find(row => row.file === product.file || row.packId === product.packId) || plans?.[index];
      if (!planned || !planned.targetRepo) throw new Error(`Reviewed target repository missing for collection product ${product.file}`);
      return { repo: planned.targetRepo, repoNum: Number(planned.targetRepoNum) };
    };
    try {
      const single = await runMigration({
        ...resolved,
        manifest: approvedManifest,
        statePath: resolved.singleStatePath,
        workdir: path.join(resolved.workdir, 'single'),
        phase,
      }, {
        ...services,
        allocateRepo: allocateSingle,
      });
      const collection = await runCollectionMigration({
        ...resolved,
        manifest: approvedManifest,
        statePath: resolved.collectionStatePath,
        workdir: path.join(resolved.workdir, 'collection'),
        phase,
      }, {
        ...services,
        allocateRepo(product, index, phaseOptions) {
          const parent = approvedManifest.entries.find(entry =>
            entry.normalization.collection && entry.normalization.products.some(row => row.file === product.file)
          );
          return allocateCollection(product, index, { ...phaseOptions, __reviewEntry: parent && reviewByFile.get(parent.file) });
        },
      });
      finishExecutionPhase(resolved, approvedManifest, review, executionState, 'staged_verified', { single, collection });
      return { phase, reviewedArtifactDigest, single, collection };
    } finally {
      cleanupEmptyWorkdir(resolved.workdir);
    }
  }
  if (phase === 'prepare-site') {
    if (!executionState.catalogBefore) {
      executionState.catalogBefore = catalogSnapshot(resolved);
      writeJsonAtomic(resolved.statePath, executionState);
    }
    beginCatalogTransaction(resolved, reviewedArtifactDigest);
    try {
      executionState.status = 'site_preparing';
      executionState.lifecycle.site_preparing = new Date().toISOString();
      writeJsonAtomic(resolved.statePath, executionState);
    } catch (error) {
      discardCatalogTransaction(resolved);
      throw error;
    }
    try {
      await services.prepareAssets({
        manifest: approvedManifest,
        review,
        illegal: currentStates.illegal,
        single: currentStates.single,
        collection: currentStates.collection,
        options: resolved,
      });
      const illegal = await runIllegalRetirement({
        ...resolved,
        manifest: approvedManifest,
        statePath: resolved.illegalStatePath,
        tombstonePath: resolved.tombstonePath || path.join(path.dirname(resolved.statePath), 'pack-normalization-illegal-tombstones.json'),
        phase,
      }, services);
      const single = await runMigration({
        ...resolved,
        manifest: approvedManifest,
        statePath: resolved.singleStatePath,
        workdir: path.join(resolved.workdir, 'single'),
        phase,
      }, services);
      const collection = await runCollectionMigration({
        ...resolved,
        manifest: approvedManifest,
        statePath: resolved.collectionStatePath,
        workdir: path.join(resolved.workdir, 'collection'),
        phase,
      }, services);
      applyCatalogDecisions(review, resolved);
      await services.generateCatalog({ manifest: approvedManifest, review, illegal, single, collection, options: resolved });
      executionState.catalogAfter = catalogSnapshot(resolved);
      executionState.catalogDiff = catalogDiff(executionState.catalogBefore, executionState.catalogAfter);
      finishExecutionPhase(resolved, approvedManifest, review, executionState, 'site_prepared', { illegal, single, collection });
      discardCatalogTransaction(resolved);
      return { phase, reviewedArtifactDigest, illegal, single, collection };
    } catch (error) {
      try {
        restoreCatalogTransaction(resolved, reviewedArtifactDigest);
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], 'Site preparation failed and catalog rollback also failed');
      }
      throw error;
    }
  }
  if (phase === 'verify-deployment') {
    if (typeof services.verifyCatalogDeployment !== 'function' ||
        !await services.verifyCatalogDeployment({ manifest: approvedManifest, review, options: resolved })) {
      throw new Error('Catalog deployment verification failed');
    }
    const single = await runMigration({
      ...resolved, manifest: approvedManifest, statePath: resolved.singleStatePath, phase,
    }, services);
    const collection = await runCollectionMigration({
      ...resolved, manifest: approvedManifest, statePath: resolved.collectionStatePath, phase,
    }, services);
    const illegal = await runIllegalRetirement({
      ...resolved, manifest: approvedManifest, statePath: resolved.illegalStatePath,
      tombstonePath: resolved.tombstonePath || path.join(path.dirname(resolved.statePath), 'pack-normalization-illegal-tombstones.json'),
      phase,
    }, services);
    finishExecutionPhase(resolved, approvedManifest, review, executionState, 'deployed_verified', { illegal, single, collection });
    return { phase, reviewedArtifactDigest, illegal, single, collection };
  }
  if (phase === 'cleanup') {
    const single = await runMigration({
      ...resolved, manifest: approvedManifest, statePath: resolved.singleStatePath, phase,
    }, services);
    const collection = await runCollectionMigration({
      ...resolved, manifest: approvedManifest, statePath: resolved.collectionStatePath, phase,
    }, services);
    const illegal = await runIllegalRetirement({
      ...resolved, manifest: approvedManifest, statePath: resolved.illegalStatePath,
      tombstonePath: resolved.tombstonePath || path.join(path.dirname(resolved.statePath), 'pack-normalization-illegal-tombstones.json'),
      phase,
    }, services);
    const reconciliation = await reconcileFinalState(resolved, services);
    executionState.finalReconciliation = reconciliation;
    finishExecutionPhase(resolved, approvedManifest, review, executionState, 'complete', { illegal, single, collection });
    return { phase, reviewedArtifactDigest, illegal, single, collection, reconciliation };
  }
  throw new Error(`Unknown reviewed normalization phase: ${phase || '(missing)'}`);
}

function parseExecutionArgs(argv) {
  const args = {
    phase: null,
    approvalDigest: null,
    execute: false,
    owner: 'Sakyvo',
    baseUrl: 'https://vale.cc.cd/',
    sourcePreflightConcurrency: 6,
    finalReconciliationConcurrency: 6,
    archiveRequestTimeoutMs: 30 * 60 * 1000,
    archiveRangeChunkBytes: 4 * 1024 * 1024,
    archiveTransport: 'curl',
    deploymentConcurrency: 8,
    deploymentTimeoutMs: 20 * 60 * 1000,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--phase') args.phase = argv[++index];
    else if (arg === '--approval-digest') args.approvalDigest = argv[++index];
    else if (arg === '--execute') args.execute = true;
    else if (arg === '--owner') args.owner = argv[++index];
    else if (arg === '--base-url') args.baseUrl = argv[++index];
    else if (arg === '--source-preflight-concurrency') args.sourcePreflightConcurrency = Number(argv[++index]);
    else if (arg === '--final-reconciliation-concurrency') args.finalReconciliationConcurrency = Number(argv[++index]);
    else if (arg === '--archive-request-timeout-minutes') args.archiveRequestTimeoutMs = Number(argv[++index]) * 60 * 1000;
    else if (arg === '--archive-range-chunk-mib') args.archiveRangeChunkBytes = Number(argv[++index]) * 1024 * 1024;
    else if (arg === '--deployment-concurrency') args.deploymentConcurrency = Number(argv[++index]);
    else if (arg === '--deployment-timeout-minutes') args.deploymentTimeoutMs = Number(argv[++index]) * 60 * 1000;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!PHASE_STATES[args.phase]) throw new Error('Use --phase stage|prepare-site|verify-deployment|cleanup');
  if (!args.execute) throw new Error('Reviewed normalization production phases require --execute');
  if (!/^[a-f0-9]{64}$/.test(String(args.approvalDigest || ''))) {
    throw new Error('Reviewed normalization production phases require --approval-digest <64-char sha256>');
  }
  for (const [name, value] of [
    ['source preflight concurrency', args.sourcePreflightConcurrency],
    ['final reconciliation concurrency', args.finalReconciliationConcurrency],
    ['archive request timeout', args.archiveRequestTimeoutMs],
    ['archive range chunk size', args.archiveRangeChunkBytes],
    ['deployment concurrency', args.deploymentConcurrency],
    ['deployment timeout', args.deploymentTimeoutMs],
  ]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${name}`);
  }
  if (!Number.isSafeInteger(args.archiveRangeChunkBytes)) throw new Error('Invalid archive range chunk size');
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseExecutionArgs(argv);
  const review = readJson(DEFAULTS.reviewPath, null);
  if (!review || review.approvalDigest !== args.approvalDigest) {
    throw new Error('Command approval digest does not match pack-normalization-review.json');
  }
  const {
    createProductionServices,
    productionPaths,
  } = require('./lib/normalization-production-services');
  const options = {
    ...productionPaths(),
    phase: args.phase,
    owner: args.owner,
    repoOwner: args.owner,
    baseUrl: args.baseUrl,
    sourcePreflightConcurrency: args.sourcePreflightConcurrency,
    finalReconciliationConcurrency: args.finalReconciliationConcurrency,
    archiveRequestTimeoutMs: args.archiveRequestTimeoutMs,
    archiveRangeChunkBytes: args.archiveRangeChunkBytes,
    archiveTransport: args.archiveTransport,
    deploymentConcurrency: args.deploymentConcurrency,
    deploymentTimeoutMs: args.deploymentTimeoutMs,
    onSourcePreflightProgress(done, total) {
      if (done === total || done % 25 === 0) console.log(`Source preflight: ${done}/${total}`);
    },
    onFinalReconciliationProgress(done, total) {
      if (done === total || done % 25 === 0) console.log(`Final reconciliation: ${done}/${total}`);
    },
  };
  const production = createProductionServices(options);
  let failed = false;
  try {
    const result = await runReviewedMigration(options, production.services);
    console.log(JSON.stringify({
      phase: result.phase,
      reviewedArtifactDigest: result.reviewedArtifactDigest,
      reconciliation: result.reconciliation || null,
    }, null, 2));
    return result;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      production.close();
    } catch (error) {
      if (!failed) throw error;
      console.error(`Temporary upload workspace cleanup also failed: ${error.message}`);
    }
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  assertReviewedArtifact,
  computeApprovalDigest,
  computeReviewDigest,
  catalogDiff,
  catalogSnapshot,
  applyCatalogDecisions,
  assertExecutionPhase,
  assertPhaseServices,
  beginCatalogTransaction,
  restoreCatalogTransaction,
  reconcileFinalState,
  safeGeneratedPath,
  preflightSourceIdentities,
  parseExecutionArgs,
  main,
  runReviewedMigration,
};
