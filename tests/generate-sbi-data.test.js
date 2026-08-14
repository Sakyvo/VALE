const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  buildExclusionSet,
  buildGroupedData,
  writeShards,
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
