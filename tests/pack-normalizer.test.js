const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');
const sharp = require('sharp');
const {
  NORMALIZATION_SCHEMA_VERSION,
  normalizePack,
} = require('../scripts/lib/pack-normalizer');

async function png() {
  return sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 20, g: 80, b: 140, alpha: 1 } },
  }).png().toBuffer();
}

async function writePack(filePath, prefix = '') {
  const zip = new AdmZip();
  zip.addFile(`${prefix}pack.mcmeta`, Buffer.from('{"pack":{"pack_format":1,"description":"test"}}'));
  zip.addFile(`${prefix}pack.png`, await png());
  zip.addFile(`${prefix}assets/minecraft/textures/blocks/stone.png`, await png());
  zip.writeZip(filePath);
}

test('normalizes one wrapper reproducibly and leaves a Normal pack byte-for-byte unchanged', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-normalizer-'));
  try {
    const normalPath = path.join(root, 'Normal.zip');
    const wrappedPath = path.join(root, 'Wrapped.zip');
    await writePack(normalPath);
    await writePack(wrappedPath, 'Inner/');

    const normal = await normalizePack(normalPath, { outputDir: path.join(root, 'normal-out') });
    const first = await normalizePack(wrappedPath, { outputDir: path.join(root, 'first-out') });
    const second = await normalizePack(wrappedPath, { outputDir: path.join(root, 'second-out') });

    assert.equal(normal.schemaVersion, NORMALIZATION_SCHEMA_VERSION);
    assert.equal(normal.classification, 'normal');
    assert.equal(normal.products[0].path, normalPath);
    assert.equal(normal.products[0].archiveSha256, normal.sourceArchiveSha256);

    assert.equal(first.classification, 'repairable');
    assert.deepEqual(first.causes, ['nested_container']);
    assert.equal(first.products[0].archiveSha256, second.products[0].archiveSha256);
    assert.equal(first.products[0].classification, 'normal');
    assert.deepEqual(
      new AdmZip(first.products[0].path).getEntries().filter(entry => !entry.isDirectory).map(entry => entry.entryName),
      [
        'assets/minecraft/textures/blocks/stone.png',
        'pack.mcmeta',
        'pack.png',
      ]
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
