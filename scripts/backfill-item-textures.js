// Backfill one item texture into every pack's local master directory, reading each
// archive over HTTP range requests so the catalog is never downloaded.
//
//   node scripts/backfill-item-textures.js [--set bow|potion-bottle] [--limit N]
//                                          [--concurrency N] [--pack <id> ...] [--dry-run]
//
// Driven by data/pack-registry.json (archive filename -> repository). Packs whose
// texture is already present are skipped, so an interrupted run resumes cheaply.

const fs = require('node:fs');
const path = require('node:path');
const { readArchiveEntries } = require('./lib/remote-archive');
const { getPackIdFromZipName } = require('./pack-utils');

const THUMB_DIR = path.join(__dirname, '..', 'thumbnails');
const REGISTRY_PATH = path.join(__dirname, '..', 'data', 'pack-registry.json');
// The catalogue's archives live in `Sakyvo/packs-NNN`. The mirror the site's download
// buttons already offer is the default because it is the only one that delivers response
// bodies from this network: measured over the same twelve archives, direct raw returned
// one usable body out of twelve while the mirror returned eleven. The mirror answers 429
// above roughly four concurrent workers, so the default concurrency stays low.
const DEFAULT_ARCHIVE_BASE = 'https://ghfast.top/https://raw.githubusercontent.com/Sakyvo';

// Minecraft 1.8 names the standing bow `bow_standby.png`; later layouts use `bow.png`.
const BOW_TEXTURES = [
  'assets/minecraft/textures/items/bow_standby.png',
  'assets/minecraft/textures/items/bow.png',
];

// One declaration per backfillable texture: archive names to try, the master filename it
// lands on, and the human label used in the run summary.
const TEXTURE_SETS = {
  bow: { label: 'Bow', archiveNames: BOW_TEXTURES, masterName: 'bow_standby.png' },
  // The cover's two drinkable slots need the bottle outline the pack actually ships; the
  // liquid mask alone leaves the silhouette vanilla.
  'potion-bottle': {
    label: 'Potion bottle',
    archiveNames: ['assets/minecraft/textures/items/potion_bottle_drinkable.png'],
    masterName: 'potion_bottle_drinkable.png',
  },
};

const DEFAULT_SET = 'bow';
// A stalled archive must free its worker quickly; the reader retries, and an archive
// that keeps timing out is reported rather than allowed to hold the crawl. This host
// flaps between fast and near-stalled, so the deadline is tunable per run: a longer one
// converts many timeouts into successes during a slow window.
const REQUEST_TIMEOUT_MS = 15_000;

function parseArgs(argv) {
  const options = { limit: 0, concurrency: 4, packs: [], dryRun: false, base: DEFAULT_ARCHIVE_BASE, set: DEFAULT_SET, timeoutMs: REQUEST_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--set') options.set = argv[++i];
    else if (arg === '--limit') options.limit = Number(argv[++i]);
    else if (arg === '--concurrency') options.concurrency = Number(argv[++i]);
    else if (arg === '--timeout') options.timeoutMs = Number(argv[++i]);
    else if (arg === '--pack') options.packs.push(argv[++i]);
    else if (arg === '--base') options.base = argv[++i];
    else if (arg === '--dry-run') options.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!TEXTURE_SETS[options.set]) throw new Error(`Unknown --set: ${options.set}`);
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('--timeout must be a positive number of milliseconds');
  return options;
}

function archiveUrl(base, repo, fileName) {
  return `${base}/${repo}/main/resourcepacks/${encodeURIComponent(fileName)}`;
}

// One pack. Never throws: a broken archive is data to report, not a reason to stop
// the run, because the catalog is 3000+ independent archives.
async function backfillPack({ archiveUrl, outputDir, dryRun = false, set = DEFAULT_SET, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const { archiveNames, masterName } = TEXTURE_SETS[set];
  if (!fs.existsSync(outputDir)) return { status: 'no-master' };
  if (archiveNames.some(name => fs.existsSync(path.join(outputDir, path.basename(name))))) {
    return { status: 'present' };
  }

  let entries;
  let missing;
  try {
    ({ entries, missing } = await readArchiveEntries(archiveUrl, archiveNames, { timeoutMs }));
  } catch (error) {
    return { status: 'unreadable', reason: error.message };
  }

  // Prefer the first declared name that exists (1.8 name before the later one).
  const chosen = archiveNames.find(name => entries.has(name));
  if (!chosen) return { status: 'absent', reason: missing.join(', ') };
  if (dryRun) return { status: 'written', name: chosen, dryRun: true };

  await fs.promises.writeFile(path.join(outputDir, masterName), entries.get(chosen));
  return { status: 'written', name: chosen };
}

async function runPool(items, concurrency, worker) {
  const results = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));

  let targets = Object.entries(registry).map(([fileName, record]) => ({
    fileName,
    packId: getPackIdFromZipName(fileName),
    repo: record.repo,
  }));
  if (options.packs.length) {
    const wanted = new Set(options.packs);
    targets = targets.filter(row => wanted.has(row.packId));
  }
  if (options.limit) targets = targets.slice(0, options.limit);

  const results = await runPool(targets, options.concurrency, async (target, index) => {
    const result = await backfillPack({
      archiveUrl: archiveUrl(options.base, target.repo, target.fileName),
      outputDir: path.join(THUMB_DIR, target.packId),
      dryRun: options.dryRun,
      set: options.set,
      timeoutMs: options.timeoutMs,
    });
    if ((index + 1) % 100 === 0) console.log(`  ${index + 1}/${targets.length}`);
    return { ...target, ...result };
  });

  const counts = results.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});

  for (const row of results) {
    if (row.status === 'unreadable') console.log(`  unreadable ${row.packId} (${row.repo}): ${row.reason}`);
  }
  console.log(`${TEXTURE_SETS[options.set].label} backfill: ${JSON.stringify(counts)}`);
  return { counts, results };
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  BOW_TEXTURES,
  TEXTURE_SETS,
  archiveUrl,
  backfillPack,
  main,
  parseArgs,
};