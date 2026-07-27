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
    for (const file of firstFiles) assert.ok(fs.statSync(path.join(shardDir, file)).size < 4096, file);

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
