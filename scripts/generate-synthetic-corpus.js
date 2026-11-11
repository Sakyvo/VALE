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
 *   test_img/synthetic/<tier>/...png  - historical synthetic screenshots
 *   --aligned --output <separate-dir> [--plan-only] freezes/renders alignment-v2.
 *
 * The generator reads groups from data/sbi-fp/meta.json and thumb textures from thumbnails/.
 */

const path = require('path');
const fs = require('fs');
const { buildSyntheticCorpus, planAlignedCorpus, renderAlignedCorpus, DEFAULT_SEED, PERTURBATION_TIERS } = require('./lib/synthetic-corpus');

const ROOT = path.resolve(__dirname, '..');
const META_PATH = path.join(ROOT, 'data', 'sbi-fp', 'meta.json');
const EXTRACTED_PATH = path.join(ROOT, 'data', 'extracted.json');
const DEFAULT_OUT = path.join(ROOT, 'test_img', 'synthetic');
const DEFAULT_THUMBS = path.join(ROOT, 'thumbnails');

function parseArgs(argv) {
  const out = { seed: DEFAULT_SEED, out: DEFAULT_OUT, tiers: ['light', 'heavy'], thumbs: DEFAULT_THUMBS, groupsLimit: 0,
    aligned: false, planOnly: false, explicitOutput: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--output') { out.out = path.resolve(argv[++i]); out.explicitOutput = true; }
    else if (a.startsWith('--output=')) { out.out = path.resolve(a.slice('--output='.length)); out.explicitOutput = true; }
    else if (a === '--aligned') out.aligned = true;
    else if (a === '--plan-only') out.planOnly = true;
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
  if (!Number.isInteger(out.seed) || !Number.isInteger(out.groupsLimit) || out.groupsLimit < 0) throw new Error('Invalid seed or groups limit');
  if (out.planOnly && !out.aligned) throw new Error('--plan-only requires --aligned');
  if (out.aligned && !out.explicitOutput) throw new Error('Aligned corpus requires a separate output directory');
  const rel = path.relative(DEFAULT_OUT, out.out);
  if (out.aligned && (rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)))) {
    throw new Error('Aligned output must not overwrite the historical corpus');
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

  if (opts.aligned) {
    const plan = await planAlignedCorpus({ groups, thumbsRoot: opts.thumbs, seed: opts.seed });
    const planFile = path.join(opts.out, 'plan.json');
    if (fs.existsSync(planFile) && JSON.parse(fs.readFileSync(planFile, 'utf8')).hash !== plan.hash) {
      throw new Error('Refusing to overwrite another corpus plan');
    }
    fs.mkdirSync(opts.out, { recursive: true });
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
    console.log(`Aligned plan ${plan.hash}: ${plan.images.length} images; source failures ${plan.images.filter(row => row.sourceError).length}`);
    if (opts.planOnly) return plan;
    const manifest = await renderAlignedCorpus(plan, { corpusDir: opts.out, thumbsRoot: opts.thumbs,
      onProgress: (done, total) => console.log(`  ${done}/${total}`) });
    console.log(`Rendered ${manifest.images.length} rows; failures ${manifest.images.filter(row => row.error).length}`);
    return manifest;
  }

  console.log(`Synthetic corpus generator`);
  console.log(`  SBI packs: ${meta.packCount} in ${meta.groupCount} groups`);
  console.log(`  Extracted records: ${extracted.length}`);
  console.log(`  Output: ${opts.out}`);
  console.log(`  Seed: ${opts.seed}  Tiers: ${opts.tiers.join(', ')}\n`);

  const result = await buildSyntheticCorpus({
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
  return result;
}

module.exports = { main };

if (require.main === module) {
  main().catch(err => {
    console.error(err.stack || err);
    process.exit(1);
  });
}
