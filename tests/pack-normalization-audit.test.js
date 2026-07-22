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
const { auditRegistry } = require('../scripts/audit-pack-normalization');

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
