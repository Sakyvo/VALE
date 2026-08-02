const OVERLAY_LIST_NAME = 'Overlay';

// Colour codes and separators must not hide the word: "§bSky §cOverlay" and
// "Tory_block_overlay" both name an overlay.
function isOverlayByName(pack) {
  if (!pack) return false;
  const candidates = [pack.displayName, pack.name, pack.id];
  return candidates.some(value =>
    typeof value === 'string' && value.replace(/§./g, '').toLowerCase().includes('overlay')
  );
}

// Name matching and pixel detection are two independent routes into the List and
// union together; membership is additive so an existing member is never dropped.
function mergeOverlayMembers(detected, catalog, existing = []) {
  const members = new Set([...(existing || []), ...(detected || [])]);
  for (const pack of catalog || []) {
    if (isOverlayByName(pack)) members.add(pack.name);
  }
  return [...members].sort();
}

module.exports = { OVERLAY_LIST_NAME, isOverlayByName, mergeOverlayMembers };
