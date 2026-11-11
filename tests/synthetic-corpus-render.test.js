const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  buildSyntheticCorpus,
  planAlignedCorpus,
  renderAlignedCorpus,
  applyPerturbation,
  mulberry32,
  renderHotbar,
  renderSyntheticShot,
  DEFAULT_SEED,
} = require('../scripts/lib/synthetic-corpus');

const THUMBS = path.resolve(__dirname, '..', 'thumbnails');
const EXTRACTED = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', 'extracted.json'), 'utf8'));
const META = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', 'sbi-fp', 'meta.json'), 'utf8'));

function packHasTextures(packId) {
  const dir = path.join(THUMBS, packId);
  if (!fs.existsSync(dir)) return false;
  const needed = ['diamond_sword.png', 'ender_pearl.png', 'splash_potion_of_healing.png',
    'steak.png', 'golden_carrot.png', 'widgets.png', 'icons.png'];
  return needed.every(f => fs.existsSync(path.join(dir, f)));
}

function findRenderablePack() {
  for (const [groupId, g] of Object.entries(META.groups)) {
    for (const member of g.members) {
      if (packHasTextures(member)) return { groupId, packId: member };
    }
  }
  return null;
}

test('renderSyntheticShot produces a full screenshot containing all three evidence planes', async () => {
  const found = findRenderablePack();
  assert.ok(found, 'need at least one pack with all required textures');
  const dir = path.join(THUMBS, found.packId);

  const itemPng = (name) => fs.readFileSync(path.join(dir, `${name}.png`));
  const png = await renderSyntheticShot({
    packId: found.packId,
    slots: [
      { type: 'DS', file: itemPng('diamond_sword') },
      { type: 'EP', file: itemPng('ender_pearl') },
      { type: 'HL', file: itemPng('splash_potion_of_healing') },
      { type: 'HL', file: itemPng('splash_potion_of_healing') },
      { type: 'food', file: itemPng('steak') },
    ],
    status: {
      healthFull: 10, healthHalf: 0, armorFull: 10,
      hungerFull: 10, hungerHalf: 0,
      iconsTex: itemPng('icons'),
    },
    widgetTex: itemPng('widgets'),
  });

  const { data, info } = await require('sharp')(png).raw().toBuffer({ resolveWithObject: true });
  assert.ok(info.width >= 180, 'wide enough for 9 slots');
  assert.ok(info.height >= 48, 'tall enough for HUD + hotbar');
  assert.ok(data.length > 0);
});

test('aligned rendering keeps empty slot positions, 16-unit item bounds and explicit overlays', async () => {
  const sharp = require('sharp');
  const item = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#30a0c0' } }).png().toBuffer();
  const slots = Array(9).fill(null);
  slots[0] = { file: item, durability: 0.5 };
  slots[8] = { file: item, count: 12 };
  const png = await renderSyntheticShot({ slots, outputW: 640, outputH: 360, unit: 2, bottomOffset: 8, layoutVersion: 2,
    fontTex: fs.readFileSync(path.join(THUMBS, '$hyGuy$', 'ascii.png')) });
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixel = (x, y) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)];
  // A 364x44 widget starts at (138,308); item centers begin at (144,314).
  assert.deepStrictEqual(pixel(144, 314), [48, 160, 192, 255]);
  assert.deepStrictEqual(pixel(143, 314), [18, 16, 22, 255]);
  assert.deepStrictEqual(pixel(184, 314), [18, 16, 22, 255], 'empty slot 1 must not collapse');
  assert.deepStrictEqual(pixel(464, 314), [48, 160, 192, 255], 'last item stays in slot 8');
  assert.notDeepStrictEqual(pixel(146, 344), [48, 160, 192, 255], 'durability overlay is present');
});

test('aligned HUD rows occupy known icon rectangles independently of the extractor', async () => {
  const sharp = require('sharp');
  const atlas = Buffer.alloc(256 * 256 * 4);
  const sprite = (x0, y0, rgb) => {
    for (let y = y0; y < y0 + 9; y++) for (let x = x0; x < x0 + 9; x++) {
      atlas.set([...rgb, 255], (y * 256 + x) * 4);
    }
  };
  sprite(52, 0, [200, 10, 20]);
  sprite(52, 27, [10, 200, 20]);
  sprite(34, 9, [10, 20, 200]);
  const iconsTex = await sharp(atlas, { raw: { width: 256, height: 256, channels: 4 } }).png().toBuffer();
  const png = await renderSyntheticShot({ outputW: 640, outputH: 360, unit: 2, bottomOffset: 8, layoutVersion: 2, iconsTex });
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixel = (x, y) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)];
  assert.deepStrictEqual(pixel(138, 254), [10, 20, 200, 255], 'armor 27 units above hotbar');
  assert.deepStrictEqual(pixel(138, 274), [200, 10, 20, 255], 'hearts 17 units above hotbar');
  assert.deepStrictEqual(pixel(282, 274), [200, 10, 20, 255], 'last heart uses 8-unit spacing');
  assert.deepStrictEqual(pixel(484, 274), [10, 200, 20, 255], 'hunger starts at the right edge');
  assert.deepStrictEqual(pixel(340, 274), [10, 200, 20, 255], 'last hunger uses right-to-left spacing');
});

test('stack-count overlays render distinct glyphs rather than solid placeholders', async () => {
  const sharp = require('sharp');
  const item = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#30a0c0' } }).png().toBuffer();
  const render = count => renderSyntheticShot({ slots: [{ file: item, count }],
    outputW: 640, outputH: 360, unit: 2, layoutVersion: 2,
    fontTex: fs.readFileSync(path.join(THUMBS, '$hyGuy$', 'ascii.png')) });
  const twelve = await render(12), sixtyTwo = await render(62);
  assert.notDeepStrictEqual(twelve, sixtyTwo, 'different counts with the same digit count must have different pixels');
  assert.deepStrictEqual(await render(12), twelve, 'glyph rendering must be deterministic');
  const { data } = await sharp(twelve).extract({ left: 144, top: 322, width: 32, height: 32 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const white = [], underlying = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] === 245 && data[i + 1] === 245 && data[i + 2] === 245) white.push(i);
    if (data[i] === 48 && data[i + 1] === 160 && data[i + 2] === 192) underlying.push(i);
  }
  assert.ok(white.length > 0 && underlying.length > white.length);
});

test('aligned corpus freezes source truth, geometry and group-isolated roles before rendering', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-aligned-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packId = '$hyGuy$';
  const groups = { g1: { representative: packId, members: [packId, 'missing-source'] } };
  const options = { groups, thumbsRoot: THUMBS, seed: 42 };
  const plan = await planAlignedCorpus(options);
  assert.equal(plan.schemaVersion, 2);
  assert.equal(plan.images.length, 6, 'all members and all three profiles are planned, including missing sources');
  assert.equal(new Set(plan.images.map(row => row.role)).size, 1, 'related variants cannot cross role boundaries');
  assert.deepStrictEqual(await planAlignedCorpus(options), plan);
  const sparse = plan.images.find(row => row.packId === packId && row.profile === 'sparse');
  assert.deepStrictEqual(sparse.geometry.widgetRect, { x: 687, y: 1014, w: 546, h: 66 });
  assert.deepStrictEqual(sparse.geometry.slotRects[0], { x: 696, y: 1023, w: 48, h: 48 });
  assert.deepStrictEqual(sparse.geometry.slotRects[8], { x: 1176, y: 1023, w: 48, h: 48 });
  assert.ok(sparse.sourceHashes.diamond_sword);
  const resized = plan.images.find(row => row.packId === packId && row.profile === 'full');
  assert.equal(resized.geometry.width, 1600);
  assert.equal(resized.geometry.effectiveUnit, 2.5);
  assert.ok(plan.images.filter(row => row.packId === 'missing-source').every(row => row.sourceError));
  const manifest = await renderAlignedCorpus(plan, { corpusDir: root, thumbsRoot: THUMBS });
  assert.equal(manifest.images.length, 6);
  assert.equal(manifest.planHash, plan.hash);
  assert.equal(manifest.images.filter(row => row.error).length, 3);
  for (const image of manifest.images.filter(row => !row.error)) {
    const hash = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(root, image.file))).digest('hex');
    assert.equal(image.sha256, hash);
  }
});

test('aligned corpus refuses changed source files even when resuming previously rendered images', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-aligned-stale-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const thumbs = path.join(root, 'sources'), output = path.join(root, 'corpus');
  const packId = '$hyGuy$';
  fs.mkdirSync(path.join(thumbs, packId), { recursive: true });
  for (const name of ['diamond_sword', 'ender_pearl', 'splash_potion_of_healing', 'steak', 'golden_carrot', 'widgets', 'icons', 'ascii']) {
    fs.copyFileSync(path.join(THUMBS, packId, name + '.png'), path.join(thumbs, packId, name + '.png'));
  }
  const plan = await planAlignedCorpus({ groups: { g1: { representative: packId, members: [packId] } }, thumbsRoot: thumbs });
  await renderAlignedCorpus(plan, { corpusDir: output, thumbsRoot: thumbs });
  fs.appendFileSync(path.join(thumbs, packId, 'steak.png'), 'changed');
  await assert.rejects(renderAlignedCorpus(plan, { corpusDir: output, thumbsRoot: thumbs }), /Source changed/);
});

test('aligned corpus command freezes a separate plan without overwriting the historical corpus', async t => {
  const { main } = require('../scripts/generate-synthetic-corpus');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-plan-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(main(['--aligned', '--plan-only']), /separate output/i);
  await assert.rejects(main(['--aligned', '--output', path.join(THUMBS, '..', 'test_img/synthetic')]), /historical/i);
  const plan = await main(['--aligned', '--plan-only', '--output', root, '--groups-limit', '1']);
  assert.equal(plan.schemaVersion, 2);
  assert.equal(Object.keys(plan.groups).length, 1);
  assert.equal(fs.existsSync(path.join(root, 'plan.json')), true);
  assert.equal(fs.existsSync(path.join(root, 'manifest.json')), false, 'planning must not claim rendered images');
});

test('resuming a completed corpus never publishes a shorter checkpoint while verifying cached images', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-resume-prefix-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const groups = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [
    'g' + i, { representative: 'missing-source', members: ['missing-source'] },
  ]));
  const plan = await planAlignedCorpus({ groups, thumbsRoot: THUMBS });
  const previous = await renderAlignedCorpus(plan, { corpusDir: root, thumbsRoot: THUMBS });
  assert.equal(previous.images.length, 27);
  const progress = [];
  await renderAlignedCorpus(plan, { corpusDir: root, thumbsRoot: THUMBS,
    onProgress() {
      progress.push(JSON.parse(fs.readFileSync(path.join(root, 'manifest.partial.json'), 'utf8')).images.length);
    } });
  assert.ok(progress.every(count => count >= 27), 'published progress must not regress: ' + progress.join(','));
});

test('checkpoint replacement retries transient Windows locks without deleting the previous checkpoint', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-checkpoint-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plan = await planAlignedCorpus({ groups: { g1: { representative: 'missing-source', members: ['missing-source'] } }, thumbsRoot: THUMBS });
  await renderAlignedCorpus(plan, { corpusDir: root, thumbsRoot: THUMBS });
  const checkpoint = path.join(root, 'manifest.partial.json');
  const original = fs.readFileSync(checkpoint);
  const rename = fs.renameSync;
  let lockCount = 0;
  const mocked = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === checkpoint && lockCount++ === 0) {
      assert.deepStrictEqual(fs.readFileSync(checkpoint), original);
      throw Object.assign(new Error('Windows sharing violation'), { code: 'EPERM' });
    }
    return rename(from, to);
  });
  try {
    const resumed = await renderAlignedCorpus(plan, { corpusDir: root, thumbsRoot: THUMBS });
    assert.equal(resumed.images.length, 3);
    assert.ok(lockCount >= 2);
    assert.deepStrictEqual(fs.readFileSync(checkpoint), original);
  } finally { mocked.mock.restore(); }
});

test('persistent checkpoint locks leave the prior committed progress readable', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-checkpoint-persistent-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plan = await planAlignedCorpus({ groups: { g1: { representative: 'missing-source', members: ['missing-source'] } }, thumbsRoot: THUMBS });
  await renderAlignedCorpus(plan, { corpusDir: root, thumbsRoot: THUMBS });
  const checkpoint = path.join(root, 'manifest.partial.json');
  const original = fs.readFileSync(checkpoint);
  const rename = fs.renameSync;
  const mocked = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === checkpoint) throw Object.assign(new Error('Still locked'), { code: 'EPERM' });
    return rename(from, to);
  });
  try {
    await assert.rejects(renderAlignedCorpus(plan, { corpusDir: root, thumbsRoot: THUMBS }), /Still locked/);
    assert.deepStrictEqual(fs.readFileSync(checkpoint), original);
  } finally { mocked.mock.restore(); }
});

test('synthetic corpus manifest includes slot/order information for role-checkable evaluation', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vale-synth-016-'));
  try {
    const smallGroups = Object.fromEntries(Object.entries(META.groups).slice(0, 5));
    const res = await buildSyntheticCorpus({
      corpusDir: tmp, seed: DEFAULT_SEED, groups: smallGroups,
      extracted: EXTRACTED, thumbsRoot: THUMBS,
      tiers: ['light'], samplesPerGroup: 1,
    });
    for (const img of res.manifest.images) {
      assert.ok(img.groupId);
      assert.ok(img.packId);
      assert.ok(img.slotTypes && Array.isArray(img.slotTypes), 'slotTypes recorded for downstream analysis');
      assert.ok(Array.isArray(img.slots));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
