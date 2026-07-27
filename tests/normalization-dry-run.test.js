const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');
const sharp = require('sharp');
const { computeRegistryDigest, sourceKey } = require('../scripts/lib/pack-content-index');
const { fingerprintPack } = require('../scripts/lib/pack-content-fingerprint');
const { normalizePack } = require('../scripts/lib/pack-normalizer');
const {
  buildReview,
  renderReviewSummary,
  runNormalizationDryRun,
  runPreflight,
} = require('../scripts/run-normalization-dry-run');

function hash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function writeNormal(filePath, wrapped = false) {
  const color = wrapped
    ? { r: 180, g: 70, b: 40, alpha: 1 }
    : { r: 80, g: 120, b: 180, alpha: 1 };
  const texture = await sharp({ create: { width: 8, height: 8, channels: 4, background: color } }).png().toBuffer();
  const zip = new AdmZip();
  const prefix = wrapped ? 'Inner/' : '';
  zip.addFile(`${prefix}pack.mcmeta`, Buffer.from('{}'));
  zip.addFile(`${prefix}assets/minecraft/textures/blocks/stone.png`, texture);
  zip.writeZip(filePath);
}

test('runs a complete read-only registry dry-run with review-bound evidence', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-normalization-dry-run-'));
  try {
    const remoteRoot = path.join(root, 'remote');
    fs.mkdirSync(remoteRoot, { recursive: true });
    const normalPath = path.join(remoteRoot, 'Normal.zip');
    const wrappedPath = path.join(remoteRoot, 'Wrapped.zip');
    const illegalPath = path.join(remoteRoot, 'Illegal.zip');
    await writeNormal(normalPath);
    await writeNormal(wrappedPath, true);
    const illegal = new AdmZip();
    illegal.addFile('readme.txt', Buffer.from('not a pack'));
    illegal.writeZip(illegalPath);
    const registry = {
      'Normal.zip': { repo: 'packs-001', repoNum: 1, size: fs.statSync(normalPath).size },
      'Wrapped.zip': { repo: 'packs-001', repoNum: 1, size: fs.statSync(wrappedPath).size },
      'Illegal.zip': { repo: 'packs-001', repoNum: 1, size: fs.statSync(illegalPath).size },
    };
    const registryPath = path.join(root, 'registry.json');
    const siteIndexPath = path.join(root, 'index.json');
    const listsPath = path.join(root, 'lists.json');
    const extractedPath = path.join(root, 'extracted.json');
    const contentIndexPath = path.join(root, 'content-index.json');
    const manifestPath = path.join(root, 'manifest.json');
    const auditPath = path.join(root, 'audit.json');
    const summaryPath = path.join(root, 'summary.md');
    const reviewPath = path.join(root, 'review.json');
    const workdir = path.join(root, 'audit-work');
    fs.writeFileSync(registryPath, JSON.stringify(registry));
    fs.writeFileSync(siteIndexPath, JSON.stringify({ items: [{ name: 'Normal' }] }));
    fs.writeFileSync(listsPath, JSON.stringify([{ name: 'Sakyvo', packs: ['Normal'] }]));
    fs.writeFileSync(extractedPath, JSON.stringify([{ originalName: 'Normal', packId: 'Normal' }]));
    const normalized = await normalizePack(wrappedPath, { outputDir: path.join(root, 'normalized') });
    const normalFingerprint = await fingerprintPack(normalPath);
    const wrappedFingerprint = await fingerprintPack(normalized.products[0].path);
    fs.writeFileSync(contentIndexPath, JSON.stringify({
      schemaVersion: 1,
      fingerprintSchemaVersion: 1,
      registryDigest: computeRegistryDigest(registry),
      complete: true,
      failures: [],
      packs: {
        'Normal.zip': { packId: 'Normal', ...registry['Normal.zip'], sourceKey: sourceKey('Normal.zip', registry['Normal.zip']), ...normalFingerprint },
        'Wrapped.zip': { packId: 'Wrapped', ...registry['Wrapped.zip'], sourceKey: sourceKey('Wrapped.zip', registry['Wrapped.zip']), ...wrappedFingerprint },
        'Illegal.zip': { packId: 'Illegal', ...registry['Illegal.zip'], sourceKey: sourceKey('Illegal.zip', registry['Illegal.zip']), archiveSha256: hash(illegalPath), visualContentHash: 'illegal', visualEntryCount: 0, swords: {} },
      },
    }));
    const before = [registryPath, siteIndexPath, listsPath, extractedPath, contentIndexPath].map(hash);
    const calls = [];
    let failAfter = null;
    let downloadCount = 0;
    const resumedFiles = [];
    const remote = {
      async downloadArchive({ file, destination }) {
        downloadCount++;
        if (failAfter && downloadCount === failAfter) throw new Error('simulated download interruption');
        calls.push(`download:${file}`);
        fs.copyFileSync(path.join(remoteRoot, file), destination);
      },
      async publishArchive() { calls.push('publish'); },
      async deleteArchive() { calls.push('delete'); },
    };
    const options = {
      registryPath, siteIndexPath, listsPath, extractedPath, contentIndexPath,
      manifestPath, auditPath, summaryPath, reviewPath, workdir,
      checkpointPath: path.join(root, 'checkpoint.json'),
      repoStatePath: path.join(root, 'repo-state.json'),
    };
    fs.writeFileSync(options.repoStatePath, JSON.stringify({ schemaVersion: 1, fullRepoNums: [1] }));
    const first = await runNormalizationDryRun(options, {
      remote,
      checkAuth: async () => true,
      listTrackedArchives: () => [],
    });
    assert.equal(first.review.reviewed, false);
    assert.equal(first.review.registryDigest, computeRegistryDigest(registry));
    assert.equal(first.review.entries.length, 3);
    const normal = first.manifest.entries.find(entry => entry.file === 'Normal.zip');
    assert.equal(normal.normalization.products[0].fingerprintSource, 'content_index');
    const wrapped = first.review.entries.find(entry => entry.file === 'Wrapped.zip');
    assert.equal(wrapped.action, 'migrate');
    assert.equal(wrapped.storagePlan.targetRepo, 'packs-002');
    const illegalEntry = first.review.entries.find(entry => entry.file === 'Illegal.zip');
    assert.equal(illegalEntry.action, 'retire');
    assert.deepEqual(calls.sort(), ['download:Illegal.zip', 'download:Normal.zip', 'download:Wrapped.zip']);
    assert.deepEqual([registryPath, siteIndexPath, listsPath, extractedPath, contentIndexPath].map(hash), before);
    assert.equal(fs.existsSync(workdir), false);
    assert.equal(first.executionEligible, false);
    assert.equal(fs.existsSync(options.checkpointPath), false);
    const firstReview = fs.readFileSync(reviewPath, 'utf8');
    const firstSummary = fs.readFileSync(summaryPath, 'utf8');
    const second = await runNormalizationDryRun(options, {
      remote,
      checkAuth: async () => true,
      listTrackedArchives: () => [],
    });
    assert.equal(fs.readFileSync(reviewPath, 'utf8'), firstReview);
    assert.equal(fs.readFileSync(summaryPath, 'utf8'), firstSummary);
    assert.equal(second.executionEligible, false);
    assert.equal(calls.length, 6);

    failAfter = 2;
    downloadCount = 0;
    await assert.rejects(
      () => runNormalizationDryRun(options, { remote, checkAuth: async () => true, listTrackedArchives: () => [] }),
      /simulated download interruption/
    );
    assert.equal(fs.existsSync(options.checkpointPath), true);
    failAfter = null;
    downloadCount = 0;
    await runNormalizationDryRun(options, {
      remote,
      checkAuth: async () => true,
      listTrackedArchives: () => [],
      onProgress: ({ file, resumed }) => { if (resumed) resumedFiles.push(file); },
    });
    assert.ok(resumedFiles.includes('Illegal.zip'));
    assert.equal(fs.existsSync(options.checkpointPath), false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('checkpoint recovery never authorizes deleting an unknown audit workspace', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-normalization-preflight-'));
  try {
    const registryPath = path.join(root, 'registry.json');
    const contentIndexPath = path.join(root, 'content-index.json');
    const workdir = path.join(root, 'audit-work');
    const checkpointPath = path.join(root, 'checkpoint.json');
    const registry = { 'A.zip': { repo: 'packs-001', repoNum: 1, size: 10 } };
    fs.writeFileSync(registryPath, JSON.stringify(registry));
    fs.writeFileSync(contentIndexPath, JSON.stringify({
      schemaVersion: 1,
      fingerprintSchemaVersion: 1,
      registryDigest: computeRegistryDigest(registry),
      complete: true,
      failures: [],
      packs: { 'A.zip': { visualContentHash: 'visual-hash' } },
    }));
    fs.mkdirSync(workdir, { recursive: true });
    fs.writeFileSync(path.join(workdir, 'unexpected.txt'), 'do not delete');
    fs.writeFileSync(checkpointPath, '{}');

    await assert.rejects(() => runPreflight({
      registryPath,
      contentIndexPath,
      workdir,
      checkpointPath,
    }, {
      checkAuth: async () => true,
      listTrackedArchives: () => [],
    }), /Audit workspace already exists/);
    assert.equal(fs.readFileSync(path.join(workdir, 'unexpected.txt'), 'utf8'), 'do not delete');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('review keeps existing Normal-pack conflicts and List anomalies explicit', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-normalization-review-'));
  try {
    const listsPath = path.join(root, 'lists.json');
    fs.writeFileSync(listsPath, JSON.stringify([
      { name: 'Sakyvo', packs: ['Normal', 'Normal', 'Missing'] },
    ]));
    const registry = {
      'Normal.zip': { repo: 'packs-001', repoNum: 1, size: 10 },
    };
    const manifest = {
      registryDigest: computeRegistryDigest(registry),
      evidenceDigest: 'evidence-digest',
      entries: [{
        file: 'Normal.zip',
        source: { archiveSha256: 'source-hash', size: 10, repoNum: 1 },
        visibility: { packId: 'Normal', public: true, lists: ['Sakyvo'], registryOnly: false },
        normalization: {
          classification: 'normal',
          collection: false,
          causes: [],
          products: [{
            file: 'Normal.zip', packId: 'Normal', size: 10,
            archiveSha256: 'source-hash', visualContentHash: 'visual-hash',
          }],
        },
        blockers: [{ code: 'content_duplicate_conflict' }],
        effects: { catalog: 'unchanged' },
      }],
    };
    const review = buildReview(manifest, registry, { authenticated: true }, {
      listsPath,
      repoStatePath: path.join(root, 'repo-state.json'),
      maxRepoSize: 5 * 1024 * 1024 * 1024,
    });

    assert.equal(review.entries[0].action, 'review_required');
    assert.deepEqual(review.catalogReconciliation.listReferences.duplicates, [
      { list: 'Sakyvo', packId: 'Normal', count: 2, plannedAction: 'deduplicate' },
    ]);
    assert.deepEqual(review.catalogReconciliation.listReferences.dangling, [
      { list: 'Sakyvo', packId: 'Missing', decision: null },
    ]);
    assert.equal(review.catalogReconciliation.reviewRequired, true);
    const summary = renderReviewSummary(review, manifest);
    assert.match(summary, /Normal-pack conflicts/i);
    assert.match(summary, /Sakyvo.*Missing/);
    assert.match(summary, /Sakyvo.*Normal.*deduplicate/);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
