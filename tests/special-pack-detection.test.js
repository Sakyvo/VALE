const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sharp = require('sharp');
const { computeRegistryDigest } = require('../scripts/lib/pack-content-index');
const { pixelHash } = require('../scripts/detect-overlay');
const {
  detectConquest,
  main,
  matchingSwordPairs,
  updateManagedLists,
  validateOverrides,
} = require('../scripts/detect-special-packs');

test('detection report timestamp is bound to the validated content index', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-special-report-'));
  try {
    const registryPath = path.join(dir, 'registry.json');
    const contentIndexPath = path.join(dir, 'content-index.json');
    const siteIndexPath = path.join(dir, 'site-index.json');
    const overridesPath = path.join(dir, 'overrides.json');
    const listsPath = path.join(dir, 'lists.json');
    const registry = {};
    fs.writeFileSync(registryPath, JSON.stringify(registry));
    fs.writeFileSync(contentIndexPath, JSON.stringify({
      schemaVersion: 1,
      fingerprintSchemaVersion: 1,
      registryDigest: computeRegistryDigest(registry),
      registryCount: 0,
      selectedCount: 0,
      complete: true,
      generatedAt: '2026-07-21T00:00:00.000Z',
      packs: {},
      failures: [],
    }));
    fs.writeFileSync(siteIndexPath, JSON.stringify({ items: [] }));
    fs.writeFileSync(overridesPath, JSON.stringify({ schemaVersion: 1, conquest: {} }));
    fs.writeFileSync(listsPath, JSON.stringify([{ name: 'Overlay', packs: [] }]));
    const report = await main([
      '--dry-run', '--skip-overlay', '--registry', registryPath,
      '--content-index', contentIndexPath, '--site-index', siteIndexPath,
      '--overrides', overridesPath, '--lists', listsPath,
    ]);
    assert.equal(report.generatedAt, '2026-07-21T00:00:00.000Z');
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('overlay pixel identity includes image dimensions', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-overlay-hash-'));
  try {
    const flat = path.join(dir, 'flat.png');
    const square = path.join(dir, 'square.png');
    const background = { r: 10, g: 20, b: 30, alpha: 1 };
    await sharp({ create: { width: 1, height: 4, channels: 4, background } }).png().toFile(flat);
    await sharp({ create: { width: 2, height: 2, channels: 4, background } }).png().toFile(square);
    assert.notEqual(await pixelHash(flat), await pixelHash(square));
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test('requires exact equality among stone, iron, and diamond sword hashes', () => {
  assert.deepEqual(matchingSwordPairs({ stone: 'a', iron: 'a', diamond: 'b' }), ['stone=iron']);
  assert.deepEqual(matchingSwordPairs({ stone: 'a', iron: 'b', diamond: 'a' }), ['stone=diamond']);
  assert.deepEqual(matchingSwordPairs({ stone: 'a', iron: 'b', diamond: 'b' }), ['iron=diamond']);
  assert.deepEqual(matchingSwordPairs({ stone: 'a', iron: 'b', diamond: 'c' }), []);
  assert.deepEqual(matchingSwordPairs({ stone: 'a', iron: 'near-a', diamond: 'b' }), []);
});

test('applies force include/exclude with reasons and only lists public packs', () => {
  const index = {
    packs: {
      'Auto.zip': { packId: 'Auto', swords: { stone: 'a', iron: 'a', diamond: 'b' } },
      'Excluded.zip': { packId: 'Excluded', swords: { stone: 'c', iron: 'c', diamond: 'd' } },
      'Forced.zip': { packId: 'Forced', swords: { stone: 'e', iron: 'f', diamond: 'g' } },
      'Private.zip': { packId: 'Private', swords: { stone: 'h', iron: 'h', diamond: 'i' } },
    },
  };
  const overrides = validateOverrides({
    schemaVersion: 1,
    conquest: {
      forceInclude: { Forced: 'reviewed mode pack' },
      forceExclude: { Excluded: 'reviewed false positive' },
    },
  });
  const result = detectConquest(index, overrides, new Set(['Auto', 'Excluded', 'Forced']));
  assert.deepEqual(result.packs, ['Auto', 'Forced']);
  assert.match(result.records.find(row => row.packId === 'Forced').reason, /^forceInclude:/);
  assert.match(result.records.find(row => row.packId === 'Excluded').reason, /^forceExclude:/);
  assert.equal(result.records.find(row => row.packId === 'Private').included, true);
  assert.equal(result.records.find(row => row.packId === 'Private').public, false);
});

test('rejects missing, conflicting, or unknown override decisions', () => {
  assert.throws(() => validateOverrides({ schemaVersion: 1, conquest: { forceInclude: { A: '' }, forceExclude: {} } }), /requires a reason/);
  assert.throws(() => validateOverrides({ schemaVersion: 1, conquest: { forceInclude: { A: 'x' }, forceExclude: { A: 'y' } } }), /conflict/);
  const overrides = validateOverrides({ schemaVersion: 1, conquest: { forceInclude: { Missing: 'x' }, forceExclude: {} } });
  assert.throws(() => detectConquest({ packs: {} }, overrides, new Set()), /unknown pack/);
});

test('updates managed Lists while preserving unrelated fields and Lists', () => {
  const lists = [
    { name: 'Overlay', cover: 'old', description: 'old', packs: ['Old'] },
    { name: 'Other', cover: '', description: '', packs: ['Keep'] },
  ];
  updateManagedLists(lists, ['C2', 'C1', 'C1'], ['O2', 'O1']);
  assert.deepEqual(lists.find(row => row.name === 'Conquest').packs, ['C1', 'C2']);
  assert.deepEqual(lists.find(row => row.name === 'Overlay').packs, ['O1', 'O2']);
  assert.equal(lists.find(row => row.name === 'Overlay').cover, 'old');
  assert.deepEqual(lists.find(row => row.name === 'Other').packs, ['Keep']);
});
