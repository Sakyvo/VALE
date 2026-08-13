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
