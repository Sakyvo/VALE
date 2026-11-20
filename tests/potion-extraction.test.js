const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');
const sharp = require('sharp');

const { extractPack } = require('../scripts/extract-textures');

async function png(color, size = 16) {
  return sharp({ create: { width: size, height: size, channels: 4, background: color } }).png().toBuffer();
}

// A pack carrying only what the potion branch needs.
async function writePack(dir, textures) {
  const zip = new AdmZip();
  zip.addFile('pack.mcmeta', Buffer.from('{"pack":{"pack_format":1,"description":"test"}}'));
  for (const [relativePath, buffer] of Object.entries(textures)) {
    zip.addFile(relativePath, buffer);
  }
  const file = path.join(dir, 'Potion Pack.zip');
  zip.writeZip(file);
  return file;
}

async function pixels(filePath) {
  const { data, info } = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    at(x, y) {
      const i = (y * info.width + x) * 4;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    },
  };
}

test('a pack with its own potions produces all six potion files', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-potion-'));
  // White mask everywhere, transparent bottle: the composites keep the pure tint.
  const overlay = await sharp({
    create: { width: 16, height: 16, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  }).png().toBuffer();
  const emptyBottle = await sharp({
    create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).png().toBuffer();

  const zipPath = await writePack(dir, {
    'assets/minecraft/textures/items/potion_overlay.png': overlay,
    'assets/minecraft/textures/items/potion_bottle_splash.png': emptyBottle,
    'assets/minecraft/textures/items/potion_bottle_drinkable.png': emptyBottle,
  });

  const result = await extractPack(zipPath, path.join(dir, 'out'));
  const outDir = result.outputDir;

  for (const file of [
    'potion_overlay.png',
    'potion_bottle_splash.png',
    'potion_bottle_drinkable.png',
    'splash_potion_of_healing.png',
    'potion_speed.png',
    'potion_fire_resistance.png',
  ]) {
    assert.ok(fs.existsSync(path.join(outDir, file)), `${file} was extracted`);
  }

  // Each potion carries its own colour, so the three slots cannot look alike.
  assert.deepEqual((await pixels(path.join(outDir, 'splash_potion_of_healing.png'))).at(8, 8), [248, 36, 35, 255]);
  assert.deepEqual((await pixels(path.join(outDir, 'potion_speed.png'))).at(8, 8), [124, 175, 198, 255]);
  assert.deepEqual((await pixels(path.join(outDir, 'potion_fire_resistance.png'))).at(8, 8), [228, 154, 58, 255]);
  // The potion products join the item list alongside the plain item textures.
  for (const file of ['splash_potion_of_healing.png', 'potion_speed.png', 'potion_fire_resistance.png']) {
    assert.ok(result.extracted.items.includes(file), `${file} is listed as an extracted item`);
  }
});

test('a pack with no potion textures falls back to the vanilla bottles', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-potion-vanilla-'));
  const zipPath = await writePack(dir, {
    'assets/minecraft/textures/items/diamond_sword.png': await png({ r: 1, g: 2, b: 3, alpha: 1 }),
  });

  const result = await extractPack(zipPath, path.join(dir, 'out'));

  for (const file of ['potion_bottle_drinkable.png', 'potion_bottle_splash.png', 'potion_speed.png', 'potion_fire_resistance.png', 'splash_potion_of_healing.png']) {
    assert.ok(fs.existsSync(path.join(result.outputDir, file)), `${file} fell back to the vanilla texture`);
  }
});

test('extracting the same pack twice produces byte-identical potions', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-potion-stable-'));
  const zipPath = await writePack(dir, {
    'assets/minecraft/textures/items/potion_overlay.png': await png({ r: 255, g: 255, b: 255, alpha: 1 }),
  });

  const first = await extractPack(zipPath, path.join(dir, 'a'));
  const second = await extractPack(zipPath, path.join(dir, 'b'));

  for (const file of ['potion_speed.png', 'potion_fire_resistance.png', 'splash_potion_of_healing.png']) {
    assert.deepEqual(
      await fs.promises.readFile(path.join(first.outputDir, file)),
      await fs.promises.readFile(path.join(second.outputDir, file)),
      `${file} is deterministic`,
    );
  }
});