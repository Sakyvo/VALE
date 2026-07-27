const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');
const sharp = require('sharp');
const { computeRegistryDigest, sourceKey } = require('../scripts/lib/pack-content-index');
const { auditRegistry } = require('../scripts/audit-pack-normalization');
const { runMigration } = require('../scripts/migrate-pack-normalization');

async function writeWrapped(filePath) {
  const texture = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 50, g: 100, b: 180, alpha: 1 } } }).png().toBuffer();
  const zip = new AdmZip();
  zip.addFile('Inner/pack.mcmeta', Buffer.from('{}'));
  zip.addFile('Inner/assets/minecraft/textures/blocks/stone.png', texture);
  zip.writeZip(filePath);
}

function hash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function createStageFixture(root) {
  const oldPath = path.join(root, 'Published.zip');
  await writeWrapped(oldPath);
  const registry = { 'Published.zip': { repo: 'packs-001', repoNum: 1, size: fs.statSync(oldPath).size } };
  const registryPath = path.join(root, 'registry.json');
  const siteIndexPath = path.join(root, 'index.json');
  const listsPath = path.join(root, 'lists.json');
  const extractedPath = path.join(root, 'extracted.json');
  const contentIndexPath = path.join(root, 'content-index.json');
  fs.writeFileSync(registryPath, JSON.stringify(registry));
  fs.writeFileSync(siteIndexPath, JSON.stringify({ items: [{ name: 'Published', uploadDate: '2020-01-02' }] }));
  fs.writeFileSync(listsPath, JSON.stringify([{ name: 'Sakyvo', packs: ['Published'] }]));
  fs.writeFileSync(extractedPath, JSON.stringify([{ originalName: 'Published', packId: 'Published' }]));
  const remoteRoot = path.join(root, 'remote');
  fs.mkdirSync(path.join(remoteRoot, 'packs-001'), { recursive: true });
  fs.copyFileSync(oldPath, path.join(remoteRoot, 'packs-001', 'Published.zip'));
  const calls = [];
  const remote = {
    async downloadArchive({ repo, file, destination }) {
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
      if (!actual || actual.size !== identity.size || actual.archiveSha256 !== identity.archiveSha256) {
        throw new Error('staged verification failed');
      }
    },
    async deleteArchive({ repo, file }) {
      calls.push(`delete:${repo}/${file}`);
      fs.rmSync(path.join(remoteRoot, repo, file), { force: true });
    },
  };
  const auditOptions = {
    registryPath,
    siteIndexPath,
    listsPath,
    extractedPath,
    contentIndexPath,
    manifestPath: path.join(root, 'manifest.json'),
    auditPath: path.join(root, 'audit.json'),
    summaryPath: path.join(root, 'summary.md'),
    workdir: path.join(root, 'audit-work'),
  };
  const { manifest } = await auditRegistry(auditOptions, { remote });
  return {
    manifest,
    registry,
    remote,
    remoteRoot,
    calls,
    options: {
      manifest,
      registryPath,
      siteIndexPath,
      listsPath,
      extractedPath,
      contentIndexPath,
      statePath: path.join(root, 'state.json'),
      workdir: path.join(root, 'migration-work'),
      targetRepo: { repo: 'packs-002', repoNum: 2 },
      phase: 'stage',
    },
  };
}

test('migrates a one-product registered pack through monotonic phases without downtime', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-pack-migration-'));
  try {
    const oldPath = path.join(root, 'Published.zip');
    await writeWrapped(oldPath);
    const registry = { 'Published.zip': { repo: 'packs-001', repoNum: 1, size: fs.statSync(oldPath).size } };
    const registryPath = path.join(root, 'registry.json');
    const siteIndexPath = path.join(root, 'index.json');
    const listsPath = path.join(root, 'lists.json');
    const contentIndexPath = path.join(root, 'content-index.json');
    const extractedPath = path.join(root, 'extracted.json');
    const auditManifestPath = path.join(root, 'audit-manifest.json');
    const auditPath = path.join(root, 'audit.json');
    const summaryPath = path.join(root, 'summary.md');
    const statePath = path.join(root, 'migration-state.json');
    fs.writeFileSync(registryPath, JSON.stringify(registry));
    fs.writeFileSync(siteIndexPath, JSON.stringify({ items: [{ name: 'Published', uploadDate: '2020-01-02', route: '/p/Published/' }] }));
    fs.writeFileSync(listsPath, JSON.stringify([{ name: 'Sakyvo', packs: ['Published'] }]));
    fs.writeFileSync(extractedPath, JSON.stringify([{ originalName: 'Published', packId: 'Published' }]));

    const remoteRoot = path.join(root, 'remote');
    fs.mkdirSync(path.join(remoteRoot, 'packs-001'), { recursive: true });
    fs.copyFileSync(oldPath, path.join(remoteRoot, 'packs-001', 'Published.zip'));
    const remoteCalls = [];
    const remote = {
      async downloadArchive({ file, destination }) {
        fs.copyFileSync(path.join(remoteRoot, 'packs-001', file), destination);
      },
      async getArchiveIdentity({ repo, file }) {
        const target = path.join(remoteRoot, repo, file);
        if (!fs.existsSync(target)) return null;
        return { size: fs.statSync(target).size, archiveSha256: hash(target) };
      },
      async publishArchive({ repo, file, path: sourcePath }) {
        remoteCalls.push(`publish:${repo}/${file}`);
        const target = path.join(remoteRoot, repo, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(sourcePath, target);
      },
      async verifyArchive(identity) {
        const actual = await remote.getArchiveIdentity(identity);
        assert.equal(actual.size, identity.size);
        assert.equal(actual.archiveSha256, identity.archiveSha256);
      },
      async deleteArchive({ repo, file }) {
        remoteCalls.push(`delete:${repo}/${file}`);
        fs.rmSync(path.join(remoteRoot, repo, file), { force: true });
      },
    };

    const audit = await auditRegistry({
      registryPath,
      siteIndexPath,
      listsPath,
      extractedPath,
      manifestPath: auditManifestPath,
      auditPath,
      summaryPath,
      workdir: path.join(root, 'audit-work'),
    }, { remote });
    const productHash = audit.manifest.entries[0].normalization.products[0].visualContentHash;
    fs.writeFileSync(contentIndexPath, JSON.stringify({
      schemaVersion: 1,
      fingerprintSchemaVersion: 1,
      registryDigest: computeRegistryDigest(registry),
      complete: true,
      failures: [],
      packs: {
        'Published.zip': {
          packId: 'Published',
          repo: 'packs-001',
          repoNum: 1,
          size: registry['Published.zip'].size,
          sourceKey: sourceKey('Published.zip', registry['Published.zip']),
          archiveSha256: hash(oldPath),
          visualContentHash: productHash,
          visualEntryCount: 1,
          swords: {},
        },
      },
    }));

    const base = {
      manifest: audit.manifest,
      registryPath,
      siteIndexPath,
      listsPath,
      contentIndexPath,
      extractedPath,
      statePath,
      workdir: path.join(root, 'migration-work'),
      targetRepo: { repo: 'packs-002', repoNum: 2 },
      phase: 'stage',
    };
    let state = await runMigration(base, { remote });
    assert.equal(state.entries[0].status, 'staged_verified');
    assert.equal(fs.existsSync(path.join(remoteRoot, 'packs-001', 'Published.zip')), true);
    assert.equal(fs.existsSync(path.join(remoteRoot, 'packs-002', 'Published.zip')), true);
    assert.deepEqual(remoteCalls, ['publish:packs-002/Published.zip']);

    state = await runMigration(base, { remote });
    assert.equal(state.entries[0].status, 'staged_verified');
    assert.deepEqual(remoteCalls, ['publish:packs-002/Published.zip']);

    state = await runMigration({ ...base, phase: 'prepare-site' }, { remote });
    assert.equal(state.entries[0].status, 'site_prepared');
    assert.equal(JSON.parse(fs.readFileSync(registryPath, 'utf8'))['Published.zip'].repo, 'packs-002');
    assert.deepEqual(JSON.parse(fs.readFileSync(listsPath, 'utf8'))[0].packs, ['Published']);
    assert.equal(JSON.parse(fs.readFileSync(siteIndexPath, 'utf8')).items[0].uploadDate, '2020-01-02');

    state = await runMigration({ ...base, phase: 'verify-deployment' }, {
      remote,
      verifyDeployment: async () => true,
    });
    assert.equal(state.entries[0].status, 'deployed_verified');
    assert.equal(fs.existsSync(path.join(remoteRoot, 'packs-001', 'Published.zip')), true);

    const deleteArchive = remote.deleteArchive;
    remote.deleteArchive = async ({ repo, file }) => {
      remoteCalls.push(`failed-delete:${repo}/${file}`);
    };
    await assert.rejects(
      () => runMigration({ ...base, phase: 'cleanup' }, { remote }),
      /old archive remains after cleanup/i
    );
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).entries[0].status, 'deployed_verified');
    remote.deleteArchive = deleteArchive;
    state = await runMigration({ ...base, phase: 'cleanup' }, { remote });
    assert.equal(state.entries[0].status, 'complete');
    assert.equal(fs.existsSync(path.join(remoteRoot, 'packs-001', 'Published.zip')), false);
    assert.equal(fs.existsSync(path.join(remoteRoot, 'packs-002', 'Published.zip')), true);
    assert.deepEqual(remoteCalls, [
      'publish:packs-002/Published.zip',
      'failed-delete:packs-001/Published.zip',
      'delete:packs-001/Published.zip',
    ]);

    const repeated = await runMigration({ ...base, phase: 'cleanup' }, { remote });
    assert.equal(repeated.entries[0].status, 'complete');
    assert.deepEqual(remoteCalls, [
      'publish:packs-002/Published.zip',
      'failed-delete:packs-001/Published.zip',
      'delete:packs-001/Published.zip',
    ]);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('aborts staging when the reviewed source remote hash changes', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-pack-migration-stale-'));
  try {
    const fixture = await createStageFixture(root);
    const source = path.join(fixture.remoteRoot, 'packs-001', 'Published.zip');
    const bytes = fs.readFileSync(source);
    bytes[bytes.length - 1] ^= 0xff;
    fs.writeFileSync(source, bytes);

    await assert.rejects(
      () => runMigration(fixture.options, { remote: fixture.remote }),
      /source.*changed|source.*missing/i
    );
    assert.deepEqual(fixture.calls, []);
    assert.equal(fs.existsSync(path.join(fixture.remoteRoot, 'packs-002', 'Published.zip')), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.options.registryPath, 'utf8')), fixture.registry);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('rejects migration state from a different registry digest', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-pack-migration-registry-state-'));
  try {
    const fixture = await createStageFixture(root);
    const product = fixture.manifest.entries[0].normalization.products[0];
    fs.writeFileSync(fixture.options.contentIndexPath, JSON.stringify({
      schemaVersion: 1,
      fingerprintSchemaVersion: 1,
      registryDigest: computeRegistryDigest(fixture.registry),
      complete: true,
      failures: [],
      packs: {
        'Published.zip': {
          packId: 'Published',
          ...fixture.registry['Published.zip'],
          sourceKey: sourceKey('Published.zip', fixture.registry['Published.zip']),
          archiveSha256: fixture.manifest.entries[0].source.archiveSha256,
          visualContentHash: product.visualContentHash,
          visualEntryCount: product.visualEntryCount,
          swords: product.swords,
        },
      },
    }));
    const staged = await runMigration(fixture.options, { remote: fixture.remote });
    assert.equal(staged.entries[0].status, 'staged_verified');
    const staleManifest = { ...fixture.manifest, registryDigest: 'different-registry-digest' };

    await assert.rejects(
      () => runMigration({ ...fixture.options, manifest: staleManifest, phase: 'prepare-site' }, { remote: fixture.remote }),
      /state does not match the reviewed manifest/i
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.options.registryPath, 'utf8')), fixture.registry);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('records an unverified staged artifact as an orphan without deleting it', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-pack-migration-orphan-'));
  try {
    const fixture = await createStageFixture(root);
    fixture.remote.verifyArchive = async () => { throw new Error('verification unavailable'); };

    await assert.rejects(
      () => runMigration(fixture.options, { remote: fixture.remote }),
      /verification unavailable/
    );
    const state = JSON.parse(fs.readFileSync(fixture.options.statePath, 'utf8'));
    assert.equal(state.entries[0].status, 'planned');
    assert.equal(state.entries[0].orphans.length, 1);
    assert.equal(fs.existsSync(path.join(fixture.remoteRoot, 'packs-002', 'Published.zip')), true);
    assert.deepEqual(fixture.calls, ['publish:packs-002/Published.zip']);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('defers an online product that remains over the post-normalization size limit', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-pack-migration-oversize-'));
  try {
    const fixture = await createStageFixture(root);
    const state = await runMigration({ ...fixture.options, githubFileLimit: 1 }, { remote: fixture.remote });
    assert.equal(state.entries[0].status, 'deferred');
    assert.equal(state.entries[0].deferReason, 'online_oversize');
    assert.deepEqual(fixture.calls, []);
    assert.equal(fs.existsSync(path.join(fixture.remoteRoot, 'packs-001', 'Published.zip')), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.options.registryPath, 'utf8')), fixture.registry);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
