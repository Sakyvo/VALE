const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const test = require('node:test');
const {
  assertAssetName,
  buildAssetUrl,
  buildObjectKey,
  createAssetRemote,
  resolveAssetBase,
} = require('../scripts/lib/asset-remote');

const md5Hex = data => crypto.createHash('md5').update(data).digest('hex');
const sha256Hex = data => crypto.createHash('sha256').update(data).digest('hex');

// Local stub standing in for the S3-compatible endpoint: records every request
// and serves HEAD/PUT from an in-memory object store. Never touches a real remote.
function startStub() {
  const objects = new Map();
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const key = decodeURIComponent(req.url.replace(/^\/+/, '').replace(/^stub-bucket\//, ''));
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.method === 'HEAD') {
        const found = objects.get(key);
        if (!found) { res.writeHead(404).end(); return; }
        res.writeHead(200, { etag: `"${found.etag}"`, 'content-length': String(found.body.length) }).end();
        return;
      }
      if (req.method === 'PUT') {
        const etag = md5Hex(body);
        objects.set(key, { body, etag });
        res.writeHead(200, { etag: `"${etag}"` }).end();
        return;
      }
      res.writeHead(405).end();
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        endpoint: `http://127.0.0.1:${port}`,
        objects,
        requests,
        close: () => new Promise(done => server.close(done)),
      });
    });
    server.on('error', reject);
  });
}

function createRemote(endpoint) {
  return createAssetRemote({
    endpoint,
    bucket: 'stub-bucket',
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
    publicBaseUrl: 'https://assets.vale.cc.cd',
  });
}

test('validates asset names and rejects traversal and illegal object names', () => {
  assert.equal(assertAssetName('§a Pack #1'), '§a Pack #1');
  assert.equal(assertAssetName('cover.png'), 'cover.png');
  for (const bad of ['', '..', '.', 'a/b', 'a\\b', 'a\0b', '../cover.png', 'a\nb']) {
    assert.throws(() => assertAssetName(bad), /Invalid asset name/, JSON.stringify(bad));
  }
  assert.throws(() => buildObjectKey('ok', '../cover.png'), /Invalid asset name/);
  assert.throws(() => buildObjectKey('../pack', 'cover.png'), /Invalid asset name/);
});

test('builds public asset URLs with exact encoding for colour codes, hashes and spaces', () => {
  assert.equal(
    buildAssetUrl('https://assets.vale.cc.cd', '§a Pack #1', 'cover.png'),
    'https://assets.vale.cc.cd/%C2%A7a%20Pack%20%231/cover.png'
  );
  assert.equal(
    buildAssetUrl('https://assets.vale.cc.cd/', '$hyGuy$', 'diamond sword.png'),
    'https://assets.vale.cc.cd/%24hyGuy%24/diamond%20sword.png'
  );
  assert.equal(buildObjectKey('§a Pack #1', 'cover.png'), '§a Pack #1/cover.png');
});

test('uploads an asset with a signed request and verifies the returned etag', async () => {
  const stub = await startStub();
  try {
    const remote = createRemote(stub.endpoint);
    const body = Buffer.from('fake-png-bytes');
    const result = await remote.uploadAsset({ pack: '§a Pack #1', file: 'cover.png', body });
    assert.equal(result.uploaded, true);
    assert.equal(result.etag, md5Hex(body));
    assert.equal(result.url, 'https://assets.vale.cc.cd/%C2%A7a%20Pack%20%231/cover.png');

    assert.equal(stub.requests.length, 2);
    const [head, put] = stub.requests;
    assert.equal(head.method, 'HEAD');
    assert.equal(put.method, 'PUT');
    assert.equal(put.url, '/stub-bucket/%C2%A7a%20Pack%20%231/cover.png');
    assert.deepEqual(put.body, body);
    assert.match(put.headers.authorization,
      /^AWS4-HMAC-SHA256 Credential=test-key\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/);
    assert.equal(put.headers['x-amz-content-sha256'], sha256Hex(body));
  } finally {
    await stub.close();
  }
});

test('re-uploading an unchanged object skips it; a rerun after interruption only sends what is missing', async () => {
  const stub = await startStub();
  try {
    const bodyA = Buffer.from('asset-a');
    const bodyB = Buffer.from('asset-b');

    // First run uploads A and B, then "crashes" before C.
    const first = createRemote(stub.endpoint);
    await first.uploadAsset({ pack: 'Pack', file: 'a.png', body: bodyA });
    await first.uploadAsset({ pack: 'Pack', file: 'b.png', body: bodyB });
    assert.equal(stub.requests.filter(r => r.method === 'PUT').length, 2);

    // Immediate duplicate within a run is a no-op.
    const dupe = await first.uploadAsset({ pack: 'Pack', file: 'a.png', body: bodyA });
    assert.deepEqual(dupe, {
      uploaded: false, skipped: true, etag: md5Hex(bodyA),
      url: 'https://assets.vale.cc.cd/Pack/a.png',
    });
    assert.equal(stub.requests.filter(r => r.method === 'PUT').length, 2);

    // Second run (fresh client, same remote state) resumes: A and B verified by
    // HEAD and skipped, only C is actually sent.
    const second = createRemote(stub.endpoint);
    const resumeA = await second.uploadAsset({ pack: 'Pack', file: 'a.png', body: bodyA });
    const resumeB = await second.uploadAsset({ pack: 'Pack', file: 'b.png', body: bodyB });
    const resumeC = await second.uploadAsset({ pack: 'Pack', file: 'c.png', body: Buffer.from('asset-c') });
    assert.equal(resumeA.skipped, true);
    assert.equal(resumeB.skipped, true);
    assert.equal(resumeC.uploaded, true);
    const puts = stub.requests.filter(r => r.method === 'PUT');
    assert.equal(puts.length, 3);
    assert.equal(puts[2].url, '/stub-bucket/Pack/c.png');

    // A changed body under an existing key is re-sent (etag mismatch).
    const changed = await second.uploadAsset({ pack: 'Pack', file: 'a.png', body: Buffer.from('asset-a-v2') });
    assert.equal(changed.uploaded, true);
    assert.equal(stub.requests.filter(r => r.method === 'PUT').length, 4);
  } finally {
    await stub.close();
  }
});

test('headAsset returns null for missing objects and metadata for existing ones', async () => {
  const stub = await startStub();
  try {
    const remote = createRemote(stub.endpoint);
    assert.equal(await remote.headAsset('Pack', 'missing.png'), null);
    const body = Buffer.from('present');
    await remote.uploadAsset({ pack: 'Pack', file: 'present.png', body });
    const head = await remote.headAsset('Pack', 'present.png');
    assert.equal(head.etag, md5Hex(body));
    assert.equal(head.size, body.length);
  } finally {
    await stub.close();
  }
});

test('resolveAssetBase maps migrated packs to the remote base and keeps the rest local', () => {
  const config = { remote: { base: 'https://assets.vale.cc.cd', packs: ['§a Pack #1'] } };
  assert.equal(resolveAssetBase(config, '§a Pack #1'), 'https://assets.vale.cc.cd');
  assert.equal(resolveAssetBase(config, 'Other Pack'), '/thumbnails');
  assert.equal(resolveAssetBase(null, '§a Pack #1'), '/thumbnails');
  assert.equal(resolveAssetBase({}, '§a Pack #1'), '/thumbnails');
  assert.equal(resolveAssetBase({ remote: { packs: ['x'] } }, 'x'), '/thumbnails');
});
