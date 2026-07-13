const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildExclusionSet,
  buildGroupedData,
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

test('groups only complete exact observable fingerprint records', () => {
  const common = { diamond_sword: feature('same'), health_full: feature('hud') };
  const { groupPacks, meta } = buildGroupedData({
    Zed: common,
    Alpha: JSON.parse(JSON.stringify(common)),
    Different: { diamond_sword: feature('different'), health_full: feature('hud') },
    MissingHud: { diamond_sword: feature('same') },
  }, { Overlay: 2, Conquest: 3 });

  assert.equal(meta.packCount, 4);
  assert.equal(meta.groupCount, 3);
  assert.equal(Object.keys(groupPacks).length, 3);
  const exact = Object.entries(meta.groups).find(([, group]) => group.members.length === 2);
  assert.deepEqual(exact[1].members, ['Alpha', 'Zed']);
  assert.equal(exact[1].representative, 'Alpha');
  assert.deepEqual(meta.excludedCounts, { Overlay: 2, Conquest: 3 });
});

test('computes rarity counts over exact groups rather than raw pack names', () => {
  const shared = feature('shared');
  const { meta } = buildGroupedData({
    A: { diamond_sword: shared, hotbar_widget: feature('unique-a') },
    ACopy: { diamond_sword: shared, hotbar_widget: feature('unique-a') },
    B: { diamond_sword: shared, hotbar_widget: feature('unique-b') },
    C: { diamond_sword: feature('rare'), hotbar_widget: feature('unique-c') },
  });
  const aGroupId = Object.keys(meta.groups).find(id => meta.groups[id].members.includes('A'));
  const cGroupId = Object.keys(meta.groups).find(id => meta.groups[id].members.includes('C'));
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
