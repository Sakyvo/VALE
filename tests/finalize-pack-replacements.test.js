const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { computeRegistryDigest } = require('../scripts/lib/pack-content-index');
const { applyLocalCleanup, completePendingCleanup, parseArgs } = require('../scripts/finalize-pack-replacements');

test('local cleanup removes only discarded identities and preserves the retained pack', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-finalize-'));
  try {
    const options = {
      registryPath: path.join(dir, 'registry.json'),
      contentIndexPath: path.join(dir, 'content-index.json'),
      aliasesPath: path.join(dir, 'aliases.json'),
      extractedPath: path.join(dir, 'extracted.json'),
      listsPath: path.join(dir, 'lists.json'),
      pendingPath: path.join(dir, 'pending.json'),
      thumbnailsRoot: path.join(dir, 'thumbnails'),
      packDataRoot: path.join(dir, 'data-packs'),
      packPageRoot: path.join(dir, 'pages'),
    };
    for (const root of [options.thumbnailsRoot, options.packDataRoot, options.packPageRoot]) fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.join(options.thumbnailsRoot, 'Old'));
    fs.mkdirSync(path.join(options.thumbnailsRoot, 'New'));
    fs.mkdirSync(path.join(options.packPageRoot, 'Old'));
    fs.mkdirSync(path.join(options.packPageRoot, 'New'));
    fs.writeFileSync(path.join(options.packDataRoot, 'Old.json'), '{}');
    fs.writeFileSync(path.join(options.packDataRoot, 'New.json'), '{}');

    const registry = {
      'Old.zip': { repo: 'packs-001', repoNum: 1, size: 10 },
      'New.zip': { repo: 'packs-002', repoNum: 2, size: 10 },
    };
    const contentIndex = {
      schemaVersion: 1,
      complete: true,
      registryDigest: computeRegistryDigest(registry),
      failures: [],
      packs: {
        'Old.zip': { packId: 'Old', repo: 'packs-001', archiveSha256: 'old-archive', visualContentHash: 'same' },
        'New.zip': { packId: 'New', repo: 'packs-002', archiveSha256: 'new-archive', visualContentHash: 'same' },
      },
    };
    const replacement = {
      incomingFile: 'New.zip',
      incomingPackId: 'New',
      visualContentHash: 'same',
      existing: [{ file: 'Old.zip', packId: 'Old', repo: 'packs-001', repoNum: 1 }],
    };
    const state = {
      registry,
      contentIndex,
      extracted: [
        { originalName: 'Old', packId: 'Old' },
        { originalName: 'New', packId: 'New' },
      ],
      lists: [
        { name: 'Sakyvo', packs: ['Old', 'New'] },
        { name: 'Other', packs: ['Old'] },
      ],
      aliases: { schemaVersion: 1, entries: [] },
      pending: { schemaVersion: 1, entries: [{ ...replacement, status: 'uploaded_pending_site_verification' }], resolved: [] },
    };

    applyLocalCleanup(options, [replacement], state);

    const nextRegistry = JSON.parse(fs.readFileSync(options.registryPath, 'utf8'));
    const nextIndex = JSON.parse(fs.readFileSync(options.contentIndexPath, 'utf8'));
    const nextExtracted = JSON.parse(fs.readFileSync(options.extractedPath, 'utf8'));
    const nextLists = JSON.parse(fs.readFileSync(options.listsPath, 'utf8'));
    const aliases = JSON.parse(fs.readFileSync(options.aliasesPath, 'utf8'));
    const pending = JSON.parse(fs.readFileSync(options.pendingPath, 'utf8'));

    assert.deepEqual(Object.keys(nextRegistry), ['New.zip']);
    assert.deepEqual(Object.keys(nextIndex.packs), ['New.zip']);
    assert.equal(nextIndex.complete, true);
    assert.equal(nextIndex.registryDigest, computeRegistryDigest(nextRegistry));
    assert.deepEqual(nextExtracted.map(row => row.packId), ['New']);
    assert.deepEqual(nextLists[0].packs, ['New']);
    assert.deepEqual(nextLists[1].packs, ['New']);
    assert.equal(aliases.entries[0].retainedPackId, 'New');
    assert.equal(pending.entries.length, 1);
    assert.equal(pending.entries[0].status, 'site_cleanup_pending_deployment');
    assert.deepEqual(pending.resolved, []);
    assert.equal(fs.existsSync(path.join(options.thumbnailsRoot, 'Old')), false);
    assert.equal(fs.existsSync(path.join(options.packDataRoot, 'Old.json')), false);
    assert.equal(fs.existsSync(path.join(options.packPageRoot, 'Old')), false);
    assert.equal(fs.existsSync(path.join(options.thumbnailsRoot, 'New')), true);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('remote cleanup completion resolves only prepared entries', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-finalize-state-'));
  try {
    const pendingPath = path.join(dir, 'pending.json');
    const prepared = { incomingFile: 'New.zip', status: 'site_cleanup_pending_deployment', existing: [] };
    const untouched = { incomingFile: 'Other.zip', status: 'uploaded_pending_site_verification', existing: [] };
    const pending = { schemaVersion: 1, entries: [prepared, untouched], resolved: [] };
    completePendingCleanup({ pendingPath }, [prepared], pending);
    const result = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
    assert.deepEqual(result.entries.map(row => row.incomingFile), ['Other.zip']);
    assert.equal(result.resolved[0].status, 'remote_deleted');
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('requires explicit replacement cleanup phases', () => {
  assert.equal(parseArgs(['--prepare-site']).prepareSite, true);
  assert.equal(parseArgs(['--execute-cleanup']).executeCleanup, true);
  assert.throws(() => parseArgs(['--execute']), /prepare-site/);
  assert.throws(() => parseArgs(['--prepare-site', '--execute-cleanup']), /either/);
});
