const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');
const sharp = require('sharp');
const {
  PackFingerprintError,
  fingerprintPack,
} = require('../scripts/lib/pack-content-fingerprint');

async function png(width, height, rgba) {
  return sharp({
    create: { width, height, channels: 4, background: rgba },
  }).png().toBuffer();
}

async function writePack(dir, name, files, options = {}) {
  const zip = new AdmZip();
  const prefix = options.prefix || '';
  const entries = [
    ...(options.omitMeta ? [] : [['pack.mcmeta', Buffer.from(JSON.stringify(options.mcmeta || { pack: { pack_format: 1, description: name } }))]]),
    ['pack.png', await png(4, 4, options.packColor || { r: 1, g: 2, b: 3, alpha: 1 })],
    ...Object.entries(files),
  ];
  if (options.reverse) entries.reverse();
  for (const [entryPath, data] of entries) zip.addFile(prefix + entryPath, Buffer.isBuffer(data) ? data : Buffer.from(data));
  const output = path.join(dir, name + '.zip');
  zip.writeZip(output);
  return output;
}

async function withTemp(fn) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-pack-fp-'));
  try {
    return await fn(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

function corruptCentralCrc(filePath, entryName) {
  const bytes = fs.readFileSync(filePath);
  const wanted = Buffer.from(entryName);
  for (let offset = 0; offset + 46 + wanted.length <= bytes.length; offset++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = bytes.readUInt16LE(offset + 28);
    if (nameLength !== wanted.length || !bytes.subarray(offset + 46, offset + 46 + nameLength).equals(wanted)) continue;
    bytes.writeUInt32LE((bytes.readUInt32LE(offset + 16) ^ 0xffffffff) >>> 0, offset + 16);
    fs.writeFileSync(filePath, bytes);
    return;
  }
  throw new Error(`Central zip entry not found: ${entryName}`);
}

function corruptCompressedPayload(filePath, entryName) {
  const bytes = fs.readFileSync(filePath);
  const wanted = Buffer.from(entryName);
  for (let offset = 0; offset + 30 + wanted.length <= bytes.length; offset++) {
    if (bytes.readUInt32LE(offset) !== 0x04034b50) continue;
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    if (nameLength !== wanted.length || !bytes.subarray(offset + 30, offset + 30 + nameLength).equals(wanted)) continue;
    const payload = offset + 30 + nameLength + extraLength;
    bytes.fill(0xff, payload, Math.min(payload + 16, bytes.length));
    fs.writeFileSync(filePath, bytes);
    return;
  }
  throw new Error(`Local zip entry not found: ${entryName}`);
}

test('ignores archive metadata, root branding, sounds, language, and config formatting', async () => withTemp(async dir => {
  const sword = await png(16, 16, { r: 20, g: 100, b: 200, alpha: 1 });
  const filesA = {
    'assets/minecraft/textures/items/diamond_sword.png': sword,
    'assets/minecraft/models/item/example.json': '{"parent":"item/generated","textures":{"layer0":"item/example"}}',
    'assets/minecraft/mcpatcher/cit/example.properties': '# comment\ntexture = x\nitems=276\n',
    'assets/minecraft/sounds/example.ogg': Buffer.from('sound-a'),
    'assets/minecraft/lang/en_US.lang': Buffer.from('name=a'),
  };
  const filesB = {
    'assets/minecraft/lang/en_US.lang': Buffer.from('name=b'),
    'assets/minecraft/sounds/example.ogg': Buffer.from('sound-b'),
    'assets/minecraft/mcpatcher/cit/example.properties': 'items:276\r\ntexture=x\r\n',
    'assets/minecraft/models/item/example.json': '{"textures":{"layer0":"item/example"},"parent":"item/generated"}',
    'assets/minecraft/textures/items/diamond_sword.png': sword,
  };
  const first = await writePack(dir, 'first', filesA);
  const second = await writePack(dir, 'second', filesB, { reverse: true, packColor: { r: 255, g: 0, b: 0, alpha: 1 } });
  const a = await fingerprintPack(first);
  const b = await fingerprintPack(second);
  assert.equal(a.visualContentHash, b.visualContentHash);
  assert.notEqual(a.archiveSha256, b.archiveSha256);
}));

test('normalizes a single wrapper folder without changing identity', async () => withTemp(async dir => {
  const texture = await png(8, 8, { r: 4, g: 5, b: 6, alpha: 1 });
  const files = { 'assets/minecraft/textures/particle/particles.png': texture };
  const root = await writePack(dir, 'root', files);
  const wrapped = await writePack(dir, 'wrapped', files, { prefix: 'Wrapper/' });
  assert.equal((await fingerprintPack(root)).visualContentHash, (await fingerprintPack(wrapped)).visualContentHash);
}));

test('accepts one unambiguous assets root when pack metadata is missing', async () => withTemp(async dir => {
  const texture = await png(8, 8, { r: 7, g: 8, b: 9, alpha: 1 });
  const files = { 'assets/minecraft/textures/blocks/stone.png': texture };
  const normal = await writePack(dir, 'normal', files);
  const rootOnly = await writePack(dir, 'root-only', files, { omitMeta: true });
  const wrapped = await writePack(dir, 'wrapped-only', files, { omitMeta: true, prefix: 'Wrapper/' });
  const expected = (await fingerprintPack(normal)).visualContentHash;
  assert.equal((await fingerprintPack(rootOnly)).visualContentHash, expected);
  assert.equal((await fingerprintPack(wrapped)).visualContentHash, expected);
}));

test('rejects multiple metadata-free assets roots', async () => withTemp(async dir => {
  const texture = await png(8, 8, { r: 7, g: 8, b: 9, alpha: 1 });
  const zip = new AdmZip();
  zip.addFile('One/assets/minecraft/textures/blocks/stone.png', texture);
  zip.addFile('Two/assets/minecraft/textures/blocks/stone.png', texture);
  const file = path.join(dir, 'ambiguous.zip');
  zip.writeZip(file);
  await assert.rejects(
    () => fingerprintPack(file),
    error => error instanceof PackFingerprintError && error.code === 'ambiguous_pack_root'
  );
}));

test('includes sky, block, particle, pixels, dimensions, and visual config in identity', async () => withTemp(async dir => {
  const basePng = await png(8, 8, { r: 20, g: 30, b: 40, alpha: 1 });
  const changedPng = await png(8, 8, { r: 21, g: 30, b: 40, alpha: 1 });
  const baseFiles = {
    'assets/minecraft/mcpatcher/sky/world0/sky1.png': basePng,
    'assets/minecraft/textures/blocks/stone.png': basePng,
    'assets/minecraft/textures/particle/particles.png': basePng,
    'assets/minecraft/textures/blocks/stone.png.mcmeta': '{"animation":{"frametime":2}}',
  };
  const baseline = await fingerprintPack(await writePack(dir, 'baseline', baseFiles));
  for (const [index, target] of Object.keys(baseFiles).entries()) {
    const changed = { ...baseFiles };
    changed[target] = target.endsWith('.mcmeta') ? '{"animation":{"frametime":3}}' : changedPng;
    const result = await fingerprintPack(await writePack(dir, `changed-${index}`, changed));
    assert.notEqual(result.visualContentHash, baseline.visualContentHash, target);
  }
  const resized = { ...baseFiles, 'assets/minecraft/textures/blocks/stone.png': await png(4, 16, { r: 20, g: 30, b: 40, alpha: 1 }) };
  assert.notEqual((await fingerprintPack(await writePack(dir, 'resized', resized))).visualContentHash, baseline.visualContentHash);
}));

test('records exact effective sword pixel hashes', async () => withTemp(async dir => {
  const shared = await png(16, 16, { r: 0, g: 150, b: 220, alpha: 1 });
  const iron = await png(16, 16, { r: 180, g: 180, b: 180, alpha: 1 });
  const result = await fingerprintPack(await writePack(dir, 'swords', {
    'assets/minecraft/textures/items/stone_sword.png': shared,
    'assets/minecraft/textures/items/iron_sword.png': iron,
    'assets/minecraft/textures/items/diamond_sword.png': shared,
  }));
  assert.equal(result.swords.stone, result.swords.diamond);
  assert.notEqual(result.swords.iron, result.swords.diamond);
}));

test('hashes malformed mcmeta bytes and ignores AppleDouble metadata', async () => withTemp(async dir => {
  const texture = await png(16, 16, { r: 30, g: 80, b: 140, alpha: 1 });
  const baseFiles = {
    'assets/minecraft/textures/items/ender_pearl.png': texture,
    'assets/minecraft/textures/items/ender_pearl.png.mcmeta': Buffer.from('{broken\r\n'),
  };
  const base = await fingerprintPack(await writePack(dir, 'invalid-meta', baseFiles));
  const withMetadata = await fingerprintPack(await writePack(dir, 'appledouble', {
    ...baseFiles,
    '__MACOSX/assets/minecraft/textures/items/._ender_pearl.png': Buffer.from('not a png'),
    'assets/minecraft/textures/items/._diamond_sword.png': Buffer.from('not a png'),
  }));
  const changed = await fingerprintPack(await writePack(dir, 'changed-meta', {
    ...baseFiles,
    'assets/minecraft/textures/items/ender_pearl.png.mcmeta': Buffer.from('{different'),
  }));
  assert.equal(withMetadata.visualContentHash, base.visualContentHash);
  assert.notEqual(changed.visualContentHash, base.visualContentHash);
}));

test('hashes undecodable raster and JSON bytes without ignoring them', async () => withTemp(async dir => {
  const first = await fingerprintPack(await writePack(dir, 'broken-a', {
    'assets/minecraft/textures/blocks/unused.png': Buffer.from('{"not":"png"}'),
    'assets/minecraft/models/block/unused.json': Buffer.from('{broken\r\n'),
  }));
  const same = await fingerprintPack(await writePack(dir, 'broken-b', {
    'assets/minecraft/textures/blocks/unused.png': Buffer.from('{"not":"png"}'),
    'assets/minecraft/models/block/unused.json': Buffer.from('{broken\n'),
  }));
  const changed = await fingerprintPack(await writePack(dir, 'broken-c', {
    'assets/minecraft/textures/blocks/unused.png': Buffer.from('{"different":"bytes"}'),
    'assets/minecraft/models/block/unused.json': Buffer.from('{broken\n'),
  }));
  assert.equal(first.visualContentHash, same.visualContentHash);
  assert.notEqual(first.visualContentHash, changed.visualContentHash);
}));

test('recovers a decodable visual entry when only its zip CRC is wrong', async () => withTemp(async dir => {
  const entryName = 'assets/minecraft/textures/blocks/stone.png';
  const files = { [entryName]: await png(16, 16, { r: 30, g: 40, b: 50, alpha: 1 }) };
  const valid = await writePack(dir, 'valid-crc', files);
  const broken = await writePack(dir, 'broken-crc', files);
  corruptCentralCrc(broken, entryName);
  assert.equal(
    (await fingerprintPack(valid)).visualContentHash,
    (await fingerprintPack(broken)).visualContentHash
  );
}));

test('still fails when a visual zip entry cannot be decompressed', async () => withTemp(async dir => {
  const file = await writePack(dir, 'unreadable', {
    'assets/minecraft/textures/blocks/stone.png': await png(16, 16, { r: 1, g: 2, b: 3, alpha: 1 }),
  });
  corruptCompressedPayload(file, 'assets/minecraft/textures/blocks/stone.png');
  await assert.rejects(
    () => fingerprintPack(file),
    error => error instanceof PackFingerprintError
  );
}));
