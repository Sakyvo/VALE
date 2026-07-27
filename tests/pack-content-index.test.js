const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  PackContentIndexError,
  buildVisualHashLookup,
  computeRegistryDigest,
  sourceKey,
  validateContentIndex,
  writeJsonAtomic,
} = require('../scripts/lib/pack-content-index');

const registry = {
  'a.zip': { repo: 'packs-001', repoNum: 1, size: 10 },
};

test('writeJsonAtomic retries transient Windows file locks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vale-atomic-write-'));
  const filePath = path.join(root, 'state.json');
  fs.writeFileSync(filePath, '{}');
  const originalRename = fs.renameSync;
  const originalRemove = fs.rmSync;
  let renameFailures = 1;
  let removeFailures = 1;
  fs.renameSync = (...args) => {
    if (renameFailures-- > 0) {
      const error = new Error('locked');
      error.code = 'EPERM';
      throw error;
    }
    return originalRename(...args);
  };
  fs.rmSync = (...args) => {
    if (removeFailures-- > 0) {
      const error = new Error('locked');
      error.code = 'EPERM';
      throw error;
    }
    return originalRemove(...args);
  };
  try {
    writeJsonAtomic(filePath, { ok: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { ok: true });
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync = originalRemove;
    originalRemove(root, { recursive: true, force: true });
  }
});

test('validates a complete index bound to the registry digest', () => {
  const index = {
    schemaVersion: 1,
    fingerprintSchemaVersion: 1,
    complete: true,
    registryDigest: computeRegistryDigest(registry),
    failures: [],
    packs: { 'a.zip': { visualContentHash: 'same' } },
  };
  assert.equal(validateContentIndex(index, registry, 1), index);
  assert.throws(
    () => validateContentIndex(index, registry, 2),
    error => error instanceof PackContentIndexError && error.code === 'content_index_fingerprint_schema_mismatch'
  );
});

test('fails closed for stale, incomplete, and missing content index data', () => {
  const cases = [
    [null, 'content_index_missing_or_unsupported'],
    [{ schemaVersion: 1, complete: true, registryDigest: 'stale', failures: [], packs: {} }, 'content_index_stale'],
    [{ schemaVersion: 1, complete: false, registryDigest: computeRegistryDigest(registry), failures: [], packs: {} }, 'content_index_incomplete'],
    [{ schemaVersion: 1, complete: true, registryDigest: computeRegistryDigest(registry), failures: [], packs: {} }, 'content_index_missing_entries'],
  ];
  for (const [index, code] of cases) {
    assert.throws(
      () => validateContentIndex(index, registry),
      error => error instanceof PackContentIndexError && error.code === code
    );
  }
});

test('builds deterministic visual hash lookup records', () => {
  const lookup = buildVisualHashLookup({
    packs: {
      'z.zip': { packId: 'Z', visualContentHash: 'same' },
      'a.zip': { packId: 'A', visualContentHash: 'same' },
    },
  });
  assert.deepEqual(lookup.get('same').map(row => row.file), ['a.zip', 'z.zip']);
  assert.notEqual(sourceKey('a.zip', registry['a.zip']), sourceKey('b.zip', registry['a.zip']));
});
