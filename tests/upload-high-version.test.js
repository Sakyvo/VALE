const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');
const sharp = require('sharp');
const { computeRegistryDigest } = require('../scripts/lib/pack-content-index');
const { HIGH_VERSION_CAUSE } = require('../scripts/lib/pack-normalizer');
const { buildPlan } = require('../scripts/upload-folder');

async function png(color) {
  return sharp({ create: { width: 16, height: 16, channels: 4, background: color } }).png().toBuffer();
}

async function writePack(filePath, { singular }) {
  const zip = new AdmZip();
  zip.addFile('pack.mcmeta', Buffer.from('{"pack":{"pack_format":1,"description":"test"}}'));
  const swordDir = singular ? 'item' : 'items';
  const blockDir = singular ? 'block' : 'blocks';
  zip.addFile(`assets/minecraft/textures/${swordDir}/diamond_sword.png`, await png({ r: 1, g: 120, b: 220, alpha: 1 }));
  zip.addFile(`assets/minecraft/textures/${blockDir}/stone.png`, await png({ r: 90, g: 90, b: 90, alpha: 1 }));
  zip.writeZip(filePath);
}

async function withSource(files, fn) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-hv-plan-'));
  try {
    const source = path.join(dir, 'source');
    fs.mkdirSync(source);
    for (const [name, shape] of Object.entries(files)) {
      await writePack(path.join(source, name), shape);
    }
    const registry = {};
    const paths = {
      source,
      registryPath: path.join(dir, 'registry.json'),
      siteIndexPath: path.join(dir, 'site-index.json'),
      listsPath: path.join(dir, 'lists.json'),
      contentIndex: path.join(dir, 'content-index.json'),
      contentAliases: path.join(dir, 'aliases.json'),
      pendingReplacements: path.join(dir, 'pending.json'),
    };
    fs.writeFileSync(paths.registryPath, JSON.stringify(registry));
    fs.writeFileSync(paths.siteIndexPath, JSON.stringify({ items: [] }));
    fs.writeFileSync(paths.listsPath, '[]');
    fs.writeFileSync(paths.contentIndex, JSON.stringify({
      schemaVersion: 1,
      fingerprintSchemaVersion: 1,
      complete: true,
      registryDigest: computeRegistryDigest(registry),
      failures: [],
      packs: {},
    }));
    await fn({ paths });
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

function options(paths, extra = {}) {
  return {
    ...paths,
    list: 'Sakyvo',
    workdir: path.join(path.dirname(paths.source), 'workdir'),
    execute: false,
    skipBlockers: false,
    onlyRepoNum: null,
    duplicateResolutions: null,
    ...extra,
  };
}

test('a high-version pack is skipped instead of uploaded or listed', async () => withSource(
  { 'HighVersion.zip': { singular: true } },
  async ({ paths }) => {
    const plan = await buildPlan(options(paths));
    assert.equal(plan.uploadEntries.length, 0, 'nothing uploads');
    assert.deepEqual(plan.listPackIds, [], 'nothing joins the List');
    const row = plan.entries.find(entry => entry.file === 'HighVersion.zip');
    assert.ok(row, 'the skipped pack is reported');
    assert.equal(row.classification, HIGH_VERSION_CAUSE);
    assert.equal(row.action, HIGH_VERSION_CAUSE);
  }
));

test('high-version packs do not stop their low-version siblings from uploading', async () => withSource(
  { 'HighVersion.zip': { singular: true }, 'Normal.zip': { singular: false } },
  async ({ paths }) => {
    const plan = await buildPlan(options(paths));
    assert.deepEqual(plan.uploadEntries.map(entry => entry.packId), ['Normal']);
    assert.deepEqual(plan.listPackIds, ['Normal']);
  }
));

test('--skip-blockers cannot make a high-version pack uploadable', async () => withSource(
  { 'HighVersion.zip': { singular: true } },
  async ({ paths }) => {
    const plan = await buildPlan(options(paths, { skipBlockers: true }));
    assert.equal(plan.uploadEntries.length, 0);
    assert.deepEqual(plan.listPackIds, []);
  }
));
