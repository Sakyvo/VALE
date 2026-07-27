const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { computeRegistryDigest } = require('../scripts/lib/pack-content-index');
const {
  collectAssetTargets,
  productionPaths,
  verifyDeploymentOnce,
} = require('../scripts/lib/normalization-production-services');

test('production paths include the resolved catalog inputs used by production services', () => {
  const paths = productionPaths();
  assert.equal(paths.extractedPath, path.join(__dirname, '..', 'data', 'extracted.json'));
  assert.equal(paths.registryPath, path.join(__dirname, '..', 'data', 'pack-registry.json'));
  assert.equal(paths.siteIndexPath, path.join(__dirname, '..', 'data', 'index.json'));
  assert.equal(paths.listsPath, path.join(__dirname, '..', 'l', 'lists.json'));
  assert.equal(paths.contentIndexPath, path.join(__dirname, '..', 'data', 'internal', 'pack-content-index.json'));
});

test('collects only visible staged products that need local assets', () => {
  const targets = collectAssetTargets({
    entries: [
      {
        status: 'staged_verified', packId: 'Public', visibility: { public: true }, siteSnapshot: {},
        target: { repo: 'packs-005', file: 'Public.zip' },
      },
      {
        status: 'staged_verified', packId: 'Hidden', visibility: { public: false }, siteSnapshot: {},
        target: { repo: 'packs-005', file: 'Hidden.zip' },
      },
      {
        status: 'staged_verified', packId: 'Extracted', visibility: { public: false }, siteSnapshot: { extracted: {} },
        target: { repo: 'packs-006', file: 'Extracted.zip' },
      },
    ],
  }, {
    entries: [{
      status: 'staged_verified', visibility: { public: true }, siteSnapshot: {},
      products: [
        { repo: 'packs-006', file: 'Child.zip', packId: 'Child', reused: false },
        { repo: 'packs-001', file: 'Existing.zip', packId: 'Existing', reused: true },
      ],
    }],
  });
  assert.deepEqual(targets.map(target => target.file), ['Public.zip', 'Extracted.zip', 'Child.zip']);
});

test('deployment verification compares prepared catalogs, routes, downloads, and SBI metadata', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-deployment-verify-'));
  const serverState = { staleRegistry: false };
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/download/One.zip') {
      response.writeHead(200, { 'content-length': 12, 'content-type': 'application/zip' });
      response.end(request.method === 'HEAD' ? undefined : Buffer.alloc(12));
      return;
    }
    if (pathname === '/p/One/') {
      response.writeHead(200, { 'content-type': 'text/html' }).end('<html></html>');
      return;
    }
    const files = {
      '/data/pack-registry.json': 'registry.json',
      '/data/index.json': 'index.json',
      '/l/lists.json': 'lists.json',
      '/data/extracted.json': 'extracted.json',
      '/data/sbi-fp/meta.json': 'sbi-meta.json',
      '/data/packs/One.json': 'One.json',
    };
    if (!files[pathname] || pathname === '/data/sbi-fingerprints.json') {
      response.writeHead(404).end();
      return;
    }
    const value = JSON.parse(fs.readFileSync(path.join(root, files[pathname]), 'utf8'));
    if (pathname === '/data/pack-registry.json' && serverState.staleRegistry) {
      value['One.zip'].repo = 'packs-001';
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}/`;
    const downloadUrl = `${baseUrl}download/One.zip`;
    const registry = { 'One.zip': { repo: 'packs-002', repoNum: 2, size: 12 } };
    const siteIndex = { items: [{ id: 'One', name: 'One' }] };
    const lists = [{ name: 'Sakyvo', packs: ['One'] }];
    const pack = { id: 'One', name: 'One', downloads: { github: downloadUrl } };
    fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify(registry));
    fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify(siteIndex));
    fs.writeFileSync(path.join(root, 'lists.json'), JSON.stringify(lists));
    fs.writeFileSync(path.join(root, 'extracted.json'), '[]');
    fs.writeFileSync(path.join(root, 'sbi-meta.json'), JSON.stringify({ shards: {} }));
    fs.writeFileSync(path.join(root, 'One.json'), JSON.stringify(pack));
    const contentIndexPath = path.join(root, 'content-index.json');
    fs.writeFileSync(contentIndexPath, JSON.stringify({
      schemaVersion: 1,
      fingerprintSchemaVersion: 1,
      registryDigest: computeRegistryDigest(registry),
      complete: true,
      failures: [],
      packs: {
        'One.zip': {
          packId: 'One', visualContentHash: 'visual', archiveSha256: 'archive',
          repo: 'packs-002', repoNum: 2, size: 12,
        },
      },
    }));
    const options = {
      baseUrl,
      registryPath: path.join(root, 'registry.json'),
      siteIndexPath: path.join(root, 'index.json'),
      listsPath: path.join(root, 'lists.json'),
      extractedPath: path.join(root, 'extracted.json'),
      contentIndexPath,
      packDataRoot: root,
      sbiMetaPath: path.join(root, 'sbi-meta.json'),
      legacySbiPath: path.join(root, 'legacy-sbi.json'),
      manifest: { entries: [] },
      review: { entries: [] },
      approvalDigest: 'approved',
      downloadUrlBuilder: () => downloadUrl,
      requestAttempts: 1,
    };
    const result = await verifyDeploymentOnce(options);
    assert.deepEqual(result, { registryCount: 1, publicPackCount: 1, listCount: 1 });

    serverState.staleRegistry = true;
    await assert.rejects(() => verifyDeploymentOnce(options), /deployed registry/i);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
