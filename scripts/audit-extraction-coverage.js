#!/usr/bin/env node
// audit-extraction-coverage: list registry packs that were uploaded but never
// extracted. Run after any ingest to catch invisible packs before users do.
//
//   node scripts/audit-extraction-coverage.js [--json]

const { loadFiles } = require('./lib/extraction-coverage');

const report = loadFiles('data/pack-registry.json', 'data/extracted.json');
if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(`registry:   ${report.registryTotal}`);
  console.log(`extracted:  ${report.extractedTotal}`);
  console.log(`uploaded:   ${report.uploadedTotal}`);
  console.log(`missing:    ${report.missingTotal}`);
  console.log('by repo:', JSON.stringify(report.byRepo));
  if (report.missingTotal) {
    console.log('\nmissing entries:');
    for (const m of report.missing) console.log(`  ${m.repo}  ${JSON.stringify(m.file)}  ->  ${m.packId}`);
  }
}
process.exitCode = report.missingTotal ? 1 : 0;
