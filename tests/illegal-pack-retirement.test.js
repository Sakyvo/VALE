const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');
const { computeRegistryDigest, sourceKey } = require('../scripts/lib/pack-content-index');
const { auditRegistry } = require('../scripts/audit-pack-normalization');
const { NORMALIZATION_SCHEMA_VERSION } = require('../scripts/lib/pack-normalizer');
const { runIllegalRetirement } = require('../scripts/retire-illegal-pack');

function hash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function writeIllegalArchive(filePath) {
  const zip = new AdmZip();
  zip.addFile('readme.txt', Buffer.from('not a resource pack'));
  zip.writeZip(filePath);
}

test('retires registered illegal material in two phases and leaves a tombstone', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-illegal-retirement-'));
  try {
    const archive = path.join(root, 'Illegal.zip');
    await writeIllegalArchive(archive);
    const registry = { 'Illegal.zip': { repo: 'packs-001', repoNum: 1, size: fs.statSync(archive).size } };
    const registryPath = path.join(root, 'registry.json');
    const siteIndexPath = path.join(root, 'index.json');
    const listsPath = path.join(root, 'lists.json');
    const extractedPath = path.join(root, 'extracted.json');
    const contentIndexPath = path.join(root, 'content-index.json');
    const thumbnailsRoot = path.join(root, 'thumbnails');
    const packDataRoot = path.join(root, 'packs');
    const packPageRoot = path.join(root, 'pages');
    const sbiPath = path.join(root, 'sbi.json');
    const statePath = path.join(root, 'retirement-state.json');
    const tombstonePath = path.join(root, 'tombstones.json');
    fs.writeFileSync(registryPath, JSON.stringify(registry));
    fs.writeFileSync(siteIndexPath, JSON.stringify({ items: [{ name: 'Illegal', route: '/p/Illegal/' }] }));
    fs.writeFileSync(listsPath, JSON.stringify([{ name: 'Sakyvo', packs: ['Illegal', 'Keep'] }, { name: 'Overlay', packs: ['Illegal'] }]));
    fs.writeFileSync(extractedPath, JSON.stringify([{ originalName: 'Illegal', packId: 'Illegal' }]));
    fs.mkdirSync(path.join(thumbnailsRoot, 'Illegal'), { recursive: true });
    fs.writeFileSync(path.join(thumbnailsRoot, 'Illegal', 'stone.png'), 'old');
    fs.mkdirSync(packDataRoot, { recursive: true });
    fs.writeFileSync(path.join(packDataRoot, 'Illegal.json'), '{}');
    fs.mkdirSync(path.join(packPageRoot, 'Illegal'), { recursive: true });
    fs.writeFileSync(path.join(packPageRoot, 'Illegal', 'index.html'), 'old');
    fs.writeFileSync(sbiPath, JSON.stringify({ Illegal: { old: true }, Keep: { old: false } }));

    const remoteRoot = path.join(root, 'remote', 'packs-001');
    fs.mkdirSync(remoteRoot, { recursive: true });
    fs.copyFileSync(archive, path.join(remoteRoot, 'Illegal.zip'));
    const calls = [];
    const remote = {
      async downloadArchive({ repo, file, destination }) {
        fs.copyFileSync(path.join(root, 'remote', repo, file), destination);
      },
      async getArchiveIdentity({ repo, file }) {
        const target = path.join(root, 'remote', repo, file);
        return fs.existsSync(target) ? { size: fs.statSync(target).size, archiveSha256: hash(target) } : null;
      },
      async deleteArchive({ repo, file }) {
        calls.push(`delete:${repo}/${file}`);
        fs.rmSync(path.join(root, 'remote', repo, file), { force: true });
      },
    };
    const audit = await auditRegistry({
      registryPath, siteIndexPath, listsPath, extractedPath,
      manifestPath: path.join(root, 'manifest.json'), auditPath: path.join(root, 'audit.json'),
      summaryPath: path.join(root, 'summary.md'), workdir: path.join(root, 'audit-work'),
    }, { remote });
    assert.equal(audit.manifest.entries[0].normalization.classification, 'illegal');
    fs.writeFileSync(contentIndexPath, JSON.stringify({
      schemaVersion: 1,
      fingerprintSchemaVersion: 1,
      registryDigest: computeRegistryDigest(registry),
      complete: true,
      failures: [],
      packs: {
        'Illegal.zip': {
          packId: 'Illegal', repo: 'packs-001', repoNum: 1, size: registry['Illegal.zip'].size,
          sourceKey: sourceKey('Illegal.zip', registry['Illegal.zip']), archiveSha256: hash(archive),
          visualContentHash: 'illegal-content', visualEntryCount: 0, swords: {},
        },
      },
    }));
    const options = {
      manifest: audit.manifest,
      registryPath, siteIndexPath, listsPath, extractedPath, contentIndexPath,
      thumbnailsRoot, packDataRoot, packPageRoot, sbiPath, statePath, tombstonePath,
      phase: 'prepare-site',
    };
    let state = await runIllegalRetirement(options, { remote });
    assert.equal(state.entries[0].status, 'site_prepared');
    assert.ok(JSON.parse(fs.readFileSync(registryPath, 'utf8'))['Illegal.zip'] === undefined);
    assert.deepEqual(JSON.parse(fs.readFileSync(listsPath, 'utf8')), [{ name: 'Sakyvo', packs: ['Keep'] }, { name: 'Overlay', packs: [] }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(siteIndexPath, 'utf8')).items, []);
    assert.equal(fs.existsSync(path.join(thumbnailsRoot, 'Illegal')), false);
    assert.equal(fs.existsSync(path.join(packDataRoot, 'Illegal.json')), false);
    assert.equal(fs.existsSync(path.join(packPageRoot, 'Illegal')), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(sbiPath, 'utf8')), { Keep: { old: false } });
    assert.equal(fs.existsSync(path.join(root, 'remote', 'packs-001', 'Illegal.zip')), true);
    assert.deepEqual(calls, []);

    state = await runIllegalRetirement(options, { remote });
    assert.equal(state.entries[0].status, 'site_prepared');
    assert.deepEqual(calls, []);

    await assert.rejects(() => runIllegalRetirement({ ...options, phase: 'verify-deployment' }, {
      remote,
      verifyDeployment: async () => false,
    }), /deployment verification failed/i);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).entries[0].status, 'site_prepared');
    assert.deepEqual(calls, []);

    state = await runIllegalRetirement({ ...options, phase: 'verify-deployment' }, {
      remote,
      verifyDeployment: async entry => {
        assert.equal(entry.packId, 'Illegal');
        return true;
      },
    });
    assert.equal(state.entries[0].status, 'deployed_verified');
    const remoteArchive = path.join(root, 'remote', 'packs-001', 'Illegal.zip');
    const originalBytes = fs.readFileSync(remoteArchive);
    const changedBytes = Buffer.from(originalBytes);
    changedBytes[changedBytes.length - 1] ^= 0xff;
    fs.writeFileSync(remoteArchive, changedBytes);
    await assert.rejects(
      () => runIllegalRetirement({ ...options, phase: 'cleanup' }, { remote }),
      /changed before cleanup/i
    );
    assert.deepEqual(calls, []);
    fs.writeFileSync(remoteArchive, originalBytes);
    state = await runIllegalRetirement({ ...options, phase: 'cleanup' }, { remote });
    assert.equal(state.entries[0].status, 'complete');
    assert.deepEqual(calls, ['delete:packs-001/Illegal.zip']);
    assert.equal(fs.existsSync(path.join(root, 'remote', 'packs-001', 'Illegal.zip')), false);
    const tombstones = JSON.parse(fs.readFileSync(tombstonePath, 'utf8'));
    assert.equal(tombstones.entries[0].file, 'Illegal.zip');
    assert.equal(tombstones.entries[0].status, 'complete');
    assert.equal(tombstones.entries[0].source.archiveSha256, hash(archive));
    state = await runIllegalRetirement({ ...options, phase: 'cleanup' }, { remote });
    assert.equal(state.entries[0].status, 'complete');
    assert.deepEqual(calls, ['delete:packs-001/Illegal.zip']);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('resumes an already-absent illegal archive after deployment verification', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-illegal-already-absent-'));
  try {
    const statePath = path.join(root, 'state.json');
    const tombstonePath = path.join(root, 'tombstones.json');
    const manifest = {
      schemaVersion: 1,
      normalizationSchemaVersion: NORMALIZATION_SCHEMA_VERSION,
      registryDigest: 'registry-digest',
      evidenceDigest: 'evidence-digest',
      entries: [],
    };
    fs.writeFileSync(statePath, JSON.stringify({
      schemaVersion: 1,
      normalizationSchemaVersion: NORMALIZATION_SCHEMA_VERSION,
      manifestEvidenceDigest: manifest.evidenceDigest,
      manifestRegistryDigest: manifest.registryDigest,
      entries: [{
        file: 'Illegal.zip',
        packId: 'Illegal',
        causes: ['coreless'],
        status: 'deployed_verified',
        source: {
          file: 'Illegal.zip', repo: 'packs-001', repoNum: 1, size: 123,
          registrySize: 123, archiveSha256: 'archive-sha', sourceKey: 'source-key',
        },
        visibility: { packId: 'Illegal', public: true, lists: ['Sakyvo'] },
        lifecycle: { planned: '2026-01-01T00:00:00.000Z', deployed_verified: '2026-01-02T00:00:00.000Z' },
      }],
    }));
    let deletes = 0;
    const state = await runIllegalRetirement({
      manifest,
      statePath,
      tombstonePath,
      registryPath: path.join(root, 'registry.json'),
      contentIndexPath: path.join(root, 'content-index.json'),
      siteIndexPath: path.join(root, 'index.json'),
      listsPath: path.join(root, 'lists.json'),
      extractedPath: path.join(root, 'extracted.json'),
      phase: 'cleanup',
    }, {
      remote: {
        async getArchiveIdentity() { return null; },
        async deleteArchive() { deletes += 1; },
      },
    });
    assert.equal(state.entries[0].status, 'complete');
    assert.equal(deletes, 0);
    const tombstones = JSON.parse(fs.readFileSync(tombstonePath, 'utf8'));
    assert.equal(tombstones.entries[0].label, '非法材质');
    assert.equal(tombstones.entries[0].status, 'complete');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
