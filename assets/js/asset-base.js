// Display-asset URL construction for the browser.
//
// The per-pack asset base is stamped into the generated data at build time
// (data/asset-base.json -> generate-index.js): migrated packs carry an
// `assetBase` field pointing at the object-storage domain, everything else
// falls back to the in-repo thumbnails directory. The fallback is also what
// local development uses when no generated data carries a base.
const VALE_LOCAL_ASSET_BASE = '/thumbnails';
const VALE_COVER_FILE = 'cover-hud-v1.png';

function valeCoverUrl(url) {
  return String(url).replace(/\/cover(?:-hud-v\d+)?\.png(?:[?#].*)?$/, '/' + VALE_COVER_FILE);
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
  module.exports = { VALE_COVER_FILE, valeCoverUrl, valeAssetBaseUrl, valeAssetUrl };
}
