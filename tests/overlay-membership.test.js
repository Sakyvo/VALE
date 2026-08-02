const assert = require('node:assert/strict');
const test = require('node:test');
const { isOverlayByName, mergeOverlayMembers } = require('../scripts/lib/overlay-membership');

test('a pack named as an overlay is recognized regardless of case or separators', () => {
  for (const name of ['KOTH Sword Overlay v13', 'clear glass overlay', 'MONOCHROM_OVERLAY', 'Overlay Gapple Money']) {
    assert.ok(isOverlayByName({ displayName: name, name: 'slug' }), `${name} is an overlay by name`);
  }
});

test('the catalog slug is matched when the display name has been stripped', () => {
  assert.ok(isOverlayByName({ displayName: '', name: 'Tory_block_overlay' }));
});

test('Minecraft colour codes cannot hide the word', () => {
  assert.ok(isOverlayByName({ displayName: '§bSky §cOverlay', name: 'sky_overlay' }));
});

test('packs that are not named as overlays are left alone', () => {
  for (const name of ['Infera Blue', 'Eum3 Revamp', 'over the moon', 'layered pack']) {
    assert.equal(isOverlayByName({ displayName: name, name: name }), false, `${name} is not an overlay by name`);
  }
});

test('name matches union with pixel detection and never drop existing members', () => {
  const detected = ['PixelOnly'];
  const catalog = [
    { name: 'PixelOnly', displayName: 'Pixel Only' },
    { name: 'SwordOverlay', displayName: 'KOTH Sword Overlay v2' },
    { name: 'Regular', displayName: 'Regular Pack' },
  ];
  assert.deepEqual(mergeOverlayMembers(detected, catalog).sort(), ['PixelOnly', 'SwordOverlay']);
});

test('a member already in the list survives even when neither rule matches it today', () => {
  const catalog = [{ name: 'Legacy', displayName: 'Legacy Pack' }];
  assert.deepEqual(mergeOverlayMembers([], catalog, ['Legacy']), ['Legacy']);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { updateLists } = require('../scripts/upload-folder');

test('uploading an overlay-named pack places it in the Overlay List without a classifier run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vale-overlay-upload-'));
  const listsPath = path.join(dir, 'lists.json');
  fs.writeFileSync(listsPath, JSON.stringify([{ name: 'Overlay', cover: '', description: '', packs: [] }]));
  updateLists('Sakyvo', ['KOTH_Sword_Overlay_v99', 'Regular_Pack'], [], listsPath);
  const lists = JSON.parse(fs.readFileSync(listsPath, 'utf8'));
  const overlay = lists.find(entry => entry.name === 'Overlay');
  assert.deepEqual(overlay.packs, ['KOTH_Sword_Overlay_v99'], 'only the overlay-named pack joins');
  const target = lists.find(entry => entry.name === 'Sakyvo');
  assert.deepEqual(target.packs.sort(), ['KOTH_Sword_Overlay_v99', 'Regular_Pack'], 'both still join the requested List');
});
