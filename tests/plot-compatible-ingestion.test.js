const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');
const sharp = require('sharp');
const { computeRegistryDigest, sourceKey } = require('../scripts/lib/pack-content-index');
const { fingerprintPack } = require('../scripts/lib/pack-content-fingerprint');
const { normalizePack } = require('../scripts/lib/pack-normalizer');
const { buildPlan, runIngestion } = require('../scripts/upload-folder');

async function png(color) {
  return sharp({
    create: { width: 8, height: 8, channels: 4, background: color },
  }).png().toBuffer();
}

function writeCatalog(root) {
  const paths = {
    registryPath: path.join(root, 'registry.json'),
    siteIndexPath: path.join(root, 'site-index.json'),
    listsPath: path.join(root, 'lists.json'),
    contentIndex: path.join(root, 'content-index.json'),
    contentAliases: path.join(root, 'aliases.json'),
    pendingReplacements: path.join(root, 'pending.json'),
    normalizationAudit: path.join(root, 'normalization-audit.json'),
  };
  fs.writeFileSync(paths.registryPath, '{}');
  fs.writeFileSync(paths.siteIndexPath, '{"items":[]}');
  fs.writeFileSync(paths.listsPath, '[]');
  fs.writeFileSync(paths.contentIndex, JSON.stringify({
    schemaVersion: 1,
    fingerprintSchemaVersion: 1,
    registryDigest: computeRegistryDigest({}),
    complete: true,
    failures: [],
    packs: {},
  }));
  return paths;
}

function options(root, source, extra = {}) {
  return {
    source,
    list: 'Sakyvo',
    workdir: path.join(root, 'work'),
    execute: false,
    skipBlockers: false,
    onlyRepoNum: null,
    duplicateResolutions: null,
    ...writeCatalog(root),
    ...extra,
  };
}

test('scans top-level folder packs and ZIP content with a wrong extension while ignoring junk', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-plot-source-'));
  try {
    const source = path.join(root, 'source');
    const folder = path.join(source, 'Folder Pack');
    fs.mkdirSync(path.join(folder, 'assets/minecraft/textures/blocks'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'pack.mcmeta'), '{"pack":{"pack_format":1,"description":"folder"}}');
    fs.writeFileSync(
      path.join(folder, 'assets/minecraft/textures/blocks/stone.png'),
      await png({ r: 20, g: 80, b: 140, alpha: 1 })
    );

    const wrongExtension = new AdmZip();
    wrongExtension.addFile('pack.mcmeta', Buffer.from('{"pack":{"pack_format":1,"description":"wrong extension"}}'));
    wrongExtension.addFile(
      'assets/minecraft/textures/blocks/stone.png',
      await png({ r: 140, g: 70, b: 30, alpha: 1 })
    );
    wrongExtension.writeZip(path.join(source, 'Wrong.rar'));
    fs.writeFileSync(path.join(source, 'desktop.ini'), 'junk');

    const plan = await buildPlan(options(root, source));

    assert.equal(plan.summary.sourceFiles, 2);
    assert.deepEqual(plan.uploadEntries.map(row => row.file).sort(), ['Folder Pack.zip', 'Wrong.zip']);
    assert.deepEqual(plan.listPackIds.sort(), ['Folder_Pack', 'Wrong']);
    assert.equal(plan.entries.some(row => row.file === 'desktop.ini'), false);
    assert.ok(plan.uploadEntries.every(row => row.normalization.classification === 'repairable'));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('records unrepairable sources as illegal material without publishing them', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-plot-illegal-'));
  try {
    const source = path.join(root, 'source');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'notes.txt'), 'not a pack');
    fs.writeFileSync(path.join(source, 'real.rar'), Buffer.from('Rar!\x1a\x07\x01\x00rest'));
    fs.writeFileSync(path.join(source, 'real.7z'), Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00]));
    const empty = new AdmZip();
    empty.writeZip(path.join(source, 'empty.zip'));
    fs.writeFileSync(path.join(source, 'broken.zip'), Buffer.from('PK\x03\x04broken'));
    const deep = new AdmZip();
    const prefix = 'a/'.repeat(11);
    deep.addFile(`${prefix}assets/minecraft/a.png`, Buffer.from('x'));
    deep.writeZip(path.join(source, 'too-deep.zip'));
    const encrypted = new AdmZip();
    encrypted.addFile('pack.mcmeta', Buffer.from('{}'));
    encrypted.addFile('assets/minecraft/a.png', Buffer.from('x'));
    const encryptedPath = path.join(source, 'encrypted.zip');
    encrypted.writeZip(encryptedPath);
    const encryptedBytes = fs.readFileSync(encryptedPath);
    for (let index = 0; index + 4 <= encryptedBytes.length; index++) {
      if (encryptedBytes.subarray(index, index + 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
        encryptedBytes[index + 6] |= 1;
      } else if (encryptedBytes.subarray(index, index + 4).equals(Buffer.from([0x50, 0x4b, 0x01, 0x02]))) {
        encryptedBytes[index + 8] |= 1;
      }
    }
    fs.writeFileSync(encryptedPath, encryptedBytes);

    const paths = writeCatalog(root);
    const plan = await buildPlan({
      source,
      list: 'Sakyvo',
      workdir: path.join(root, 'work'),
      execute: false,
      skipBlockers: false,
      onlyRepoNum: null,
      duplicateResolutions: null,
      ...paths,
    });

    assert.equal(plan.uploadEntries.length, 0);
    assert.equal(plan.listPackIds.length, 0);
    assert.equal(plan.illegalEntries.length, 7);
    assert.ok(plan.illegalEntries.every(row => row.label === '非法材质'));
    const reasonByFile = Object.fromEntries(plan.illegalEntries.map(row => [row.file, row.reason]));
    assert.equal(reasonByFile['real.rar'], 'rar_archive');
    assert.equal(reasonByFile['real.7z'], 'sevenz_archive');
    assert.equal(reasonByFile['empty.zip'], 'no_core_found');
    assert.equal(reasonByFile['broken.zip'], 'corrupt_zip');
    assert.equal(reasonByFile['too-deep.zip'], 'too_deep');
    assert.equal(reasonByFile['encrypted.zip'], 'encrypted_zip');
    const audit = JSON.parse(fs.readFileSync(paths.normalizationAudit, 'utf8'));
    assert.equal(audit.entries.length, 7);
    assert.ok(audit.entries.every(row => row.classification === 'illegal'));
    assert.ok(audit.entries.every(row => !JSON.stringify(row).includes(path.resolve(source))));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('applies Plot repair families and emits a clean Normal product', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-plot-repairs-'));
  try {
    const source = path.join(root, 'source');
    fs.mkdirSync(source);
    const zip = new AdmZip();
    zip.addFile('Pack.mcmeta', Buffer.from('{"pack":{"pack_format":1,"description":"\\u00A7b\\! repaired"}}'));
    zip.addFile('pack..png', Buffer.from('icon'));
    zip.addFile('assets/minecraft/textures/blocks/stone.png', await png({ r: 70, g: 80, b: 90, alpha: 1 }));
    zip.addFile('assets/minecraft/records/cat.ogg', Buffer.from('dead'));
    zip.addFile('assets/minecraft/.DS_Store', Buffer.from('junk'));
    zip.addFile('Thumbs.db', Buffer.from('junk'));
    zip.addFile('credits.txt', Buffer.from('extra'));
    zip.writeZip(path.join(source, 'Messy.zip'));

    const missing = new AdmZip();
    missing.addFile('assets/minecraft/textures/blocks/stone.png', await png({ r: 10, g: 20, b: 30, alpha: 1 }));
    missing.writeZip(path.join(source, 'Missing.zip'));

    const paths = writeCatalog(root);
    const plan = await buildPlan({
      source,
      list: 'Sakyvo',
      workdir: path.join(root, 'work'),
      execute: false,
      skipBlockers: false,
      onlyRepoNum: null,
      duplicateResolutions: null,
      ...paths,
    });

    assert.equal(plan.blockers.length, 0);
    assert.deepEqual(plan.uploadEntries.map(row => row.file).sort(), ['Messy.zip', 'Missing.zip']);
    for (const upload of plan.uploadEntries) {
      const entries = new AdmZip(upload.path).getEntries()
        .filter(entry => !entry.isDirectory)
        .map(entry => entry.entryName);
      assert.ok(entries.includes('pack.mcmeta'));
      assert.ok(entries.includes('assets/minecraft/textures/blocks/stone.png'));
      assert.equal(entries.some(name => /records|DS_Store|Thumbs|credits/.test(name)), false);
      assert.equal(entries.some(name => /Pack\.mcmeta|pack\.\.png/.test(name)), false);
      assert.equal(upload.normalization.classification, 'repairable');
    }
    const messy = plan.uploadEntries.find(row => row.file === 'Messy.zip');
    const mcmeta = new AdmZip(messy.path).readAsText('pack.mcmeta');
    assert.match(mcmeta, /\\u00A7b! repaired/);
    assert.equal(plan.entries.every(row => row.action !== 'illegal_material'), true);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('unwraps ZIP and folder containers through depth ten and rejects depth eleven', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-plot-depth-'));
  try {
    const source = path.join(root, 'source');
    fs.mkdirSync(source);

    const core = new AdmZip();
    core.addFile('pack.mcmeta', Buffer.from('{"pack":{"pack_format":1,"description":"deep"}}'));
    core.addFile('assets/minecraft/textures/blocks/stone.png', await png({ r: 50, g: 100, b: 150, alpha: 1 }));
    let nested = core.toBuffer();
    for (let depth = 10; depth >= 1; depth--) {
      const wrapper = new AdmZip();
      wrapper.addFile(depth === 10 ? 'Real Pack.zip' : `Layer ${depth}.zip`, nested);
      nested = wrapper.toBuffer();
    }
    fs.writeFileSync(path.join(source, 'Outer.zip'), nested);

    const folderPrefix = Array.from({ length: 9 }, (_, index) => `folder-${index + 1}`);
    folderPrefix.push('Real Folder');
    const folderPack = path.join(source, 'Folder Container', ...folderPrefix);
    fs.mkdirSync(path.join(folderPack, 'assets/minecraft/textures/blocks'), { recursive: true });
    fs.writeFileSync(path.join(folderPack, 'pack.mcmeta'), '{"pack":{"pack_format":1,"description":"folder"}}');
    fs.writeFileSync(
      path.join(folderPack, 'assets/minecraft/textures/blocks/stone.png'),
      await png({ r: 150, g: 100, b: 50, alpha: 1 })
    );

    const tooDeep = new AdmZip();
    const tooDeepPrefix = `${'deep/'.repeat(10)}one-too-many/`;
    tooDeep.addFile(`${tooDeepPrefix}pack.mcmeta`, Buffer.from('{"pack":{"pack_format":1,"description":"too deep"}}'));
    tooDeep.addFile(`${tooDeepPrefix}assets/minecraft/a.png`, Buffer.from('x'));
    tooDeep.writeZip(path.join(source, 'Too Deep.zip'));

    const plan = await buildPlan(options(root, source));

    assert.deepEqual(plan.uploadEntries.map(row => row.file).sort(), ['Real Folder.zip', 'Real Pack.zip']);
    assert.equal(plan.illegalEntries.length, 1);
    assert.equal(plan.illegalEntries[0].file, 'Too Deep.zip');
    assert.equal(plan.illegalEntries[0].reason, 'too_deep');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('turns archive safety violations into explicit limits blockers', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-plot-limits-'));
  try {
    const source = path.join(root, 'source');
    fs.mkdirSync(source);
    const cases = [
      ['unsafe.zip', [['../escape.txt', 'x'], ['assets/minecraft/a.png', 'x']]],
      ['collision.zip', [['assets/minecraft/A.png', 'a'], ['assets/minecraft/a.png', 'b']]],
      ['many.zip', [['assets/minecraft/one.png', '1'], ['assets/minecraft/two.png', '2'], ['assets/minecraft/three.png', '3']]],
      ['large-entry.zip', [['assets/minecraft/large.png', '12345']]],
    ];
    for (const [name, entries] of cases) {
      const zip = new AdmZip();
      zip.addFile('pack.mcmeta', Buffer.from('{"pack":{"pack_format":1,"description":"limits"}}'));
      for (const [entry, data] of entries) zip.addFile(entry, Buffer.from(data));
      zip.writeZip(path.join(source, name));
    }
    const linkedInner = new AdmZip();
    linkedInner.addFile('pack.mcmeta', Buffer.from('{}'));
    linkedInner.addFile('assets/link', Buffer.from('target'));
    linkedInner.getEntry('assets/link').attr = (0xa1ff << 16) >>> 0;
    const linkedOuter = new AdmZip();
    linkedOuter.addFile('Linked.zip', linkedInner.toBuffer());
    linkedOuter.writeZip(path.join(source, 'nested-link.zip'));

    const plan = await buildPlan({
      source,
      list: 'Sakyvo',
      workdir: path.join(root, 'work'),
      normalizationLimits: { maxEntries: 2, maxEntryBytes: 4, maxTotalBytes: 8 },
      execute: false,
      skipBlockers: false,
      onlyRepoNum: null,
      duplicateResolutions: null,
      ...writeCatalog(root),
    });

    assert.equal(plan.uploadEntries.length, 0);
    assert.equal(plan.illegalEntries.length, 0);
    assert.equal(plan.blockers.length, 5);
    assert.ok(plan.blockers.every(row => row.action === 'blocked_archive_limits'));
    assert.ok(plan.hardBlockers.every(row => row.action === 'blocked_archive_limits'));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('does not follow top-level or nested filesystem links', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-plot-links-'));
  try {
    const source = path.join(root, 'source');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(source);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
    const link = path.join(source, 'linked-pack');
    try {
      fs.symlinkSync(outside, link, 'junction');
    } catch (error) {
      t.skip(`junctions unavailable: ${error.code || error.message}`);
      return;
    }

    const plan = await buildPlan({
      source,
      list: 'Sakyvo',
      workdir: path.join(root, 'work'),
      execute: false,
      skipBlockers: false,
      onlyRepoNum: null,
      duplicateResolutions: null,
      ...writeCatalog(root),
    });

    assert.equal(plan.uploadEntries.length, 0);
    assert.equal(plan.illegalEntries.length, 0);
    assert.equal(plan.blockers.length, 1);
    assert.equal(plan.blockers[0].action, 'blocked_archive_limits');
    assert.equal(fs.existsSync(path.join(outside, 'secret.txt')), true);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('distinguishes entry, total expansion, and nested link safety causes', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-plot-limit-causes-'));
  try {
    const entryZip = new AdmZip();
    entryZip.addFile('pack.mcmeta', Buffer.from('{}'));
    entryZip.addFile('assets/minecraft/a.bin', Buffer.from('123456'));
    const entryPath = path.join(root, 'entry.zip');
    entryZip.writeZip(entryPath);

    const totalZip = new AdmZip();
    totalZip.addFile('pack.mcmeta', Buffer.from('{}'));
    totalZip.addFile('assets/minecraft/a.bin', Buffer.from('1234'));
    totalZip.addFile('assets/minecraft/b.bin', Buffer.from('5678'));
    const totalPath = path.join(root, 'total.zip');
    totalZip.writeZip(totalPath);

    const linkedInner = new AdmZip();
    linkedInner.addFile('pack.mcmeta', Buffer.from('{}'));
    linkedInner.addFile('assets/link', Buffer.from('target'));
    linkedInner.getEntry('assets/link').attr = (0xa1ff << 16) >>> 0;
    const linkedOuter = new AdmZip();
    linkedOuter.addFile('Inner.zip', linkedInner.toBuffer());
    const linkedPath = path.join(root, 'linked.zip');
    linkedOuter.writeZip(linkedPath);

    const entry = await normalizePack(entryPath, {
      outputDir: path.join(root, 'entry-out'),
      limits: { maxEntries: 10, maxEntryBytes: 5, maxTotalBytes: 100 },
    });
    const total = await normalizePack(totalPath, {
      outputDir: path.join(root, 'total-out'),
      limits: { maxEntries: 10, maxEntryBytes: 10, maxTotalBytes: 8 },
    });
    const linked = await normalizePack(linkedPath, {
      outputDir: path.join(root, 'linked-out'),
    });

    assert.deepEqual([entry.classification, entry.causes[0]], ['blocked', 'entry_too_large']);
    assert.deepEqual([total.classification, total.causes[0]], ['blocked', 'archive_expands_too_large']);
    assert.deepEqual([linked.classification, linked.causes[0]], ['blocked', 'link_entry']);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('applies the file-size gate after bloat cleanup without marking oversize as illegal', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-plot-size-gate-'));
  try {
    const source = path.join(root, 'source');
    fs.mkdirSync(source);
    const texture = await png({ r: 30, g: 60, b: 90, alpha: 1 });

    const slimmed = new AdmZip();
    slimmed.addFile('pack.mcmeta', Buffer.from('{"pack":{"pack_format":1,"description":"slimmed"}}'));
    slimmed.addFile('assets/minecraft/textures/blocks/stone.png', texture);
    slimmed.addFile('credits.txt', crypto.randomBytes(10_000));
    slimmed.writeZip(path.join(source, 'Slimmed.zip'));

    const oversize = new AdmZip();
    oversize.addFile('pack.mcmeta', Buffer.from('{"pack":{"pack_format":1,"description":"oversize"}}'));
    oversize.addFile('assets/minecraft/textures/blocks/stone.png', texture);
    oversize.addFile('assets/minecraft/sounds/large.ogg', crypto.randomBytes(10_000));
    oversize.writeZip(path.join(source, 'Oversize.zip'));

    const plan = await buildPlan(options(root, source, { githubFileLimit: 2_000 }));

    assert.deepEqual(plan.uploadEntries.map(row => row.file), ['Slimmed.zip']);
    assert.equal(plan.blockers.length, 1);
    assert.equal(plan.blockers[0].file, 'Oversize.zip');
    assert.equal(plan.blockers[0].action, 'blocked_oversize');
    assert.equal(plan.illegalEntries.length, 0);
    assert.ok(plan.uploadEntries[0].size < 2_000);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('keeps full markers sticky and routes new work past repositories over the soft threshold', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-plot-repo-allocation-'));
  try {
    const source = path.join(root, 'source');
    fs.mkdirSync(source);
    const incoming = new AdmZip();
    incoming.addFile('pack.mcmeta', Buffer.from('{"pack":{"pack_format":1,"description":"incoming"}}'));
    incoming.addFile(
      'assets/minecraft/textures/blocks/stone.png',
      await png({ r: 80, g: 120, b: 160, alpha: 1 })
    );
    incoming.writeZip(path.join(source, 'Incoming.zip'));

    const paths = writeCatalog(root);
    const registry = {
      'Old One.zip': { repo: 'packs-001', repoNum: 1, size: 100 },
      'Old Two.zip': { repo: 'packs-002', repoNum: 2, size: 3_000 },
    };
    fs.writeFileSync(paths.registryPath, JSON.stringify(registry));
    fs.writeFileSync(paths.contentIndex, JSON.stringify({
      schemaVersion: 1,
      fingerprintSchemaVersion: 1,
      registryDigest: computeRegistryDigest(registry),
      complete: true,
      failures: [],
      packs: Object.fromEntries(Object.entries(registry).map(([file, entry], index) => [file, {
        packId: `Old_${index + 1}`,
        repo: entry.repo,
        repoNum: entry.repoNum,
        size: entry.size,
        sourceKey: sourceKey(file, entry),
        archiveSha256: `archive-${index}`,
        visualContentHash: `visual-${index}`,
        visualEntryCount: 1,
        swords: {},
      }])),
    }));
    const repoState = path.join(root, 'repo-state.json');
    fs.writeFileSync(repoState, JSON.stringify({ schemaVersion: 1, fullRepoNums: [1] }));

    const plan = await buildPlan({
      source,
      list: 'Sakyvo',
      workdir: path.join(root, 'work'),
      repoState,
      maxRepoSize: 2_000,
      execute: false,
      skipBlockers: false,
      onlyRepoNum: null,
      duplicateResolutions: null,
      ...paths,
    });

    assert.equal(plan.uploadEntries[0].repo, 'packs-003');
    assert.deepEqual(plan.summary.fullRepoNums, [1, 2]);
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.registryPath, 'utf8')), registry);
    assert.equal(plan.illegalEntries.length, 0);

    const published = [];
    await runIngestion({
      source,
      list: 'Sakyvo',
      workdir: path.join(root, 'execute-work'),
      repoState,
      maxRepoSize: 2_000,
      execute: true,
      skipBlockers: false,
      onlyRepoNum: null,
      duplicateResolutions: null,
      ...paths,
    }, {
      remote: {
        publishBatch(batch) {
          published.push({ repo: batch.repo, files: batch.files.map(file => file.file), markFull: batch.markFull });
        },
        verifyArchive() {},
      },
    });
    assert.deepEqual(published, [
      { repo: 'packs-001', files: [], markFull: true },
      { repo: 'packs-002', files: [], markFull: true },
      { repo: 'packs-003', files: ['Incoming.zip'], markFull: false },
    ]);
    assert.deepEqual(JSON.parse(fs.readFileSync(repoState, 'utf8')).fullRepoNums, [1, 2]);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('splits a collection into deterministic independent products and keeps the outer source as provenance', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-collection-products-'));
  try {
    const source = path.join(root, 'source');
    fs.mkdirSync(source);
    const collection = new AdmZip();
    const products = [
      ['A/Same', { r: 200, g: 30, b: 30, alpha: 1 }],
      ['B/Same', { r: 30, g: 30, b: 200, alpha: 1 }],
      ['C/Unique', { r: 30, g: 180, b: 60, alpha: 1 }],
    ];
    for (const [prefix, color] of products) {
      collection.addFile(`${prefix}/pack.mcmeta`, Buffer.from('{"pack":{"pack_format":1,"description":"collection"}}'));
      collection.addFile(`${prefix}/assets/minecraft/textures/blocks/stone.png`, await png(color));
    }
    collection.writeZip(path.join(source, 'Bundle.zip'));

    const first = await buildPlan(options(root, source, { workdir: path.join(root, 'first-work') }));
    const secondRoot = path.join(root, 'second-catalog');
    fs.mkdirSync(secondRoot);
    const second = await buildPlan(options(secondRoot, source, { workdir: path.join(root, 'second-work') }));

    assert.deepEqual(first.uploadEntries.map(row => row.file), ['Same.zip', 'Same (1).zip', 'Unique.zip']);
    assert.equal(first.uploadEntries.some(row => row.file === 'Bundle.zip'), false);
    assert.ok(first.uploadEntries.every(row => row.normalization.collection === true));
    assert.ok(first.uploadEntries.every(row => row.normalization.productClassification === 'normal'));
    assert.deepEqual(
      first.uploadEntries.map(row => [row.file, row.fingerprint.archiveSha256]),
      second.uploadEntries.map(row => [row.file, row.fingerprint.archiveSha256])
    );
    assert.deepEqual(first.listPackIds, ['Same', 'Same(1)', 'Unique']);
    const audit = JSON.parse(fs.readFileSync(path.join(root, 'normalization-audit.json'), 'utf8'));
    assert.equal(audit.entries[0].sourceFile, 'Bundle.zip');
    assert.equal(audit.entries[0].products.length, 3);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('reuses exact existing content for one collection product and records provenance without replacement', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-collection-reuse-'));
  try {
    const source = path.join(root, 'source');
    fs.mkdirSync(source);
    const collectionPath = path.join(source, 'Bundle.zip');
    const collection = new AdmZip();
    const existingTexture = await png({ r: 180, g: 40, b: 60, alpha: 1 });
    const newTexture = await png({ r: 40, g: 160, b: 80, alpha: 1 });
    for (const [name, texture] of [['Existing Product', existingTexture], ['New Product', newTexture]]) {
      collection.addFile(`${name}/pack.mcmeta`, Buffer.from('{}'));
      collection.addFile(`${name}/assets/minecraft/textures/blocks/stone.png`, texture);
    }
    collection.writeZip(collectionPath);

    const normalized = await normalizePack(collectionPath, { outputDir: path.join(root, 'normalized-fixture') });
    const existingProduct = normalized.products.find(product => product.name === 'Existing Product');
    const existingFingerprint = await fingerprintPack(existingProduct.path);
    const paths = writeCatalog(root);
    const registry = { 'Existing.zip': { repo: 'packs-001', repoNum: 1, size: 10 } };
    fs.writeFileSync(paths.registryPath, JSON.stringify(registry));
    fs.writeFileSync(paths.siteIndexPath, JSON.stringify({ items: [{ name: 'Existing' }] }));
    fs.writeFileSync(paths.contentIndex, JSON.stringify({
      schemaVersion: 1,
      fingerprintSchemaVersion: 1,
      registryDigest: computeRegistryDigest(registry),
      complete: true,
      failures: [],
      packs: {
        'Existing.zip': {
          packId: 'Existing',
          repo: 'packs-001',
          repoNum: 1,
          size: 10,
          sourceKey: sourceKey('Existing.zip', registry['Existing.zip']),
          archiveSha256: 'existing-archive',
          visualContentHash: existingFingerprint.visualContentHash,
          visualEntryCount: existingFingerprint.visualEntryCount,
          swords: existingFingerprint.swords,
        },
      },
    }));

    const plan = await buildPlan({
      source,
      list: 'Sakyvo',
      workdir: path.join(root, 'work'),
      execute: false,
      skipBlockers: false,
      onlyRepoNum: null,
      duplicateResolutions: null,
      ...paths,
    });

    assert.equal(plan.blockers.length, 0);
    assert.deepEqual(plan.uploadEntries.map(row => row.file), ['New Product.zip']);
    assert.deepEqual(plan.listPackIds, ['Existing', 'New_Product']);
    assert.equal(plan.replacements.length, 0);
    assert.equal(
      plan.entries.find(row => row.file === 'Existing Product.zip').action,
      'reuse_collection_product_exact_content'
    );
    const reused = plan.provenance.find(row => row.productFile === 'Existing Product.zip');
    assert.equal(reused.sourceFile, 'Bundle.zip');
    assert.equal(reused.retainedFile, 'Existing.zip');
    assert.equal(reused.retainedPackId, 'Existing');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('requires a hash-bound explicit name override for a different-content collection identity collision', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-collection-name-override-'));
  try {
    const source = path.join(root, 'source');
    fs.mkdirSync(source);
    const collectionPath = path.join(source, 'Bundle.zip');
    const collection = new AdmZip();
    collection.addFile('Collision/pack.mcmeta', Buffer.from('{}'));
    collection.addFile(
      'Collision/assets/minecraft/textures/blocks/stone.png',
      await png({ r: 220, g: 40, b: 40, alpha: 1 })
    );
    collection.addFile('Other/pack.mcmeta', Buffer.from('{}'));
    collection.addFile(
      'Other/assets/minecraft/textures/blocks/stone.png',
      await png({ r: 40, g: 180, b: 80, alpha: 1 })
    );
    collection.writeZip(collectionPath);

    const normalized = await normalizePack(collectionPath, { outputDir: path.join(root, 'normalized-fixture') });
    const collisionProduct = normalized.products.find(product => product.name === 'Collision');
    const paths = writeCatalog(root);
    const registry = { 'Published Collision.zip': { repo: 'packs-001', repoNum: 1, size: 10 } };
    fs.writeFileSync(paths.registryPath, JSON.stringify(registry));
    fs.writeFileSync(paths.siteIndexPath, JSON.stringify({ items: [{ name: 'Collision' }] }));
    fs.writeFileSync(paths.contentIndex, JSON.stringify({
      schemaVersion: 1,
      fingerprintSchemaVersion: 1,
      registryDigest: computeRegistryDigest(registry),
      complete: true,
      failures: [],
      packs: {
        'Published Collision.zip': {
          packId: 'Collision',
          repo: 'packs-001',
          repoNum: 1,
          size: 10,
          sourceKey: sourceKey('Published Collision.zip', registry['Published Collision.zip']),
          archiveSha256: 'published-archive',
          visualContentHash: 'published-different-content',
          visualEntryCount: 1,
          swords: {},
        },
      },
    }));
    const baseOptions = {
      source,
      list: 'Sakyvo',
      workdir: path.join(root, 'work'),
      execute: false,
      skipBlockers: false,
      onlyRepoNum: null,
      duplicateResolutions: null,
      ...paths,
    };

    const blocked = await buildPlan(baseOptions);
    assert.equal(blocked.hardBlockers[0].action, 'blocked_pack_id_content_conflict');
    assert.deepEqual(blocked.uploadEntries.map(row => row.file), ['Other.zip']);

    const decisions = path.join(root, 'decisions.json');
    fs.writeFileSync(decisions, JSON.stringify({
      schemaVersion: 1,
      registryDigest: computeRegistryDigest(registry),
      decisions: [],
      nameOverrides: [{
        sourceArchiveSha256: normalized.sourceArchiveSha256,
        productArchiveSha256: collisionProduct.archiveSha256,
        file: 'Collision New.zip',
        reason: 'reviewed identity split',
      }],
    }));
    const resolved = await buildPlan({ ...baseOptions, duplicateResolutions: decisions });

    assert.equal(resolved.blockers.length, 0);
    assert.deepEqual(resolved.uploadEntries.map(row => row.file), ['Collision New.zip', 'Other.zip']);
    assert.deepEqual(resolved.listPackIds, ['Collision_New', 'Other']);
    assert.equal(resolved.appliedNameOverrides[0].from, 'Collision.zip');
    assert.equal(resolved.appliedNameOverrides[0].to, 'Collision New.zip');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('sanitizes inner collection names before deterministic collision numbering', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-collection-safe-names-'));
  try {
    const source = path.join(root, 'Bundle.zip');
    const collection = new AdmZip();
    for (const [prefix, value] of [['A/What?: Pack', 'a'], ['B/What*? Pack', 'b']]) {
      collection.addFile(`${prefix}/pack.mcmeta`, Buffer.from('{}'));
      collection.addFile(`${prefix}/assets/minecraft/a.txt`, Buffer.from(value));
    }
    collection.writeZip(source);

    const normalized = await normalizePack(source, { outputDir: path.join(root, 'out') });

    assert.deepEqual(normalized.products.map(product => path.basename(product.path)), [
      'What__ Pack.zip',
      'What__ Pack (1).zip',
    ]);
    assert.ok(normalized.products.every(product => product.classification === 'normal'));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
