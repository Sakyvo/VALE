const test = require('node:test');
const assert = require('node:assert');

// buildGroupedData is not exported directly; load the module internals by requiring
// the generator and invoking its private function through a thin test seam.
// We replicate the minimal packData shape that processTexture produces.
const {
  computeGroupKey,
  OBSERVABLE_GROUP_SURFACES,
} = require('../scripts/lib/group-equivalence');

// Minimal packData factory: surfaces carry { dhash, hist, moments, edge, sig, pix }.
// Only dhash participates in the observable group key for anchor surfaces.
function surf(dhashHex) {
  return {
    dhash: dhashHex,
    hist: [1, 2, 3],
    moments: { meanLum: 10.0 },
    edge: 0.5,
    sig: { n: 5, meanR: 12.34 },
    pix: new Array(256).fill(0),
  };
}

test('computeGroupKey depends only on anchor-surface dhash', () => {
  const packA = {
    diamond_sword: surf('aaaa'),
    ender_pearl: surf('bbbb'),
    splash_potion: surf('cccc'),
    steak: surf('dddd'),
    golden_carrot: surf('eeee'),
    hotbar_widget: { hist: [9], moments: { x: 1 }, edge: 0 },
    health_full: surf('ffff'),
  };
  const keyA = computeGroupKey(packA);
  // Same anchor dhashes but different food/widget/HUD -> same group
  const packB = {
    ...packA,
    steak: surf('zzzz'),
    golden_carrot: surf('yyyy'),
    hotbar_widget: { hist: [0], moments: { x: 2 }, edge: 1 },
    health_full: surf('0000'),
  };
  const keyB = computeGroupKey(packB);
  assert.strictEqual(keyA, keyB, 'differing only in non-anchor surfaces must merge');
});

test('computeGroupKey differs when an anchor dhash differs', () => {
  const packA = { diamond_sword: surf('aaaa'), ender_pearl: surf('bbbb'), splash_potion: surf('cccc') };
  const packB = { ...packA, diamond_sword: surf('aabb') };
  assert.notStrictEqual(computeGroupKey(packA), computeGroupKey(packB));
});

test('computeGroupKey treats missing anchor surfaces as null (deterministic)', () => {
  const pack = { diamond_sword: surf('aaaa') }; // EP, HL missing
  const key = computeGroupKey(pack);
  assert.ok(key.startsWith('g:'));
  const keyAgain = computeGroupKey(pack);
  assert.strictEqual(key, keyAgain, 'deterministic for missing surfaces');
  // A pack with the same DS but different EP dhash still present differs
  const pack2 = { ...pack, ender_pearl: surf('bbbb') };
  assert.notStrictEqual(key, computeGroupKey(pack2));
});

test('OBSERVABLE_GROUP_SURFACES is exactly the three anchors', () => {
  assert.deepStrictEqual(OBSERVABLE_GROUP_SURFACES, ['diamond_sword', 'ender_pearl', 'splash_potion']);
});

test('computeGroupKey is insensitive to float noise in non-dhash fields', () => {
  const packA = { diamond_sword: surf('aaaa'), ender_pearl: surf('bbbb'), splash_potion: surf('cccc') };
  const packB = {
    diamond_sword: { ...packA.diamond_sword, moments: { meanLum: 10.0000001 }, sig: { n: 5, meanR: 12.340001 } },
    ender_pearl: packA.ender_pearl,
    splash_potion: packA.splash_potion,
  };
  assert.strictEqual(computeGroupKey(packA), computeGroupKey(packB), 'float noise must not split groups');
});
