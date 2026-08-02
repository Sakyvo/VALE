const assert = require('node:assert/strict');
const test = require('node:test');
const { textureVersionSignal, HIGH_VERSION_CAUSE } = require('../scripts/lib/pack-normalizer');

const paths = (...list) => list.map(path => ({ path }));

test('plural texture directories are low-version evidence', () => {
  assert.equal(textureVersionSignal(paths(
    'assets/minecraft/textures/items/diamond_sword.png',
    'pack.mcmeta',
  )), 'low');
  assert.equal(textureVersionSignal(paths(
    'assets/minecraft/textures/blocks/stone.png',
  )), 'low');
});

test('singular item textures or a singular block directory mark a high-version pack', () => {
  assert.equal(textureVersionSignal(paths(
    'assets/minecraft/textures/item/apple.png',
    'pack.mcmeta',
  )), 'high');
  assert.equal(textureVersionSignal(paths(
    'assets/minecraft/textures/block/stone.png',
  )), 'high');
});

test('plural evidence wins when a pack carries both layouts', () => {
  assert.equal(textureVersionSignal(paths(
    'assets/minecraft/textures/item/apple.png',
    'assets/minecraft/textures/items/diamond_sword.png',
  )), 'low');
});

test('an empty singular item directory is not evidence on its own', () => {
  assert.equal(textureVersionSignal([
    { path: 'assets/minecraft/textures/item/', directory: true },
    { path: 'pack.mcmeta' },
  ]), 'none');
});

test('packs without either layout report no signal', () => {
  assert.equal(textureVersionSignal(paths(
    'assets/minecraft/textures/gui/widgets.png',
    'pack.mcmeta',
  )), 'none');
});

test('the version signal reads layout only, never a declared pack_format', () => {
  const declaredNew = [
    { path: 'assets/minecraft/textures/items/diamond_sword.png' },
    { path: 'pack.mcmeta', declaredFormat: 22 },
  ];
  assert.equal(textureVersionSignal(declaredNew), 'low', 'a 1.8 pack declaring a modern format stays low-version');
});

test('high-version packs carry a dedicated classification cause', () => {
  assert.equal(typeof HIGH_VERSION_CAUSE, 'string');
  assert.ok(HIGH_VERSION_CAUSE.length > 0);
  assert.notEqual(HIGH_VERSION_CAUSE, 'illegal');
  assert.notEqual(HIGH_VERSION_CAUSE, 'repairable');
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectPackSource } = require('../scripts/lib/pack-normalizer');

function packDir(layout) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vale-ver-'));
  for (const [rel, body] of Object.entries(layout)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return dir;
}

test('a high-version source classifies into its own bucket, not illegal or repairable', () => {
  const dir = packDir({
    'pack.mcmeta': '{"pack":{"pack_format":1,"description":"x"}}',
    'assets/minecraft/textures/item/apple.png': 'x',
    'assets/minecraft/textures/block/stone.png': 'x',
  });
  const result = inspectPackSource(dir);
  assert.equal(result.classification, HIGH_VERSION_CAUSE);
  assert.deepEqual(result.causes, [HIGH_VERSION_CAUSE]);
});

test('a low-version source is unaffected by the version gate', () => {
  const dir = packDir({
    'pack.mcmeta': '{"pack":{"pack_format":1,"description":"x"}}',
    'assets/minecraft/textures/items/diamond_sword.png': 'x',
  });
  const result = inspectPackSource(dir);
  assert.notEqual(result.classification, HIGH_VERSION_CAUSE);
});
