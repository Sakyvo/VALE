const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { stableStringify } = require('./pack-content-fingerprint');

const INDEX_SCHEMA_VERSION = 1;

class PackContentIndexError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PackContentIndexError';
    this.code = code;
    this.details = details;
  }
}

function readJson(filePath, fallback) {
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : fallback;
}

function retryWindowsFileOperation(operation, attempts = 20, delayMs = 25) {
  for (let attempt = 0; ; attempt++) {
    try {
      return operation();
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= attempts - 1) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2));
  try {
    fs.renameSync(tempPath, filePath);
  } catch {
    retryWindowsFileOperation(() => fs.rmSync(filePath, { force: true }));
    retryWindowsFileOperation(() => fs.renameSync(tempPath, filePath));
  }
}

function canonicalRegistry(registry) {
  const out = {};
  for (const file of Object.keys(registry).sort()) {
    const entry = registry[file] || {};
    out[file] = {
      repo: entry.repo || '',
      repoNum: Number(entry.repoNum) || 0,
      size: Number(entry.size) || 0,
    };
  }
  return out;
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function computeRegistryDigest(registry) {
  return sha256Text(stableStringify(canonicalRegistry(registry)));
}

function sourceKey(file, entry) {
  return sha256Text(stableStringify({
    file,
    repo: entry.repo || '',
    repoNum: Number(entry.repoNum) || 0,
    size: Number(entry.size) || 0,
  }));
}

function validateContentIndex(index, registry, expectedFingerprintSchemaVersion = null) {
  if (!index || index.schemaVersion !== INDEX_SCHEMA_VERSION) {
    throw new PackContentIndexError('content_index_missing_or_unsupported', 'Pack content index is missing or has an unsupported schema');
  }
  if (expectedFingerprintSchemaVersion != null && index.fingerprintSchemaVersion !== expectedFingerprintSchemaVersion) {
    throw new PackContentIndexError('content_index_fingerprint_schema_mismatch', 'Pack content index uses an incompatible fingerprint schema', {
      expected: expectedFingerprintSchemaVersion,
      actual: index.fingerprintSchemaVersion || null,
    });
  }
  const expectedDigest = computeRegistryDigest(registry);
  if (index.registryDigest !== expectedDigest) {
    throw new PackContentIndexError('content_index_stale', 'Pack content index does not match pack-registry.json', {
      expectedDigest,
      actualDigest: index.registryDigest || null,
    });
  }
  if (!index.complete) {
    throw new PackContentIndexError('content_index_incomplete', 'Pack content index scan is not complete');
  }
  if (Array.isArray(index.failures) && index.failures.length) {
    throw new PackContentIndexError('content_index_has_failures', 'Pack content index contains scan failures', { count: index.failures.length });
  }
  const packs = index.packs || {};
  const missing = Object.keys(registry).filter(file => !packs[file] || !packs[file].visualContentHash);
  if (missing.length) {
    throw new PackContentIndexError('content_index_missing_entries', 'Pack content index is missing registry entries', {
      count: missing.length,
      sample: missing.slice(0, 10),
    });
  }
  return index;
}

function buildVisualHashLookup(index) {
  const lookup = new Map();
  for (const [file, entry] of Object.entries((index && index.packs) || {})) {
    if (!entry || !entry.visualContentHash) continue;
    if (!lookup.has(entry.visualContentHash)) lookup.set(entry.visualContentHash, []);
    lookup.get(entry.visualContentHash).push({ file, ...entry });
  }
  for (const matches of lookup.values()) matches.sort((a, b) => a.file.localeCompare(b.file));
  return lookup;
}

function buildDuplicateGroups(packs) {
  const lookup = buildVisualHashLookup({ packs });
  return [...lookup.entries()]
    .filter(([, matches]) => matches.length > 1)
    .map(([visualContentHash, matches]) => ({
      visualContentHash,
      members: matches.map(match => ({ file: match.file, packId: match.packId, repo: match.repo })),
    }))
    .sort((a, b) => a.members[0].file.localeCompare(b.members[0].file));
}

function refreshContentIndexMetadata(index, registry) {
  index.registryDigest = computeRegistryDigest(registry);
  index.registryCount = Object.keys(registry).length;
  index.selectedCount = index.registryCount;
  index.complete = (!index.failures || index.failures.length === 0) &&
    Object.keys(index.packs || {}).length === index.registryCount;
  index.generatedAt = new Date().toISOString();
  index.duplicateGroups = buildDuplicateGroups(index.packs || {});
  return index;
}

module.exports = {
  INDEX_SCHEMA_VERSION,
  PackContentIndexError,
  buildDuplicateGroups,
  buildVisualHashLookup,
  canonicalRegistry,
  computeRegistryDigest,
  readJson,
  refreshContentIndexMetadata,
  retryWindowsFileOperation,
  sourceKey,
  validateContentIndex,
  writeJsonAtomic,
};
