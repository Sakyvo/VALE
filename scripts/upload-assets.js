// Upload one pack's display assets to the asset remote (R2).
//
//   node scripts/upload-assets.js <packId> [--dry-run]
//
// Masters are read from thumbnails/<packId>/; each PNG goes through the
// downsample rules (scripts/lib/display-assets.js) with nearest-neighbor
// power-of-two scaling, then through the asset remote (scripts/lib/
// asset-remote.js), which skips objects whose content already matches.
// .mcmeta sidecars are uploaded verbatim (the browser fetches them as
// <texture>.mcmeta for animation timing).
//
// After every object verifies, the pack is registered in
// data/asset-base.json so the next generate-index run stamps the remote
// base into its generated records. Rerun generate-index.js and build.js
// to publish.
//
// Credentials come from the environment:
//   R2_ACCOUNT_ID (or R2_ENDPOINT), R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { createAssetRemote } = require('./lib/asset-remote');
const { planDisplayAsset } = require('./lib/display-assets');

const CONFIG_PATH = path.join('data', 'asset-base.json');

function fail(message) {
  console.error(`upload-assets: ${message}`);
  process.exit(1);
}

async function main() {
  const packId = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  if (!packId) fail('usage: node scripts/upload-assets.js <packId> [--dry-run]');

  const sourceDir = path.join('thumbnails', packId);
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    fail(`local thumbnail master directory is missing: ${sourceDir}`);
  }

  const config = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) : {};
  const publicBaseUrl = config.remote && config.remote.base;
  if (!publicBaseUrl) fail(`${CONFIG_PATH} has no remote.base`);

  const files = fs.readdirSync(sourceDir).filter(f => fs.statSync(path.join(sourceDir, f)).isFile());
  if (!files.length) fail(`no assets in ${sourceDir}`);

  let remote = null;
  if (!dryRun) {
    const endpoint = process.env.R2_ENDPOINT ||
      (process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : '');
    const accessKeyId = process.env.R2_ACCESS_KEY_ID || '';
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || '';
    const bucket = process.env.R2_BUCKET || '';
    if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
      fail('missing R2 credentials: set R2_ACCOUNT_ID (or R2_ENDPOINT), R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET');
    }
    remote = createAssetRemote({ endpoint, bucket, accessKeyId, secretAccessKey, publicBaseUrl });
  }

  const plans = [];
  for (const file of files) {
    const filePath = path.join(sourceDir, file);
    const source = fs.readFileSync(filePath);
    let body = source;
    let note = 'verbatim';
    if (file.toLowerCase().endsWith('.png')) {
      const meta = await sharp(source).metadata();
      const plan = planDisplayAsset(file, meta.width, meta.height);
      if (plan.action === 'resize') {
        body = await sharp(source)
          .resize(plan.width, plan.height, { kernel: 'nearest' })
          .png()
          .toBuffer();
        note = `${meta.width}x${meta.height} -> ${plan.width}x${plan.height} (nearest, x${plan.factor})`;
      } else {
        note = `keep ${meta.width}x${meta.height}`;
      }
    }
    plans.push({ file, body, note });
  }

  let uploaded = 0;
  let skipped = 0;
  for (const { file, body, note } of plans) {
    const contentType = file.toLowerCase().endsWith('.png')
      ? 'image/png'
      : (file.toLowerCase().endsWith('.mcmeta') ? 'application/json' : 'application/octet-stream');
    if (dryRun) {
      console.log(`[dry-run] ${file}: ${note} (${body.length} bytes)`);
      continue;
    }
    const result = await remote.uploadAsset({ pack: packId, file, body, contentType });
    if (result.skipped) skipped++; else uploaded++;
    console.log(`${result.skipped ? 'skip' : 'put '} ${file}: ${note} -> ${result.url}`);
  }

  if (dryRun) {
    console.log(`[dry-run] ${plans.length} assets planned for ${packId}; no uploads, config untouched.`);
    return;
  }

  const next = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) : {};
  next.remote = next.remote && typeof next.remote === 'object' ? next.remote : {};
  next.remote.base = next.remote.base || publicBaseUrl;
  next.remote.packs = Array.isArray(next.remote.packs) ? next.remote.packs : [];
  if (!next.remote.packs.includes(packId)) {
    next.remote.packs.push(packId);
    next.remote.packs.sort();
  }
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`done: ${uploaded} uploaded, ${skipped} already current; ${packId} registered in ${CONFIG_PATH}.`);
  console.log('next: node scripts/generate-index.js && node scripts/build.js');
}

main().catch(error => fail(error.message));
