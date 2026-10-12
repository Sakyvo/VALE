const path = require('path');
const crypto = require('crypto');

const PACK_ID_OVERRIDES = {
  'AMARANTH': { check: name => name === '#§3AMARANTH', id: 'AMARANTH_v2' },
  'SoupSkidz4LIFE': { check: name => name === '§4SoupSkidz4LIFE', id: 'SoupSkidz4LIFE_v2' },
  '1_1Infera_Blue': { check: () => true, id: 'Infera_Blue' },
};

function sanitizeName(name) {
  let r = name.replace(/^(?:§[0-9a-fk-or])*[!#]+\s*/gi, '');
  if (name.includes('§')) r = r.replace(/_([0-9a-fk-or])/gi, '§$1');
  r = r.replace(/§[0-9a-fk-or]/gi, '');
  let trail = '';
  r = r.replace(/\((\d+)\)\s*$/, (_, n) => { trail = `(${n})`; return ''; });
  const base = r.replace(/[!@#%^&*()+=\[\]{}|\\:;"'<>,?\/~`§]/g, '').replace(/^[^0-9a-zA-Z\u4e00-\u9fff$]+/, '').trim().replace(/\s+/g, '_');
  // A name made only of symbols (e.g. `-_-`, `¬_¬`) leaves no usable identity.
  // An empty id collides across such archives, escapes the pack_id conflict
  // checks, and makes extraction write textures into the thumbnails root.
  // Derive a stable unique slug from the full original name instead.
  if (!base) return `Pack_${crypto.createHash('sha1').update(name).digest('hex').slice(0, 8)}`;
  return (base + trail).replace(/[. ]+$/, '');
}

function getPackIdFromZipName(file) {
  const originalName = path.basename(file, '.zip');
  let packId = sanitizeName(originalName);
  const override = PACK_ID_OVERRIDES[packId];
  if (override && override.check(originalName)) packId = override.id;
  return packId;
}

module.exports = {
  PACK_ID_OVERRIDES,
  sanitizeName,
  getPackIdFromZipName,
};
