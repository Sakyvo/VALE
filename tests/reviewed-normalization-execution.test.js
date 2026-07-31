const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');
const sharp = require('sharp');
const { auditRegistry } = require('../scripts/audit-pack-normalization');
const { computeRegistryDigest } = require('../scripts/lib/pack-content-index');
const { buildReview } = require('../scripts/run-normalization-dry-run');
const {
  computeApprovalDigest,
  computeReviewDigest,
  parseExecutionArgs,
  reconcileFinalState,
  runReviewedMigration,
} = require('../scripts/execute-reviewed-normalization');

function hash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function fixture(root) {
  const registry = { 'Wrapped.zip': { repo: 'packs-001', repoNum: 1, size: 12 } };
  const registryPath = path.join(root, 'registry.json');
  const listsPath = path.join(root, 'lists.json');
  const contentIndexPath = path.join(root, 'content-index.json');
  const manifestPath = path.join(root, 'manifest.json');
  const reviewPath = path.join(root, 'review.json');
  const auditPath = path.join(root, 'audit.json');
  const statePath = path.join(root, 'execution-state.json');
  fs.writeFileSync(registryPath, JSON.stringify(registry));
  fs.writeFileSync(listsPath, JSON.stringify([]));
  fs.writeFileSync(contentIndexPath, JSON.stringify({
    schemaVersion: 1,
    fingerprintSchemaVersion: 1,
    registryDigest: computeRegistryDigest(registry),
    complete: true,
    failures: [],
    packs: {
      'Wrapped.zip': {
        packId: 'Wrapped', repo: 'packs-001', repoNum: 1, size: 12,
        sourceKey: 'packs-001/Wrapped.zip', archiveSha256: 'source-hash',
        visualContentHash: 'visual-hash', visualEntryCount: 1, swords: {},
      },
    },
  }));
  const manifest = {
    schemaVersion: 1,
    normalizationSchemaVersion: 1,
    registryDigest: computeRegistryDigest(registry),
    evidenceDigest: 'evidence-digest',
    entries: [{
      file: 'Wrapped.zip',
      source: {
        file: 'Wrapped.zip', repo: 'packs-001', repoNum: 1, size: 12,
        registrySize: 12, archiveSha256: 'source-hash', sourceKey: 'packs-001/Wrapped.zip',
      },
      visibility: { packId: 'Wrapped', public: false, lists: [], extracted: false, registryOnly: true },
      normalization: {
        schemaVersion: 1, classification: 'repairable', collection: false, causes: ['nested_container'],
        products: [{
          file: 'Wrapped.zip', normalizedFile: 'product.zip', packId: 'Wrapped', size: 12,
          archiveSha256: 'product-hash', visualContentHash: 'visual-hash', visualEntryCount: 1,
          swords: {}, classification: 'normal', oversize: false,
        }],
      },
      effects: { catalog: 'preserve_non_public', registry: 'switch_after_staged_verification', remote: 'stage_same_filename_then_delete_old', visibility: 'preserve' },
      blockers: [], reviewRequired: false, decision: null,
    }],
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const review = buildReview(manifest, registry, {
    authenticated: true,
    registryCount: 1,
    contentIndexCount: 1,
    registryDigest: manifest.registryDigest,
    trackedArchiveCount: 0,
    workspaceSafe: true,
  }, {
    listsPath,
    repoStatePath: path.join(root, 'repo-state.json'),
    maxRepoSize: 5 * 1024 * 1024 * 1024,
    githubFileLimit: 100 * 1024 * 1024,
  });
  fs.writeFileSync(reviewPath, JSON.stringify(review));
  return { registry, manifest, review, paths: { registryPath, listsPath, contentIndexPath, manifestPath, reviewPath, statePath } };
}

test('production CLI requires an explicit phase, execute flag, and approval digest', () => {
  const digest = 'a'.repeat(64);
  assert.deepEqual(
    parseExecutionArgs(['--phase', 'stage', '--execute', '--approval-digest', digest]),
    {
      phase: 'stage', approvalDigest: digest, execute: true, owner: 'Sakyvo',
      baseUrl: 'https://vale.cc.cd/', sourcePreflightConcurrency: 6,
      finalReconciliationConcurrency: 6,
      archiveRequestTimeoutMs: 30 * 60 * 1000,
      archiveRangeChunkBytes: 4 * 1024 * 1024,
      archiveTransport: 'curl',
      deploymentConcurrency: 8, deploymentTimeoutMs: 20 * 60 * 1000,
    }
  );
  assert.equal(
    parseExecutionArgs([
      '--phase', 'stage', '--execute', '--approval-digest', digest,
      '--archive-request-timeout-minutes', '45',
    ]).archiveRequestTimeoutMs,
    45 * 60 * 1000
  );
  assert.equal(
    parseExecutionArgs([
      '--phase', 'stage', '--execute', '--approval-digest', digest,
      '--archive-range-chunk-mib', '2',
    ]).archiveRangeChunkBytes,
    2 * 1024 * 1024
  );
  assert.throws(() => parseExecutionArgs(['--phase', 'stage', '--approval-digest', digest]), /--execute/);
  assert.throws(() => parseExecutionArgs(['--phase', 'cleanup', '--execute']), /--approval-digest/);
  assert.throws(
    () => parseExecutionArgs(['--phase', 'stage', '--execute', '--approval-digest', digest, '--source-preflight-concurrency', '0']),
    /Invalid source preflight concurrency/
  );
  assert.throws(
    () => parseExecutionArgs(['--phase', 'cleanup', '--execute', '--approval-digest', digest, '--final-reconciliation-concurrency', '0']),
    /Invalid final reconciliation concurrency/
  );
  assert.throws(
    () => parseExecutionArgs(['--phase', 'stage', '--execute', '--approval-digest', digest, '--archive-request-timeout-minutes', '0']),
    /Invalid archive request timeout/
  );
  assert.throws(
    () => parseExecutionArgs(['--phase', 'stage', '--execute', '--approval-digest', digest, '--archive-range-chunk-mib', '0']),
    /Invalid archive range chunk size/
  );
});

async function writeWrapped(filePath, color) {
  const texture = await sharp({
    create: { width: 8, height: 8, channels: 4, background: { ...color, alpha: 1 } },
  }).png().toBuffer();
  const zip = new AdmZip();
  zip.addFile('Inner/pack.mcmeta', Buffer.from('{}'));
  zip.addFile('Inner/assets/minecraft/textures/blocks/stone.png', texture);
  zip.writeZip(filePath);
}

async function writeCollection(filePath) {
  const zip = new AdmZip();
  for (const [name, color] of [
    ['PackA', { r: 200, g: 40, b: 40 }],
    ['PackB', { r: 40, g: 80, b: 200 }],
  ]) {
    const texture = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { ...color, alpha: 1 } },
    }).png().toBuffer();
    zip.addFile(`${name}/pack.mcmeta`, Buffer.from('{}'));
    zip.addFile(`${name}/assets/minecraft/textures/blocks/stone.png`, texture);
  }
  zip.writeZip(filePath);
}

async function stageFixture(root) {
  const remoteRoot = path.join(root, 'remote');
  fs.mkdirSync(path.join(remoteRoot, 'packs-001'), { recursive: true });
  const files = ['One.zip', 'Two.zip'];
  await writeWrapped(path.join(remoteRoot, 'packs-001', files[0]), { r: 180, g: 50, b: 40 });
  await writeWrapped(path.join(remoteRoot, 'packs-001', files[1]), { r: 40, g: 80, b: 180 });
  const registry = Object.fromEntries(files.map(file => [file, {
    repo: 'packs-001', repoNum: 1,
    size: fs.statSync(path.join(remoteRoot, 'packs-001', file)).size,
  }]));
  const registryPath = path.join(root, 'registry.json');
  const siteIndexPath = path.join(root, 'index.json');
  const listsPath = path.join(root, 'lists.json');
  const extractedPath = path.join(root, 'extracted.json');
  const contentIndexPath = path.join(root, 'content-index.json');
  const manifestPath = path.join(root, 'manifest.json');
  const reviewPath = path.join(root, 'review.json');
  const auditPath = path.join(root, 'audit.json');
  fs.writeFileSync(registryPath, JSON.stringify(registry));
  fs.writeFileSync(siteIndexPath, JSON.stringify({ items: [] }));
  fs.writeFileSync(listsPath, JSON.stringify([]));
  fs.writeFileSync(extractedPath, JSON.stringify([]));
  const audit = await auditRegistry({
    registryPath, siteIndexPath, listsPath, extractedPath, contentIndexPath,
    manifestPath, auditPath,
    summaryPath: path.join(root, 'summary.md'), workdir: path.join(root, 'audit-work'),
  }, {
    remote: {
      async downloadArchive({ repo, file, destination }) {
        fs.copyFileSync(path.join(remoteRoot, repo, file), destination);
      },
    },
  });
  const packs = {};
  for (const file of files) {
    const product = audit.manifest.entries.find(entry => entry.file === file).normalization.products[0];
    packs[file] = {
      packId: file.replace(/\.zip$/, ''), ...registry[file],
      sourceKey: `${registry[file].repo}/${file}`,
      archiveSha256: audit.manifest.entries.find(entry => entry.file === file).source.archiveSha256,
      visualContentHash: product.visualContentHash,
      visualEntryCount: product.visualEntryCount,
      swords: product.swords || {},
    };
  }
  fs.writeFileSync(contentIndexPath, JSON.stringify({
    schemaVersion: 1, fingerprintSchemaVersion: 1,
    registryDigest: computeRegistryDigest(registry), complete: true, failures: [], packs,
  }));
  const review = buildReview(audit.manifest, registry, { authenticated: true }, {
    listsPath, repoStatePath: path.join(root, 'repo-state.json'),
    maxRepoSize: 5 * 1024 * 1024 * 1024, githubFileLimit: 100 * 1024 * 1024,
  });
  review.reviewed = true;
  review.entries[1].storagePlan.targetRepo = 'packs-003';
  review.entries[1].storagePlan.targetRepoNum = 3;
  review.reviewDigest = computeReviewDigest(review);
  review.approvalDigest = computeApprovalDigest(review);
  fs.writeFileSync(reviewPath, JSON.stringify(review));
  const calls = [];
  const remote = {
    async downloadArchive({ repo, file, destination }) {
      calls.push(`download:${repo}/${file}`);
      fs.copyFileSync(path.join(remoteRoot, repo, file), destination);
    },
    async getArchiveIdentity({ repo, file }) {
      const target = path.join(remoteRoot, repo, file);
      if (!fs.existsSync(target)) return null;
      return { size: fs.statSync(target).size, archiveSha256: hash(target) };
    },
    async publishArchive({ repo, file, path: sourcePath }) {
      calls.push(`publish:${repo}/${file}`);
      const target = path.join(remoteRoot, repo, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(sourcePath, target);
    },
    async verifyArchive(identity) {
      const actual = await remote.getArchiveIdentity(identity);
      assert.ok(actual);
      assert.equal(actual.size, identity.size);
      assert.equal(actual.archiveSha256, identity.archiveSha256);
    },
  };
  return {
    registry,
    review,
    calls,
    remote,
    remoteRoot,
    paths: {
      registryPath, siteIndexPath, listsPath, extractedPath, contentIndexPath,
      manifestPath, reviewPath, auditPath, statePath: path.join(root, 'state.json'),
      singleStatePath: path.join(root, 'single-state.json'),
      collectionStatePath: path.join(root, 'collection-state.json'),
      illegalStatePath: path.join(root, 'illegal-state.json'),
      workdir: path.join(root, 'work'),
    },
  };
}

async function mixedFixture(root) {
  const remoteRoot = path.join(root, 'remote');
  fs.mkdirSync(path.join(remoteRoot, 'packs-001'), { recursive: true });
  const bundlePath = path.join(remoteRoot, 'packs-001', 'Bundle.zip');
  const illegalPath = path.join(remoteRoot, 'packs-001', 'Illegal.zip');
  await writeCollection(bundlePath);
  const illegal = new AdmZip();
  illegal.addFile('readme.txt', Buffer.from('not a resource pack'));
  illegal.writeZip(illegalPath);
  const registry = {
    'Bundle.zip': { repo: 'packs-001', repoNum: 1, size: fs.statSync(bundlePath).size },
    'Illegal.zip': { repo: 'packs-001', repoNum: 1, size: fs.statSync(illegalPath).size },
  };
  const registryPath = path.join(root, 'registry.json');
  const siteIndexPath = path.join(root, 'index.json');
  const listsPath = path.join(root, 'lists.json');
  const extractedPath = path.join(root, 'extracted.json');
  const contentIndexPath = path.join(root, 'content-index.json');
  const manifestPath = path.join(root, 'manifest.json');
  const reviewPath = path.join(root, 'review.json');
  const auditPath = path.join(root, 'audit.json');
  fs.writeFileSync(registryPath, JSON.stringify(registry));
  fs.writeFileSync(siteIndexPath, JSON.stringify({ items: [{ name: 'Bundle' }, { name: 'Illegal' }] }));
  fs.writeFileSync(listsPath, JSON.stringify([{ name: 'Sakyvo', packs: ['Bundle', 'Illegal'] }]));
  fs.writeFileSync(extractedPath, JSON.stringify([
    { originalName: 'Bundle', packId: 'Bundle' },
    { originalName: 'Illegal', packId: 'Illegal' },
  ]));
  const download = async ({ repo, file, destination }) => {
    fs.copyFileSync(path.join(remoteRoot, repo, file), destination);
  };
  const audit = await auditRegistry({
    registryPath, siteIndexPath, listsPath, extractedPath, contentIndexPath,
    manifestPath, auditPath, summaryPath: path.join(root, 'summary.md'),
    workdir: path.join(root, 'audit-work'),
  }, { remote: { downloadArchive: download } });
  const bundle = audit.manifest.entries.find(entry => entry.file === 'Bundle.zip');
  const illegalEntry = audit.manifest.entries.find(entry => entry.file === 'Illegal.zip');
  fs.writeFileSync(contentIndexPath, JSON.stringify({
    schemaVersion: 1, fingerprintSchemaVersion: 1,
    registryDigest: computeRegistryDigest(registry), complete: true, failures: [],
    packs: {
      'Bundle.zip': {
        packId: 'Bundle', ...registry['Bundle.zip'], sourceKey: 'bundle-source',
        archiveSha256: bundle.source.archiveSha256, visualContentHash: 'bundle-parent',
        visualEntryCount: 0, swords: {},
      },
      'Illegal.zip': {
        packId: 'Illegal', ...registry['Illegal.zip'], sourceKey: 'illegal-source',
        archiveSha256: illegalEntry.source.archiveSha256, visualContentHash: 'illegal-source',
        visualEntryCount: 0, swords: {},
      },
    },
  }));
  const review = buildReview(audit.manifest, registry, { authenticated: true }, {
    listsPath, repoStatePath: path.join(root, 'repo-state.json'),
    maxRepoSize: 5 * 1024 * 1024 * 1024, githubFileLimit: 100 * 1024 * 1024,
  });
  review.reviewed = true;
  review.approvalDigest = computeApprovalDigest(review);
  fs.writeFileSync(reviewPath, JSON.stringify(review));
  const calls = [];
  const remote = {
    downloadArchive: download,
    async getArchiveIdentity({ repo, file }) {
      const target = path.join(remoteRoot, repo, file);
      return fs.existsSync(target) ? { size: fs.statSync(target).size, archiveSha256: hash(target) } : null;
    },
    async publishArchive({ repo, file, path: sourcePath }) {
      calls.push(`publish:${repo}/${file}`);
      const target = path.join(remoteRoot, repo, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(sourcePath, target);
    },
    async verifyArchive(identity) {
      const actual = await remote.getArchiveIdentity(identity);
      assert.ok(actual);
      assert.equal(actual.archiveSha256, identity.archiveSha256);
    },
    async deleteArchive({ repo, file }) {
      calls.push(`delete:${repo}/${file}`);
      fs.rmSync(path.join(remoteRoot, repo, file), { force: true });
    },
  };
  return {
    audit,
    calls,
    remote,
    remoteRoot,
    paths: {
      registryPath, siteIndexPath, listsPath, extractedPath, contentIndexPath, manifestPath, reviewPath, auditPath,
      statePath: path.join(root, 'state.json'), singleStatePath: path.join(root, 'single-state.json'),
      collectionStatePath: path.join(root, 'collection-state.json'), illegalStatePath: path.join(root, 'illegal-state.json'),
      tombstonePath: path.join(root, 'tombstones.json'), workdir: path.join(root, 'work'),
    },
  };
}

test('rejects unapproved or tampered review before creating state or calling remote', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-reviewed-gate-'));
  try {
    const fixtureData = fixture(root);
    const calls = [];
    const remote = {
      async getArchiveIdentity() { calls.push('get'); return null; },
      async publishArchive() { calls.push('publish'); },
    };
    const base = {
      ...fixtureData.paths,
      manifest: fixtureData.manifest,
      review: fixtureData.review,
      phase: 'stage',
      targetRepo: { repo: 'packs-002', repoNum: 2 },
      workdir: path.join(root, 'work'),
    };
    await assert.rejects(
      () => runReviewedMigration(base, { remote }),
      /review.*approved|reviewed/i
    );
    assert.equal(fs.existsSync(fixtureData.paths.statePath), false);
    assert.deepEqual(calls, []);

    const tampered = JSON.parse(JSON.stringify(fixtureData.review));
    tampered.reviewed = true;
    tampered.entries[0].sourceArchiveSha256 = 'changed-source';
    tampered.approvalDigest = computeApprovalDigest(tampered);
    await assert.rejects(
      () => runReviewedMigration({ ...base, review: tampered }, { remote }),
      /review.*digest|source.*evidence|tamper/i
    );
    assert.equal(fs.existsSync(fixtureData.paths.statePath), false);
    assert.deepEqual(calls, []);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('requires an approved decision for every dangling List reference before staging', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-reviewed-list-gate-'));
  try {
    const data = await stageFixture(root);
    fs.writeFileSync(data.paths.listsPath, JSON.stringify([{ name: 'Sakyvo', packs: ['Legacy'] }]));
    const manifest = JSON.parse(fs.readFileSync(data.paths.manifestPath, 'utf8'));
    const review = buildReview(manifest, data.registry, { authenticated: true }, {
      listsPath: data.paths.listsPath,
      repoStatePath: path.join(root, 'repo-state.json'),
      maxRepoSize: 5 * 1024 * 1024 * 1024,
      githubFileLimit: 100 * 1024 * 1024,
    });
    review.reviewed = true;
    review.approvalDigest = computeApprovalDigest(review);

    await assert.rejects(
      () => runReviewedMigration({
        ...data.paths, manifest, review, phase: 'stage',
      }, { remote: data.remote }),
      /List.*decision.*Legacy|Legacy.*decision/i
    );
    assert.deepEqual(data.calls, []);
    assert.equal(fs.existsSync(data.paths.singleStatePath), false);

    review.catalogReconciliation.listReferences.dangling[0].decision = {
      action: 'replace',
      targetPackId: 'One',
      reason: 'reviewed legacy pack ID migration',
    };
    review.approvalDigest = computeApprovalDigest(review);
    const options = { ...data.paths, manifest, review, phase: 'stage' };
    await runReviewedMigration(options, { remote: data.remote });
    await runReviewedMigration({ ...options, phase: 'prepare-site' }, {
      remote: data.remote,
      prepareAssets: async () => {},
      generateCatalog: async () => {},
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(data.paths.listsPath, 'utf8'))[0].packs, ['One']);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('stages approved one-product entries using each reviewed repository plan', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-reviewed-stage-'));
  try {
    const data = await stageFixture(root);
    const beforeRegistry = fs.readFileSync(data.paths.registryPath, 'utf8');
    const state = await runReviewedMigration({
      ...data.paths,
      manifestPath: data.paths.manifestPath,
      reviewPath: data.paths.reviewPath,
      phase: 'stage',
      targetRepo: { repo: 'packs-999', repoNum: 999 },
    }, { remote: data.remote });
    assert.deepEqual(data.calls.filter(call => call.startsWith('publish:')).sort(), [
      'publish:packs-002/One.zip',
      'publish:packs-003/Two.zip',
    ]);
    assert.ok(state.single);
    assert.deepEqual(state.single.entries.map(entry => entry.status), ['staged_verified', 'staged_verified']);
    assert.equal(fs.readFileSync(data.paths.registryPath, 'utf8'), beforeRegistry);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('preflights every reviewed source hash before publishing the first staged archive', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-reviewed-source-preflight-'));
  try {
    const data = await stageFixture(root);
    const source = path.join(data.remoteRoot, 'packs-001', 'Two.zip');
    const bytes = fs.readFileSync(source);
    bytes[bytes.length - 1] ^= 0xff;
    fs.writeFileSync(source, bytes);

    await assert.rejects(
      () => runReviewedMigration({ ...data.paths, phase: 'stage' }, { remote: data.remote }),
      /source.*changed|source.*mismatch/i
    );
    assert.deepEqual(data.calls.filter(call => call.startsWith('publish:')), []);
    assert.equal(fs.existsSync(data.paths.singleStatePath), false);
    assert.equal(fs.existsSync(path.join(data.remoteRoot, 'packs-002', 'One.zip')), false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('prepares site only after staging and runs catalog preparation after state switches', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-reviewed-prepare-'));
  try {
    const data = await stageFixture(root);
    const events = [];
    const stageOptions = {
      ...data.paths,
      manifestPath: data.paths.manifestPath,
      reviewPath: data.paths.reviewPath,
      phase: 'stage',
      targetRepo: { repo: 'packs-999', repoNum: 999 },
    };
    await runReviewedMigration(stageOptions, { remote: data.remote });
    const prepared = await runReviewedMigration({
      ...stageOptions,
      phase: 'prepare-site',
    }, {
      remote: data.remote,
      prepareAssets: async () => { events.push('assets'); },
      generateCatalog: async () => { events.push('catalog'); },
    });
    assert.equal(prepared.single.entries.every(entry => entry.status === 'site_prepared'), true);
    assert.deepEqual(events, ['assets', 'catalog']);
    const nextRegistry = JSON.parse(fs.readFileSync(data.paths.registryPath, 'utf8'));
    assert.equal(nextRegistry['One.zip'].repo, 'packs-002');
    assert.equal(nextRegistry['Two.zip'].repo, 'packs-003');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('refuses site preparation without required asset and catalog generators', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-reviewed-generators-'));
  try {
    const data = await stageFixture(root);
    const options = { ...data.paths, phase: 'stage' };
    await runReviewedMigration(options, { remote: data.remote });
    const before = fs.readFileSync(data.paths.registryPath, 'utf8');
    await assert.rejects(
      () => runReviewedMigration({ ...options, phase: 'prepare-site' }, { remote: data.remote }),
      /asset.*catalog.*generator|required.*generator/i
    );
    assert.equal(fs.readFileSync(data.paths.registryPath, 'utf8'), before);
    assert.equal(JSON.parse(fs.readFileSync(data.paths.singleStatePath, 'utf8')).entries.every(entry => entry.status === 'staged_verified'), true);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('rejects out-of-order phases before touching assets or remote state', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-reviewed-order-'));
  try {
    const fx = await stageFixture(root);
    let assetCalls = 0;
    let remoteCalls = 0;
    const remote = {
      ...fx.remote,
      async getArchiveIdentity(identity) {
        remoteCalls++;
        return fx.remote.getArchiveIdentity(identity);
      },
    };
    await assert.rejects(
      runReviewedMigration({ ...fx.paths, phase: 'prepare-site' }, {
        remote,
        prepareAssets: async () => { assetCalls++; },
        generateCatalog: async () => {},
      }),
      /requires execution state staged_verified/
    );
    assert.equal(assetCalls, 0);
    assert.equal(remoteCalls, 0);

    remoteCalls = 0;
    await assert.rejects(
      runReviewedMigration({ ...fx.paths, phase: 'stage' }, {
        remote: {
          async getArchiveIdentity() {
            remoteCalls++;
            return null;
          },
        },
      }),
      /downloadArchive/
    );
    assert.equal(remoteCalls, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rolls back catalog JSON and sub-state when site generation fails', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-reviewed-rollback-'));
  try {
    const fx = await stageFixture(root);
    const generatedRoots = {
      thumbnailsRoot: path.join(root, 'thumbnails'),
      packDataRoot: path.join(root, 'packs'),
      packPageRoot: path.join(root, 'pages'),
      pagesRoot: path.join(root, 'page-data'),
      sbiShardRoot: path.join(root, 'sbi-fp'),
    };
    for (const directory of Object.values(generatedRoots)) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'before.txt'), 'before');
    }
    const legacySbiPath = path.join(root, 'sbi-fingerprints.json');
    fs.writeFileSync(legacySbiPath, 'legacy');
    const options = { ...fx.paths, ...generatedRoots, legacySbiPath, phase: 'stage' };
    await runReviewedMigration(options, { remote: fx.remote });
    const protectedPaths = [
      fx.paths.registryPath,
      fx.paths.contentIndexPath,
      fx.paths.listsPath,
      fx.paths.extractedPath,
      fx.paths.singleStatePath,
    ];
    const before = new Map(protectedPaths.map(filePath => [filePath, fs.readFileSync(filePath)]));
    await assert.rejects(
      runReviewedMigration({ ...options, phase: 'prepare-site' }, {
        remote: fx.remote,
        prepareAssets: async () => {
          fs.writeFileSync(fx.paths.extractedPath, '[{"changed":true}]');
          fs.writeFileSync(path.join(generatedRoots.thumbnailsRoot, 'before.txt'), 'changed');
          fs.writeFileSync(path.join(generatedRoots.thumbnailsRoot, 'new.txt'), 'new');
        },
        generateCatalog: async () => {
          fs.rmSync(path.join(generatedRoots.packDataRoot, 'before.txt'));
          fs.rmSync(legacySbiPath);
          throw new Error('generator failed');
        },
      }),
      /generator failed/
    );
    for (const filePath of protectedPaths) {
      assert.deepEqual(fs.readFileSync(filePath), before.get(filePath), `${path.basename(filePath)} was not rolled back`);
    }
    for (const directory of Object.values(generatedRoots)) {
      assert.equal(fs.readFileSync(path.join(directory, 'before.txt'), 'utf8'), 'before');
      assert.equal(fs.existsSync(path.join(directory, 'new.txt')), false);
    }
    assert.equal(fs.readFileSync(legacySbiPath, 'utf8'), 'legacy');
    const execution = JSON.parse(fs.readFileSync(fx.paths.statePath, 'utf8'));
    assert.equal(execution.status, 'staged_verified');
    assert.ok(execution.catalogBefore);
    assert.equal(fs.existsSync(path.join(root, '.pack-normalization-catalog-backup')), false);

    const prepared = await runReviewedMigration({ ...options, phase: 'prepare-site' }, {
      remote: fx.remote,
      prepareAssets: async () => {},
      generateCatalog: async () => {},
    });
    assert.equal(prepared.single.entries.every(entry => entry.status === 'site_prepared'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prepares collection products and illegal retirement without deleting source archives', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-reviewed-mixed-'));
  try {
    const data = await mixedFixture(root);
    const options = { ...data.paths, phase: 'stage' };
    await runReviewedMigration(options, { remote: data.remote });
    const prepared = await runReviewedMigration({ ...options, phase: 'prepare-site' }, {
      remote: data.remote,
      prepareAssets: async () => {},
      generateCatalog: async () => {},
    });
    assert.equal(prepared.collection.entries[0].status, 'site_prepared');
    assert.equal(prepared.illegal.entries[0].status, 'site_prepared');
    const registry = JSON.parse(fs.readFileSync(data.paths.registryPath, 'utf8'));
    assert.equal(registry['Bundle.zip'], undefined);
    assert.equal(registry['Illegal.zip'], undefined);
    assert.ok(registry['PackA.zip']);
    assert.ok(registry['PackB.zip']);
    assert.deepEqual(JSON.parse(fs.readFileSync(data.paths.listsPath, 'utf8'))[0].packs, ['PackA', 'PackB']);
    const tombstones = JSON.parse(fs.readFileSync(data.paths.tombstonePath, 'utf8'));
    assert.equal(tombstones.entries[0].label, '非法材质');
    assert.equal(fs.existsSync(path.join(data.remoteRoot, 'packs-001', 'Bundle.zip')), true);
    assert.equal(fs.existsSync(path.join(data.remoteRoot, 'packs-001', 'Illegal.zip')), true);
    assert.deepEqual(data.calls.filter(call => call.startsWith('delete:')), []);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('blocks cleanup until deployment verification and reconciles retained remote files', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-reviewed-cleanup-'));
  try {
    const data = await mixedFixture(root);
    const options = { ...data.paths, phase: 'stage' };
    await runReviewedMigration(options, { remote: data.remote });
    await runReviewedMigration({ ...options, phase: 'prepare-site' }, {
      remote: data.remote,
      prepareAssets: async () => {},
      generateCatalog: async () => {},
    });
    await assert.rejects(
      () => runReviewedMigration({ ...options, phase: 'verify-deployment' }, {
        remote: data.remote,
        verifyCatalogDeployment: async () => false,
        verifyDeployment: async () => true,
      }),
      /deployment verification failed/i
    );
    assert.equal(JSON.parse(fs.readFileSync(data.paths.collectionStatePath, 'utf8')).entries[0].status, 'site_prepared');
    assert.equal(JSON.parse(fs.readFileSync(data.paths.illegalStatePath, 'utf8')).entries[0].status, 'site_prepared');
    assert.deepEqual(data.calls.filter(call => call.startsWith('delete:')), []);

    const verified = await runReviewedMigration({ ...options, phase: 'verify-deployment' }, {
      remote: data.remote,
      verifyCatalogDeployment: async () => true,
      verifyDeployment: async () => true,
    });
    assert.equal(verified.collection.entries[0].status, 'deployed_verified');
    assert.equal(verified.illegal.entries[0].status, 'deployed_verified');

    const completed = await runReviewedMigration({ ...options, phase: 'cleanup' }, { remote: data.remote });
    assert.equal(completed.collection.entries[0].status, 'complete');
    assert.equal(completed.illegal.entries[0].status, 'complete');
    assert.equal(completed.reconciliation.registryCount, 2);
    assert.equal(completed.reconciliation.remoteVerified, 2);
    let active = 0;
    let maxActive = 0;
    const concurrentRemote = {
      async getArchiveIdentity(identity) {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 20));
        try {
          return await data.remote.getArchiveIdentity(identity);
        } finally {
          active--;
        }
      },
    };
    const concurrent = await reconcileFinalState(
      { ...data.paths, finalReconciliationConcurrency: 2 },
      { remote: concurrentRemote }
    );
    assert.equal(concurrent.remoteVerified, 2);
    assert.equal(maxActive, 2);
    const reconciliationStatePath = path.join(root, 'reconciliation-state.json');
    let firstRunCalls = 0;
    await assert.rejects(
      reconcileFinalState({
        ...data.paths,
        finalReconciliationConcurrency: 1,
        finalReconciliationStatePath: reconciliationStatePath,
      }, {
        remote: {
          getRepositoryReference: async repo => `head-${repo}`,
          async getArchiveIdentity(identity) {
            firstRunCalls++;
            if (firstRunCalls === 2) throw new Error('transient remote failure');
            return data.remote.getArchiveIdentity(identity);
          },
        },
      }),
      /transient remote failure/
    );
    const checkpoint = JSON.parse(fs.readFileSync(reconciliationStatePath, 'utf8'));
    assert.equal(Object.keys(checkpoint.verified).length, 1);
    let resumedCalls = 0;
    const resumed = await reconcileFinalState({
      ...data.paths,
      finalReconciliationConcurrency: 1,
      finalReconciliationStatePath: reconciliationStatePath,
    }, {
      remote: {
        getRepositoryReference: async repo => `head-${repo}`,
        async getArchiveIdentity(identity) {
          resumedCalls++;
          return data.remote.getArchiveIdentity(identity);
        },
      },
    });
    assert.equal(resumed.remoteVerified, 2);
    assert.equal(resumedCalls, 1);
    assert.equal(fs.existsSync(reconciliationStatePath), false);
    const executionState = JSON.parse(fs.readFileSync(data.paths.statePath, 'utf8'));
    assert.equal(executionState.reviewedArtifactDigest, completed.reviewedArtifactDigest);
    assert.equal(executionState.status, 'complete');
    assert.deepEqual(executionState.finalReconciliation, completed.reconciliation);
    assert.ok(executionState.catalogDiff.some(entry => entry.path === data.paths.registryPath && entry.changed));
    const audit = JSON.parse(fs.readFileSync(data.paths.auditPath, 'utf8'));
    assert.equal(audit.entries.find(entry => entry.remoteIdentity.file === 'Bundle.zip').lifecycle.status, 'complete');
    assert.equal(audit.entries.find(entry => entry.remoteIdentity.file === 'Illegal.zip').lifecycle.status, 'complete');
    assert.equal(fs.existsSync(path.join(data.remoteRoot, 'packs-001', 'Bundle.zip')), false);
    assert.equal(fs.existsSync(path.join(data.remoteRoot, 'packs-001', 'Illegal.zip')), false);
    assert.equal(fs.existsSync(path.join(data.remoteRoot, 'packs-002', 'PackA.zip')), true);
    assert.equal(fs.existsSync(path.join(data.remoteRoot, 'packs-002', 'PackB.zip')), true);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('final reconciliation validates generated download routes and SBI shard sizes', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-reviewed-reconcile-'));
  try {
    const registry = { 'One.zip': { repo: 'packs-002', repoNum: 2, size: 12 } };
    const registryPath = path.join(root, 'registry.json');
    const contentIndexPath = path.join(root, 'content-index.json');
    const listsPath = path.join(root, 'lists.json');
    const siteIndexPath = path.join(root, 'index.json');
    const packDataRoot = path.join(root, 'packs');
    const packPageRoot = path.join(root, 'pages');
    const sbiShardRoot = path.join(root, 'sbi-fp');
    fs.mkdirSync(packDataRoot, { recursive: true });
    fs.mkdirSync(path.join(packPageRoot, 'One'), { recursive: true });
    fs.mkdirSync(sbiShardRoot, { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify(registry));
    fs.writeFileSync(listsPath, JSON.stringify([{ name: 'Sakyvo', packs: ['One'] }]));
    fs.writeFileSync(siteIndexPath, JSON.stringify({ items: [{ id: 'One', name: 'One' }] }));
    fs.writeFileSync(path.join(packPageRoot, 'One', 'index.html'), 'pack');
    fs.writeFileSync(contentIndexPath, JSON.stringify({
      schemaVersion: 1, fingerprintSchemaVersion: 1,
      registryDigest: computeRegistryDigest(registry), complete: true, failures: [],
      packs: {
        'One.zip': {
          packId: 'One', ...registry['One.zip'], archiveSha256: 'one-hash',
          visualContentHash: 'one-visual', visualEntryCount: 1, swords: {},
        },
      },
    }));
    fs.writeFileSync(path.join(packDataRoot, 'One.json'), JSON.stringify({
      id: 'One', name: 'One', downloads: { github: 'https://example.invalid/One.zip' },
    }));
    fs.writeFileSync(path.join(sbiShardRoot, 'one.json'), 'abc');
    fs.writeFileSync(path.join(sbiShardRoot, 'meta.json'), JSON.stringify({
      shards: { sword: { buckets: [{ file: 'one.json', bytes: 3 }] } },
    }));
    const options = {
      registryPath, contentIndexPath, listsPath, siteIndexPath,
      packDataRoot, packPageRoot, sbiShardRoot, maxSbiShardBytes: 2,
      legacySbiPath: path.join(root, 'sbi-fingerprints.json'),
    };
    const services = {
      remote: {
        async getArchiveIdentity() { return { size: 12, archiveSha256: 'one-hash' }; },
      },
    };
    await assert.rejects(() => reconcileFinalState(options, services), /download URL/i);

    fs.writeFileSync(path.join(packDataRoot, 'One.json'), JSON.stringify({
      id: 'One', name: 'One',
      downloads: { github: 'https://raw.githubusercontent.com/Sakyvo/packs-002/main/resourcepacks/One.zip' },
    }));
    await assert.rejects(() => reconcileFinalState(options, services), /SBI shard.*limit/i);
    const result = await reconcileFinalState({ ...options, maxSbiShardBytes: 4 }, services);
    assert.equal(result.generatedPackCount, 1);
    assert.equal(result.sbiShardCount, 1);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
