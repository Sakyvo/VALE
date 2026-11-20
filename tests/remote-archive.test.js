const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const test = require('node:test');
const AdmZip = require('adm-zip');
const sharp = require('sharp');

const { readArchiveEntries } = require('../scripts/lib/remote-archive');

const BOW = 'assets/minecraft/textures/items/bow_standby.png';

async function bowPng() {
  return sharp({
    create: { width: 16, height: 16, channels: 4, background: { r: 12, g: 34, b: 56, alpha: 1 } },
  }).png().toBuffer();
}

// Serves an archive over HTTP with range support and records how many bytes left the
// server, so a test can prove the whole archive was never transferred.
function serveArchive(buffer) {
  const state = { bytes: 0, requests: 0, wholeBodyRequests: 0 };
  const server = http.createServer((req, res) => {
    state.requests++;
    const total = buffer.length;
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (!match) {
      if (req.method !== 'HEAD') {
        state.wholeBodyRequests++;
        state.bytes += total;
      }
      res.writeHead(200, { 'content-length': total, 'accept-ranges': 'bytes' });
      res.end(req.method === 'HEAD' ? undefined : buffer);
      return;
    }
    let start = match[1] === '' ? total - Number(match[2]) : Number(match[1]);
    let end = match[1] === '' || match[2] === '' ? total - 1 : Number(match[2]);
    const slice = buffer.subarray(start, end + 1);
    state.bytes += slice.length;
    res.writeHead(206, {
      'content-range': `bytes ${start}-${end}/${total}`,
      'content-length': slice.length,
      'accept-ranges': 'bytes',
    });
    res.end(slice);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/pack.zip`, state, close: () => server.close() });
    });
  });
}

test('reads one entry out of a remote archive without transferring the archive', async () => {
  const bow = await bowPng();
  const zip = new AdmZip();
  zip.addFile('pack.mcmeta', Buffer.from('{"pack":{"pack_format":1}}'));
  // An incompressible filler entry pushes the archive well past what a single entry needs.
  zip.addFile('filler.bin', crypto.randomBytes(2 * 1024 * 1024));
  zip.addFile(BOW, bow);
  const archive = zip.toBuffer();

  const served = await serveArchive(archive);
  try {
    const { entries, missing } = await readArchiveEntries(served.url, [BOW]);

    assert.deepEqual(missing, []);
    assert.deepEqual(entries.get(BOW), bow);
    assert.ok(served.state.bytes < 200 * 1024, `transferred ${served.state.bytes} bytes`);
    assert.equal(served.state.wholeBodyRequests, 0);
  } finally {
    served.close();
  }
});

test('an entry the archive does not carry is reported as missing', async () => {
  const zip = new AdmZip();
  zip.addFile('pack.mcmeta', Buffer.from('{"pack":{"pack_format":1}}'));
  zip.addFile('assets/minecraft/textures/items/diamond_sword.png', await bowPng());
  const served = await serveArchive(zip.toBuffer());
  try {
    const { entries, missing } = await readArchiveEntries(served.url, [BOW, 'assets/minecraft/textures/items/bow.png']);

    assert.deepEqual([...entries.keys()], []);
    assert.deepEqual(missing, [BOW, 'assets/minecraft/textures/items/bow.png']);
  } finally {
    served.close();
  }
});

test('every requested entry is returned, so the caller chooses the preference order', async () => {
  const bow = await bowPng();
  const standby = await sharp({
    create: { width: 16, height: 16, channels: 4, background: { r: 200, g: 10, b: 10, alpha: 1 } },
  }).png().toBuffer();
  const zip = new AdmZip();
  zip.addFile('pack.mcmeta', Buffer.from('{"pack":{"pack_format":1}}'));
  zip.addFile(BOW, standby);
  zip.addFile('assets/minecraft/textures/items/bow.png', bow);
  const served = await serveArchive(zip.toBuffer());
  try {
    const { entries } = await readArchiveEntries(served.url, ['assets/minecraft/textures/items/bow.png', BOW]);

    assert.deepEqual(entries.get('assets/minecraft/textures/items/bow.png'), bow);
    assert.deepEqual(entries.get(BOW), standby);
  } finally {
    served.close();
  }
});

test('an archive that cannot be read fails loudly with the URL in the message', async () => {
  const server = http.createServer((req, res) => { res.writeHead(404).end('nope'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await assert.rejects(
      readArchiveEntries(`http://127.0.0.1:${port}/missing.zip`, [BOW]),
      /missing\.zip/,
    );
  } finally {
    server.close();
  }
});
test('a throttled request is retried instead of reported as unreadable', async () => {
  const bow = await bowPng();
  const zip = new AdmZip();
  zip.addFile('pack.mcmeta', Buffer.from('{"pack":{"pack_format":1}}'));
  zip.addFile(BOW, bow);
  const archive = zip.toBuffer();

  let throttled = 0;
  const server = http.createServer((req, res) => {
    if (throttled < 2) {
      throttled++;
      res.writeHead(429, { 'retry-after': '0' }).end('slow down');
      return;
    }
    const total = archive.length;
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (!match) {
      res.writeHead(200, { 'content-length': total, 'accept-ranges': 'bytes' });
      res.end(req.method === 'HEAD' ? undefined : archive);
      return;
    }
    if (match[1] === '') {
      // raw.githubusercontent.com answers suffix ranges with 501.
      res.writeHead(501).end('suffix ranges unsupported');
      return;
    }
    const start = Number(match[1]);
    const end = match[2] === '' ? total - 1 : Number(match[2]);
    const slice = archive.subarray(start, end + 1);
    res.writeHead(206, {
      'content-range': `bytes ${start}-${end}/${total}`,
      'content-length': slice.length,
      'accept-ranges': 'bytes',
    });
    res.end(slice);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const { entries } = await readArchiveEntries(`http://127.0.0.1:${port}/pack.zip`, [BOW]);
    assert.deepEqual(entries.get(BOW), bow);
    assert.equal(throttled, 2);
  } finally {
    server.close();
  }
});

test('a request that never answers is abandoned instead of blocking the crawl', async () => {
  // The socket is accepted and then left open: without a deadline one worker would
  // stay blocked forever and the crawl would silently stall.
  const server = http.createServer(() => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const started = Date.now();
  try {
    await assert.rejects(
      readArchiveEntries(`http://127.0.0.1:${port}/pack.zip`, [BOW], { timeoutMs: 300 }),
      /pack\.zip/,
    );
    assert.ok(Date.now() - started < 10_000, 'the reader gave up instead of hanging');
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('a response whose body never arrives is abandoned and still names the archive', async () => {
  // Headers are flushed, then the body stalls: the abort surfaces from the body read,
  // not from connect, so it must still be reported against this archive.
  const server = http.createServer((req, res) => {
    res.writeHead(206, {
      'content-range': 'bytes 0-1/1024',
      'content-length': '2',
      'accept-ranges': 'bytes',
    });
    res.flushHeaders(); // headers reach the client, the body is withheld forever
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const started = Date.now();
  try {
    await assert.rejects(
      readArchiveEntries(`http://127.0.0.1:${port}/pack.zip`, [BOW], { timeoutMs: 300 }),
      /timeout 300ms.*pack\.zip/,
    );
    assert.ok(Date.now() - started < 10_000, 'the reader gave up instead of hanging');
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
