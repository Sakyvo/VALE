const assert = require('node:assert/strict');
const test = require('node:test');
const { computeUploadedNotExtracted } = require('../scripts/lib/extraction-coverage');
const { getPackIdFromZipName } = require('../scripts/pack-utils');

test('lists registry packs that have no extraction row, keyed by pack ID', () => {
  const registry = {
    'Visible One.zip': { repo: 'packs-006', repoNum: 6, size: 100 },
    'Visible Two.zip': { repo: 'packs-006', repoNum: 6, size: 200 },
    'Hidden Three.zip': { repo: 'packs-005', repoNum: 5, size: 300 },
    '§a Hidden #4.zip': { repo: 'packs-005', repoNum: 5, size: 400 },
  };
  const extracted = [
    { packId: getPackIdFromZipName('Visible One.zip') },
    { packId: getPackIdFromZipName('Visible Two.zip') },
  ];
  const report = computeUploadedNotExtracted(registry, extracted);
  assert.equal(report.registryTotal, 4);
  assert.equal(report.extractedTotal, 2);
  assert.equal(report.uploadedTotal, 4);
  assert.equal(report.missingTotal, 2);
  assert.deepEqual(report.byRepo, { 'packs-005': 2 });
  const files = new Set(report.missing.map(m => m.file));
  assert.equal(files.size, 2);
  assert.ok(files.has('Hidden Three.zip'));
  assert.ok(files.has('§a Hidden #4.zip'));
  const ids = report.missing.map(m => m.packId);
  assert.ok(ids.includes(getPackIdFromZipName('Hidden Three.zip')));
  assert.ok(ids.includes(getPackIdFromZipName('§a Hidden #4.zip')));
});

test('treats a missing extracted.json as empty and flags every registry entry', () => {
  const registry = { 'Only One.zip': { repo: 'packs-004', repoNum: 4, size: 5 } };
  const report = computeUploadedNotExtracted(registry, []);
  assert.equal(report.missingTotal, 1);
  assert.equal(report.extractedTotal, 0);
  assert.equal(report.missing[0].size, 5);
});

test('handles empty or null inputs without throwing', () => {
  assert.deepEqual(computeUploadedNotExtracted(null, null), {
    registryTotal: 0, extractedTotal: 0, uploadedTotal: 0,
    missingTotal: 0, byRepo: {}, missing: [],
  });
  const onlyExtracted = computeUploadedNotExtracted({}, [{ packId: 'X' }]);
  assert.equal(onlyExtracted.extractedTotal, 1);
  assert.equal(onlyExtracted.missingTotal, 0);
});

test('does not double-count entries sharing one pack ID after sanitization', () => {
  // Same pack ID resolved from two filenames still counts as one missing entry.
  const registry = {
    '! Revedents Faithful 2.0.zip': { repo: 'packs-004', repoNum: 4, size: 1 },
    'Revedents Faithful 2.0.zip': { repo: 'packs-004', repoNum: 4, size: 1 },
  };
  const report = computeUploadedNotExtracted(registry, []);
  assert.equal(report.missingTotal, 2);
  assert.equal(new Set(report.missing.map(m => m.packId)).size, 1);
});
