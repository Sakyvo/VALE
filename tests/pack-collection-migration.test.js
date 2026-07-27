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
const { auditRegistry } = require('../scripts/audit-pack-normalization');
const { runCollectionMigration } = require('../scripts/migrate-pack-collection');

function hash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function writeCollection(filePath) {
  const zip = new AdmZip();
  for (const [name, color] of [
    ['PackA', { r: 200, g: 40, b: 40, alpha: 1 }],
    ['PackB', { r: 40, g: 80, b: 200, alpha: 1 }],
  ]) {
    const texture = await sharp({ create: { width: 8, height: 8, channels: 4, background: color } }).png().toBuffer();
    zip.addFile(`${name}/pack.mcmeta`, Buffer.from('{}'));
    zip.addFile(`${name}/assets/minecraft/textures/blocks/stone.png`, texture);
  }
  zip.writeZip(filePath);
}

async function writeNormalPack(filePath, color) {
  const texture = await sharp({ create: { width: 8, height: 8, channels: 4, background: color } }).png().toBuffer();
  const zip = new AdmZip();
  zip.addFile('pack.mcmeta', Buffer.from('{}'));
  zip.addFile('assets/minecraft/textures/blocks/stone.png', texture);
  zip.writeZip(filePath);
}

test('migrates a published collection only after all products are verified', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-collection-migration-'));
  try {
    const parentPath = path.join(root, 'Bundle.zip');
    await writeCollection(parentPath);
    const registry = { 'Bundle.zip': { repo: 'packs-001', repoNum: 1, size: fs.statSync(parentPath).size } };
    const registryPath = path.join(root, 'registry.json');
    const siteIndexPath = path.join(root, 'index.json');
    const listsPath = path.join(root, 'lists.json');
    const extractedPath = path.join(root, 'extracted.json');
    const contentIndexPath = path.join(root, 'content-index.json');
    const thumbnailsRoot = path.join(root, 'thumbnails');
    const packDataRoot = path.join(root, 'packs');
    const packPageRoot = path.join(root, 'pages');
    const sbiPath = path.join(root, 'sbi.json');
    fs.writeFileSync(registryPath, JSON.stringify(registry));
    fs.writeFileSync(siteIndexPath, JSON.stringify({ items: [{ name: 'Bundle', uploadDate: '2021-04-05', route: '/p/Bundle/' }] }));
    fs.writeFileSync(listsPath, JSON.stringify([
      { name: 'Sakyvo', packs: ['Bundle', 'Keep'] },
      { name: 'Custom', packs: ['Bundle'] },
      { name: 'Overlay', packs: ['Bundle'] },
      { name: 'Conquest', packs: ['Bundle'] },
    ]));
    fs.writeFileSync(extractedPath, JSON.stringify([{ originalName: 'Bundle', packId: 'Bundle', description: 'parent' }]));
    fs.mkdirSync(path.join(thumbnailsRoot, 'Bundle'), { recursive: true });
    fs.writeFileSync(path.join(thumbnailsRoot, 'Bundle', 'stone.png'), 'old');
    fs.mkdirSync(packDataRoot, { recursive: true });
    fs.writeFileSync(path.join(packDataRoot, 'Bundle.json'), '{}');
    fs.mkdirSync(path.join(packPageRoot, 'Bundle'), { recursive: true });
    fs.writeFileSync(path.join(packPageRoot, 'Bundle', 'index.html'), 'old');
    fs.writeFileSync(sbiPath, JSON.stringify({ Bundle: { old: true }, Keep: { old: false } }));

    const parentFingerprint = await fingerprintPack(parentPath).catch(() => ({
      archiveSha256: hash(parentPath),
      visualContentHash: 'collection-parent',
      visualEntryCount: 0,
      swords: {},
    }));
    fs.writeFileSync(contentIndexPath, JSON.stringify({
      schemaVersion: 1,
      fingerprintSchemaVersion: 1,
      registryDigest: computeRegistryDigest(registry),
      complete: true,
      failures: [],
      packs: {
        'Bundle.zip': {
          packId: 'Bundle',
          repo: 'packs-001',
          repoNum: 1,
          size: registry['Bundle.zip'].size,
          sourceKey: sourceKey('Bundle.zip', registry['Bundle.zip']),
          archiveSha256: hash(parentPath),
          visualContentHash: parentFingerprint.visualContentHash,
          visualEntryCount: parentFingerprint.visualEntryCount,
          swords: parentFingerprint.swords,
        },
      },
    }));

    const remoteRoot = path.join(root, 'remote');
    fs.mkdirSync(path.join(remoteRoot, 'packs-001'), { recursive: true });
    fs.copyFileSync(parentPath, path.join(remoteRoot, 'packs-001', 'Bundle.zip'));
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
        assert.equal(actual.size, identity.size);
        assert.equal(actual.archiveSha256, identity.archiveSha256);
      },
      async deleteArchive({ repo, file }) {
        calls.push(`delete:${repo}/${file}`);
        fs.rmSync(path.join(remoteRoot, repo, file), { force: true });
      },
    };
    const { manifest } = await auditRegistry({
      registryPath,
      siteIndexPath,
      listsPath,
      extractedPath,
      contentIndexPath,
      manifestPath: path.join(root, 'manifest.json'),
      auditPath: path.join(root, 'audit.json'),
      summaryPath: path.join(root, 'summary.md'),
      workdir: path.join(root, 'audit-work'),
    }, { remote });
    const options = {
      manifest,
      registryPath,
      siteIndexPath,
      listsPath,
      extractedPath,
      contentIndexPath,
      thumbnailsRoot,
      packDataRoot,
      packPageRoot,
      sbiPath,
      statePath: path.join(root, 'state.json'),
      workdir: path.join(root, 'migration-work'),
      targetRepo: { repo: 'packs-002', repoNum: 2 },
      phase: 'stage',
    };

    let state = await runCollectionMigration(options, { remote });
    assert.equal(state.entries[0].status, 'staged_verified');
    assert.equal(state.entries[0].products.length, 2);
    assert.equal(fs.existsSync(path.join(remoteRoot, 'packs-001', 'Bundle.zip')), true);
    assert.equal(fs.existsSync(path.join(thumbnailsRoot, 'Bundle')), true);
    assert.equal(JSON.parse(fs.readFileSync(registryPath, 'utf8'))['Bundle.zip'].repo, 'packs-001');

    state = await runCollectionMigration(options, { remote });
    assert.equal(state.entries[0].status, 'staged_verified');
    assert.equal(calls.filter(call => call.startsWith('publish:')).length, 2);

    state = await runCollectionMigration({ ...options, phase: 'prepare-site' }, {
      remote,
      classifyManagedLists(product) {
        return product.packId === 'PackA' ? ['Overlay'] : ['Conquest'];
      },
    });
    assert.equal(state.entries[0].status, 'site_prepared');
    const nextRegistry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    assert.equal(nextRegistry['Bundle.zip'], undefined);
    assert.ok(nextRegistry['PackA.zip'] && nextRegistry['PackB.zip']);
    const lists = JSON.parse(fs.readFileSync(listsPath, 'utf8'));
    assert.deepEqual(lists.find(list => list.name === 'Sakyvo').packs, ['PackA', 'PackB', 'Keep']);
    assert.deepEqual(lists.find(list => list.name === 'Custom').packs, ['PackA', 'PackB']);
    assert.deepEqual(lists.find(list => list.name === 'Overlay').packs, ['PackA']);
    assert.deepEqual(lists.find(list => list.name === 'Conquest').packs, ['PackB']);
    const extracted = JSON.parse(fs.readFileSync(extractedPath, 'utf8'));
    assert.deepEqual(extracted.map(row => row.packId).sort(), ['PackA', 'PackB']);
    assert.equal(fs.existsSync(path.join(thumbnailsRoot, 'Bundle')), false);
    assert.equal(fs.existsSync(path.join(packDataRoot, 'Bundle.json')), false);
    assert.equal(fs.existsSync(path.join(packPageRoot, 'Bundle')), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(sbiPath, 'utf8')), { Keep: { old: false } });

    state = await runCollectionMigration({ ...options, phase: 'verify-deployment' }, {
      remote,
      verifyDeployment: async entry => entry.products.every(product => product.packId.startsWith('Pack')),
    });
    assert.equal(state.entries[0].status, 'deployed_verified');
    assert.equal(fs.existsSync(path.join(remoteRoot, 'packs-001', 'Bundle.zip')), true);

    state = await runCollectionMigration({ ...options, phase: 'cleanup' }, { remote });
    assert.equal(state.entries[0].status, 'complete');
    assert.equal(fs.existsSync(path.join(remoteRoot, 'packs-001', 'Bundle.zip')), false);
    assert.equal(fs.existsSync(path.join(remoteRoot, 'packs-002', 'PackA.zip')), true);
    assert.equal(fs.existsSync(path.join(remoteRoot, 'packs-002', 'PackB.zip')), true);
    assert.equal(calls.filter(call => call.startsWith('delete:')).length, 1);

    state = await runCollectionMigration({ ...options, phase: 'cleanup' }, { remote });
    assert.equal(state.entries[0].status, 'complete');
    assert.equal(calls.filter(call => call.startsWith('delete:')).length, 1);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('blocks a collection identity conflict until a hash-bound name override is supplied', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-collection-conflict-'));
  try {
    const bundlePath = path.join(root, 'Bundle.zip');
    const existingPath = path.join(root, 'PackA.zip');
    await writeCollection(bundlePath);
    await writeNormalPack(existingPath, { r: 20, g: 220, b: 80, alpha: 1 });
    const registry = {
      'Bundle.zip': { repo: 'packs-001', repoNum: 1, size: fs.statSync(bundlePath).size },
      'PackA.zip': { repo: 'packs-001', repoNum: 1, size: fs.statSync(existingPath).size },
    };
    const registryPath = path.join(root, 'registry.json');
    const siteIndexPath = path.join(root, 'index.json');
    const listsPath = path.join(root, 'lists.json');
    const extractedPath = path.join(root, 'extracted.json');
    const contentIndexPath = path.join(root, 'content-index.json');
    fs.writeFileSync(registryPath, JSON.stringify(registry));
    fs.writeFileSync(siteIndexPath, JSON.stringify({ items: [{ name: 'Bundle' }, { name: 'PackA' }] }));
    fs.writeFileSync(listsPath, '[]');
    fs.writeFileSync(extractedPath, JSON.stringify([{ originalName: 'Bundle', packId: 'Bundle' }]));
    const existingFingerprint = await fingerprintPack(existingPath);
    fs.writeFileSync(contentIndexPath, JSON.stringify({
      schemaVersion: 1,
      fingerprintSchemaVersion: 1,
      registryDigest: computeRegistryDigest(registry),
      complete: true,
      failures: [],
      packs: {
        'Bundle.zip': {
          packId: 'Bundle', repo: 'packs-001', repoNum: 1, size: registry['Bundle.zip'].size,
          sourceKey: sourceKey('Bundle.zip', registry['Bundle.zip']), archiveSha256: hash(bundlePath),
          visualContentHash: 'collection-parent', visualEntryCount: 0, swords: {},
        },
        'PackA.zip': {
          packId: 'PackA', repo: 'packs-001', repoNum: 1, size: registry['PackA.zip'].size,
          sourceKey: sourceKey('PackA.zip', registry['PackA.zip']), ...existingFingerprint,
        },
      },
    }));
    const remoteRoot = path.join(root, 'remote', 'packs-001');
    fs.mkdirSync(remoteRoot, { recursive: true });
    fs.copyFileSync(bundlePath, path.join(remoteRoot, 'Bundle.zip'));
    fs.copyFileSync(existingPath, path.join(remoteRoot, 'PackA.zip'));
    const published = [];
    const remote = {
      async downloadArchive({ repo, file, destination }) {
        fs.copyFileSync(path.join(root, 'remote', repo, file), destination);
      },
      async getArchiveIdentity({ repo, file }) {
        const target = path.join(root, 'remote', repo, file);
        return fs.existsSync(target) ? { size: fs.statSync(target).size, archiveSha256: hash(target) } : null;
      },
      async publishArchive(identity) {
        published.push(identity.file);
        const target = path.join(root, 'remote', identity.repo, identity.file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(identity.path, target);
      },
      async verifyArchive() {},
    };
    const { manifest } = await auditRegistry({
      registryPath, siteIndexPath, listsPath, extractedPath, contentIndexPath,
      manifestPath: path.join(root, 'manifest.json'), auditPath: path.join(root, 'audit.json'),
      summaryPath: path.join(root, 'summary.md'), workdir: path.join(root, 'audit-work'),
    }, { remote });

    await assert.rejects(() => runCollectionMigration({
      manifest, registryPath, siteIndexPath, listsPath, extractedPath, contentIndexPath,
      statePath: path.join(root, 'state.json'), workdir: path.join(root, 'migration-work'),
      targetRepo: { repo: 'packs-002', repoNum: 2 }, phase: 'stage',
    }, { remote }), /conflict|published identity/i);
    assert.deepEqual(published, []);

    const conflicting = manifest.entries.find(entry => entry.file === 'Bundle.zip');
    const planned = conflicting.normalization.products.find(product => product.file === 'PackA.zip');
    conflicting.decision = {
      action: 'name_override',
      overrides: [{
        action: 'name_override',
        file: planned.file,
        to: 'PackA Split.zip',
        archiveSha256: planned.archiveSha256,
        visualContentHash: planned.visualContentHash,
      }],
    };
    const state = await runCollectionMigration({
      manifest, registryPath, siteIndexPath, listsPath, extractedPath, contentIndexPath,
      statePath: path.join(root, 'state.json'), workdir: path.join(root, 'migration-work'),
      targetRepo: { repo: 'packs-002', repoNum: 2 }, phase: 'stage',
    }, { remote });
    assert.equal(state.entries.find(entry => entry.file === 'Bundle.zip').status, 'staged_verified');
    assert.deepEqual(published.sort(), ['PackA Split.zip', 'PackB.zip']);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('reuses exact collection content without widening registry-only visibility', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-collection-registry-only-'));
  try {
    const bundlePath = path.join(root, 'Bundle.zip');
    const existingPath = path.join(root, 'PackA.zip');
    await writeCollection(bundlePath);
    await writeNormalPack(existingPath, { r: 200, g: 40, b: 40, alpha: 1 });
    const registry = {
      'Bundle.zip': { repo: 'packs-001', repoNum: 1, size: fs.statSync(bundlePath).size },
      'PackA.zip': { repo: 'packs-001', repoNum: 1, size: fs.statSync(existingPath).size },
    };
    const registryPath = path.join(root, 'registry.json');
    const siteIndexPath = path.join(root, 'index.json');
    const listsPath = path.join(root, 'lists.json');
    const extractedPath = path.join(root, 'extracted.json');
    const contentIndexPath = path.join(root, 'content-index.json');
    fs.writeFileSync(registryPath, JSON.stringify(registry));
    fs.writeFileSync(siteIndexPath, JSON.stringify({ items: [] }));
    fs.writeFileSync(listsPath, '[]');
    fs.writeFileSync(extractedPath, '[]');
    const existingFingerprint = await fingerprintPack(existingPath);
    fs.writeFileSync(contentIndexPath, JSON.stringify({
      schemaVersion: 1,
      fingerprintSchemaVersion: 1,
      registryDigest: computeRegistryDigest(registry),
      complete: true,
      failures: [],
      packs: {
        'Bundle.zip': {
          packId: 'Bundle', repo: 'packs-001', repoNum: 1, size: registry['Bundle.zip'].size,
          sourceKey: sourceKey('Bundle.zip', registry['Bundle.zip']), archiveSha256: hash(bundlePath),
          visualContentHash: 'collection-parent', visualEntryCount: 0, swords: {},
        },
        'PackA.zip': {
          packId: 'PackA', repo: 'packs-001', repoNum: 1, size: registry['PackA.zip'].size,
          sourceKey: sourceKey('PackA.zip', registry['PackA.zip']), ...existingFingerprint,
        },
      },
    }));
    const remoteRoot = path.join(root, 'remote');
    fs.mkdirSync(path.join(remoteRoot, 'packs-001'), { recursive: true });
    fs.copyFileSync(bundlePath, path.join(remoteRoot, 'packs-001', 'Bundle.zip'));
    fs.copyFileSync(existingPath, path.join(remoteRoot, 'packs-001', 'PackA.zip'));
    const published = [];
    const remote = {
      async downloadArchive({ repo, file, destination }) {
        fs.copyFileSync(path.join(remoteRoot, repo, file), destination);
      },
      async getArchiveIdentity({ repo, file }) {
        const target = path.join(remoteRoot, repo, file);
        return fs.existsSync(target) ? { size: fs.statSync(target).size, archiveSha256: hash(target) } : null;
      },
      async publishArchive({ repo, file, path: sourcePath }) {
        published.push(file);
        const target = path.join(remoteRoot, repo, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(sourcePath, target);
      },
      async verifyArchive(identity) {
        const actual = await remote.getArchiveIdentity(identity);
        assert.equal(actual.archiveSha256, identity.archiveSha256);
      },
      async deleteArchive({ repo, file }) {
        fs.rmSync(path.join(remoteRoot, repo, file), { force: true });
      },
    };
    const { manifest } = await auditRegistry({
      registryPath, siteIndexPath, listsPath, extractedPath, contentIndexPath,
      manifestPath: path.join(root, 'manifest.json'), auditPath: path.join(root, 'audit.json'),
      summaryPath: path.join(root, 'summary.md'), workdir: path.join(root, 'audit-work'),
    }, { remote });
    const options = {
      manifest, registryPath, siteIndexPath, listsPath, extractedPath, contentIndexPath,
      statePath: path.join(root, 'state.json'), workdir: path.join(root, 'migration-work'),
      targetRepo: { repo: 'packs-002', repoNum: 2 }, phase: 'stage',
    };

    let state = await runCollectionMigration(options, { remote });
    const products = state.entries[0].products;
    assert.equal(products.find(product => product.file === 'PackA.zip').reused, true);
    assert.deepEqual(published, ['PackB.zip']);

    const retainedPath = path.join(remoteRoot, 'packs-001', 'PackA.zip');
    fs.rmSync(retainedPath, { force: true });
    await assert.rejects(
      () => runCollectionMigration({ ...options, phase: 'prepare-site' }, { remote }),
      /Reused product.*missing|changed/i
    );
    fs.copyFileSync(existingPath, retainedPath);
    state = await runCollectionMigration({ ...options, phase: 'prepare-site' }, { remote });
    assert.equal(state.entries[0].status, 'site_prepared');
    const nextRegistry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    assert.equal(nextRegistry['Bundle.zip'], undefined);
    assert.equal(nextRegistry['PackA.zip'].repo, 'packs-001');
    assert.equal(nextRegistry['PackB.zip'].repo, 'packs-002');
    assert.deepEqual(JSON.parse(fs.readFileSync(siteIndexPath, 'utf8')).items, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(extractedPath, 'utf8')), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(listsPath, 'utf8')), []);

    fs.rmSync(retainedPath, { force: true });
    await assert.rejects(
      () => runCollectionMigration({ ...options, phase: 'verify-deployment' }, {
        remote,
        verifyDeployment: async () => true,
      }),
      /Reused product.*missing|changed/i
    );
    fs.copyFileSync(existingPath, retainedPath);
    state = await runCollectionMigration({ ...options, phase: 'verify-deployment' }, {
      remote,
      verifyDeployment: async () => true,
    });
    assert.equal(state.entries[0].status, 'deployed_verified');
    state = await runCollectionMigration({ ...options, phase: 'cleanup' }, { remote });
    assert.equal(state.entries[0].status, 'complete');
    assert.equal(fs.existsSync(path.join(remoteRoot, 'packs-001', 'Bundle.zip')), false);
    assert.equal(fs.existsSync(retainedPath), true);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
