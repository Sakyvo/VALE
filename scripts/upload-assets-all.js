// Batch-upload every local pack's display assets to the asset remote (R2).
//
//   node scripts/upload-assets-all.js [--limit N] [--concurrency N] [--pack id ...]
//
// Issue 013 driver: iterates thumbnails/<packId>/ (the local masters),
// runs the same per-file downsample+upload logic as upload-assets.js,
// and registers each verified pack into data/asset-base.json as it
// completes — so an interrupted run resumes with only missing packs.
//
// Credentials come from the environment (same as upload-assets.js):
//   R2_ACCOUNT_ID (or R2_ENDPOINT), R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { createAssetRemote } = require('./lib/asset-remote');
const { planDisplayAsset } = require('./lib/display-assets');
const { VALE_COVER_FILE } = require('../assets/js/asset-base');
const { generateCoverFromOutputDir } = require('./thumbnail-preview-utils');
const crypto = require('node:crypto');

const CONFIG_PATH = path.join('data', 'asset-base.json');
const MASTERS_DIR = path.join('thumbnails');

function fail(message) {
  console.error(`upload-assets-all: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { limit: 0, concurrency: 4, packs: [], coversOnly: false, verifyOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--covers-only') out.coversOnly = true;
    else if (arg === '--verify-only') { out.coversOnly = true; out.verifyOnly = true; }
    else if (arg === '--limit') out.limit = Number(argv[++i]);
    else if (arg === '--concurrency') out.concurrency = Number(argv[++i]);
    else if (arg === '--pack') out.packs.push(argv[++i]);
    else fail(`unknown argument: ${arg}`);
  }
  return out;
}

function loadConfig() {
  return fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) : {};
}

function saveRegisteredPack(config, packId) {
  config.remote = config.remote && typeof config.remote === 'object' ? config.remote : {};
  config.remote.base = config.remote.base || '';
  config.remote.packs = Array.isArray(config.remote.packs) ? config.remote.packs : [];
  if (!config.remote.packs.includes(packId)) {
    config.remote.packs.push(packId);
    config.remote.packs.sort();
  }
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

async function uploadPack(remote, packId, publicBaseUrl, config) {
  const sourceDir = path.join(MASTERS_DIR, packId);
  const files = fs.readdirSync(sourceDir).filter(f => fs.statSync(path.join(sourceDir, f)).isFile());
  if (!files.length) return { packId, uploaded: 0, skipped: 0, error: 'no assets' };

  let uploaded = 0;
  let skipped = 0;
  for (const file of files) {
    const source = fs.readFileSync(path.join(sourceDir, file));
    let body = source;
    if (file.toLowerCase().endsWith('.png')) {
      const meta = await sharp(source).metadata();
      const plan = planDisplayAsset(file, meta.width, meta.height);
      if (plan.action === 'resize') {
        body = await sharp(source)
          .resize(plan.width, plan.height, { kernel: 'nearest' })
          .png()
          .toBuffer();
      }
    }
    const contentType = file.toLowerCase().endsWith('.png')
      ? 'image/png'
      : (file.toLowerCase().endsWith('.mcmeta') ? 'application/json' : 'application/octet-stream');
    const result = await remote.uploadAsset({ pack: packId, file, body, contentType });
    if (result.skipped) skipped++; else uploaded++;
  }
  saveRegisteredPack(config, packId);
  return { packId, uploaded, skipped };
}

function selectCoverTargets(items, requested) {
  const ids = items.map(item => item.name);
  for (const id of requested) if (!ids.includes(id)) throw new Error(`Unknown public pack: ${id}`);
  return requested.length ? ids.filter(id => requested.includes(id)) : ids;
}

async function uploadCover(remote, packId, verifyOnly = false, mastersDir = MASTERS_DIR) {
  const sourceDir = path.join(mastersDir, packId);
  const file = path.join(sourceDir, VALE_COVER_FILE);
  // Keep the returned buffer: Windows case aliases share a directory, but R2 keys
  // are case-sensitive and must each be published under their exact catalog ID.
  fs.mkdirSync(sourceDir, { recursive: true });
  const body = verifyOnly ? fs.readFileSync(file)
    : await generateCoverFromOutputDir(sourceDir, VALE_COVER_FILE);
  const meta = await sharp(body).metadata();
  if (meta.width !== 728 || meta.height !== 196) throw new Error(`Invalid HUD geometry: ${packId}`);
  const expected = crypto.createHash('md5').update(body).digest('hex');
  const result = verifyOnly ? { skipped: true } : await remote.uploadAsset({ pack: packId, file: VALE_COVER_FILE, body });
  const actual = await remote.headAsset(packId, VALE_COVER_FILE);
  if (!actual || actual.etag !== expected || actual.size !== body.length) throw new Error(`Cover verification failed: ${packId}`);
  return { packId, uploaded: result.skipped ? 0 : 1, skipped: result.skipped ? 1 : 0 };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const publicBaseUrl = config.remote && config.remote.base;
  if (!publicBaseUrl) fail(`${CONFIG_PATH} has no remote.base`);

  const endpoint = process.env.R2_ENDPOINT ||
    (process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : '');
  const accessKeyId = process.env.R2_ACCESS_KEY_ID || '';
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || '';
  const bucket = process.env.R2_BUCKET || '';
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    fail('missing R2 credentials: set R2_ACCOUNT_ID (or R2_ENDPOINT), R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET');
  }
  const remote = createAssetRemote({ endpoint, bucket, accessKeyId, secretAccessKey, publicBaseUrl,
    fetchImpl: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }),
  });

  const registered = new Set(config.remote.packs || []);
  let packIds = opts.packs.length
    ? opts.packs
    : fs.readdirSync(MASTERS_DIR).filter(d => fs.statSync(path.join(MASTERS_DIR, d)).isDirectory());
  const pending = opts.coversOnly
    ? selectCoverTargets(JSON.parse(fs.readFileSync('data/index.json', 'utf8')).items, opts.packs)
    : packIds.filter(id => !registered.has(id));
  const targets = opts.limit > 0 ? pending.slice(0, opts.limit) : pending;

  console.log(`packs: ${packIds.length} local, ${registered.size} registered, ${pending.length} pending, ${targets.length} targeted`);

  let done = 0;
  let failed = 0;
  const failures = [];
  const queue = [...targets];
  const worker = async () => {
    while (queue.length) {
      const packId = queue.shift();
      try {
        const r = opts.coversOnly
          ? await uploadCover(remote, packId, opts.verifyOnly)
          : await uploadPack(remote, packId, publicBaseUrl, config);
        done++;
        if (r.error) { failed++; failures.push(r); }
        console.log(`[${done}/${targets.length}] ${packId}: ${r.uploaded} uploaded, ${r.skipped} skipped`);
      } catch (error) {
        failed++;
        failures.push({ packId, error: error.message });
        console.error(`[${done}/${targets.length}] ${packId}: FAILED ${error.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));

  console.log(`\nfinished: ${done} packs processed, ${failed} failed`);
  if (failures.length) {
    console.log('failures:');
    for (const f of failures) console.log(`  ${f.packId}: ${f.error}`);
    process.exitCode = 1;
  }
  if (!opts.coversOnly) console.log('next: node scripts/generate-index.js && node scripts/build.js');
}

if (require.main === module) main().catch(error => fail(error.message));
module.exports = { selectCoverTargets, uploadCover, parseArgs };
