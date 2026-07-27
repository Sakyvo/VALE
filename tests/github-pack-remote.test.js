const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const {
  assertArchiveFile,
  assertRepo,
  buildRawArchiveUrl,
  createGitHubPackRemote,
  pushCommitWithRetry,
} = require('../scripts/lib/github-pack-remote');

function git(args, options = {}) {
  return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

test('validates pack repository identities and encodes raw archive URLs', () => {
  assert.equal(assertRepo('packs-006'), 'packs-006');
  assert.equal(assertArchiveFile('§a Pack #1.zip'), '§a Pack #1.zip');
  assert.equal(
    buildRawArchiveUrl('Sakyvo', 'packs-006', '§a Pack #1.zip'),
    'https://raw.githubusercontent.com/Sakyvo/packs-006/main/resourcepacks/%C2%A7a%20Pack%20%231.zip'
  );
  assert.throws(() => assertRepo('VALE'), /Invalid pack repository/);
  assert.throws(() => assertArchiveFile('../Pack.zip'), /Invalid pack archive filename/);
  assert.throws(() => assertArchiveFile('folder/Pack.zip'), /Invalid pack archive filename/);
});

test('retries an interrupted git push and accepts an ambiguously successful push', () => {
  let attempts = 0;
  const commit = 'a'.repeat(40);
  pushCommitWithRetry({
    repo: 'packs-006',
    commit,
    attempts: 3,
    push() {
      attempts++;
      if (attempts === 1) throw new Error('curl 55 Send failure: Connection was reset');
    },
    remoteHead: () => 'b'.repeat(40),
    wait() {},
  });
  assert.equal(attempts, 2);

  attempts = 0;
  pushCommitWithRetry({
    repo: 'packs-006',
    commit,
    attempts: 3,
    push() {
      attempts++;
      throw new Error('remote disconnected after accepting the update');
    },
    remoteHead: () => commit,
    wait() {},
  });
  assert.equal(attempts, 1);
});

test('streams archive identities and downloads without retaining response bytes', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-github-remote-http-'));
  const payload = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(64 * 1024, 37)]);
  const server = http.createServer((request, response) => {
    if (request.url.includes('Missing.zip')) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/zip', 'content-length': payload.length });
    response.end(payload);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const remote = createGitHubPackRemote({
    allowCreateRepo: false,
    rawUrl: (_repo, file) => `http://127.0.0.1:${address.port}/${encodeURIComponent(file)}`,
  });
  try {
    const identity = await remote.getArchiveIdentity({ repo: 'packs-001', file: 'Pack.zip' });
    assert.equal(identity.size, payload.length);
    assert.match(identity.archiveSha256, /^[a-f0-9]{64}$/);
    assert.equal(await remote.getArchiveIdentity({ repo: 'packs-001', file: 'Missing.zip' }), null);
    const destination = path.join(root, 'download', 'Pack.zip');
    await remote.downloadArchive({ repo: 'packs-001', file: 'Pack.zip', destination });
    assert.deepEqual(fs.readFileSync(destination), payload);
  } finally {
    remote.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('retries archive identity when the response stream fails after headers', async () => {
  const payload = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('retry-body')]);
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests++;
    response.writeHead(200, { 'content-type': 'application/zip', 'content-length': payload.length });
    if (requests === 1) {
      response.flushHeaders();
      response.write(payload.subarray(0, 5));
      setTimeout(() => response.destroy(), 50);
      return;
    }
    response.end(payload);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const remote = createGitHubPackRemote({
    allowCreateRepo: false,
    fetchOptions: { attempts: 2, timeoutMs: 1000 },
    rawUrl: () => `http://127.0.0.1:${address.port}/Pack.zip`,
  });
  try {
    const identity = await remote.getArchiveIdentity({ repo: 'packs-001', file: 'Pack.zip' });
    assert.equal(requests, 2);
    assert.deepEqual(identity, {
      size: 14,
      archiveSha256: '30b97f3b6350701958c405c2bcb7e33ed8094291600eb7297682a89f246ccce9',
    });
  } finally {
    remote.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('hashes archive ranges and retries only the interrupted chunk', async () => {
  const payload = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('retry-body')]);
  const ranges = [];
  let secondChunkAttempts = 0;
  const server = http.createServer((request, response) => {
    const range = request.headers.range;
    ranges.push(range);
    const match = /^bytes=(\d+)-(\d+)$/.exec(range || '');
    if (!match) {
      response.writeHead(400).end();
      return;
    }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), payload.length - 1);
    const chunk = payload.subarray(start, end + 1);
    response.writeHead(206, {
      'content-length': chunk.length,
      'content-range': `bytes ${start}-${end}/${payload.length}`,
    });
    if (start === 8 && secondChunkAttempts++ === 0) {
      response.flushHeaders();
      response.write(chunk.subarray(0, 2));
      setTimeout(() => response.destroy(), 50);
      return;
    }
    response.end(chunk);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const remote = createGitHubPackRemote({
    allowCreateRepo: false,
    rangeChunkSize: 8,
    fetchOptions: { attempts: 2, timeoutMs: 1000 },
    rawUrl: () => `http://127.0.0.1:${address.port}/Pack.zip`,
  });
  try {
    assert.deepEqual(
      await remote.getArchiveIdentity({ repo: 'packs-001', file: 'Pack.zip' }),
      {
        size: 14,
        archiveSha256: '30b97f3b6350701958c405c2bcb7e33ed8094291600eb7297682a89f246ccce9',
      }
    );
    assert.deepEqual(ranges, ['bytes=0-7', 'bytes=8-13', 'bytes=8-13']);
  } finally {
    remote.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('curl transport hashes ranges and retries only the interrupted chunk', async () => {
  const payload = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('retry-body')]);
  const ranges = [];
  let secondChunkAttempts = 0;
  const server = http.createServer((request, response) => {
    if (!/^curl\//.test(request.headers['user-agent'] || '')) {
      response.writeHead(400).end();
      return;
    }
    const range = request.headers.range;
    ranges.push(range);
    const match = /^bytes=(\d+)-(\d+)$/.exec(range || '');
    const start = Number(match && match[1]);
    const end = Math.min(Number(match && match[2]), payload.length - 1);
    const chunk = payload.subarray(start, end + 1);
    response.writeHead(206, {
      'content-length': chunk.length,
      'content-range': `bytes ${start}-${end}/${payload.length}`,
    });
    if (start === 8 && secondChunkAttempts++ === 0) {
      response.flushHeaders();
      response.write(chunk.subarray(0, 2));
      setTimeout(() => response.destroy(), 50);
      return;
    }
    response.end(chunk);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const remote = createGitHubPackRemote({
    allowCreateRepo: false,
    transport: 'curl',
    curlNoProxy: '*',
    rangeChunkSize: 8,
    fetchOptions: { attempts: 2, timeoutMs: 1000 },
    rawUrl: () => `http://127.0.0.1:${address.port}/Pack.zip`,
  });
  try {
    assert.deepEqual(
      await remote.getArchiveIdentity({ repo: 'packs-001', file: 'Pack.zip', size: payload.length }),
      {
        size: 14,
        archiveSha256: '30b97f3b6350701958c405c2bcb7e33ed8094291600eb7297682a89f246ccce9',
      }
    );
    assert.deepEqual(ranges, ['bytes=0-7', 'bytes=8-13', 'bytes=8-13']);
  } finally {
    remote.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('retries archive downloads after removing a partial response', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-github-remote-retry-'));
  const payload = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(4096, 73)]);
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests++;
    response.writeHead(200, { 'content-type': 'application/zip', 'content-length': payload.length });
    if (requests === 1) {
      response.flushHeaders();
      response.write(payload.subarray(0, 512));
      setTimeout(() => response.destroy(), 50);
      return;
    }
    response.end(payload);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const remote = createGitHubPackRemote({
    allowCreateRepo: false,
    fetchOptions: { attempts: 2, timeoutMs: 1000 },
    rawUrl: () => `http://127.0.0.1:${address.port}/Pack.zip`,
  });
  const destination = path.join(root, 'download', 'Pack.zip');
  try {
    await remote.downloadArchive({ repo: 'packs-001', file: 'Pack.zip', destination });
    assert.equal(requests, 2);
    assert.deepEqual(fs.readFileSync(destination), payload);
  } finally {
    remote.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('curl transport downloads ranges and rewrites only the interrupted chunk', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-github-curl-download-'));
  const payload = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(2048, 73)]);
  const ranges = [];
  let secondChunkAttempts = 0;
  const server = http.createServer((request, response) => {
    if (!/^curl\//.test(request.headers['user-agent'] || '')) {
      response.writeHead(400).end();
      return;
    }
    const range = request.headers.range;
    ranges.push(range);
    const match = /^bytes=(\d+)-(\d+)$/.exec(range || '');
    const start = Number(match && match[1]);
    const end = Math.min(Number(match && match[2]), payload.length - 1);
    const chunk = payload.subarray(start, end + 1);
    response.writeHead(206, {
      'content-length': chunk.length,
      'content-range': `bytes ${start}-${end}/${payload.length}`,
    });
    if (start === 1024 && secondChunkAttempts++ === 0) {
      response.flushHeaders();
      response.write(chunk.subarray(0, 100));
      setTimeout(() => response.destroy(), 50);
      return;
    }
    response.end(chunk);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const remote = createGitHubPackRemote({
    allowCreateRepo: false,
    transport: 'curl',
    curlNoProxy: '*',
    rangeChunkSize: 1024,
    fetchOptions: { attempts: 2, timeoutMs: 1000 },
    rawUrl: () => `http://127.0.0.1:${address.port}/Pack.zip`,
  });
  const destination = path.join(root, 'download', 'Pack.zip');
  try {
    await remote.downloadArchive({
      repo: 'packs-001', file: 'Pack.zip', size: payload.length, destination,
    });
    assert.deepEqual(ranges, [
      'bytes=0-1023', 'bytes=1024-2047', 'bytes=1024-2047', 'bytes=2048-2051',
    ]);
    assert.deepEqual(fs.readFileSync(destination), payload);
  } finally {
    remote.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('publishes and deletes archives through an owned temporary partial clone', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-github-remote-git-'));
  const bare = path.join(root, 'packs-005.git');
  const seed = path.join(root, 'seed');
  const workdir = path.join(root, 'upload-work');
  try {
    git(['init', '--bare', bare]);
    git(['init', '-b', 'main', seed]);
    git(['-C', seed, 'config', 'user.name', 'VALE test']);
    git(['-C', seed, 'config', 'user.email', 'vale-test@localhost']);
    fs.writeFileSync(path.join(seed, 'README.md'), '# packs-005\n');
    git(['-C', seed, 'add', 'README.md']);
    git(['-C', seed, 'commit', '-m', 'init']);
    git(['-C', seed, 'remote', 'add', 'origin', bare]);
    git(['-C', seed, 'push', '-u', 'origin', 'main']);

    const source = path.join(root, 'Product.zip');
    const payload = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(2048, 91)]);
    fs.writeFileSync(source, payload);
    const remote = createGitHubPackRemote({
      allowCreateRepo: false,
      mutation: true,
      repoUrl: () => bare,
      workdir,
    });
    try {
      await remote.publishArchive({ repo: 'packs-005', file: 'Product.zip', path: source });
      const stored = git(['--git-dir', bare, 'show', 'main:resourcepacks/Product.zip'], { encoding: null });
      assert.deepEqual(stored, payload);
      await assert.rejects(
        remote.publishArchive({ repo: 'packs-005', file: 'Product.zip', path: source }),
        /already exists/
      );
      await remote.deleteArchive({ repo: 'packs-005', file: 'Product.zip' });
      assert.throws(() => git(['--git-dir', bare, 'cat-file', '-e', 'main:resourcepacks/Product.zip']));
    } finally {
      remote.close();
    }
    assert.equal(fs.existsSync(workdir), false);

    fs.mkdirSync(workdir);
    assert.throws(
      () => createGitHubPackRemote({ mutation: true, workdir }),
      /already exists/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('publishes without materializing existing promisor blobs', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-github-remote-promisor-'));
  const bare = path.join(root, 'packs-005.git');
  const seed = path.join(root, 'seed');
  const workdir = path.join(root, 'upload-work');
  try {
    git(['init', '--bare', bare]);
    git(['--git-dir', bare, 'config', 'uploadpack.allowFilter', 'true']);
    git(['init', '-b', 'main', seed]);
    git(['-C', seed, 'config', 'user.name', 'VALE test']);
    git(['-C', seed, 'config', 'user.email', 'vale-test@localhost']);
    fs.mkdirSync(path.join(seed, 'resourcepacks'));
    fs.writeFileSync(path.join(seed, 'README.md'), '# packs-005\n');
    fs.writeFileSync(path.join(seed, 'resourcepacks', 'Existing.zip'), Buffer.alloc(2 * 1024 * 1024, 41));
    git(['-C', seed, 'add', 'README.md', 'resourcepacks/Existing.zip']);
    git(['-C', seed, 'commit', '-m', 'seed existing pack']);
    git(['-C', seed, 'remote', 'add', 'origin', bare]);
    git(['-C', seed, 'push', '-u', 'origin', 'main']);
    const existingBlob = git(
      ['-C', seed, 'rev-parse', 'HEAD:resourcepacks/Existing.zip'], { encoding: 'utf8' }
    ).toString().trim();

    const source = path.join(root, 'Product.zip');
    fs.writeFileSync(source, Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(1024, 77)]));
    const remote = createGitHubPackRemote({
      allowCreateRepo: false,
      mutation: true,
      repoUrl: () => pathToFileURL(bare).href,
      workdir,
    });
    try {
      await remote.publishArchive({ repo: 'packs-005', file: 'Product.zip', path: source });
      assert.throws(() => git(
        ['-C', path.join(workdir, 'packs-005'), 'cat-file', '-e', existingBlob],
        { env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } }
      ));
    } finally {
      remote.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
