const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');
const sharp = require('sharp');
const { fingerprintPack } = require('../scripts/lib/pack-content-fingerprint');
const { computeRegistryDigest, sourceKey } = require('../scripts/lib/pack-content-index');
const { buildPlan, updateLists } = require('../scripts/upload-folder');

async function png(color) {
  return sharp({ create: { width: 16, height: 16, channels: 4, background: color } }).png().toBuffer();
}

async function createPack(filePath) {
  const zip = new AdmZip();
  zip.addFile('pack.mcmeta', Buffer.from('{"pack":{"pack_format":1,"description":"test"}}'));
  zip.addFile('assets/minecraft/textures/items/diamond_sword.png', await png({ r: 1, g: 120, b: 220, alpha: 1 }));
  zip.addFile('assets/minecraft/textures/blocks/stone.png', await png({ r: 90, g: 90, b: 90, alpha: 1 }));
  zip.writeZip(filePath);
}

async function withFixture(fn) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-upload-plan-'));
  try {
    const source = path.join(dir, 'source');
    fs.mkdirSync(source);
    const incomingPath = path.join(source, 'Renamed.zip');
    await createPack(incomingPath);
    const fingerprint = await fingerprintPack(incomingPath);
    const registry = { 'Existing.zip': { repo: 'packs-001', repoNum: 1, size: 10 } };
    const paths = {
      source,
      registryPath: path.join(dir, 'registry.json'),
      siteIndexPath: path.join(dir, 'site-index.json'),
      listsPath: path.join(dir, 'lists.json'),
      contentIndex: path.join(dir, 'content-index.json'),
      contentAliases: path.join(dir, 'aliases.json'),
      pendingReplacements: path.join(dir, 'pending.json'),
    };
    fs.writeFileSync(paths.registryPath, JSON.stringify(registry));
    fs.writeFileSync(paths.siteIndexPath, JSON.stringify({ items: [{ name: 'Existing' }] }));
    fs.writeFileSync(paths.listsPath, '[]');
    fs.writeFileSync(paths.contentIndex, JSON.stringify({
      schemaVersion: 1,
      fingerprintSchemaVersion: 1,
      complete: true,
      registryDigest: computeRegistryDigest(registry),
      failures: [],
      packs: {
        'Existing.zip': {
          packId: 'Existing',
          repo: 'packs-001',
          repoNum: 1,
          size: 10,
          sourceKey: sourceKey('Existing.zip', registry['Existing.zip']),
          archiveSha256: 'existing-archive',
          visualContentHash: fingerprint.visualContentHash,
          visualEntryCount: fingerprint.visualEntryCount,
          swords: fingerprint.swords,
        },
      },
    }));
    await fn({ dir, fingerprint, paths, registry });
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

function options(paths, extra = {}) {
  return {
    ...paths,
    list: 'Sakyvo',
    workdir: path.join(path.dirname(paths.source), 'workdir'),
    execute: false,
    skipBlockers: false,
    onlyRepoNum: null,
    duplicateResolutions: null,
    ...extra,
  };
}

test('blocks an exact renamed copy until a retain decision exists', async () => withFixture(async ({ paths }) => {
  const plan = await buildPlan(options(paths));
  assert.equal(plan.uploadEntries.length, 0);
  assert.equal(plan.hardBlockers.length, 1);
  assert.equal(plan.hardBlockers[0].action, 'blocked_content_duplicate');
  assert.equal(plan.hardBlockers[0].matches[0].packId, 'Existing');
}));

test('same pack id skips only when visual content is exact', async () => withFixture(async ({ paths }) => {
  fs.writeFileSync(paths.siteIndexPath, JSON.stringify({ items: [{ name: 'Renamed' }] }));
  const contentIndex = JSON.parse(fs.readFileSync(paths.contentIndex, 'utf8'));
  contentIndex.packs['Existing.zip'].packId = 'Renamed';
  fs.writeFileSync(paths.contentIndex, JSON.stringify(contentIndex));
  const plan = await buildPlan(options(paths));
  assert.equal(plan.blockers.length, 0);
  assert.equal(plan.uploadEntries.length, 0);
  assert.deepEqual(plan.listPackIds, ['Renamed']);
  assert.equal(plan.entries.find(row => row.file === 'Renamed.zip').action, 'skip_existing_pack_id_exact_content');
}));

test('same pack id with different visual content is a hard blocker', async () => withFixture(async ({ paths }) => {
  fs.writeFileSync(paths.siteIndexPath, JSON.stringify({ items: [{ name: 'Renamed' }] }));
  const contentIndex = JSON.parse(fs.readFileSync(paths.contentIndex, 'utf8'));
  contentIndex.packs['Existing.zip'].packId = 'Renamed';
  contentIndex.packs['Existing.zip'].visualContentHash = 'different-content';
  fs.writeFileSync(paths.contentIndex, JSON.stringify(contentIndex));
  const plan = await buildPlan(options(paths));
  assert.equal(plan.uploadEntries.length, 0);
  assert.equal(plan.hardBlockers[0].action, 'blocked_pack_id_content_conflict');
}));

test('registered filename with different visual content is a hard blocker', async () => withFixture(async ({ paths }) => {
  const incomingSize = fs.statSync(path.join(paths.source, 'Renamed.zip')).size;
  const registry = { 'Renamed.zip': { repo: 'packs-001', repoNum: 1, size: incomingSize } };
  fs.writeFileSync(paths.registryPath, JSON.stringify(registry));
  fs.writeFileSync(paths.siteIndexPath, JSON.stringify({ items: [] }));
  const contentIndex = JSON.parse(fs.readFileSync(paths.contentIndex, 'utf8'));
  const retained = contentIndex.packs['Existing.zip'];
  retained.packId = 'Renamed';
  retained.size = incomingSize;
  retained.sourceKey = sourceKey('Renamed.zip', registry['Renamed.zip']);
  retained.visualContentHash = 'different-content';
  contentIndex.packs = { 'Renamed.zip': retained };
  contentIndex.registryDigest = computeRegistryDigest(registry);
  fs.writeFileSync(paths.contentIndex, JSON.stringify(contentIndex));
  const plan = await buildPlan(options(paths));
  assert.equal(plan.uploadEntries.length, 0);
  assert.equal(plan.hardBlockers[0].action, 'blocked_registry_filename_content_conflict');
}));

test('keep-existing resolution skips upload, adds retained List id, and records alias', async () => withFixture(async ({ dir, fingerprint, paths, registry }) => {
  const resolutions = path.join(dir, 'resolutions.json');
  fs.writeFileSync(resolutions, JSON.stringify({
    schemaVersion: 1,
    registryDigest: computeRegistryDigest(registry),
    decisions: [{
      archiveSha256: fingerprint.archiveSha256,
      visualContentHash: fingerprint.visualContentHash,
      keep: 'existing',
      retainedFile: 'Existing.zip',
      reason: 'reviewed_test',
    }],
  }));
  const plan = await buildPlan(options(paths, { duplicateResolutions: resolutions }));
  assert.equal(plan.blockers.length, 0);
  assert.equal(plan.uploadEntries.length, 0);
  assert.deepEqual(plan.listPackIds, ['Existing']);
  assert.equal(plan.aliasUpdates[0].retainedPackId, 'Existing');
}));

test('keep-incoming resolution uploads first and creates a pending replacement', async () => withFixture(async ({ dir, fingerprint, paths, registry }) => {
  const resolutions = path.join(dir, 'resolutions.json');
  fs.writeFileSync(resolutions, JSON.stringify({
    schemaVersion: 1,
    registryDigest: computeRegistryDigest(registry),
    decisions: [{
      archiveSha256: fingerprint.archiveSha256,
      visualContentHash: fingerprint.visualContentHash,
      keep: 'incoming',
    }],
  }));
  const plan = await buildPlan(options(paths, { duplicateResolutions: resolutions }));
  assert.equal(plan.blockers.length, 0);
  assert.equal(plan.uploadEntries.length, 1);
  assert.equal(plan.uploadEntries[0].packId, 'Renamed');
  assert.equal(plan.replacements.length, 1);
  assert.equal(plan.replacements[0].incomingArchiveSha256, fingerprint.archiveSha256);
  assert.equal(plan.replacements[0].incomingSize, fs.statSync(path.join(paths.source, 'Renamed.zip')).size);
  assert.equal(plan.replacements[0].existing[0].packId, 'Existing');
  assert.equal(plan.replacements[0].existing[0].archiveSha256, 'existing-archive');
  assert.equal(plan.replacements[0].existing[0].size, 10);
}));

test('fails closed when the operational content index is unavailable', async () => withFixture(async ({ paths }) => {
  fs.rmSync(paths.contentIndex);
  const plan = await buildPlan(options(paths));
  assert.ok(plan.hardBlockers.some(row => row.action === 'blocked_content_index'));
  assert.equal(plan.uploadEntries.length, 0);
}));

test('fails closed without dereferencing a missing index when resolutions are supplied', async () => withFixture(async ({ dir, fingerprint, paths }) => {
  const resolutions = path.join(dir, 'resolutions.json');
  fs.writeFileSync(resolutions, JSON.stringify({
    schemaVersion: 1,
    registryDigest: 'stale',
    decisions: [{
      archiveSha256: fingerprint.archiveSha256,
      visualContentHash: fingerprint.visualContentHash,
      keep: 'existing',
      retainedFile: 'Existing.zip',
    }],
  }));
  fs.rmSync(paths.contentIndex);
  const plan = await buildPlan(options(paths, { duplicateResolutions: resolutions }));
  assert.ok(plan.hardBlockers.some(row => row.action === 'blocked_content_index'));
  assert.equal(plan.uploadEntries.length, 0);
}));

test('migrates all List memberships without creating duplicates', async () => withFixture(async ({ paths }) => {
  fs.writeFileSync(paths.listsPath, JSON.stringify([
    { name: 'Sakyvo', cover: '', description: '', packs: ['Existing', 'Renamed'] },
    { name: 'Other', cover: '', description: '', packs: ['Existing', 'Keep'] },
  ]));
  updateLists('Sakyvo', ['Renamed'], [{
    incomingPackId: 'Renamed',
    existing: [{ packId: 'Existing' }],
  }], paths.listsPath);
  const lists = JSON.parse(fs.readFileSync(paths.listsPath, 'utf8'));
  assert.deepEqual(lists.find(row => row.name === 'Sakyvo').packs, ['Renamed']);
  assert.deepEqual(lists.find(row => row.name === 'Other').packs, ['Renamed', 'Keep']);
}));
