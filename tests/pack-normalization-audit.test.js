const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');
const sharp = require('sharp');
const { computeRegistryDigest } = require('../scripts/lib/pack-content-index');
const { getPackIdFromZipName } = require('../scripts/pack-utils');
const { auditRegistry, renderSummary, validateAuditManifest } = require('../scripts/audit-pack-normalization');

async function writePack(filePath, prefix = '', color = { r: 20, g: 80, b: 140, alpha: 1 }) {
  const texture = await sharp({ create: { width: 8, height: 8, channels: 4, background: color } }).png().toBuffer();
  const zip = new AdmZip();
  zip.addFile(`${prefix}pack.mcmeta`, Buffer.from('{}'));
  zip.addFile(`${prefix}assets/minecraft/textures/blocks/stone.png`, texture);
  zip.writeZip(filePath);
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('audits every registry archive, including hidden entries, and cleans remote staging', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-normalization-audit-'));
  try {
    const remoteRoot = path.join(root, 'remote');
    fs.mkdirSync(remoteRoot);
    const normalPath = path.join(remoteRoot, 'Normal.zip');
    const wrappedPath = path.join(remoteRoot, 'Hidden.zip');
    await writePack(normalPath, '', { r: 20, g: 80, b: 140, alpha: 1 });
    await writePack(wrappedPath, 'Inner/', { r: 140, g: 60, b: 30, alpha: 1 });
    const registry = {
      'Normal.zip': { repo: 'packs-001', repoNum: 1, size: fs.statSync(normalPath).size },
      'Hidden.zip': { repo: 'packs-002', repoNum: 2, size: fs.statSync(wrappedPath).size },
    };
    const registryPath = path.join(root, 'registry.json');
    const siteIndexPath = path.join(root, 'index.json');
    const listsPath = path.join(root, 'lists.json');
    const extractedPath = path.join(root, 'extracted.json');
    const manifestPath = path.join(root, 'manifest.json');
    const auditPath = path.join(root, 'audit.json');
    const summaryPath = path.join(root, 'summary.md');
    fs.writeFileSync(registryPath, JSON.stringify(registry));
    fs.writeFileSync(siteIndexPath, JSON.stringify({ items: [{ name: getPackIdFromZipName('Normal.zip') }] }));
    fs.writeFileSync(listsPath, JSON.stringify([{ name: 'Sakyvo', packs: ['Normal'] }]));
    fs.writeFileSync(extractedPath, JSON.stringify([{ originalName: 'Normal', packId: 'Normal' }]));
    const before = [registryPath, siteIndexPath, listsPath, extractedPath].map(file => sha256(file));
    const downloads = [];
    const options = {
      registryPath,
      siteIndexPath,
      listsPath,
      extractedPath,
      manifestPath,
      auditPath,
      summaryPath,
      workdir: path.join(root, 'work'),
    };
    const services = {
      remote: {
        async downloadArchive({ file, destination }) {
          downloads.push(file);
          fs.copyFileSync(path.join(remoteRoot, file), destination);
        },
      },
    };

    const first = await auditRegistry(options, services);
    assert.equal(first.manifest.entries.length, 2);
    assert.deepEqual(downloads.sort(), ['Hidden.zip', 'Normal.zip']);
    const hidden = first.manifest.entries.find(entry => entry.file === 'Hidden.zip');
    assert.equal(hidden.visibility.public, false);
    assert.equal(hidden.visibility.registryOnly, true);
    assert.equal(hidden.normalization.classification, 'repairable');
    assert.equal(hidden.normalization.products[0].classification, 'normal');
    assert.equal(hidden.source.size, registry['Hidden.zip'].size);
    assert.equal(hidden.source.archiveSha256, sha256(wrappedPath));
    assert.equal(first.manifest.registryDigest, computeRegistryDigest(registry));
    assert.equal(fs.existsSync(options.workdir), false);
    assert.deepEqual([registryPath, siteIndexPath, listsPath, extractedPath].map(file => sha256(file)), before);
    const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
    assert.equal(audit.entries.length, 2);
    assert.ok(audit.entries.every(entry => !JSON.stringify(entry).includes(path.resolve(root))));
    assert.ok(!JSON.stringify(audit).includes('Inner/pack.mcmeta'));

    const firstSummary = fs.readFileSync(summaryPath, 'utf8');
    await auditRegistry(options, services);
    assert.equal(fs.readFileSync(summaryPath, 'utf8'), firstSummary);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('requires hash-bound review decisions and rejects stale registry or remote evidence', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-normalization-decisions-'));
  try {
    const remoteRoot = path.join(root, 'remote');
    fs.mkdirSync(remoteRoot);
    const illegalPath = path.join(remoteRoot, 'Illegal.zip');
    const oversizePath = path.join(remoteRoot, 'Oversize.zip');
    const illegalZip = new AdmZip();
    illegalZip.addFile('readme.txt', Buffer.from('not a pack'));
    illegalZip.writeZip(illegalPath);
    const oversizeZip = new AdmZip();
    oversizeZip.addFile('pack.mcmeta', Buffer.from('{}'));
    oversizeZip.addFile('assets/minecraft/large.bin', crypto.randomBytes(200));
    oversizeZip.writeZip(oversizePath);
    const registry = {
      'Illegal.zip': { repo: 'packs-001', repoNum: 1, size: fs.statSync(illegalPath).size },
      'Oversize.zip': { repo: 'packs-001', repoNum: 1, size: fs.statSync(oversizePath).size },
    };
    const registryPath = path.join(root, 'registry.json');
    const manifestPath = path.join(root, 'manifest.json');
    const auditPath = path.join(root, 'audit.json');
    const summaryPath = path.join(root, 'summary.md');
    fs.writeFileSync(registryPath, JSON.stringify(registry));
    const options = {
      registryPath,
      siteIndexPath: path.join(root, 'index.json'),
      listsPath: path.join(root, 'lists.json'),
      extractedPath: path.join(root, 'extracted.json'),
      manifestPath,
      auditPath,
      summaryPath,
      githubFileLimit: 100,
      workdir: path.join(root, 'work'),
    };
    fs.writeFileSync(options.siteIndexPath, '{"items":[]}');
    fs.writeFileSync(options.listsPath, '[]');
    fs.writeFileSync(options.extractedPath, '[]');
    const remote = {
      async downloadArchive({ file, destination }) {
        fs.copyFileSync(path.join(remoteRoot, file), destination);
      },
      async getArchiveIdentity({ file }) {
        const filePath = path.join(remoteRoot, file);
        return { size: fs.statSync(filePath).size, archiveSha256: sha256(filePath) };
      },
    };
    const { manifest } = await auditRegistry(options, { remote });
    assert.equal(manifest.executable, false);
    assert.ok(manifest.entries.every(entry => entry.reviewRequired));

    const decisionsPath = path.join(root, 'decisions.json');
    fs.writeFileSync(decisionsPath, JSON.stringify({
      schemaVersion: 1,
      registryDigest: manifest.registryDigest,
      decisions: [
        { file: 'Illegal.zip', action: 'defer', reason: 'manual replacement required' },
        { file: 'Oversize.zip', action: 'defer', reason: 'online archive remains unchanged' },
      ],
    }));
    const reviewed = await validateAuditManifest(manifest, { registryPath, decisionsPath, remote });
    assert.equal(reviewed.executable, true);
    assert.equal(reviewed.entries.every(entry => entry.decision.action === 'defer'), true);

    const staleRegistry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    staleRegistry['Illegal.zip'].size += 1;
    fs.writeFileSync(registryPath, JSON.stringify(staleRegistry));
    await assert.rejects(
      () => validateAuditManifest(manifest, { registryPath, decisionsPath, remote }),
      /stale.*registry/i
    );

    fs.writeFileSync(registryPath, JSON.stringify(registry));
    const changed = fs.readFileSync(oversizePath);
    changed[changed.length - 1] ^= 0xff;
    fs.writeFileSync(oversizePath, changed);
    await assert.rejects(
      () => validateAuditManifest(manifest, { registryPath, decisionsPath, remote }),
      /remote.*changed|archive.*changed/i
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('renders audit categories in deterministic review order', () => {
  const manifest = {
    registryDigest: 'digest',
    normalizationSchemaVersion: 1,
    entries: [
      { file: 'z.zip', normalization: { classification: 'illegal', collection: false, causes: ['no_core_found'] }, blockers: [], decision: null },
      { file: 'a.zip', normalization: { classification: 'normal', collection: false, causes: [] }, blockers: [], decision: null },
      { file: 'c.zip', normalization: { classification: 'repairable', collection: false, causes: ['nested_container'] }, blockers: [{ code: 'blocked_oversize' }], decision: null },
      { file: 'd.zip', normalization: { classification: 'repairable', collection: false, causes: [] }, blockers: [{ code: 'content_duplicate_conflict' }], decision: null },
      { file: 'e.zip', normalization: { classification: 'illegal', collection: false, causes: ['not_zip'] }, blockers: [], decision: { action: 'defer' } },
    ],
  };
  manifest.summary = {
    normal: 1,
    repairable: 0,
    collection: 0,
    illegal: 1,
    oversize: 1,
    'safety-blocked': 0,
    conflict: 1,
    deferred: 1,
  };
  const markdown = renderSummary(manifest);
  assert.ok(markdown.indexOf('## Normal') < markdown.indexOf('## Repairable'));
  assert.ok(markdown.indexOf('## Repairable') < markdown.indexOf('## Collection'));
  assert.ok(markdown.indexOf('## Collection') < markdown.indexOf('## Illegal material'));
  assert.ok(markdown.indexOf('## Illegal material') < markdown.indexOf('## Oversize'));
  assert.match(markdown, /`a\.zip`/);
  assert.match(markdown, /`e\.zip`/);
});
