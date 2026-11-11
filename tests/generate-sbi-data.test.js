const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  buildExclusionSet,
  buildGroupedData,
  writeShards,
  writeAlignedReferences,
} = require('../scripts/generate-sbi-data');

function feature(seed) {
  return {
    dhash: seed,
    hist: [seed.length, 1],
    moments: [0.1, 0.2],
    edge: 0.3,
    sig: { n: 10, meanLum: seed.length },
  };
}

test('aligned reference generation preserves native first frames and deduplicates content without losing group members', async t => {
  const sharp = require('sharp');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-native-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const thumbs = path.join(dir, 'thumbnails'), output = path.join(dir, 'references');
  const frame = Buffer.alloc(128 * 256 * 4);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 128; x++) {
    const i = (y * 128 + x) * 4;
    frame.set(y < 128 ? [x, y, 200, 255] : [255, 0, 0, 255], i);
  }
  for (const name of ['A', 'ACopy', 'B']) {
    fs.mkdirSync(path.join(thumbs, name), { recursive: true });
    await sharp(frame, { raw: { width: 128, height: 256, channels: 4 } }).png()
      .toFile(path.join(thumbs, name, 'diamond_sword.png'));
  }
  const meta = { groups: { g1: { representative: 'A', members: ['A', 'ACopy'] }, g2: { representative: 'B', members: ['B'] } } };
  const first = await writeAlignedReferences(meta, { thumbsRoot: thumbs, outputDir: output });
  assert.equal(first.textures.length, 1);
  assert.deepStrictEqual(first.groups.g1.items.diamond_sword, [0]);
  assert.deepStrictEqual(first.groups.g2.items.diamond_sword, [0]);
  assert.deepStrictEqual(first.groups.g1.members, ['A', 'ACopy']);
  const texture = first.textures[0];
  assert.equal(texture.width, 128);
  assert.equal(texture.height, 128);
  assert.equal(texture.frameIndex, 0);
  const generated = await sharp(path.join(output, texture.file)).ensureAlpha().raw().toBuffer();
  assert.deepStrictEqual(generated, frame.subarray(0, 128 * 128 * 4));
  const again = await writeAlignedReferences(meta, { thumbsRoot: thumbs, outputDir: output });
  assert.deepStrictEqual(again, first);
  const { createSbiEngine } = require('../assets/js/sbi-engine');
  const transfers = [];
  const engine = createSbiEngine({
    matcher: 'aligned',
    fetchImpl: async url => {
      transfers.push(url);
      const file = path.join(output, String(url).split('/aligned/')[1].split('?')[0]);
      const bytes = fs.readFileSync(file);
      return { ok: true, json: async () => JSON.parse(bytes), arrayBuffer: async () => bytes };
    },
    decodeReference: async bytes => {
      const { data, info } = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { width: info.width, height: info.height, pixels: new Uint8ClampedArray(data) };
    },
  });
  const observation = { slots: [{ index: 0, native: { width: 128, height: 128,
    pixels: new Uint8ClampedArray(generated) } }] };
  await engine.prepareSearch();
  assert.equal(engine.store._packToGroup.ACopy, 'g1');
  const [cold, concurrent] = await Promise.all([
    engine.searchObservation(observation), engine.searchObservation(observation),
  ]);
  const warm = await engine.searchObservation(observation);
  assert.deepStrictEqual(concurrent.results, cold.results);
  assert.deepStrictEqual(warm.results, cold.results);
  assert.equal(transfers.filter(url => url.includes('/textures/')).length, 1,
    'concurrent and warm queries share a single reference transfer');
  assert.ok(cold.results.some(row => row.name === 'ACopy'), 'all winning group members remain visible');
  assert.ok(cold.candidateGroupIds.includes('g1'));
  assert.equal(cold.metrics.refinementSizes[0], 128);
});

test('rectangular item references retain every source pixel through generation and native retrieval', async t => {
  const sharp = require('sharp');
  const { createSbiEngine } = require('../assets/js/sbi-engine');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-rectangular-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const thumbs = path.join(dir, 'thumbnails'), output = path.join(dir, 'references');
  fs.mkdirSync(path.join(thumbs, 'Rect'), { recursive: true });
  const pixels = Buffer.alloc(129 * 128 * 4);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 129; x++) {
    pixels.set(x === 128 ? [255, 20, 30, 255] : [x, y, 180, 255], (y * 129 + x) * 4);
  }
  await sharp(pixels, { raw: { width: 129, height: 128, channels: 4 } }).png()
    .toFile(path.join(thumbs, 'Rect', 'steak.png'));
  const index = await writeAlignedReferences({ groups: { rect: { representative: 'Rect', members: ['Rect'] } } },
    { thumbsRoot: thumbs, outputDir: output });
  const texture = index.textures[0];
  assert.equal(texture.width, 129);
  assert.equal(texture.height, 128);
  assert.deepStrictEqual(await sharp(path.join(output, texture.file)).ensureAlpha().raw().toBuffer(), pixels);
  const engine = createSbiEngine({
    fetchImpl: async url => {
      const file = path.join(output, String(url).split('/aligned/')[1].split('?')[0]);
      const bytes = fs.readFileSync(file);
      return { ok: true, json: async () => JSON.parse(bytes), arrayBuffer: async () => bytes };
    },
    decodeReference: async bytes => {
      const { data, info } = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { width: info.width, height: info.height, pixels: new Uint8ClampedArray(data) };
    },
  });
  const matched = await engine.searchAlignedObservation({ slots: [{ index: 0,
    native: { width: 129, height: 128, pixels: new Uint8ClampedArray(pixels) } }] });
  assert.equal(matched.results[0].name, 'Rect');
  assert.ok(matched.results[0].score > 0.999);
});

test('native retrieval rejects changed bytes and permits a clean retry without caching the failure', async t => {
  const sharp = require('sharp');
  const { createSbiEngine } = require('../assets/js/sbi-engine');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-reference-integrity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const thumbs = path.join(dir, 'sources'), output = path.join(dir, 'references');
  fs.mkdirSync(path.join(thumbs, 'One'), { recursive: true });
  await sharp({ create: { width: 16, height: 16, channels: 4, background: '#289ad0' } }).png()
    .toFile(path.join(thumbs, 'One', 'diamond_sword.png'));
  const index = await writeAlignedReferences({ groups: { g1: { representative: 'One', members: ['One'] } } },
    { thumbsRoot: thumbs, outputDir: output });
  const png = fs.readFileSync(path.join(output, index.textures[0].file));
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const observation = { slots: [{ index: 0, native: { width: info.width, height: info.height, pixels: new Uint8ClampedArray(data) } }] };
  let changed = true;
  const engine = createSbiEngine({ matcher: 'aligned',
    fetchImpl: async url => String(url).includes('index.json')
      ? { ok: true, json: async () => JSON.parse(JSON.stringify(index)) }
      : { ok: true, arrayBuffer: async () => changed ? Buffer.concat([png, Buffer.from('changed')]) : png },
    decodeReference: async bytes => {
      const raw = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { width: raw.info.width, height: raw.info.height, pixels: new Uint8ClampedArray(raw.data) };
    },
  });
  await assert.rejects(engine.searchObservation(observation), /reference (hash|byte)/i);
  changed = false;
  assert.equal((await engine.searchObservation(observation)).results[0].name, 'One');
});

test('repeating one observed item does not dilute the other item evidence or discard a full hotbar', async t => {
  const sharp = require('sharp');
  const { createSbiEngine } = require('../assets/js/sbi-engine');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-repeat-evidence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const thumbs = path.join(dir, 'sources'), output = path.join(dir, 'references');
  const icon = color => {
    const pixels = new Uint8ClampedArray(16 * 16 * 4);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      pixels.set([color[0] + x, color[1] + y, color[2], 255], (y * 16 + x) * 4);
    }
    return { width: 16, height: 16, pixels };
  };
  const sword = icon([180, 40, 40]), pearl = icon([40, 160, 200]), other = icon([70, 130, 130]);
  for (const [pack, items] of [['A', [sword, pearl]], ['B', [sword, other]]]) {
    fs.mkdirSync(path.join(thumbs, pack), { recursive: true });
    for (const [i, item] of items.entries()) {
      await sharp(Buffer.from(item.pixels), { raw: { width: 16, height: 16, channels: 4 } }).png()
        .toFile(path.join(thumbs, pack, i === 0 ? 'diamond_sword.png' : 'ender_pearl.png'));
    }
  }
  await writeAlignedReferences({ groups: { a: { representative: 'A', members: ['A'] }, b: { representative: 'B', members: ['B'] } } },
    { thumbsRoot: thumbs, outputDir: output });
  const engine = createSbiEngine({ matcher: 'aligned',
    fetchImpl: async url => {
      const bytes = fs.readFileSync(path.join(output, String(url).split('/aligned/')[1].split('?')[0]));
      return { ok: true, json: async () => JSON.parse(bytes), arrayBuffer: async () => bytes };
    },
    decodeReference: async bytes => {
      const { data, info } = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { width: info.width, height: info.height, pixels: data };
    },
  });
  const search = items => engine.searchObservation({ slots: items.map((native, index) => ({ index, native })) });
  const two = await search([sword, pearl]);
  const nine = await search([sword, ...Array(8).fill(pearl)]);
  assert.deepStrictEqual(nine.results, two.results, 'duplicate evidence must not change relative confidence');
  assert.equal(nine.results[0].name, 'A');
  const plate = { width: 16, height: 16, pixels: new Uint8ClampedArray(16 * 16 * 4) };
  for (let i = 0; i < plate.pixels.length; i += 4) plate.pixels.set([32, 32, 32, 255], i);
  const withEmpty = await search([sword, pearl, ...Array(7).fill(plate)]);
  assert.deepStrictEqual(withEmpty.results, two.results, 'featureless plates do not vote against visible items');
  assert.deepStrictEqual(withEmpty.metrics.uninformativeSlotIndexes, [2, 3, 4, 5, 6, 7, 8]);
  const repeated = await search(Array(9).fill(pearl));
  assert.equal(repeated.results[0].name, 'A', 'nine identical items are not an empty hotbar');
  assert.equal(repeated.metrics.observedSlotCount, 9);
  assert.equal(repeated.metrics.distinctSlotCount, 1);
  const overlay = { ...pearl, pixels: Uint8ClampedArray.from(pearl.pixels) };
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    if (y >= 14 || (x >= 10 && y >= 10)) overlay.pixels.set([255, 255, 255, 255], (y * 16 + x) * 4);
  }
  const masked = await search([sword, pearl, overlay]);
  assert.deepStrictEqual(masked.results, two.results);
  assert.deepStrictEqual(masked.metrics.evidenceSlots, [[0], [1, 2]]);
  const fine = delta => {
    const pixels = new Uint8ClampedArray(32 * 32 * 4);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) pixels.set([100 + (x % 2 ? delta : -delta), 150, 180, 255], (y * 32 + x) * 4);
    return { width: 32, height: 32, pixels };
  };
  const a = fine(10), b = fine(20);
  assert.deepStrictEqual(engine.resampleItemArea(a, 16), engine.resampleItemArea(b, 16));
  assert.equal((await search([a, b])).metrics.distinctSlotCount, 2,
    'identical coarse previews cannot erase different native detail');
});

test('coarse diagnostics retain their order when native detail changes the final winner', async t => {
  const sharp = require('sharp');
  const { createSbiEngine } = require('../assets/js/sbi-engine');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-stage-order-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const thumbs = path.join(dir, 'sources'), output = path.join(dir, 'references');
  const images = {};
  for (const [pack, delta] of [['A', 30], ['Z', 70]]) {
    const pixels = new Uint8ClampedArray(32 * 32 * 4);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      pixels.set([120 + (x % 2 ? delta : -delta), 150, 180, 255], (y * 32 + x) * 4);
    }
    images[pack] = { width: 32, height: 32, pixels };
    fs.mkdirSync(path.join(thumbs, pack), { recursive: true });
    await sharp(Buffer.from(pixels), { raw: { width: 32, height: 32, channels: 4 } }).png()
      .toFile(path.join(thumbs, pack, 'diamond_sword.png'));
  }
  await writeAlignedReferences({ groups: { a: { representative: 'A', members: ['A'] }, z: { representative: 'Z', members: ['Z'] } } },
    { thumbsRoot: thumbs, outputDir: output });
  const engine = createSbiEngine({ matcher: 'aligned',
    fetchImpl: async url => {
      const bytes = fs.readFileSync(path.join(output, String(url).split('/aligned/')[1].split('?')[0]));
      return { ok: true, json: async () => JSON.parse(bytes), arrayBuffer: async () => bytes };
    },
    decodeReference: async bytes => {
      const { data, info } = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { width: info.width, height: info.height, pixels: data };
    },
  });
  const matched = await engine.searchObservation({ slots: [{ index: 0, native: images.Z }] });
  assert.equal(matched.results[0].name, 'Z');
  assert.equal(matched.stage1Results[0].name, 'A');
  assert.equal(matched.stage1Results[0].score, matched.stage1Results[1].score);
  assert.deepStrictEqual(matched.candidateGroupIds, ['a', 'z']);
  assert.notStrictEqual(matched.stage1Results, matched.results);
  assert.ok(matched.metrics.refineMs >= 0);
  assert.ok(matched.metrics.totalMs >= matched.metrics.coarseMs + matched.metrics.refineMs);
});

test('groups packs sharing the observable anchor-surface dhash (issue 017)', () => {
  // Under issue 017 / ADR 0005, group equivalence is the dhash of the three anchor
  // surfaces (diamond_sword/ender_pearl/splash_potion). Non-anchor surfaces (food,
  // widget, HUD) no longer split groups; float noise in non-dhash fields doesn't either.
  const common = { diamond_sword: feature('same'), ender_pearl: feature('ep'), splash_potion: feature('hl'), health_full: feature('hud') };
  const { groupPacks, meta } = buildGroupedData({
    Zed: common,
    Alpha: JSON.parse(JSON.stringify(common)),
    // Missing the non-anchor health_full surface -> still same group (DS/EP/HL match)
    MissingHud: { diamond_sword: feature('same'), ender_pearl: feature('ep'), splash_potion: feature('hl') },
    // Different anchor diamond_sword dhash -> different group
    Different: { diamond_sword: feature('different'), ender_pearl: feature('ep'), splash_potion: feature('hl'), health_full: feature('hud') },
    // Same DS as common but different anchor ender_pearl dhash -> different group
    DiffEp: { diamond_sword: feature('same'), ender_pearl: feature('other-ep'), splash_potion: feature('hl') },
  }, { Overlay: 2, Conquest: 3 });

  assert.equal(meta.packCount, 5);
  assert.equal(meta.groupCount, 3);
  assert.equal(Object.keys(groupPacks).length, 3);
  const merged = Object.entries(meta.groups).find(([, group]) => group.members.length === 3);
  assert.deepEqual(merged[1].members, ['Alpha', 'MissingHud', 'Zed']);
  assert.equal(merged[1].representative, 'Alpha');
  assert.deepEqual(meta.excludedCounts, { Overlay: 2, Conquest: 3 });
});

test('computes rarity counts over the observable anchor groups (issue 017)', () => {
  // Under issue 017, A/ACopy/B all share the diamond_sword anchor dhash 'shared',
  // so they collapse to ONE group even though B differs in the non-anchor hotbar_widget.
  // D shares the same DS surface feature but a different anchor EP dhash -> separate group,
  // making A's DS surface "common" (2 groups) versus C's DS "rare" (1 group).
  const shared = feature('shared');
  const { meta } = buildGroupedData({
    A: { diamond_sword: shared, ender_pearl: feature('ep'), hotbar_widget: feature('unique-a') },
    ACopy: { diamond_sword: shared, ender_pearl: feature('ep'), hotbar_widget: feature('unique-a') },
    B: { diamond_sword: shared, ender_pearl: feature('ep'), hotbar_widget: feature('unique-b') },
    D: { diamond_sword: shared, ender_pearl: feature('other-ep'), hotbar_widget: feature('unique-d') },
    C: { diamond_sword: feature('rare'), ender_pearl: feature('ep'), hotbar_widget: feature('unique-c') },
  });
  const aGroupId = Object.keys(meta.groups).find(id => meta.groups[id].members.includes('A'));
  const cGroupId = Object.keys(meta.groups).find(id => meta.groups[id].members.includes('C'));
  // A/ACopy/B merged into one group; D is a second group sharing the DS surface feature.
  assert.equal(meta.groups[aGroupId].members.length, 3);
  // rarity.count is how many GROUPS share that surface feature (A's group + D's group = 2)
  assert.equal(meta.rarity[aGroupId].diamond_sword.count, 2);
  assert.equal(meta.rarity[cGroupId].diamond_sword.count, 1);
  assert.ok(meta.rarity[cGroupId].diamond_sword.weight > meta.rarity[aGroupId].diamond_sword.weight);
});

test('builds the exact Overlay and Conquest exclusion union', () => {
  const excluded = buildExclusionSet([
    { name: 'Overlay', packs: ['A', 'Shared'] },
    { name: 'Conquest', packs: ['B', 'Shared'] },
    { name: 'overlay', packs: ['wrong-case'] },
  ]);
  assert.deepEqual([...excluded.packs].sort(), ['A', 'B', 'Shared']);
  assert.deepEqual(excluded.counts, { Overlay: 2, Conquest: 2 });
});

test('writes deterministic size-bounded subshards and retires stale monolithic data', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-sbi-shards-'));
  try {
    const shardDir = path.join(root, 'sbi-fp');
    const monolithicPath = path.join(root, 'sbi-fingerprints.json');
    fs.mkdirSync(shardDir, { recursive: true });
    fs.writeFileSync(monolithicPath, 'legacy');
    fs.writeFileSync(path.join(shardDir, 'diamond_sword-stale.json'), 'stale');
    const packs = {};
    for (let index = 0; index < 24; index++) {
      packs[`g:${String(index).padStart(64, '0')}`] = {
        diamond_sword: { ...feature(`sword-${index}`), pix: String(index).padStart(2, '0').repeat(180) },
      };
    }
    const meta = {
      version: 17,
      schemaVersion: 1,
      packCount: 24,
      groupCount: 24,
      groups: {},
      rarity: {},
    };
    const options = { shardDir, monolithicPath, targetBytes: 1600, hardLimitBytes: 4096 };
    const firstMeta = writeShards(packs, meta, options);
    const firstFiles = fs.readdirSync(shardDir).sort();
    const firstBytes = Object.fromEntries(firstFiles.map(file => [file, fs.readFileSync(path.join(shardDir, file), 'utf8')]));

    assert.equal(fs.existsSync(monolithicPath), false);
    assert.equal(firstFiles.includes('diamond_sword-stale.json'), false);
    assert.ok(firstMeta.shards.diamond_sword.buckets.length > 1);
    assert.deepEqual(
      firstMeta.observations.diamond_sword.files,
      firstMeta.shards.diamond_sword.buckets.map(bucket => bucket.file)
    );
    for (const file of firstFiles) {
      if (file === 'meta.json') continue;
      assert.ok(fs.statSync(path.join(shardDir, file)).size < 4096, file);
    }

    const secondMeta = writeShards(packs, meta, options);
    const secondFiles = fs.readdirSync(shardDir).sort();
    assert.deepEqual(secondFiles, firstFiles);
    assert.deepEqual(secondMeta, firstMeta);
    for (const file of secondFiles) {
      assert.equal(fs.readFileSync(path.join(shardDir, file), 'utf8'), firstBytes[file], file);
    }
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
