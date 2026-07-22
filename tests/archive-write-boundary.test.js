const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const AdmZip = require('adm-zip');
const sharp = require('sharp');
const { computeRegistryDigest } = require('../scripts/lib/pack-content-index');
const { delegateUpload } = require('../scripts/upload-pack');

async function writeWrappedPack(filePath) {
  const texture = await sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 20, g: 80, b: 140, alpha: 1 } },
  }).png().toBuffer();
  const zip = new AdmZip();
  zip.addFile('Inner/pack.mcmeta', Buffer.from('{}'));
  zip.addFile('Inner/assets/minecraft/textures/blocks/stone.png', texture);
  zip.writeZip(filePath);
}

function writeCatalog(root) {
  const paths = {
    registryPath: path.join(root, 'registry.json'),
    siteIndexPath: path.join(root, 'site-index.json'),
    listsPath: path.join(root, 'lists.json'),
    contentIndex: path.join(root, 'content-index.json'),
    contentAliases: path.join(root, 'aliases.json'),
    pendingReplacements: path.join(root, 'pending.json'),
    normalizationAudit: path.join(root, 'audit.json'),
    repoState: path.join(root, 'repo-state.json'),
  };
  fs.writeFileSync(paths.registryPath, '{}');
  fs.writeFileSync(paths.siteIndexPath, '{"items":[]}');
  fs.writeFileSync(paths.listsPath, '[]');
  fs.writeFileSync(paths.contentIndex, JSON.stringify({
    schemaVersion: 1,
    fingerprintSchemaVersion: 1,
    registryDigest: computeRegistryDigest({}),
    complete: true,
    failures: [],
    packs: {},
  }));
  fs.writeFileSync(paths.repoState, JSON.stringify({ schemaVersion: 1, fullRepoNums: [] }));
  return paths;
}

test('single-file convenience upload delegates normalization and cleans its source staging directory', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-boundary-upload-'));
  try {
    const input = path.join(root, 'Wrapped.zip');
    await writeWrappedPack(input);
    const paths = writeCatalog(root);
    const remoteRoot = path.join(root, 'remote');
    const published = [];
    const result = await delegateUpload([input], {
      ...paths,
      list: 'Sakyvo',
      workdir: path.join(root, 'work'),
      execute: true,
      skipBlockers: false,
      onlyRepoNum: null,
      duplicateResolutions: null,
    }, {
      remote: {
        publishBatch({ repo, files }) {
          published.push({ repo, files: files.map(file => file.file) });
          for (const file of files) {
            const target = path.join(remoteRoot, repo, 'resourcepacks', file.file);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(file.path, target);
          }
        },
        verifyArchive(item) {
          const target = path.join(remoteRoot, item.repo, 'resourcepacks', item.file);
          assert.equal(crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'), item.fingerprint.archiveSha256);
        },
      },
    });

    assert.equal(result.uploadEntries[0].file, 'Inner.zip');
    assert.deepEqual(published, [{ repo: 'packs-001', files: ['Inner.zip'] }]);
    assert.equal(fs.existsSync(path.join(root, 'work')), false);
    assert.equal(fs.existsSync(path.join(root, '.vale-pack-upload')), false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('legacy migration command rejects direct archive migration with a nonzero exit', () => {
  const result = spawnSync(process.execPath, ['scripts/migrate-packs.js'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /retired|upload-folder/i);
});

test('browser admin has no archive write/delete surface', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'assets/js/admin.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin/index.html'), 'utf8');
  const { Admin, ARCHIVE_MUTATIONS_DISABLED } = require('../assets/js/admin.js');
  assert.equal(ARCHIVE_MUTATIONS_DISABLED, true);
  assert.doesNotMatch(html, /id="(?:file-input|upload-btn|batch-delete-btn)"/);
  let fetchCalls = 0;
  const previousFetch = global.fetch;
  global.fetch = () => { fetchCalls += 1; throw new Error('archive request should not happen'); };
  const messages = [];
  const instance = { showMessage: (...args) => messages.push(args) };
  return Promise.all([
    Admin.prototype.upload.call(instance),
    Admin.prototype.batchDelete.call(instance),
    Admin.prototype.deletePack.call(instance, 'Pack'),
  ]).finally(() => {
    global.fetch = previousFetch;
    assert.equal(fetchCalls, 0);
    assert.equal(messages.length, 3);
    assert.match(source, /ARCHIVE_MUTATIONS_DISABLED/);
  });
});

test('main repository tracks no archive blobs or resourcepacks directory', () => {
  const result = spawnSync('git', ['ls-files', '*.zip', 'resourcepacks/**'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '');
});
