#!/usr/bin/env node
/**
 * Generate synthetic SBI evaluation corpus.
 *
 * Uses each pack's own textures to render hotbar/HUD screenshots, then applies
 * deterministic degradations (JPEG re-encode, scale, brightness/contrast) so the
 * measurement approximates real screenshots while remaining reproducible.
 *
 * Usage:
 *   node scripts/generate-synthetic-corpus.js [--output <dir>] [--seed 42] [--tiers light,heavy]
 *
 * Output:
 *   test_img/synthetic/manifest.json   - per-image truth map (packId/groupId/tier/seed/perturbation)
 *   test_img/synthetic/<tier>/...png  - synthetic screenshots (gitignored by default; use --commit to stage)
 *
 * The generator reads groups from data/sbi-fp/meta.json and thumb textures from thumbnails/.
 */

const path = require('path');
const fs = require('fs');
const { buildSyntheticCorpus, DEFAULT_SEED, PERTURBATION_TIERS } = require('./lib/synthetic-corpus');

const ROOT = path.resolve(__dirname, '..');
const META_PATH = path.join(ROOT, 'data', 'sbi-fp', 'meta.json');
const EXTRACTED_PATH = path.join(ROOT, 'data', 'extracted.json');
const DEFAULT_OUT = path.join(ROOT, 'test_img', 'synthetic');
const DEFAULT_THUMBS = path.join(ROOT, 'thumbnails');

function parseArgs(argv) {
  const out = { seed: DEFAULT_SEED, out: DEFAULT_OUT, tiers: ['light', 'heavy'], thumbs: DEFAULT_THUMBS, groupsLimit: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--output') out.out = path.resolve(argv[++i]);
    else if (a.startsWith('--output=')) out.out = path.resolve(a.slice('--output='.length));
    else if (a === '--seed') out.seed = Number(argv[++i] || DEFAULT_SEED);
    else if (a.startsWith('--seed=')) out.seed = Number(a.slice('--seed='.length));
    else if (a === '--tiers') out.tiers = argv[++i].split(',').map(s => s.trim());
    else if (a.startsWith('--tiers=')) out.tiers = a.slice('--tiers='.length).split(',').map(s => s.trim());
    else if (a === '--thumbnails') out.thumbs = path.resolve(argv[++i]);
    else if (a.startsWith('--groups-limit')) {
      const v = a.includes('=') ? Number(a.slice('--groups-limit='.length)) : Number(argv[++i] || 0);
      out.groupsLimit = v || 0;
    }
    else if (a === '--commit') out.commit = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
  const extracted = JSON.parse(fs.readFileSync(EXTRACTED_PATH, 'utf8'));
  let groups = meta.groups;
  if (opts.groupsLimit > 0) {
    const entries = Object.entries(groups).slice(0, opts.groupsLimit);
    groups = Object.fromEntries(entries);
  }

  console.log(`Synthetic corpus generator`);
  console.log(`  SBI packs: ${meta.packCount} in ${meta.groupCount} groups`);
  console.log(`  Extracted records: ${extracted.length}`);
  console.log(`  Output: ${opts.out}`);
  console.log(`  Seed: ${opts.seed}  Tiers: ${opts.tiers.join(', ')}\n`);

  result = await buildSyntheticCorpus({
    corpusDir: opts.out,
    seed: opts.seed,
    groups,
    extracted,
    thumbsRoot: opts.thumbs,
    tiers: opts.tiers,
    samplesPerGroup: 2,
  });

  const manifestPath = path.join(opts.out, 'manifest.json');
  console.log(`\nWrote ${result.manifest.images.length} synthetic images to ${opts.out}`);
  console.log(`Manifest: ${manifestPath} (${result.manifest.images.length} images, ${Object.keys(result.manifest.groups).length} groups)`);
  for (const tier of opts.tiers) {
    console.log(`  ${tier}: ${JSON.stringify(PERTURBATION_TIERS[tier])}`);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.stack || err);
    process.exit(1);
  });
}
