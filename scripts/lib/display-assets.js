// Display-asset downsample rules (pure).
//
// Classification by filename:
// - cover.png: never touched. Multi-frame animated covers compute frame height
//   from the image dimensions, so any resize would break playback.
// - Atlas class (particles/inventory/inv/icons/widgets): capped at 512 on the
//   LARGER side. The frontend slices these atlases at fixed 256-base
//   coordinates scaled by image width, so a uniform power-of-two factor keeps
//   every sprite boundary aligned.
// - Everything else (items, blocks, pack.png, future textures): capped at 256
//   on the SMALLER side. Item textures are square frames and animated strips
//   stack frames vertically, so the frame side must govern - capping the strip
//   height would crush every frame.
//
// Only power-of-two factors are ever produced, and the same factor applies to
// both axes. Files already within their cap are reported as 'keep'.

const ATLAS_FILES = new Set([
  'particles.png',
  'inventory.png',
  'inv.png',
  'icons.png',
  'widgets.png',
]);

const ATLAS_CAP = 512;
const ITEM_CAP = 256;
const COVER_FILE = 'cover.png';

function classify(fileName) {
  if (fileName === COVER_FILE) return 'cover';
  if (ATLAS_FILES.has(fileName)) return 'atlas';
  return 'item';
}

function planDisplayAsset(fileName, width, height) {
  if (typeof fileName !== 'string' || fileName.length === 0) {
    throw new Error(`Invalid texture filename: ${String(fileName) || '(missing)'}`);
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid texture dimensions for ${fileName}: ${width}x${height}`);
  }
  const kind = classify(fileName);
  if (kind === 'cover') return { action: 'keep' };
  const cap = kind === 'atlas' ? ATLAS_CAP : ITEM_CAP;
  const governing = kind === 'atlas' ? Math.max(width, height) : Math.min(width, height);
  let factor = 1;
  while (governing / factor > cap) factor *= 2;
  if (factor === 1) return { action: 'keep' };
  return {
    action: 'resize',
    width: Math.floor(width / factor),
    height: Math.floor(height / factor),
    factor,
  };
}

module.exports = {
  ATLAS_CAP,
  ATLAS_FILES,
  ITEM_CAP,
  classify,
  planDisplayAsset,
};
