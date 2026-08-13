const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  buildSyntheticCorpus,
  applyPerturbation,
  mulberry32,
  renderHotbar,
  INDISTINGUISHABLE_EPSILON,
} = require('../scripts/lib/synthetic-corpus');

const FIXTURES = path.join(__dirname, 'fixtures', 'synthetic');
if (!fs.existsSync(FIXTURES)) fs.mkdirSync(FIXTURES, { recursive: true });

function solidPng(width, height, r, g, b) {
  const { PNG } = require('pngjs');
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      png.data[idx] = r; png.data[idx + 1] = g; png.data[idx + 2] = b; png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function fixturePack(dir, textureOverrides = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const textures = {
    diamond_sword: solidPng(16, 16, 80, 80, 200),
    ender_pearl: solidPng(16, 16, 50, 90, 90),
    splash_potion: solidPng(16, 16, 60, 60, 160),
    steak: solidPng(16, 16, 160, 80, 40),
    golden_carrot: solidPng(16, 16, 200, 160, 20),
    widgets: solidPng(256, 256, 128, 128, 128),
    icons: solidPng(256, 256, 180, 40, 40),
    armor: solidPng(16, 16, 160, 160, 180),
    ...textureOverrides,
  };
  for (const [name, buf] of Object.entries(textures)) {
    fs.writeFileSync(path.join(dir, `${name}.png`), buf);
  }
}

test('buildSyntheticCorpus produces deterministic manifest from seed', async () => {
  const corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vale-synth-'));
  try {
    const opts = { corpusDir, seed: 42, packsRoot: FIXTURES };
    const first = await buildSyntheticCorpus(opts);
    const second = await buildSyntheticCorpus(opts);

    assert.strictEqual(first.manifest.seed, 42);
    assert.strictEqual(first.manifest.schemaVersion, 1);
    assert.ok(first.manifest.perturbations.light);
    assert.ok(first.manifest.perturbations.heavy);
    assert.deepStrictEqual(first.manifest, second.manifest);
    assert.ok(fs.existsSync(path.join(corpusDir, 'manifest.json')));
  } finally {
    fs.rmSync(corpusDir, { recursive: true, force: true });
  }
});

test('applyPerturbation is deterministic for same seed and params', async () => {
  const png1 = solidPng(64, 64, 100, 120, 140);
  const png2 = Buffer.from(png1);
  const light = { jpegQuality: 90, scale: 1, brightnessDelta: 0.05, contrastDelta: 0.05 };
  for (let i = 0; i < 3; i++) {
    const out1 = await applyPerturbation(png1, light, 42);
    const out2 = await applyPerturbation(png2, light, 42);
    assert.ok(out1.equals(out2), `iteration ${i} outputs diverged`);
  }
});

test('applyPerturbation light vs heavy differ meaningfully', async () => {
  const src = solidPng(64, 64, 100, 120, 140);
  const light = await applyPerturbation(src, { jpegQuality: 90, scale: 1, brightnessDelta: 0.05, contrastDelta: 0.05 }, 42);
  const heavy = await applyPerturbation(src, { jpegQuality: 70, scale: 0.8, brightnessDelta: 0.15, contrastDelta: 0.15 }, 42);
  assert.ok(!light.equals(heavy), 'light and heavy should differ');
  const lm = await require('sharp')(light).metadata();
  const hm = await require('sharp')(heavy).metadata();
  assert.ok(hm.width <= lm.width, 'heavy scaled down');
});

test('buildSyntheticCorpus covers all groups provided', async () => {
  const corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vale-synth-'));
  const thumbsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vale-thumbs-'));
  try {
    // Two groups, three packs
    fixturePack(path.join(thumbsRoot, 'PackA'));
    fixturePack(path.join(thumbsRoot, 'PackB'));
    fixturePack(path.join(thumbsRoot, 'PackC'));

    const groups = {
      'g:a': { representative: 'PackA', members: ['PackA'] },
      'g:b': { representative: 'PackB', members: ['PackB', 'PackC'] },
    };
    const extracted = [
      { packId: 'PackA', outputDir: path.join(thumbsRoot, 'PackA') },
      { packId: 'PackB', outputDir: path.join(thumbsRoot, 'PackB') },
      { packId: 'PackC', outputDir: path.join(thumbsRoot, 'PackC') },
    ];
    const opts = {
      corpusDir,
      seed: 99,
      groups,
      extracted,
      thumbsRoot,
      tiers: ['light'],
      samplesPerGroup: 2,
    };
    const out = await buildSyntheticCorpus(opts);
    assert.ok(out.manifest, 'manifest returned');
    assert.strictEqual(out.manifest.groups['g:a'].expected, 1);
    assert.strictEqual(out.manifest.groups['g:b'].expected, 2);
    assert.strictEqual(out.manifest.images.length, 3 * 1 * 2); // packs × tiers × samplesPerGroup
    // every image references a real file under corpusDir
    for (const img of out.manifest.images) {
      assert.ok(fs.existsSync(path.join(corpusDir, img.file)), `missing ${img.file}`);
      assert.ok(img.packId);
      assert.ok(img.groupId);
      assert.ok(img.tier);
      assert.strictEqual(img.seed, 99);
    }
  } finally {
    fs.rmSync(corpusDir, { recursive: true, force: true });
    fs.rmSync(thumbsRoot, { recursive: true, force: true });
  }
});

test('renderHotbar itches textures into 9 slots + widget background', async () => {
  const { PNG } = require('pngjs');
  const png = await renderHotbar({
    widgetPng: solidPng(256, 256, 50, 50, 50),
    itemPngs: [
      solidPng(16, 16, 255, 0, 0),   // red in slot 0
      solidPng(16, 16, 0, 255, 0),   // green slot 1
      solidPng(16, 16, 0, 0, 255),   // blue slot 2
    ],
    outputSize: 360,
  });
  const { data } = await require('sharp')(png).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data.length > 0);
  const meta = await require('sharp')(png).metadata();
  assert.ok(meta.width >= 340, 'hotbar wide enough');
});

test('mulberry32 is deterministic', () => {
  const a = mulberry32(42); const b = mulberry32(42);
  for (let i = 0; i < 10; i++) assert.strictEqual(a(), b());
});

test('epsilon constant is positive and small', () => {
  assert.ok(typeof INDISTINGUISHABLE_EPSILON === 'number');
  assert.ok(INDISTINGUISHABLE_EPSILON > 0 && INDISTINGUISHABLE_EPSILON < 0.01);
});
