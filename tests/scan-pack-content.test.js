const assert = require('node:assert/strict');
const test = require('node:test');
const { parseArgs, rawDownloadUrl } = require('../scripts/scan-pack-content');
const {
  buildDuplicateGroups,
  computeRegistryDigest,
  sourceKey,
} = require('../scripts/lib/pack-content-index');

test('registry digest and source keys ignore object insertion order', () => {
  const a = {
    'b.zip': { repo: 'packs-002', repoNum: 2, size: 20 },
    'a.zip': { repo: 'packs-001', repoNum: 1, size: 10 },
  };
  const b = {
    'a.zip': { size: 10, repoNum: 1, repo: 'packs-001' },
    'b.zip': { size: 20, repoNum: 2, repo: 'packs-002' },
  };
  assert.equal(computeRegistryDigest(a), computeRegistryDigest(b));
  assert.equal(sourceKey('a.zip', a['a.zip']), sourceKey('a.zip', b['a.zip']));
});

test('groups only exact visual hashes and sorts deterministically', () => {
  const groups = buildDuplicateGroups({
    'z.zip': { packId: 'Z', repo: 'packs-001', visualContentHash: 'same' },
    'a.zip': { packId: 'A', repo: 'packs-001', visualContentHash: 'same' },
    'x.zip': { packId: 'X', repo: 'packs-001', visualContentHash: 'other' },
  });
  assert.deepEqual(groups, [{
    visualContentHash: 'same',
    members: [
      { file: 'a.zip', packId: 'A', repo: 'packs-001' },
      { file: 'z.zip', packId: 'Z', repo: 'packs-001' },
    ],
  }]);
});

test('encodes special filenames as one raw GitHub path segment', () => {
  assert.equal(
    rawDownloadUrl('Sakyvo', '! §bPack #1.zip', { repo: 'packs-001' }),
    'https://raw.githubusercontent.com/Sakyvo/packs-001/main/resourcepacks/!%20%C2%A7bPack%20%231.zip'
  );
});

test('validates explicit scan concurrency', () => {
  assert.equal(parseArgs(['--concurrency', '3']).concurrency, 3);
  assert.throws(() => parseArgs(['--concurrency', '0']), /concurrency/);
  assert.throws(() => parseArgs(['--concurrency', '9']), /concurrency/);
});
