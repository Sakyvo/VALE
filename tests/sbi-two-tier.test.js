const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildGroupedData,
  writeShards,
} = require('../scripts/generate-sbi-data');

function pixPack(seed) {
  return {
    dhash: seed,
    hist: [1, 2],
    moments: { m: 1 },
    edge: 0.4,
    sig: { n: 5 },
    pix: Array.from({ length: 16 * 16 * 4 }, (_, i) => (i + seed.length) % 256),
  };
}

function samplePacks() {
  const packs = {};
  for (let i = 0; i < 30; i++) {
    packs[`pack${i}`] = {
      diamond_sword: pixPack(`ds${i}`),
      ender_pearl: pixPack(`ep${i}`),
      splash_potion: pixPack(`hl${i}`),
      hotbar_widget: { hist: [9], moments: { m: 1 }, edge: 0 },
    };
  }
  return packs;
}

test('coarse shards exclude pix; pixel buckets contain only pix (issue 018)', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-018-'));
  try {
    const { groupPacks, meta } = buildGroupedData(samplePacks());
    const shardDir = path.join(dir, 'sbi-fp');
    const outMeta = writeShards(groupPacks, meta, { shardDir, metaFile: path.join(shardDir, 'meta.json'), targetBytes: 1024, hardLimitBytes: 10 * 1024 * 1024 });

    // Every coarse shard pack entry must omit pix
    for (const shard of Object.values(outMeta.shards)) {
      for (const bucket of shard.buckets) {
        const file = path.join(shardDir, bucket.file);
        assert.ok(fs.existsSync(file), `coarse shard ${bucket.file} exists`);
        const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const [packName, packData] of Object.entries(payload.packs || {})) {
          for (const [surfKey, surf] of Object.entries(packData)) {
            assert.equal(surf.pix, undefined, `coarse shard must omit pix for ${packName}/${surfKey}`);
            // Non-widget surfaces carry dhash; widget carries hist. Both must survive in coarse.
            assert.ok(surf.dhash || surf.hist, `coarse shard keeps features for ${packName}/${surfKey}`);
          }
        }
      }
    }

    // Pixel buckets exist and contain ONLY pix (+ packName), grouped by type
    assert.ok(outMeta.pixelShards, 'meta describes pixel buckets');
    assert.ok(outMeta.packToPixelBuckets, 'meta records pack -> pixel-bucket mapping');
    for (const shardName of Object.keys(outMeta.pixelShards)) {
      for (const bucket of outMeta.pixelShards[shardName].buckets) {
        const file = path.join(shardDir, bucket.file);
        assert.ok(fs.existsSync(file), `pixel bucket ${bucket.file} exists`);
        const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const [packName, packData] of Object.entries(payload.packs || {})) {
          for (const [surfKey, surf] of Object.entries(packData)) {
            assert.ok(surf.pix && surf.pix !== undefined, `pixel bucket holds pix for ${packName}/${surfKey}`);
            // pixel bucket must contain ONLY { pix }, not the full surface object
            assert.ok(Object.keys(surf).length <= 2, `pixel bucket entry is lean for ${packName}/${surfKey}`);
          }
        }
      }
    }

    // Coarse shards are materially smaller than they would be with pix
    let coarseBytes = 0, pixelBytes = 0;
    for (const shard of Object.values(outMeta.shards)) for (const b of shard.buckets) coarseBytes += b.bytes;
    for (const shard of Object.values(outMeta.pixelShards)) for (const b of shard.buckets) pixelBytes += b.bytes;
    assert.ok(coarseBytes < pixelBytes, 'coarse payload smaller than pixel payload');
    assert.ok(pixelBytes > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pixel bucket assignment is deterministic for the same input', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-018-det-'));
  try {
    const packs = samplePacks();
    const { groupPacks, meta } = buildGroupedData(packs);
    const a = writeShards(groupPacks, meta, { shardDir: path.join(dir, 'a'), metaFile: path.join(dir, 'a', 'meta.json'), targetBytes: 1024, hardLimitBytes: 10 * 1024 * 1024 });
    const b = writeShards(groupPacks, meta, { shardDir: path.join(dir, 'b'), metaFile: path.join(dir, 'b', 'meta.json'), targetBytes: 1024, hardLimitBytes: 10 * 1024 * 1024 });
    assert.deepStrictEqual(a.pixelShards, b.pixelShards);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
