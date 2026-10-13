const assert = require('node:assert/strict');
const test = require('node:test');
const { sanitizeName, getPackIdFromZipName } = require('../scripts/pack-utils');

// A corpus archive named after symbols only (e.g. `-_-`, `¬_¬`) sanitizes to an
// empty string. That empty id is not a usable identity: it collides with every
// other symbol-only archive, escapes the `pack_id_exists` conflict checks, and
// makes extraction write its textures straight into the thumbnails root instead
// of a per-pack directory. Such archives must be skipped, never ingested.
test('symbol-only archive names never produce an empty or colliding pack id', () => {
  for (const name of ['-_-', '¬_¬', '-_-_-', '!!!', '#', '@@']) {
    const packId = getPackIdFromZipName(`${name}.zip`);
    assert.notEqual(packId, '', `${name} must not sanitize to an empty pack id`);
    assert.ok(packId.length > 0, `${name} must yield a usable pack id`);
  }
});

test('sanitizeName still strips markers and decorations from ordinary names', () => {
  assert.equal(sanitizeName('! §6NoLimit 128x'), 'NoLimit_128x');
  assert.equal(sanitizeName('#§3AMARANTH'), 'AMARANTH');
  assert.equal(sanitizeName('! Fyes Default edit [FPS BOOST]'), 'Fyes_Default_edit_FPS_BOOST');
});
