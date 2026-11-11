'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { createCanvas, ImageData } = require('@napi-rs/canvas');
const { renderSyntheticShot } = require('../scripts/lib/synthetic-corpus');

const ROOT = path.join(__dirname, '..');
const THUMBS = path.join(ROOT, 'thumbnails');
const TEXTURE_FILES = {
  diamond_sword: 'diamond_sword.png',
  ender_pearl: 'ender_pearl.png',
  splash_potion: 'splash_potion_of_healing.png',
  steak: 'steak.png',
  golden_carrot: 'golden_carrot.png',
};
const SLOT_ORDER = ['DS', 'EP', 'HL', 'food', 'food'];

function loadEngine() {
  const { createSbiEngine } = require('../assets/js/sbi-engine.js');
  return createSbiEngine({
    createCanvas: () => createCanvas(1, 1),
    ImageDataCtor: ImageData,
    fetchImpl: () => { throw new Error('the engine must not fetch during tests'); },
  });
}

// Pack-side texture RGBA, top square only (animated textures stack frames).
async function textureRgba(file) {
  const meta = await sharp(file).metadata();
  const img = meta.height > meta.width && meta.height % meta.width === 0
    ? sharp(file).extract({ left: 0, top: 0, width: meta.width, height: meta.width })
    : sharp(file);
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
}

async function packFingerprints(engine, packId) {
  const out = {};
  for (const [type, file] of Object.entries(TEXTURE_FILES)) {
    const rgba = await textureRgba(path.join(THUMBS, packId, file));
    out[type] = engine.computeTextureFingerprint(rgba.data, rgba.width, rgba.height, 16);
  }
  return out;
}

async function screenshotContext(pngBuffer) {
  const { data, info } = await sharp(pngBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const canvas = createCanvas(info.width, info.height);
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(data), info.width, info.height), 0, 0);
  return { ctx, width: info.width, height: info.height };
}

function rgbaFixture(fn) {
  const bytes = new Uint8ClampedArray(16 * 16 * 4);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * 16 + x) * 4;
      bytes[i] = r; bytes[i + 1] = g; bytes[i + 2] = b; bytes[i + 3] = 255;
    }
  }
  return bytes;
}

test('a texture matches itself and rejects an unrelated texture', () => {
  const engine = loadEngine();
  const gradient = engine.computeTextureFingerprint(rgbaFixture((x, y) => [x * 16, y * 16, (x + y) * 8]), 16, 16, 16);
  const flatRed = engine.computeTextureFingerprint(rgbaFixture(() => [200, 40, 40]), 16, 16, 16);

  assert.ok(Math.abs(engine.compare(gradient, gradient) - 1) < 1e-9);
  assert.ok(engine.compare(flatRed, gradient) < 0.7, 'unrelated textures must not look like a match');
});

test('spatial comparison resamples across grid sizes instead of giving up', () => {
  const engine = loadEngine();
  // Sword and pearl pack textures live on a 32x32 grid while every extracted slot
  // is 16x16. A length mismatch used to return null, silently dropping the two
  // most identifying item types from coarse scoring.
  const fine = rgbaFixture((x, y) => [x * 16, 255 - y * 16, (x * y) % 256]);
  const coarse = engine.resizeRgbaNearest(fine, 16, 16, 32, 32);

  const same = engine.compareSpatialMetrics(
    { pix: fine },
    { pix: Buffer.from(coarse.buffer).toString('base64') }
  );
  assert.ok(same, 'comparing a 16x16 slot against a 32x32 texture must produce metrics');
  assert.ok(same.score > 0.8, 'the same item at two grid sizes must still score high, got ' + same.score);

  const other = rgbaFixture(() => [10, 10, 10]);
  const different = engine.compareSpatialMetrics(
    { pix: other },
    { pix: Buffer.from(coarse.buffer).toString('base64') }
  );
  assert.ok(different, 'a mismatched grid must still produce metrics');
  assert.ok(different.score < same.score, 'an unrelated item must score lower than the same item');
});

test('native pair refinement preserves the smaller source grid and ignores overlay-only differences', () => {
  const engine = loadEngine();
  function image(size, overlay = false) {
    const pixels = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const ink = x >= size / 4 && x < size * 3 / 4 && y < size * 3 / 4;
      pixels.set(ink ? [40, 180, 220, 255] : [20, 20, 20, 255], i);
      if (overlay && (y >= size * 14 / 16 || (x >= size * 10 / 16 && y >= size * 10 / 16))) pixels.set([255, 10, 80, 255], i);
    }
    return { width: size, height: size, pixels };
  }
  for (const [query, reference, size] of [[48, 128, 48], [96, 128, 96], [96, 32, 32], [8, 8, 8]]) {
    const clean = engine.compareNativeItem(image(query), image(reference));
    const noisy = engine.compareNativeItem(image(query, true), image(reference));
    assert.equal(clean.size, size);
    assert.ok(clean.score > 0.98, 'the same logical texture survives area sampling');
    assert.ok(Math.abs(clean.score - noisy.score) < 1e-9, 'excluded overlays must not affect the score');
  }
  const different = image(48);
  for (let i = 0; i < different.pixels.length; i += 4) different.pixels.set([200, 30, 10, 255], i);
  assert.ok(engine.compareNativeItem(image(48), different).score < 0.5);
});

test('rectangular native pairs downsample each axis without cropping or upsampling', () => {
  const engine = loadEngine();
  const image = (width, height) => {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([40, 160, 200, 255], i);
    return { width, height, pixels };
  };
  for (const [query, reference, width, height] of [
    [image(96, 96), image(32, 16), 32, 16],
    [image(48, 48), image(129, 128), 48, 48],
    [image(16, 32), image(32, 16), 16, 16],
  ]) {
    const match = engine.compareNativeItem(query, reference);
    assert.equal(match.width, width);
    assert.equal(match.height, height);
    assert.equal(match.score, 1);
  }
  const averaged = engine.resampleItemArea({ width: 4, height: 2,
    pixels: Uint8ClampedArray.from([
      40, 80, 120, 255, 40, 80, 120, 255, 180, 140, 100, 255, 180, 140, 100, 255,
      80, 120, 160, 255, 80, 120, 160, 255, 220, 180, 140, 255, 220, 180, 140, 255,
    ]) }, { width: 2, height: 1 }, false);
  assert.deepStrictEqual(Array.from(averaged.pixels), [60, 100, 140, 255, 200, 160, 120, 255]);
  assert.throws(() => engine.resampleItemArea(image(32, 16), 32), /upsampling/);
});

test('native reference comparison ignores transparent padding over a screenshot background', () => {
  const engine = loadEngine();
  const ref = { width: 16, height: 16, pixels: rgbaFixture((x, y) => [x * 12, y * 12, 200]) };
  const query = { width: 16, height: 16, pixels: Uint8ClampedArray.from(ref.pixels) };
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    if (x >= 4 && x < 12 && y >= 2 && y < 12) continue;
    const i = (y * 16 + x) * 4;
    ref.pixels.set([0, 0, 0, 0], i);
    query.pixels.set([70, 90, 100, 255], i);
  }
  assert.ok(engine.compareNativeItem(query, ref).score > 0.99);
});

test('new pixel shards participate in scoring even after a coarse-only query', () => {
  const engine = loadEngine();
  const pixels = rgbaFixture((x, y) => [x * 16, y * 16, 80]);
  const fingerprint = engine.computeTextureFingerprint(pixels, 16, 16, 16);
  const { pix, ...coarse } = fingerprint;
  engine.mergeFingerprintShard('coarse.json', { type: 'diamond_sword', packs: { source: { diamond_sword: coarse } } });
  const slots = [{ index: 0, features: { pix: pixels } }];
  assert.equal(engine.scorePaletteCandidates(slots).scores.size, 0);
  engine.mergePixelBucketShard('pixels.json', { packs: { source: { diamond_sword: { pix } } } });
  assert.equal(engine.scorePaletteCandidates(slots).scores.size, 1);
});

test('empty hotbar slots are excluded from matching', () => {
  const engine = loadEngine();
  // The real hotbar is mostly empty: those slots are pixel-identical plates and
  // used to dilute every pack score equally.
  const plate = rgbaFixture(() => [32, 32, 32]);
  const slots = [];
  const itemSlots = [0, 1, 2, 5];
  for (let index = 0; index < 9; index++) {
    const filled = itemSlots.includes(index);
    const pix = filled
      ? rgbaFixture((x, y) => (x + y + index * 7) % 3 === 0 ? [200, 60 + index * 10, 40] : [32, 32, 32])
      : Uint8ClampedArray.from(plate);
    slots.push({ index, features: { pix }, activity: filled ? 0.8 : 0.05 });
  }

  const live = engine.selectLiveSlots(slots);
  assert.deepEqual(live.map(s => s.index), itemSlots);
});
test('resized screenshots retain fractional hotbar scale and bottom offset in native crops', async () => {
  const engine = loadEngine();
  const pack = '$hyGuy$';
  const png = await renderSyntheticShot({
    slots: Object.values(TEXTURE_FILES).map(file => ({ type: 'item', file: fs.readFileSync(path.join(THUMBS, pack, file)) })),
    widgetTex: fs.readFileSync(path.join(THUMBS, pack, 'widgets.png')),
    iconsTex: fs.readFileSync(path.join(THUMBS, pack, 'icons.png')),
    unit: 3,
  });
  const resized = await sharp(png).resize(1600, 900, { kernel: 'nearest' })
    .extend({ bottom: 20, background: '#121016' }).png().toBuffer();
  const { ctx, width, height } = await screenshotContext(resized);
  const observation = engine.extractHotbarSlots(ctx, width, height, 'large');
  // The 1920x1080 source's 546x66 widget is scaled by 5/6; padding is not GUI scale.
  const rect = observation.widgetRect;
  assert.ok(rect, 'a hotbar is detected');
  assert.ok(Math.abs(rect.w - 455) <= 1, 'widget width must stay at the fractional scale, got ' + rect.w);
  assert.ok(Math.abs(rect.y - 845) <= 1, 'bottom padding must not shift the hotbar, got ' + rect.y);
  assert.ok(Math.abs(observation.searchInfo.unit - 2.5) < 0.01);
  const first = observation.slots[0].native;
  const last = observation.slots[8].native;
  assert.equal(first.width, 40);
  assert.ok(Math.abs(first.rect.x - 580) <= 1);
  assert.ok(Math.abs(last.rect.x - 980) <= 1);
  assert.deepStrictEqual(first.pixels, ctx.getImageData(first.rect.x, first.rect.y, 40, 40).data);
});

test('experience-bar edges do not move the item frame in real full screenshots', async () => {
  const bench = require('../scripts/sbi-eval-bench');
  for (const file of ['Large - Eum3 Blue Revamp.jpeg', 'Large - Tory Eum3 v1 [Revamp].jpeg']) {
    const engine = bench.createNodeEngine();
    await engine.ensureFingerprints();
    const observed = await bench.captureObservation(engine, path.join(ROOT, 'test_img', file));
    assert.deepStrictEqual(observed.widgetRect, { x: 687, y: 1014, w: 546, h: 66 }, file);
    assert.deepStrictEqual(observed.slots[8].native.rect, { x: 1176, y: 1023, w: 48, h: 48 }, file);
  }
});

test('native retrieval chooses the hotbar boundary without legacy fingerprint scores', async () => {
  const bench = require('../scripts/sbi-eval-bench');
  const engine = bench.createNodeEngine({ matcher: 'aligned' });
  const observed = await bench.captureObservation(engine, path.join(ROOT, 'test_img', 'Large - PvPMen.png'));
  assert.deepStrictEqual(observed.widgetRect, { x: 687, y: 1014, w: 546, h: 66 });
  assert.deepStrictEqual(observed.slots[0].native.rect, { x: 696, y: 1023, w: 48, h: 48 });
  assert.deepStrictEqual(observed.slots[8].native.rect, { x: 1176, y: 1023, w: 48, h: 48 });
});

test('a high-resolution selected-slot border retains the complete 96px item regions', async () => {
  const bench = require('../scripts/sbi-eval-bench');
  const engine = bench.createNodeEngine({ matcher: 'aligned' });
  const observed = await bench.captureObservation(engine, path.join(ROOT, 'test_img', 'Large - Blue 128x.png'));
  assert.deepStrictEqual(observed.widgetRect, { x: 1374, y: 2028, w: 1092, h: 132 });
  assert.deepStrictEqual(observed.slots[0].native.rect, { x: 1392, y: 2046, w: 96, h: 96 });
  assert.deepStrictEqual(observed.slots[8].native.rect, { x: 2352, y: 2046, w: 96, h: 96 });
});

test('aligned geometry follows the outer frame after fractional resize and bottom padding', async () => {
  const bench = require('../scripts/sbi-eval-bench');
  for (const pack of ['Dark_Sea_256x_VIRUZZ_COLOR', 'eum3_Pink', 'Verzide_v4']) {
    const dir = path.join(THUMBS, pack);
    const png = await renderSyntheticShot({ layoutVersion: 2, unit: 3, bottomOffset: 12,
      slots: Object.values(TEXTURE_FILES).map(file => ({ file: fs.readFileSync(path.join(dir, file)) })),
      widgetTex: fs.readFileSync(path.join(dir, 'widgets.png')), iconsTex: fs.readFileSync(path.join(dir, 'icons.png')) });
    const resized = await sharp(png).resize(1600, 900, { kernel: 'nearest' }).jpeg({ quality: 88 }).toBuffer();
    const { ctx, width, height } = await screenshotContext(resized);
    const observed = bench.createNodeEngine({ matcher: 'aligned' }).extractHotbarSlots(ctx, width, height, 'large');
    assert.ok(Math.abs(observed.widgetRect.x - 572.5) <= 1, pack);
    assert.ok(Math.abs(observed.widgetRect.y - 835) <= 1, pack + ' outer top');
    assert.equal(observed.widgetRect.w, 455, pack);
    assert.equal(observed.slots[0].native.width, 40, pack);
    assert.ok(Math.abs(observed.slots[0].native.rect.y - 842.5) <= 1, pack);
    assert.ok(Math.abs(observed.slots[8].native.rect.x - 980) <= 1, pack);
  }
});

test('asymmetric frame insets preserve native slot bounds under overlays and JPEG noise', async () => {
  const bench = require('../scripts/sbi-eval-bench');
  const dir = path.join(__dirname, 'fixtures', 'sbi-alignment');
  const fixtures = JSON.parse(fs.readFileSync(path.join(dir, 'geometry.json'), 'utf8'));
  for (const fixture of fixtures) {
    const engine = bench.createNodeEngine({ matcher: 'aligned' });
    const observed = await bench.captureObservation(engine, path.join(dir, fixture.file), fixture);
    const geometry = bench.measureGeometry(fixture.geometry, observed);
    assert.ok(geometry.passed, fixture.file + ': ' + JSON.stringify({ geometry, widget: observed.widgetRect }));
    assert.equal(observed.slots.length, 9);
  }
});

test('a hotbar screenshot ranks the pack it was rendered from first', async () => {
  const engine = loadEngine();
  const packs = ['$hyGuy$', '$zay'];

  const png = await renderSyntheticShot({
    slots: Object.entries(TEXTURE_FILES).map(([, file], index) => ({
      type: SLOT_ORDER[index],
      file: fs.readFileSync(path.join(THUMBS, packs[0], file)),
    })),
    widgetTex: fs.readFileSync(path.join(THUMBS, packs[0], 'widgets.png')),
    iconsTex: fs.readFileSync(path.join(THUMBS, packs[0], 'icons.png')),
    unit: 3,
  });

  for (const packId of packs) {
    engine.mergeFingerprintShard('test.json', { type: 'diamond_sword', packs: { [packId]: await packFingerprints(engine, packId) } });
  }
  engine.applyFingerprintMetadata({
    version: engine.SBI_FINGERPRINT_VERSION,
    groupCount: packs.length,
    packCount: packs.length,
    groups: Object.fromEntries(packs.map(p => [p, { representative: p, members: [p] }])),
    rarity: Object.fromEntries(packs.map(p => [p, {}])),
    shards: Object.fromEntries(['widget', 'health', 'hunger', 'armor', 'diamond_sword', 'ender_pearl', 'splash_potion', 'food']
      .map(type => [type, { buckets: [{ file: 'test.json' }] }])),
    observations: {},
  });

  const { ctx, width, height } = await screenshotContext(png);
  const observation = engine.extractHotbarSlots(ctx, width, height, 'large');
  const { slots, widgetFeatures, hudFeatures } = observation;
  assert.ok(slots.length > 0, 'the hotbar must be detected in the rendered screenshot');
  assert.deepStrictEqual(observation.widgetRect, { x: 687, y: 1014, w: 546, h: 66 });
  assert.deepStrictEqual(slots[0].native && { width: slots[0].native.width, height: slots[0].native.height,
    rect: slots[0].native.rect }, { width: 48, height: 48, rect: { x: 696, y: 1023, w: 48, h: 48 } });
  assert.deepStrictEqual(slots[8].native.rect, { x: 1176, y: 1023, w: 48, h: 48 });
  assert.deepStrictEqual(slots[0].native.pixels, ctx.getImageData(696, 1023, 48, 48).data);

  const { results } = engine.matchPacks(slots, widgetFeatures, hudFeatures);
  assert.equal(results[0].name, packs[0]);
  assert.ok(results[0].score > 0.5, 'the winning score must be a confident match, got ' + results[0].score);
  const bench = require('../scripts/sbi-eval-bench.js');
  const replay = bench.deserializeObservation(JSON.parse(JSON.stringify(bench.serializeObservation(observation))));
  const direct = await engine.searchObservation(observation);
  const cached = await engine.searchObservation(replay);
  assert.deepStrictEqual(cached.results, direct.results);
  assert.deepStrictEqual(cached.candidateGroupIds, direct.candidateGroupIds);
  assert.ok(direct.candidateGroupIds.includes(packs[0]));
});
