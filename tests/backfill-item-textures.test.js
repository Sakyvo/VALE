const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');
const sharp = require('sharp');

const { backfillPack, BOW_TEXTURES, TEXTURE_SETS, parseArgs } = require('../scripts/backfill-item-textures');

const BOW = 'assets/minecraft/textures/items/bow_standby.png';

async function bowPng() {
  return sharp({
    create: { width: 16, height: 16, channels: 4, background: { r: 7, g: 8, b: 9, alpha: 1 } },
  }).png().toBuffer();
}

function serve(buffer) {
  const server = http.createServer((req, res) => {
    const total = buffer.length;
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (!match) {
      res.writeHead(200, { 'content-length': total, 'accept-ranges': 'bytes' });
      res.end(req.method === 'HEAD' ? undefined : buffer);
      return;
    }
    if (match[1] === '') {
      // raw.githubusercontent.com answers suffix ranges with 501.
      res.writeHead(501).end('suffix ranges unsupported');
      return;
    }
    const start = Number(match[1]);
    const end = match[2] === '' ? total - 1 : Number(match[2]);
    const slice = buffer.subarray(start, end + 1);
    res.writeHead(206, {
      'content-range': `bytes ${start}-${end}/${total}`,
      'content-length': slice.length,
      'accept-ranges': 'bytes',
    });
    res.end(slice);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/pack.zip`,
      close: () => server.close(),
    }));
  });
}

async function packDir(withDir = true) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-bow-'));
  const dir = path.join(root, 'Some_Pack');
  if (withDir) await fs.promises.mkdir(dir);
  return dir;
}

test('a pack that carries a bow has it written into its master directory', async () => {
  const bow = await bowPng();
  const zip = new AdmZip();
  zip.addFile('pack.mcmeta', Buffer.from('{"pack":{"pack_format":1}}'));
  zip.addFile(BOW, bow);
  const served = await serve(zip.toBuffer());
  try {
    const dir = await packDir();
    const result = await backfillPack({ archiveUrl: served.url, outputDir: dir });

    assert.equal(result.status, 'written');
    assert.deepEqual(await fs.promises.readFile(path.join(dir, 'bow_standby.png')), bow);
  } finally {
    served.close();
  }
});

test('a pack without a bow is reported absent and writes nothing', async () => {
  const zip = new AdmZip();
  zip.addFile('pack.mcmeta', Buffer.from('{"pack":{"pack_format":1}}'));
  const served = await serve(zip.toBuffer());
  try {
    const dir = await packDir();
    const result = await backfillPack({ archiveUrl: served.url, outputDir: dir });

    assert.equal(result.status, 'absent');
    assert.deepEqual(await fs.promises.readdir(dir), []);
  } finally {
    served.close();
  }
});

test('an unreadable archive is reported with its reason instead of failing', async () => {
  const server = http.createServer((req, res) => { res.writeHead(500).end('boom'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const dir = await packDir();
    const result = await backfillPack({
      archiveUrl: `http://127.0.0.1:${server.address().port}/pack.zip`,
      outputDir: dir,
    });

    assert.equal(result.status, 'unreadable');
    assert.match(result.reason, /500/);
  } finally {
    server.close();
  }
});

test('a pack whose bow is already extracted is skipped without touching the network', async () => {
  const dir = await packDir();
  await fs.promises.writeFile(path.join(dir, 'bow_standby.png'), Buffer.from('already here'));
  // No server: any request would throw, so a passing test proves nothing was fetched.
  const result = await backfillPack({ archiveUrl: 'http://127.0.0.1:1/pack.zip', outputDir: dir });

  assert.equal(result.status, 'present');
  assert.equal(await fs.promises.readFile(path.join(dir, 'bow_standby.png'), 'utf8'), 'already here');
});

test('a pack without a master directory is not given one', async () => {
  const dir = await packDir(false);
  const result = await backfillPack({ archiveUrl: 'http://127.0.0.1:1/pack.zip', outputDir: dir });

  assert.equal(result.status, 'no-master');
  assert.equal(fs.existsSync(dir), false);
});

test('bow texture names cover both the 1.8 and later layouts', () => {
  assert.deepEqual(BOW_TEXTURES, [
    'assets/minecraft/textures/items/bow_standby.png',
    'assets/minecraft/textures/items/bow.png',
  ]);
});
test('the potion-bottle set takes only the drinkable bottle and writes it under its own name', async () => {
  const bottle = await sharp({
    create: { width: 16, height: 16, channels: 4, background: { r: 90, g: 40, b: 120, alpha: 1 } },
  }).png().toBuffer();
  const zip = new AdmZip();
  zip.addFile('pack.mcmeta', Buffer.from('{"pack":{"pack_format":1}}'));
  zip.addFile('assets/minecraft/textures/items/potion_bottle_drinkable.png', bottle);
  zip.addFile('assets/minecraft/textures/items/potion_bottle_splash.png', Buffer.from('not the target'));
  const served = await serve(zip.toBuffer());
  try {
    const dir = await packDir();
    const result = await backfillPack({ archiveUrl: served.url, outputDir: dir, set: 'potion-bottle' });

    assert.equal(result.status, 'written');
    assert.deepEqual(await fs.promises.readdir(dir), ['potion_bottle_drinkable.png']);
    assert.deepEqual(await fs.promises.readFile(path.join(dir, 'potion_bottle_drinkable.png')), bottle);
  } finally {
    served.close();
  }
});

test('the potion-bottle set short-circuits on an already extracted bottle', async () => {
  const dir = await packDir();
  await fs.promises.writeFile(path.join(dir, 'potion_bottle_drinkable.png'), Buffer.from('already here'));
  const result = await backfillPack({
    archiveUrl: 'http://127.0.0.1:1/pack.zip', outputDir: dir, set: 'potion-bottle',
  });

  assert.equal(result.status, 'present');
});

test('--set rejects an unknown texture set instead of silently doing nothing', () => {
  assert.throws(() => parseArgs(['--set', 'nope']), /Unknown --set: nope/);
  assert.equal(parseArgs([]).set, 'bow');
  assert.deepEqual(TEXTURE_SETS['potion-bottle'].archiveNames, [
    'assets/minecraft/textures/items/potion_bottle_drinkable.png',
  ]);
});
