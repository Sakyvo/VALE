// Display-asset URL construction for the browser.
//
// The per-pack asset base is stamped into the generated data at build time
// (data/asset-base.json -> generate-index.js): migrated packs carry an
// `assetBase` field pointing at the object-storage domain, everything else
// falls back to the in-repo thumbnails directory. The fallback is also what
// local development uses when no generated data carries a base.
const VALE_LOCAL_ASSET_BASE = '/thumbnails';

function valeAssetBaseUrl(packName, assetBase) {
  const base = String(assetBase || VALE_LOCAL_ASSET_BASE).replace(/\/+$/, '');
  return `${base}/${encodeURIComponent(packName)}/`;
}

function valeAssetUrl(packName, fileName, assetBase) {
  return valeAssetBaseUrl(packName, assetBase) + encodeURIComponent(fileName);
}
