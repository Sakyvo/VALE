#!/usr/bin/env node
// Backfill extraction for registry packs that were uploaded but never extracted.
//
//   node scripts/backfill-missing-extract.js --source-dir <local-zips> [--remote] [--limit <n>]
//
// Computes the uploaded-but-not-extracted set (scripts/lib/extraction-
// coverage), extracts every one whose archive is present in --source-dir
// locally, and -- when --remote is given -- downloads the locally-missing
// ones from their packs-NNN repository via the existing github-pack-remote
// download path into an OS temp directory, extracts those too, then cleans
// up. After this run, the index/build/SBI generators regenerate the public
// catalogue so the previously invisible packs appear on the site.
//
// The extraction script itself gains no new remote capability: remote reads
// happen through the same downloadArchive the finalizer already uses, and
// texture extraction stays a local-input-only step.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { computeUploadedNotExtracted } = require('./lib/extraction-coverage');
const { createGitHubPackRemote } = require('./lib/github-pack-remote');
const extract = require('./extract-textures');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const has = name => process.argv.includes(name);

async function main() {
  const sourceDir = arg('--source-dir') || process.env.VALE_LOCAL_PACKS;
  if (!sourceDir || !fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new Error('Missing --source-dir <local-zip-folder> (or VALE_LOCAL_PACKS env)');
  }
  const allowRemote = has('--remote');
  const limit = Number(arg('--limit')) || 0;
  const only = arg('--only');
  const onlySet = only ? new Set(only.split(',').map(s => s.trim()).filter(Boolean)) : null;

  const registry = JSON.parse(fs.readFileSync('data/pack-registry.json', 'utf-8'));
  const extracted = fs.existsSync('data/extracted.json')
    ? JSON.parse(fs.readFileSync('data/extracted.json', 'utf-8'))
    : [];
  const report = computeUploadedNotExtracted(registry, extracted);
  if (!report.missing.length) {
    console.log('No uploaded-but-unextracted packs remain.');
    return;
  }
  let targets = report.missing;
  if (onlySet) {
    targets = targets.filter(m => onlySet.has(m.file) || onlySet.has(m.packId));
    if (!targets.length) throw new Error(`--only matched no missing packs: ${only}`);
  }
  if (limit > 0) targets = targets.slice(0, limit);
  console.log(`Backfilling ${targets.length} of ${report.missingTotal} missing (by repo: ${JSON.stringify(report.byRepo)}).`);

  const manifest = {
    generated: new Date().toISOString(),
    extractPackIds: targets.map(m => m.packId),
  };
  const manifestPath = path.join(os.tmpdir(), `vale-backfill-manifest-${process.pid}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const localFiles = new Set(fs.readdirSync(sourceDir));
  const localLower = new Map();
  for (const f of localFiles) localLower.set(f.toLowerCase(), f);
  const localPresent = targets.filter(m => localFiles.has(m.file) || localLower.has(m.file.toLowerCase()));
  const localAbsent = targets.filter(m => !localFiles.has(m.file) && !localLower.has(m.file.toLowerCase()));

  let stagedRemoteDir = null;
  let remote = null;
  try {
    // Pass 1: everything available locally.
    if (localPresent.length) {
      console.log(`\n== local pass: ${localPresent.length} packs from ${sourceDir} ==`);
      const r = await extract.main(['--input', sourceDir, '--merge', '--manifest', manifestPath]);
      console.log(`  processed ${r.processed}, failures ${r.failures.length}, missing ${r.missing.length}`);
      if (r.failures.length) for (const f of r.failures) console.error(`  fail: ${f.file}: ${f.reason}`);
    }
    // Pass 2: download the locally-absent ones over the existing remote path.
    if (localAbsent.length) {
      console.log(`\n== remote pass: ${localAbsent.length} packs locally missing ==`);
      if (!allowRemote) {
        console.log('  (skipped; pass --remote to download them via github-pack-remote)');
        for (const m of localAbsent) console.log(`  need: ${m.repo} ${JSON.stringify(m.file)} (${m.size} bytes)`);
      } else {
        stagedRemoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vale-backfill-'));
        remote = createGitHubPackRemote({ owner: 'Sakyvo', mutation: false, transport: 'curl' });
        for (const m of localAbsent) {
          const dest = path.join(stagedRemoteDir, m.file);
          console.log(`  down: ${m.repo} ${JSON.stringify(m.file)} -> ${dest}`);
          await remote.downloadArchive({ repo: m.repo, file: m.file, size: m.size, destination: dest });
        }
        const r = await extract.main(['--input', stagedRemoteDir, '--merge', '--manifest', manifestPath]);
        console.log(`  processed ${r.processed}, failures ${r.failures.length}, missing ${r.missing.length}`);
        if (r.failures.length) for (const f of r.failures) console.error(`  fail: ${f.file}: ${f.reason}`);
      }
    }
    console.log('\nNext: rerun scripts/audit-extraction-coverage.js, then generate-index.js + build.js.');
  } finally {
    try { fs.rmSync(manifestPath, { force: true }); } catch {}
    if (stagedRemoteDir) {
      try { fs.rmSync(stagedRemoteDir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
    }
    if (remote) try { remote.close(); } catch {}
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
