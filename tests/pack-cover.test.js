const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sharp = require('sharp');

const { generateCoverFromOutputDir } = require('../scripts/thumbnail-preview-utils');

const SCALE = 4;

// A pack whose HUD sprites are solid, uniquely coloured blocks. The colour of a pixel
// in the cover therefore names the sprite that landed there, which is the independent
// oracle for the layout below.
const SPRITES = {
  icons: [
    { rect: [16, 0, 9, 9], color: [255, 0, 0, 255] },        // heart container
    { rect: [52, 0, 9, 9], color: [255, 0, 255, 255] },      // full heart
    { rect: [16, 9, 9, 9], color: [255, 255, 0, 255] },      // armor container
    { rect: [34, 9, 9, 9], color: [0, 255, 0, 255] },        // full armor
    { rect: [16, 27, 9, 9], color: [0, 0, 255, 255] },       // hunger container
    { rect: [52, 27, 9, 9], color: [255, 128, 0, 255] },     // full hunger
    { rect: [0, 64, 182, 5], color: [64, 64, 64, 255] },     // experience bar background
    { rect: [0, 69, 182, 5], color: [128, 0, 128, 255] },    // experience bar fill
  ],
  widgets: [
    { rect: [0, 0, 182, 22], color: [16, 16, 16, 255] },     // hotbar
    { rect: [0, 22, 24, 24], color: [0, 255, 255, 255] },    // slot selection frame
  ],
};

function paintRects(width, height, rects) {
  const data = Buffer.alloc(width * height * 4);
  for (const { rect, color } of rects) {
    const [x0, y0, w, h] = rect;
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * width + x) * 4;
        data[i] = color[0];
        data[i + 1] = color[1];
        data[i + 2] = color[2];
        data[i + 3] = color[3];
      }
    }
  }
  return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

// Vanilla-layout font: 16x16 cells of 8px, digits inked 5 wide and 7 tall.
function paintFont(width) {
  const cell = width / 16;
  const rects = [];
  for (const ch of '01564') {
    const code = ch.charCodeAt(0);
    const x = (code % 16) * cell;
    const y = Math.floor(code / 16) * cell;
    rects.push({ rect: [x, y, cell * 5 / 8, cell * 7 / 8], color: [255, 255, 255, 255] });
  }
  return paintRects(width, width, rects);
}

async function solidItem(size, color) {
  return paintRects(size, size, [{ rect: [0, 0, size, size], color }]);
}

async function buildPackDir() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-cover-'));
  await fs.promises.writeFile(path.join(dir, 'icons.png'), await paintRects(256, 256, SPRITES.icons));
  await fs.promises.writeFile(path.join(dir, 'widgets.png'), await paintRects(256, 256, SPRITES.widgets));
  await fs.promises.writeFile(path.join(dir, 'ascii.png'), await paintFont(128));
  await fs.promises.writeFile(path.join(dir, 'diamond_sword.png'), await solidItem(16, [255, 0, 0, 255]));
  await fs.promises.writeFile(path.join(dir, 'ender_pearl.png'), await solidItem(16, [0, 255, 0, 255]));
  await fs.promises.writeFile(path.join(dir, 'steak.png'), await solidItem(16, [120, 60, 20, 255]));
  await fs.promises.writeFile(path.join(dir, 'golden_carrot.png'), await solidItem(16, [200, 150, 0, 255]));
  await fs.promises.writeFile(path.join(dir, 'apple_golden.png'), await solidItem(16, [220, 180, 30, 255]));
  await fs.promises.writeFile(path.join(dir, 'potion_speed.png'), await solidItem(16, [0, 100, 200, 255]));
  await fs.promises.writeFile(path.join(dir, 'potion_fire_resistance.png'), await solidItem(16, [200, 100, 0, 255]));
  await fs.promises.writeFile(path.join(dir, 'splash_potion_of_healing.png'), await solidItem(16, [250, 20, 20, 255]));
  return dir;
}

async function readCover(dir) {
  const { data, info } = await sharp(path.join(dir, 'cover.png'))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    // Sampled in HUD base units so the assertions read like the contract.
    at(x, y) {
      const i = ((y * SCALE) * info.width + x * SCALE) * 4;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    },
    // Bounding box of an exact colour in output pixels, optionally inside a region.
    bbox(color, region) {
      const [rx0, ry0, rx1, ry1] = region ?? [0, 0, info.width, info.height];
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -1;
      let maxY = -1;
      for (let y = ry0; y < ry1; y++) {
        for (let x = rx0; x < rx1; x++) {
          const i = (y * info.width + x) * 4;
          if (data[i] !== color[0] || data[i + 1] !== color[1] || data[i + 2] !== color[2]) continue;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      if (maxX < 0) return null;
      return { x0: minX, y0: minY, x1: maxX, y1: maxY };
    },
  };
}

test('cover is a 728x196 HUD strip on a solid sky background', async () => {
  const dir = await buildPackDir();
  await generateCoverFromOutputDir(dir);

  const cover = await readCover(dir);
  assert.equal(cover.width, 728);
  assert.equal(cover.height, 196);
  assert.deepEqual(cover.at(0, 0), [0x87, 0xCE, 0xEB, 255]);
  // The gap between the experience bar and the hotbar stays background.
  assert.deepEqual(cover.at(181, 25), [0x87, 0xCE, 0xEB, 255]);
});

test('HUD rows land on the Minecraft 1.8 layout', async () => {
  const dir = await buildPackDir();
  await generateCoverFromOutputDir(dir);
  const cover = await readCover(dir);

  // Armor row occupies y 0..8, hearts y 10..18, hunger right-aligned on the same row.
  assert.deepEqual(cover.at(5, 4), [0, 255, 0, 255]);      // armor, full sprite over container
  assert.deepEqual(cover.at(5, 14), [255, 0, 255, 255]);   // heart, full sprite over container
  assert.deepEqual(cover.at(176, 14), [255, 128, 0, 255]); // hunger, full sprite over container
  assert.deepEqual(cover.at(5, 9), [0x87, 0xCE, 0xEB, 255]); // gap between the armor and heart rows

  // Experience bar occupies y 20..24: background beyond the 145-unit fill.
  assert.deepEqual(cover.at(10, 22), [128, 0, 128, 255]);
  assert.deepEqual(cover.at(170, 22), [64, 64, 64, 255]);

  // Hotbar occupies y 27..48; slot 1 carries the selection frame.
  assert.deepEqual(cover.at(30, 47), [16, 16, 16, 255]);
  assert.deepEqual(cover.at(1, 40), [0, 255, 255, 255]);
  assert.deepEqual(cover.at(1, 25), [0x87, 0xCE, 0xEB, 255]);
});

test('hotbar items sit inside their slots with the selection frame on slot 1', async () => {
  const dir = await buildPackDir();
  await generateCoverFromOutputDir(dir);
  const cover = await readCover(dir);

  assert.deepEqual(cover.at(10, 37), [255, 0, 0, 255]);  // diamond sword, slot 1
  assert.deepEqual(cover.at(30, 37), [0, 255, 0, 255]); // ender pearl, slot 2
  assert.deepEqual(cover.at(131, 37), [120, 60, 20, 255]); // steak, slot 7
  assert.deepEqual(cover.at(151, 37), [200, 150, 0, 255]); // golden carrot, slot 8
  assert.deepEqual(cover.at(171, 37), [220, 180, 30, 255]); // golden apple, slot 9
});

test('the three potion slots hold three distinct bottle textures', async () => {
  const dir = await buildPackDir();
  await generateCoverFromOutputDir(dir);
  const cover = await readCover(dir);

  assert.deepEqual(cover.at(51, 37), [0, 100, 200, 255]);   // speed, drinkable
  assert.deepEqual(cover.at(71, 37), [200, 100, 0, 255]);   // fire resistance, drinkable
  assert.deepEqual(cover.at(91, 37), [250, 20, 20, 255]);   // healing, splash
});

test('stack counts are right-aligned inside their slot and the level is centered', async () => {
  const dir = await buildPackDir();
  await generateCoverFromOutputDir(dir);
  const cover = await readCover(dir);

  // Ender pearl stack of 16: two 5x7 glyphs with a 6-unit advance, right edge at the
  // slot's item origin + 17, top at item origin + 9. Slot 2 covers base x 21..40,
  // y 27..48, i.e. output pixels x 84..163, y 108..195.
  assert.deepEqual(cover.bbox([255, 255, 255], [84, 108, 163, 195]), {
    x0: 112, y0: 156, x1: 155, y1: 183,
  });

  // Level 15: two glyphs centred on the 182-unit strip, above the experience bar.
  assert.deepEqual(cover.bbox([0x80, 0xFF, 0x20]), {
    x0: 340, y0: 56, x1: 383, y1: 83,
  });
});

test('a pack with no HUD textures at all still yields a cover from the vanilla fallback', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-cover-empty-'));
  await generateCoverFromOutputDir(dir);

  const cover = await readCover(dir);
  assert.equal(cover.width, 728);
  assert.equal(cover.height, 196);
  assert.deepEqual(cover.at(0, 0), [0x87, 0xCE, 0xEB, 255]);
  // The vanilla sprite atlases were used: armor row and hotbar row are painted.
  assert.notDeepEqual(cover.at(5, 4), [0x87, 0xCE, 0xEB, 255]);
  assert.notDeepEqual(cover.at(30, 47), [0x87, 0xCE, 0xEB, 255]);
});

test('a high-resolution atlas produces the same cover as its vanilla-size twin', async () => {
  const dir = await buildPackDir();
  await generateCoverFromOutputDir(dir);
  const vanilla = await readCover(dir);

  // The same pack with every HUD sprite at four times the resolution. Sprite geometry
  // scales with atlas width, so the output must be identical.
  const scaled = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-cover-hd-'));
  await fs.promises.writeFile(path.join(scaled, 'icons.png'), await sharp(
    await paintRects(256, 256, SPRITES.icons),
  ).resize(1024, 1024, { kernel: 'nearest' }).png().toBuffer());
  await fs.promises.writeFile(path.join(scaled, 'widgets.png'), await sharp(
    await paintRects(256, 256, SPRITES.widgets),
  ).resize(512, 512, { kernel: 'nearest' }).png().toBuffer());
  await fs.promises.writeFile(path.join(scaled, 'ascii.png'), await paintFont(256));
  for (const name of ['diamond_sword', 'ender_pearl', 'steak', 'golden_carrot', 'apple_golden']) {
    const source = path.join(dir, `${name}.png`);
    await fs.promises.writeFile(path.join(scaled, `${name}.png`), await sharp(source).resize(64, 64, { kernel: 'nearest' }).png().toBuffer());
  }
  await fs.promises.writeFile(path.join(scaled, 'potion_speed.png'), await solidItem(64, [0, 100, 200, 255]));
  await fs.promises.writeFile(path.join(scaled, 'potion_fire_resistance.png'), await solidItem(64, [200, 100, 0, 255]));
  await fs.promises.writeFile(path.join(scaled, 'splash_potion_of_healing.png'), await solidItem(64, [250, 20, 20, 255]));

  await generateCoverFromOutputDir(scaled);
  const hd = await readCover(scaled);

  assert.equal(hd.width, vanilla.width);
  for (const point of [[5, 4], [5, 14], [176, 14], [10, 22], [30, 47], [10, 37], [51, 37], [171, 37]]) {
    assert.deepEqual(hd.at(...point), vanilla.at(...point), `pixel ${point.join(',')} matches the vanilla-size render`);
  }
});

test('missing potion products are composed from vanilla instead of leaving empty slots', async t => {
  const dir = await buildPackDir();
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  for (const file of ['potion_speed.png', 'potion_fire_resistance.png', 'splash_potion_of_healing.png']) {
    await fs.promises.unlink(path.join(dir, file));
  }
  await generateCoverFromOutputDir(dir);
  const { data, info } = await sharp(path.join(dir, 'cover.png')).raw().toBuffer({ resolveWithObject: true });
  for (const slot of [2, 3, 4]) {
    let painted = 0;
    for (let y = 120; y < 184; y++) for (let x = (3 + slot * 20) * 4; x < (19 + slot * 20) * 4; x++) {
      const i = (y * info.width + x) * 4;
      if (data[i] !== 16 || data[i + 1] !== 16 || data[i + 2] !== 16) painted++;
    }
    assert.ok(painted > 100, `potion slot ${slot + 1} must contain a bottle, not just hotbar background`);
  }
});
