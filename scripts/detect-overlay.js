const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const THUMB_DIR = path.join(ROOT, 'thumbnails');
const LISTS_PATH = path.join(ROOT, 'l', 'lists.json');
const DEFAULT_TEXTURE_DIR = path.join(ROOT, 'Default_Texture');
const OVERLAY_LIST_NAME = 'overlay';

const SEED_PACKS = [
  'Cases_Block_Overlaywhite_fire',
  'Idiol_Snow_v4',
  'LightMap_Clear_Walls',
  'no_color_purple_sky_and_glint_overlay',
  'no_color_red_sky_and_glint_overlay',
  'sky_glint_overlay',
];

const CORE_TEXTURES = [
  { file: 'diamond_sword.png', defaultPath: 'assets/minecraft/textures/items/diamond_sword.png' },
  { file: 'ender_pearl.png', defaultPath: 'assets/minecraft/textures/items/ender_pearl.png' },
  { file: 'splash_potion_of_healing.png', defaultPath: null },
  { file: 'iron_sword.png', defaultPath: 'assets/minecraft/textures/items/iron_sword.png' },
  { file: 'fishing_rod_uncast.png', defaultPath: 'assets/minecraft/textures/items/fishing_rod_uncast.png' },
  { file: 'apple_golden.png', defaultPath: 'assets/minecraft/textures/items/apple_golden.png' },
  { file: 'steak.png', defaultPath: 'assets/minecraft/textures/items/beef_cooked.png' },
  { file: 'golden_carrot.png', defaultPath: 'assets/minecraft/textures/items/carrot_golden.png' },
  { file: 'widgets.png', defaultPath: 'assets/minecraft/textures/gui/widgets.png' },
  { file: 'icons.png', defaultPath: 'assets/minecraft/textures/gui/icons.png' },
  { file: 'particles.png', defaultPath: 'assets/minecraft/textures/particle/particles.png' },
];

async function pixelHash(filePath) {
  const { data } = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function buildReferenceSet() {
  const refSet = {};
  for (const tex of CORE_TEXTURES) refSet[tex.file] = new Set();

  for (const tex of CORE_TEXTURES) {
    if (!tex.defaultPath) continue;
    const full = path.join(DEFAULT_TEXTURE_DIR, tex.defaultPath);
    if (fs.existsSync(full)) refSet[tex.file].add(await pixelHash(full));
  }

  for (const seed of SEED_PACKS) {
    const seedDir = path.join(THUMB_DIR, seed);
    if (!fs.existsSync(seedDir)) {
      console.warn(`  seed missing: ${seed}`);
      continue;
    }
    for (const tex of CORE_TEXTURES) {
      const p = path.join(seedDir, tex.file);
      if (fs.existsSync(p)) refSet[tex.file].add(await pixelHash(p));
    }
  }
  return refSet;
}

async function detectOverlays(refSet) {
  const dirs = fs.readdirSync(THUMB_DIR).filter(d =>
    fs.statSync(path.join(THUMB_DIR, d)).isDirectory()
  );
  const overlays = [];
  for (const dir of dirs) {
    const packDir = path.join(THUMB_DIR, dir);
    let match = 0;
    let total = 0;
    for (const tex of CORE_TEXTURES) {
      const p = path.join(packDir, tex.file);
      if (!fs.existsSync(p)) continue;
      total++;
      const h = await pixelHash(p);
      if (refSet[tex.file].has(h)) match++;
    }
    if (total === CORE_TEXTURES.length && match === total) overlays.push(dir);
  }
  return overlays;
}

function bumpSbiVersion() {
  const generatePath = path.join(ROOT, 'scripts', 'generate-sbi-data.js');
  const sbiJsPath = path.join(ROOT, 'assets', 'js', 'sbi.js');
  const indexHtmlPath = path.join(ROOT, 'sbi', 'index.html');

  const versionRe = /const\s+SBI_FINGERPRINT_VERSION\s*=\s*(\d+)/;

  const genSrc = fs.readFileSync(generatePath, 'utf-8');
  const m = genSrc.match(versionRe);
  if (!m) throw new Error('SBI_FINGERPRINT_VERSION not found in generate-sbi-data.js');
  const oldVer = parseInt(m[1], 10);
  const newVer = oldVer + 1;

  fs.writeFileSync(generatePath, genSrc.replace(versionRe, `const SBI_FINGERPRINT_VERSION = ${newVer}`));
  const sbiJs = fs.readFileSync(sbiJsPath, 'utf-8');
  fs.writeFileSync(sbiJsPath, sbiJs.replace(versionRe, `const SBI_FINGERPRINT_VERSION = ${newVer}`));

  let html = fs.readFileSync(indexHtmlPath, 'utf-8');
  html = html.replace(/(sbi\.js\?v=)(\d+)/, (_, p1, n) => `${p1}${parseInt(n, 10) + 1}`);
  fs.writeFileSync(indexHtmlPath, html);

  console.log(`  SBI_FINGERPRINT_VERSION ${oldVer} -> ${newVer}`);
}

function updateListsJson(overlays) {
  const lists = JSON.parse(fs.readFileSync(LISTS_PATH, 'utf-8'));
  let entry = lists.find(l => l.name === OVERLAY_LIST_NAME);
  const sorted = [...overlays].sort();
  if (!entry) {
    entry = { name: OVERLAY_LIST_NAME, cover: '', description: 'Default-equivalent overlays (auto-detected)', packs: sorted };
    lists.push(entry);
  } else {
    entry.packs = sorted;
  }
  fs.writeFileSync(LISTS_PATH, JSON.stringify(lists, null, 2));
}

function runStep(label, cmd) {
  console.log(`\n[${label}] ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
}

async function main() {
  console.log('Building reference set...');
  const refSet = await buildReferenceSet();
  for (const [f, s] of Object.entries(refSet)) console.log(`  ${f}: ${s.size} sources`);

  console.log('\nScanning thumbnails...');
  const overlays = await detectOverlays(refSet);
  console.log(`\nDetected ${overlays.length} overlay pack(s):`);
  overlays.forEach(o => console.log(`  - ${o}`));

  if (process.argv.includes('--dry-run')) {
    console.log('\nDry-run: skipping writes.');
    return;
  }

  console.log('\nUpdating l/lists.json...');
  updateListsJson(overlays);

  runStep('index', 'node scripts/generate-index.js');
  console.log('\nBumping SBI version...');
  bumpSbiVersion();
  runStep('sbi:data', 'node scripts/generate-sbi-data.js');

  console.log('\nDone. Remember to run: python test_sbi.py');
}

main().catch(e => { console.error(e); process.exit(1); });
