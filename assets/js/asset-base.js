// Display-asset URL construction for the browser.
//
// The per-pack asset base is stamped into the generated data at build time
// (data/asset-base.json -> generate-index.js): migrated packs carry an
// `assetBase` field pointing at the object-storage domain, everything else
// falls back to the in-repo thumbnails directory. The fallback is also what
// local development uses when no generated data carries a base.
const VALE_LOCAL_ASSET_BASE = '/thumbnails';
const VALE_COVER_FILE = 'cover-hud-v1.png';
// Cloudflare caches the asset host for hours, and the cover object keeps a stable name so
// a publish overwrites it in place. The query is the build-level cache buster: bump it
// whenever cover content changes, and every page starts asking for the new bytes.
const VALE_COVER_VERSION = '2';

function valeCoverUrl(url) {
  const rewritten = String(url).replace(/\/cover(?:-hud-v\d+)?\.png(?:[?#].*)?$/, '/' + VALE_COVER_FILE);
  if (!rewritten.includes(VALE_COVER_FILE)) return rewritten;
  return `${rewritten}?v=${VALE_COVER_VERSION}`;
}

function valeAssetBaseUrl(packName, assetBase) {
  const base = String(assetBase || VALE_LOCAL_ASSET_BASE).replace(/\/+$/, '');
  return `${base}/${encodeURIComponent(packName)}/`;
}

function valeAssetUrl(packName, fileName, assetBase) {
  const url = valeAssetBaseUrl(packName, assetBase) + encodeURIComponent(fileName);
  return fileName === 'cover.png' ? valeCoverUrl(url) : url;
}

if (typeof module !== 'undefined') {
  module.exports = { VALE_COVER_FILE, VALE_COVER_VERSION, valeCoverUrl, valeAssetBaseUrl, valeAssetUrl };
}
