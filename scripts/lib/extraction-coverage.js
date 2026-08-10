// Extraction-coverage audit (issue 014).
//
// A registry entry that was never extracted is invisible on the site: it has a
// download URL but no thumbnails, no index entry, and no search result. This
// makes "uploaded but not extracted" a queryable state instead of a silent gap.
//
// Pure: reads the registry and extracted records and computes the difference.
// The backfill driver and the audit CLI both reuse it.

const fs = require('node:fs');
const path = require('node:path');
const { getPackIdFromZipName } = require('../pack-utils');

function computeUploadedNotExtracted(registry, extracted) {
  const extractedIds = new Set((extracted || []).map(row => row && row.packId).filter(Boolean));
  const missing = [];
  let uploaded = 0;
  const byRepo = {};
  for (const [file, record] of Object.entries(registry || {})) {
    uploaded++;
    if (!record || !record.repo) continue;
    const packId = getPackIdFromZipName(file);
    if (!extractedIds.has(packId)) {
      missing.push({ file, packId, repo: record.repo, size: record.size });
      byRepo[record.repo] = (byRepo[record.repo] || 0) + 1;
    }
  }
  return {
    registryTotal: Object.keys(registry || {}).length,
    extractedTotal: extractedIds.size,
    uploadedTotal: uploaded,
    missingTotal: missing.length,
    byRepo,
    missing,
  };
}

function loadFiles(registryPath, extractedPath) {
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
  const extracted = fs.existsSync(extractedPath)
    ? JSON.parse(fs.readFileSync(extractedPath, 'utf-8'))
    : [];
  return computeUploadedNotExtracted(registry, extracted);
}

module.exports = { computeUploadedNotExtracted, loadFiles };
