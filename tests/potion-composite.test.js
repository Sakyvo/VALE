const assert = require('node:assert/strict');
const test = require('node:test');
const sharp = require('sharp');

const { POTION_COLORS, POTION_PRODUCTS, compositePotion, tintLiquid } = require('../scripts/lib/potion-composite');

// A 4x4 PNG whose pixels are produced by `paint(x, y)`.
async function png(paint, size = 4) {
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = paint(x, y);
      const i = (y * size + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return sharp(data, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
}

async function pixels(buffer) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    at(x, y) {
      const i = (y * info.width + x) * 4;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    },
  };
}

test('the liquid mask is multiplied by the potion colour, keeping its shading', async () => {
  const mask = await png((x) => (x === 0 ? [128, 128, 128, 255] : [255, 255, 255, 255]));
  const tinted = await pixels(await tintLiquid(mask, [248, 36, 35]));

  // 128/255 of the colour keeps its shading instead of flattening to the flat colour.
  assert.deepEqual(tinted.at(0, 0), [124, 18, 18, 255]);
  assert.deepEqual(tinted.at(1, 0), [248, 36, 35, 255]);
});

test('a fully transparent mask stays invisible after tinting', async () => {
  const mask = await png(() => [255, 255, 255, 0]);
  const tinted = await pixels(await tintLiquid(mask, [124, 175, 198]));
  assert.deepEqual(tinted.at(0, 0), [0, 0, 0, 0]);
});

test('the bottle sprite is drawn over the tinted liquid', async () => {
  const overlay = await png(() => [255, 255, 255, 255]);
  const bottle = await png((x) => (x < 2 ? [10, 20, 30, 255] : [0, 0, 0, 0]));

  const result = await pixels(await compositePotion({
    bottle,
    overlay,
    color: POTION_COLORS.instant_health,
  }));

  assert.deepEqual(result.at(0, 0), [10, 20, 30, 255]); // bottle wins
  assert.deepEqual(result.at(3, 0), [248, 36, 35, 255]); // liquid shows through
});

test('the three published potions use the two bottle shapes and three colours', () => {
  assert.deepEqual(
    POTION_PRODUCTS.map(product => [product.file, product.bottle, product.color]),
    [
      ['splash_potion_of_healing.png', 'splash', 'instant_health'],
      ['potion_speed.png', 'drinkable', 'speed'],
      ['potion_fire_resistance.png', 'drinkable', 'fire_resistance'],
    ],
  );
});
test('mixed resolution bottles and liquid masks share one pixel grid', async () => {
  const overlay = await png(() => [255, 255, 255, 255], 4);
  const bottle = await png(x => x < 4 ? [10, 20, 30, 255] : [0, 0, 0, 0], 8);
  const result = await pixels(await compositePotion({ bottle, overlay, color: [124, 175, 198] }));
  assert.equal(result.width, 8);
  assert.deepEqual(result.at(0, 0), [10, 20, 30, 255]);
  assert.deepEqual(result.at(7, 0), [124, 175, 198, 255]);
});
