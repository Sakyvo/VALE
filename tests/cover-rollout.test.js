const test = require('node:test');
const assert = require('node:assert/strict');
const { valeCoverUrl, VALE_COVER_FILE } = require('../assets/js/asset-base');
const { selectCoverTargets } = require('../scripts/upload-assets-all');

test('cover revision preserves encoded pack identity and is idempotent', () => {
  assert.equal(VALE_COVER_FILE, 'cover-hud-v1.png');
  const url = 'https://assets.vale.cc.cd/A%20%23B/cover.png?v=old';
  assert.equal(valeCoverUrl(url), 'https://assets.vale.cc.cd/A%20%23B/cover-hud-v1.png');
  assert.equal(valeCoverUrl(valeCoverUrl(url)), valeCoverUrl(url));
  assert.equal(valeCoverUrl('/thumbnails/P/pack.png'), '/thumbnails/P/pack.png');
});

test('cover rollout targets every public identity even when already registered', () => {
  const items = [{name:'Pack'}, {name:'PACK'}, {name:'Other'}];
  assert.deepEqual(selectCoverTargets(items, []), ['Pack','PACK','Other']);
  assert.deepEqual(selectCoverTargets(items, ['PACK']), ['PACK']);
  assert.throws(() => selectCoverTargets(items, ['unknown']), /Unknown public pack/);
});

test('cover-only publishing verifies one immutable object and preserves master textures', async t => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const os = require('node:os');
  const crypto = require('node:crypto');
  const sharp = require('sharp');
  const { uploadCover } = require('../scripts/upload-assets-all');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vale-rollout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'P'));
  await fs.writeFile(path.join(root, 'P', 'cover.png'), 'old cover');
  const objects = new Map();
  const remote = {
    async uploadAsset({ pack, file, body }) {
      assert.equal(pack, 'P');
      assert.equal(file, 'cover-hud-v1.png');
      const meta = await sharp(body).metadata();
      assert.deepEqual([meta.width, meta.height], [728, 196]);
      const etag = crypto.createHash('md5').update(body).digest('hex');
      const skipped = objects.get(file)?.etag === etag;
      objects.set(file, { etag, size: body.length });
      return { skipped };
    },
    async headAsset(pack, file) { return objects.get(file); },
  };
  assert.equal((await uploadCover(remote, 'P', false, root)).uploaded, 1);
  assert.equal((await uploadCover(remote, 'P', false, root)).skipped, 1);
  assert.equal((await uploadCover(remote, 'P', true, root)).skipped, 1);
  assert.equal(await fs.readFile(path.join(root, 'P', 'cover.png'), 'utf8'), 'old cover');
  objects.get('cover-hud-v1.png').etag = 'wrong';
  await assert.rejects(uploadCover(remote, 'P', true, root), /verification failed/);
});
