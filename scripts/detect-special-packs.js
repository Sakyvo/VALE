const fs = require('fs');
const path = require('path');
const { buildReferenceSet, detectOverlays } = require('./detect-overlay');
const { SCHEMA_VERSION: FINGERPRINT_SCHEMA_VERSION } = require('./lib/pack-content-fingerprint');
const { readJson, validateContentIndex, writeJsonAtomic } = require('./lib/pack-content-index');

const ROOT = path.join(__dirname, '..');
const CONQUEST_DESCRIPTION = 'Packs with matching stone, iron, or diamond sword textures. Excluded from Search by Image because the held sword tier cannot be inferred reliably.';
const OVERLAY_DESCRIPTION = 'Overlay packs for selective visual changes. Excluded from Search by Image because they are not uniquely identifiable as full packs.';

function parseArgs(argv) {
  const args = {
    dryRun: false,
    skipOverlay: false,
    registryPath: path.join(ROOT, 'data', 'pack-registry.json'),
    contentIndexPath: path.join(ROOT, 'data', 'internal', 'pack-content-index.json'),
    siteIndexPath: path.join(ROOT, 'data', 'index.json'),
    overridesPath: path.join(ROOT, 'data', 'internal', 'special-pack-overrides.json'),
    listsPath: path.join(ROOT, 'l', 'lists.json'),
    reportPath: path.join(ROOT, 'data', 'internal', 'special-pack-detection.json'),
  };
  const pathOptions = {
    '--registry': 'registryPath',
    '--content-index': 'contentIndexPath',
    '--site-index': 'siteIndexPath',
    '--overrides': 'overridesPath',
    '--lists': 'listsPath',
    '--report': 'reportPath',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (pathOptions[arg]) args[pathOptions[arg]] = path.resolve(argv[++i]);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--skip-overlay') args.skipOverlay = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function validateOverrides(value) {
  if (!value || value.schemaVersion !== 1 || !value.conquest) throw new Error('Special-pack overrides require schemaVersion=1 and conquest');
  const forceInclude = value.conquest.forceInclude || {};
  const forceExclude = value.conquest.forceExclude || {};
  for (const [kind, rows] of [['forceInclude', forceInclude], ['forceExclude', forceExclude]]) {
    if (!rows || Array.isArray(rows) || typeof rows !== 'object') throw new Error(`conquest.${kind} must be an object`);
    for (const [packId, reason] of Object.entries(rows)) {
      if (!packId || typeof reason !== 'string' || !reason.trim()) throw new Error(`conquest.${kind}.${packId || '(empty)'} requires a reason`);
    }
  }
  const overlap = Object.keys(forceInclude).filter(packId => Object.prototype.hasOwnProperty.call(forceExclude, packId));
  if (overlap.length) throw new Error(`Conquest overrides conflict for: ${overlap.join(', ')}`);
  return { forceInclude, forceExclude };
}

function matchingSwordPairs(swords) {
  if (!swords || !swords.stone || !swords.iron || !swords.diamond) return [];
  const pairs = [];
  if (swords.stone === swords.iron) pairs.push('stone=iron');
  if (swords.stone === swords.diamond) pairs.push('stone=diamond');
  if (swords.iron === swords.diamond) pairs.push('iron=diamond');
  return pairs;
}

function detectConquest(contentIndex, overrides, publicPackIds) {
  const records = [];
  const conquestIds = new Set();
  const knownPackIds = new Set();
  for (const [file, entry] of Object.entries(contentIndex.packs || {}).sort((a, b) => a[0].localeCompare(b[0]))) {
    const packId = entry.packId;
    if (!packId) continue;
    knownPackIds.add(packId);
    const pairs = matchingSwordPairs(entry.swords);
    let included = pairs.length > 0;
    let reason = pairs.length ? `exact:${pairs.join(',')}` : 'no_exact_sword_pair';
    if (Object.prototype.hasOwnProperty.call(overrides.forceExclude, packId)) {
      included = false;
      reason = `forceExclude:${overrides.forceExclude[packId]}`;
    } else if (Object.prototype.hasOwnProperty.call(overrides.forceInclude, packId)) {
      included = true;
      reason = `forceInclude:${overrides.forceInclude[packId]}`;
    }
    const isPublic = publicPackIds.has(packId);
    if (included && isPublic) conquestIds.add(packId);
    records.push({ file, packId, public: isPublic, included, pairs, reason });
  }
  const unknownOverrides = [
    ...Object.keys(overrides.forceInclude),
    ...Object.keys(overrides.forceExclude),
  ].filter(packId => !knownPackIds.has(packId));
  if (unknownOverrides.length) throw new Error(`Conquest override references unknown pack id(s): ${[...new Set(unknownOverrides)].join(', ')}`);
  return {
    packs: [...conquestIds].sort((a, b) => a.localeCompare(b)),
    records,
  };
}

function updateManagedLists(lists, conquestPacks, overlayPacks) {
  const managed = [
    { name: 'Conquest', packs: conquestPacks, description: CONQUEST_DESCRIPTION },
    { name: 'Overlay', packs: overlayPacks, description: OVERLAY_DESCRIPTION },
  ];
  for (const item of managed) {
    let list = lists.find(row => row.name === item.name);
    if (!list) {
      list = { name: item.name, cover: '', description: item.description, packs: [] };
      lists.push(list);
    }
    list.description = item.description;
    list.packs = [...new Set(item.packs)].sort((a, b) => a.localeCompare(b));
  }
  return lists;
}

function ensureListPage(listsPath, name) {
  const listRoot = path.dirname(listsPath);
  const target = path.join(listRoot, name, 'index.html');
  if (fs.existsSync(target)) return;
  const template = path.join(listRoot, 'test', 'index.html');
  if (!fs.existsSync(template)) throw new Error(`List template not found: ${template}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(template, target);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const registry = readJson(args.registryPath, {});
  const contentIndex = validateContentIndex(readJson(args.contentIndexPath, null), registry, FINGERPRINT_SCHEMA_VERSION);
  const overrides = validateOverrides(readJson(args.overridesPath, null));
  const siteIndex = readJson(args.siteIndexPath, { items: [] });
  const publicPackIds = new Set((siteIndex.items || []).map(row => row.name));
  const conquest = detectConquest(contentIndex, overrides, publicPackIds);
  const lists = readJson(args.listsPath, []);

  let overlayPacks;
  if (args.skipOverlay) {
    const current = lists.find(row => row.name === 'Overlay');
    overlayPacks = current ? current.packs : [];
  } else {
    const references = await buildReferenceSet();
    overlayPacks = await detectOverlays(references);
  }
  overlayPacks = overlayPacks.filter(packId => publicPackIds.has(packId)).sort((a, b) => a.localeCompare(b));

  const report = {
    schemaVersion: 1,
    generatedAt: contentIndex.generatedAt,
    contentIndexDigest: contentIndex.registryDigest,
    conquest: {
      publicPackCount: conquest.packs.length,
      packs: conquest.packs,
      records: conquest.records,
    },
    overlay: {
      publicPackCount: overlayPacks.length,
      packs: overlayPacks,
    },
  };
  console.log(JSON.stringify({ conquest: conquest.packs.length, overlay: overlayPacks.length }, null, 2));
  if (args.dryRun) return report;

  updateManagedLists(lists, conquest.packs, overlayPacks);
  writeJsonAtomic(args.listsPath, lists);
  writeJsonAtomic(args.reportPath, report);
  ensureListPage(args.listsPath, 'Conquest');
  ensureListPage(args.listsPath, 'Overlay');
  return report;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  CONQUEST_DESCRIPTION,
  OVERLAY_DESCRIPTION,
  detectConquest,
  main,
  matchingSwordPairs,
  updateManagedLists,
  validateOverrides,
};
