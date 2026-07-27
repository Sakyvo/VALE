const assert = require('node:assert/strict');
const test = require('node:test');
const { parseArgs, upsertExtraction } = require('../scripts/extract-textures');

test('parses explicit reviewed-migration extraction flags', () => {
  assert.deepEqual(
    parseArgs(['--input', 'staged', '--merge', '--manifest', 'targets.json', '--replace-existing', '--strict']),
    {
      packsDir: 'staged',
      merge: true,
      manifestPath: 'targets.json',
      replaceExisting: true,
      strict: true,
    }
  );
  assert.throws(() => parseArgs(['--replace-existing']), /requires --manifest/);
  assert.throws(() => parseArgs(['--unknown']), /Unknown argument/);
});

test('replaces only the matching existing extraction row', () => {
  const rows = [
    { packId: 'Keep', value: 1 },
    { packId: 'Replace', value: 1 },
  ];
  upsertExtraction(rows, { packId: 'Replace', value: 2 }, true);
  upsertExtraction(rows, { packId: 'New', value: 3 }, true);
  assert.deepEqual(rows, [
    { packId: 'Keep', value: 1 },
    { packId: 'Replace', value: 2 },
    { packId: 'New', value: 3 },
  ]);
});
