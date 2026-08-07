const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ATLAS_FILES,
  planDisplayAsset,
} = require('../scripts/lib/display-assets');

test('atlas-class files are capped at 512 on their largest side', () => {
  for (const name of ['particles.png', 'inventory.png', 'inv.png', 'icons.png', 'widgets.png']) {
    assert.ok(ATLAS_FILES.has(name), `${name} is atlas class`);
  }
  assert.deepEqual(planDisplayAsset('particles.png', 1024, 1024), {
    action: 'resize', width: 512, height: 512, factor: 2,
  });
  assert.deepEqual(planDisplayAsset('icons.png', 2048, 2048), {
    action: 'resize', width: 512, height: 512, factor: 4,
  });
  // Non-square atlas: the governing side is the larger one, both sides scale by the same factor.
  assert.deepEqual(planDisplayAsset('widgets.png', 1024, 512), {
    action: 'resize', width: 512, height: 256, factor: 2,
  });
});

test('item and block textures are capped at 256 on their frame side', () => {
  assert.deepEqual(planDisplayAsset('diamond_sword.png', 512, 512), {
    action: 'resize', width: 256, height: 256, factor: 2,
  });
  assert.deepEqual(planDisplayAsset('grass_side.png', 1024, 1024), {
    action: 'resize', width: 256, height: 256, factor: 4,
  });
  // Unknown files fall into the item/block class.
  assert.deepEqual(planDisplayAsset('some_future_texture.png', 512, 384), {
    action: 'resize', width: 256, height: 192, factor: 2,
  });
});

test('animated strips keep their frames: the frame side governs, not the strip height', () => {
  // 64x64 frames stacked 16 high: the strip is tall but each frame is small.
  assert.deepEqual(planDisplayAsset('diamond_ore.png', 64, 1024), { action: 'keep' });
  // 512x512 frames stacked: downscale by exactly 2 so frame geometry survives.
  assert.deepEqual(planDisplayAsset('diamond_ore.png', 512, 8192), {
    action: 'resize', width: 256, height: 4096, factor: 2,
  });
});

test('pack.png is pressed to 256', () => {
  assert.deepEqual(planDisplayAsset('pack.png', 512, 512), {
    action: 'resize', width: 256, height: 256, factor: 2,
  });
  assert.deepEqual(planDisplayAsset('pack.png', 128, 128), { action: 'keep' });
});

test('files at or below their cap stay untouched', () => {
  assert.deepEqual(planDisplayAsset('particles.png', 512, 512), { action: 'keep' });
  assert.deepEqual(planDisplayAsset('inventory.png', 256, 256), { action: 'keep' });
  assert.deepEqual(planDisplayAsset('diamond_sword.png', 256, 256), { action: 'keep' });
  assert.deepEqual(planDisplayAsset('diamond_sword.png', 16, 16), { action: 'keep' });
});

test('cover.png never changes at any input size', () => {
  assert.deepEqual(planDisplayAsset('cover.png', 1920, 1080), { action: 'keep' });
  assert.deepEqual(planDisplayAsset('cover.png', 4096, 4096), { action: 'keep' });
  assert.deepEqual(planDisplayAsset('cover.png', 100, 100), { action: 'keep' });
});

test('every resize is a power-of-two factor applied uniformly to both sides', () => {
  const cases = [
    ['particles.png', 4096, 2048],
    ['icons.png', 768, 768],
    ['diamond_sword.png', 300, 300],
    ['pack.png', 1000, 1000],
    ['diamond_ore.png', 256, 2560],
  ];
  for (const [name, w, h] of cases) {
    const plan = planDisplayAsset(name, w, h);
    if (plan.action === 'keep') continue;
    const ratio = w / plan.width;
    assert.ok(Number.isInteger(plan.width) && Number.isInteger(plan.height), `${name} integer dims`);
    assert.ok(ratio >= 2 && (ratio & (ratio - 1)) === 0, `${name} ratio ${ratio} is a power of two`);
    assert.equal(ratio, h / plan.height, `${name} uniform factor on both axes`);
    assert.equal(ratio, plan.factor, `${name} factor matches the dimension ratio`);
  }
});

test('rejects unknown actions and invalid dimensions', () => {
  assert.throws(() => planDisplayAsset('diamond_sword.png', 0, 100), /Invalid texture dimensions/);
  assert.throws(() => planDisplayAsset('diamond_sword.png', -5, 100), /Invalid texture dimensions/);
  assert.throws(() => planDisplayAsset('diamond_sword.png', 100.5, 100), /Invalid texture dimensions/);
  assert.throws(() => planDisplayAsset('', 100, 100), /Invalid texture filename/);
});
