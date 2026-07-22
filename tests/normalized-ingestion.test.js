const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');
const sharp = require('sharp');
const { computeRegistryDigest } = require('../scripts/lib/pack-content-index');
const { fingerprintPack } = require('../scripts/lib/pack-content-fingerprint');
const { runIngestion } = require('../scripts/upload-folder');

async function writeWrappedPack(filePath) {
  const texture = await sharp({
    create: { width: 16, height: 16, channels: 4, background: { r: 40, g: 90, b: 160, alpha: 1 } },
  }).png().toBuffer();
  const zip = new AdmZip();
  zip.addFile('Inner/pack.mcmeta', Buffer.from('{"pack":{"pack_format":1,"description":"wrapped"}}'));
  zip.addFile('Inner/assets/minecraft/textures/blocks/stone.png', texture);
  zip.writeZip(filePath);
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('uploads the normalized product through a fake remote and cleans temporary work', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-normalized-ingestion-'));
  try {
    const source = path.join(root, 'source');
    const remoteRoot = path.join(root, 'remote');
    const workdir = path.join(root, 'work');
    fs.mkdirSync(source);
    const sourcePath = path.join(source, 'Wrapped.zip');
    await writeWrappedPack(sourcePath);
    const sourceFingerprint = await fingerprintPack(sourcePath);

    const registryPath = path.join(root, 'registry.json');
    const siteIndexPath = path.join(root, 'site-index.json');
    const listsPath = path.join(root, 'lists.json');
    const contentIndex = path.join(root, 'content-index.json');
    const contentAliases = path.join(root, 'aliases.json');
    const pendingReplacements = path.join(root, 'pending.json');
    fs.writeFileSync(registryPath, '{}');
    fs.writeFileSync(siteIndexPath, '{"items":[]}');
    fs.writeFileSync(listsPath, '[]');
    fs.writeFileSync(contentIndex, JSON.stringify({
      schemaVersion: 1,
      fingerprintSchemaVersion: 1,
      registryDigest: computeRegistryDigest({}),
      complete: true,
      failures: [],
      packs: {},
    }));

    const remote = {
      publishBatch({ repo, files, markFull }) {
        const target = path.join(remoteRoot, repo, 'resourcepacks');
        fs.mkdirSync(target, { recursive: true });
        for (const file of files) fs.copyFileSync(file.path, path.join(target, file.file));
        if (markFull) fs.writeFileSync(path.join(remoteRoot, repo, '!  FULL  !'), 'full\n');
      },
      verifyArchive(item) {
        const stored = path.join(remoteRoot, item.repo, 'resourcepacks', item.file);
        assert.equal(fs.statSync(stored).size, item.size);
        assert.equal(sha256File(stored), item.fingerprint.archiveSha256);
      },
    };

    const plan = await runIngestion({
      source,
      list: 'Sakyvo',
      workdir,
      registryPath,
      siteIndexPath,
      listsPath,
      contentIndex,
      contentAliases,
      pendingReplacements,
      execute: true,
      skipBlockers: false,
      onlyRepoNum: null,
      duplicateResolutions: null,
    }, { remote });

    assert.equal(plan.normalizationSchemaVersion, 1);
    assert.equal(plan.uploadEntries.length, 1);
    assert.equal(plan.uploadEntries[0].file, 'Inner.zip');
    assert.equal(plan.uploadEntries[0].sourceFile, 'Wrapped.zip');
    assert.equal(plan.uploadEntries[0].fingerprint.visualContentHash, sourceFingerprint.visualContentHash);
    assert.notEqual(plan.uploadEntries[0].fingerprint.archiveSha256, sourceFingerprint.archiveSha256);
    assert.ok(fs.existsSync(path.join(remoteRoot, 'packs-001', 'resourcepacks', 'Inner.zip')));
    assert.equal(JSON.parse(fs.readFileSync(registryPath, 'utf8'))['Inner.zip'].repo, 'packs-001');
    assert.deepEqual(JSON.parse(fs.readFileSync(listsPath, 'utf8'))[0].packs, ['Inner']);
    assert.equal(fs.existsSync(workdir), false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('cleans normalized work when the remote boundary fails', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-normalized-failure-'));
  try {
    const source = path.join(root, 'source');
    const workdir = path.join(root, 'work');
    fs.mkdirSync(source);
    await writeWrappedPack(path.join(source, 'Wrapped.zip'));
    const registry = {};
    const registryPath = path.join(root, 'registry.json');
    const siteIndexPath = path.join(root, 'site-index.json');
    const listsPath = path.join(root, 'lists.json');
    const contentIndex = path.join(root, 'content-index.json');
    fs.writeFileSync(registryPath, '{}');
    fs.writeFileSync(siteIndexPath, '{"items":[]}');
    fs.writeFileSync(listsPath, '[]');
    fs.writeFileSync(contentIndex, JSON.stringify({
      schemaVersion: 1,
      fingerprintSchemaVersion: 1,
      registryDigest: computeRegistryDigest(registry),
      complete: true,
      failures: [],
      packs: {},
    }));

    await assert.rejects(
      () => runIngestion({
        source,
        list: 'Sakyvo',
        workdir,
        registryPath,
        siteIndexPath,
        listsPath,
        contentIndex,
        contentAliases: path.join(root, 'aliases.json'),
        pendingReplacements: path.join(root, 'pending.json'),
        execute: true,
        skipBlockers: false,
        onlyRepoNum: null,
      }, {
        remote: {
          publishBatch() {
            throw new Error('remote unavailable');
          },
          verifyArchive() {},
        },
      }),
      /remote unavailable/
    );
    assert.equal(fs.existsSync(workdir), false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('blocks execution when normalization changes visual content', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-normalized-content-change-'));
  try {
    const source = path.join(root, 'source');
    const workdir = path.join(root, 'work');
    const manifest = path.join(root, 'manifest.json');
    fs.mkdirSync(source);
    const sourcePath = path.join(source, 'Wrapped.zip');
    await writeWrappedPack(sourcePath);

    const registryPath = path.join(root, 'registry.json');
    const siteIndexPath = path.join(root, 'site-index.json');
    const listsPath = path.join(root, 'lists.json');
    const contentIndex = path.join(root, 'content-index.json');
    fs.writeFileSync(registryPath, '{}');
    fs.writeFileSync(siteIndexPath, '{"items":[]}');
    fs.writeFileSync(listsPath, '[]');
    fs.writeFileSync(contentIndex, JSON.stringify({
      schemaVersion: 1,
      fingerprintSchemaVersion: 1,
      registryDigest: computeRegistryDigest({}),
      complete: true,
      failures: [],
      packs: {},
    }));

    let publishCalls = 0;
    await assert.rejects(
      () => runIngestion({
        source,
        list: 'Sakyvo',
        workdir,
        manifest,
        registryPath,
        siteIndexPath,
        listsPath,
        contentIndex,
        contentAliases: path.join(root, 'aliases.json'),
        pendingReplacements: path.join(root, 'pending.json'),
        execute: true,
        skipBlockers: false,
        onlyRepoNum: null,
      }, {
        async fingerprintPack(filePath) {
          const fingerprint = await fingerprintPack(filePath);
          if (path.resolve(filePath) === path.resolve(sourcePath)) return fingerprint;
          return { ...fingerprint, visualContentHash: '0'.repeat(64) };
        },
        remote: {
          publishBatch() {
            publishCalls += 1;
          },
          verifyArchive() {},
        },
      }),
      /non-bypassable content blocker/
    );

    const plan = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    assert.equal(plan.hardBlockers[0].action, 'blocked_normalization_content_change');
    assert.equal(plan.uploadEntries.length, 0);
    assert.equal(publishCalls, 0);
    assert.equal(fs.existsSync(workdir), false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
