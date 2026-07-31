const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_WORKDIR = path.resolve(ROOT, '..', '.vale-pack-upload');
const MARKER = '.vale-reviewed-normalization';

function assertRepo(repo) {
  if (!/^packs-\d{3}$/.test(String(repo || ''))) {
    throw new Error(`Invalid pack repository: ${repo || '(missing)'}`);
  }
  return repo;
}

function assertArchiveFile(file) {
  const value = String(file || '');
  if (!value || value.includes('\0') || value.includes('/') || value.includes('\\') ||
      path.basename(value) !== value || !value.toLowerCase().endsWith('.zip')) {
    throw new Error(`Invalid pack archive filename: ${value || '(missing)'}`);
  }
  return value;
}

function archivePath(file) {
  return `resourcepacks/${assertArchiveFile(file)}`;
}

function buildRawArchiveUrl(owner, repo, file, nonce = '', reference = 'main') {
  assertRepo(repo);
  assertArchiveFile(file);
  const base = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(reference)}/resourcepacks/${encodeURIComponent(file)}`;
  return nonce ? `${base}?vale=${encodeURIComponent(nonce)}` : base;
}

function run(command, args, options = {}) {
  const output = execFileSync(command, args, {
    encoding: options.encoding === null ? null : 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout || 20 * 60 * 1000,
    ...options,
  });
  return output == null ? '' : output.toString().trim();
}

function git(repoDir, args, options = {}) {
  return run('git', ['-C', repoDir, ...args], options);
}

function gitExists(repoDir, object) {
  try {
    git(repoDir, ['cat-file', '-e', object]);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function waitSync(milliseconds) {
  if (milliseconds > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  }
}

function pushCommitWithRetry(options) {
  const attempts = Math.max(1, Number(options.attempts) || 4);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      options.push();
      return;
    } catch (error) {
      lastError = error;
      try {
        if (options.remoteHead() === options.commit) return;
      } catch {
        // The next push attempt also rechecks the remote state.
      }
    }
    if (attempt < attempts) {
      (options.wait || waitSync)(Math.min(5000, 500 * (2 ** (attempt - 1))));
    }
  }
  throw new Error(`Git push failed after ${attempts} attempts: ${options.repo}@${options.commit}`, {
    cause: lastError,
  });
}

function parseContentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(value || ''));
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

async function hashResponse(response, hash) {
  const nextHash = hash.copy();
  let size = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    size += chunk.length;
    nextHash.update(chunk);
  }
  return { hash: nextHash, size };
}

function curlRange(command, url, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutSeconds = Math.max(1, Math.ceil((Number(options.timeoutMs) || 10 * 60 * 1000) / 1000));
    const args = [
      '--silent', '--show-error', '--location', '--fail',
      '--header', 'Accept-Encoding: identity',
      '--range', `${options.start}-${options.end}`,
      '--max-time', String(timeoutSeconds),
      '--write-out', '%{stderr}VALE_HTTP_STATUS:%{http_code}',
    ];
    if (options.noProxy) args.push('--noproxy', options.noProxy);
    args.push(url);
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let size = 0;
    let stderr = '';
    let spawnError = null;
    let streamError = null;
    child.stdout.on('data', chunk => {
      if (streamError) return;
      size += chunk.length;
      try {
        options.onChunk(chunk);
      } catch (error) {
        streamError = error;
        child.kill();
      }
    });
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });
    child.on('error', error => {
      spawnError = error;
    });
    child.on('close', code => {
      if (streamError) {
        reject(streamError);
        return;
      }
      if (spawnError) {
        reject(spawnError);
        return;
      }
      const match = /VALE_HTTP_STATUS:(\d{3})/.exec(stderr);
      const status = match ? Number(match[1]) : 0;
      if (code !== 0) {
        const detail = stderr.replace(/VALE_HTTP_STATUS:\d{3}/g, '').trim();
        const error = new Error(`curl archive request failed (${code}, HTTP ${status || 'unknown'}): ${detail}`);
        error.status = status;
        reject(error);
        return;
      }
      resolve({ size, status, detail: stderr.trim() });
    });
  });
}

async function fetchArchive(url, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 4);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers: { 'accept-encoding': 'identity', ...(options.headers || {}) },
        redirect: 'follow',
        signal: AbortSignal.timeout(Number(options.timeoutMs) || 10 * 60 * 1000),
      });
      if (response.status === 404) return null;
      if (response.ok) return response;
      const detail = (await response.text()).slice(0, 300);
      const error = new Error(`GitHub archive request failed (${response.status}): ${detail}`);
      if (![408, 429, 500, 502, 503, 504].includes(response.status)) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await delay(Math.min(5000, 500 * (2 ** (attempt - 1))));
  }
  throw lastError;
}

function createGitHubPackRemote(options = {}) {
  const owner = options.owner || 'Sakyvo';
  const workdir = path.resolve(options.workdir || DEFAULT_WORKDIR);
  const repoUrl = options.repoUrl || (repo => `https://github.com/${owner}/${repo}.git`);
  const rawUrl = options.rawUrl || ((repo, file, nonce, reference) => buildRawArchiveUrl(owner, repo, file, nonce, reference));
  const allowCreateRepo = options.allowCreateRepo !== false;
  const mutation = Boolean(options.mutation);
  const clones = new Map();
  const remoteHeads = new Map();
  const markerToken = crypto.randomBytes(16).toString('hex');
  let ownsWorkdir = false;

  if (mutation && fs.existsSync(workdir)) {
    throw new Error(`Temporary upload workspace already exists: ${workdir}`);
  }

  function ensureWorkspace() {
    if (ownsWorkdir) return;
    if (fs.existsSync(workdir)) throw new Error(`Temporary upload workspace already exists: ${workdir}`);
    fs.mkdirSync(workdir, { recursive: true });
    fs.writeFileSync(path.join(workdir, MARKER), markerToken);
    ownsWorkdir = true;
  }

  function initializeEmptyRepo(repo, repoDir) {
    git(repoDir, ['switch', '--orphan', 'main']);
    fs.writeFileSync(path.join(repoDir, 'README.md'), `# ${repo}\nResource pack storage for VALE.\n`);
    git(repoDir, ['add', '--', 'README.md']);
    git(repoDir, ['-c', 'user.name=VALE normalization', '-c', 'user.email=vale@localhost', 'commit', '-m', 'init']);
    git(repoDir, ['push', '-u', 'origin', 'main'], { stdio: 'inherit' });
    git(repoDir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  }

  function createRepository(repo) {
    if (!allowCreateRepo) throw new Error(`Pack repository does not exist: ${owner}/${repo}`);
    try {
      run('gh', ['repo', 'view', `${owner}/${repo}`, '--json', 'name']);
      throw new Error(`Pack repository exists but could not be cloned: ${owner}/${repo}`);
    } catch (error) {
      if (/exists but could not be cloned/.test(error.message)) throw error;
    }
    run('gh', ['repo', 'create', `${owner}/${repo}`, '--public', '--description', 'Resource pack storage for VALE.'], {
      stdio: 'inherit',
    });
  }

  function ensureClone(repo) {
    assertRepo(repo);
    if (clones.has(repo)) return clones.get(repo);
    ensureWorkspace();
    const repoDir = path.join(workdir, repo);
    try {
      run('git', ['clone', '--filter=blob:none', '--no-checkout', repoUrl(repo), repoDir], { stdio: 'inherit' });
    } catch (cloneError) {
      if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
      createRepository(repo);
      run('git', ['clone', '--filter=blob:none', '--no-checkout', repoUrl(repo), repoDir], { stdio: 'inherit' });
    }
    if (!gitExists(repoDir, 'refs/remotes/origin/main')) initializeEmptyRepo(repo, repoDir);
    clones.set(repo, repoDir);
    return repoDir;
  }

  function resolveRemoteHead(repo) {
    if (remoteHeads.has(repo)) return remoteHeads.get(repo);
    const repoDir = clones.get(repo);
    const head = repoDir
      ? git(repoDir, ['rev-parse', 'refs/remotes/origin/main'])
      : run('git', ['ls-remote', repoUrl(repo), 'refs/heads/main']).split(/\s+/)[0];
    if (!/^[a-f0-9]{40,64}$/.test(head)) {
      throw new Error(`Pack repository main branch is missing: ${owner}/${repo}`);
    }
    remoteHeads.set(repo, head);
    return head;
  }

  function getRepositoryReference(repo, options = {}) {
    assertRepo(repo);
    if (options.refresh) {
      remoteHeads.delete(repo);
      const repoDir = clones.get(repo);
      if (repoDir) git(repoDir, ['fetch', 'origin', 'main']);
    }
    return resolveRemoteHead(repo);
  }

  function mutateRepository(repo, file, operation, sourcePath) {
    const repoDir = ensureClone(repo);
    const targetPath = archivePath(file);
    git(repoDir, ['fetch', 'origin', 'main']);
    const parent = git(repoDir, ['rev-parse', 'refs/remotes/origin/main']);
    const indexPath = path.join(repoDir, '.git', 'vale-normalization-index');
    fs.rmSync(indexPath, { force: true });
    const env = { ...process.env, GIT_INDEX_FILE: indexPath };
    try {
      git(repoDir, ['read-tree', parent], { env });
      if (operation === 'add') {
        if (gitExists(repoDir, `${parent}:${targetPath}`)) {
          throw new Error(`Target archive already exists in ${repo}: ${file}`);
        }
        const blob = git(repoDir, ['hash-object', '-w', '--', sourcePath]);
        git(repoDir, ['update-index', '--add', '--cacheinfo', '100644', blob, targetPath], { env });
      } else {
        if (!gitExists(repoDir, `${parent}:${targetPath}`)) return false;
        git(repoDir, ['update-index', '--force-remove', '--', targetPath], { env });
      }
      const tree = git(repoDir, ['write-tree', '--missing-ok'], { env });
      const message = operation === 'add' ? `stage normalized ${file}` : `retire ${file}`;
      const commit = git(repoDir, [
        '-c', 'user.name=VALE normalization',
        '-c', 'user.email=vale@localhost',
        'commit-tree', tree, '-p', parent, '-m', message,
      ]);
      pushCommitWithRetry({
        repo,
        commit,
        attempts: options.pushAttempts,
        push: () => git(repoDir, ['push', 'origin', `${commit}:refs/heads/main`], { stdio: 'inherit' }),
        remoteHead: () => {
          git(repoDir, ['fetch', 'origin', 'main']);
          return git(repoDir, ['rev-parse', 'refs/remotes/origin/main']);
        },
      });
      git(repoDir, ['update-ref', 'refs/remotes/origin/main', commit]);
      remoteHeads.set(repo, commit);
      return true;
    } finally {
      fs.rmSync(indexPath, { force: true });
    }
  }

  async function getArchiveIdentity({ repo, file, size: expectedSize }) {
    assertRepo(repo);
    assertArchiveFile(file);
    const repoDir = clones.get(repo);
    let reference = resolveRemoteHead(repo);
    if (repoDir) {
      if (!gitExists(repoDir, `${reference}:${archivePath(file)}`)) return null;
    }
    const attempts = Math.max(1, Number(options.identityAttempts) || Number(options.fetchOptions?.attempts) || 4);
    const chunkSize = Math.max(1, Number(options.rangeChunkSize) || 16 * 1024 * 1024);
    if (options.transport === 'curl') {
      const total = Number(expectedSize);
      if (!Number.isSafeInteger(total) || total <= 0) {
        throw new Error(`Curl archive identity requires an expected size: ${repo}/${file}`);
      }
      const command = options.curlCommand || (process.platform === 'win32' ? 'curl.exe' : 'curl');
      let hash = crypto.createHash('sha256');
      for (let offset = 0; offset < total;) {
        const end = Math.min(total - 1, offset + chunkSize - 1);
        const expectedChunkSize = end - offset + 1;
        let lastError;
        let complete = false;
        for (let attempt = 1; attempt <= attempts; attempt++) {
          try {
            const nextHash = hash.copy();
            const nonce = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
            const result = await curlRange(command, rawUrl(repo, file, nonce, reference), {
              start: offset,
              end,
              timeoutMs: options.fetchOptions?.timeoutMs,
              noProxy: options.curlNoProxy,
              onChunk: chunk => nextHash.update(chunk),
            });
            if (result.status === 200 && offset === 0 && result.size === total) {
              return { size: total, archiveSha256: nextHash.digest('hex') };
            }
            if (result.status !== 206 || result.size !== expectedChunkSize) {
              throw new Error(`Invalid curl archive range: HTTP ${result.status}, expected ${expectedChunkSize}, received ${result.size}: ${result.detail}`);
            }
            hash = nextHash;
            offset = end + 1;
            complete = true;
            break;
          } catch (error) {
            if (error.status === 404 && offset === 0) return null;
            lastError = error;
          }
          if (attempt < attempts) await delay(Math.min(5000, 500 * (2 ** (attempt - 1))));
        }
        if (!complete) {
          throw new Error(`Remote archive identity failed: ${repo}/${file}: ${lastError.message}`, { cause: lastError });
        }
      }
      return { size: total, archiveSha256: hash.digest('hex') };
    }
    let hash = crypto.createHash('sha256');
    let offset = 0;
    let total = null;
    while (total == null || offset < total) {
      const requestedEnd = total == null
        ? offset + chunkSize - 1
        : Math.min(total - 1, offset + chunkSize - 1);
      let lastError;
      let complete = false;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const headers = { ...(options.fetchOptions?.headers || {}), range: `bytes=${offset}-${requestedEnd}` };
          const nonce = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
          const response = await fetchArchive(rawUrl(repo, file, nonce, reference), {
            ...options.fetchOptions,
            attempts: 1,
            headers,
          });
          if (!response) {
            if (offset === 0) return null;
            throw new Error('Archive disappeared during ranged identity read');
          }
          if (!response.body) throw new Error(`Archive response has no body: ${repo}/${file}`);
          if (offset === 0 && response.status === 200) {
            const result = await hashResponse(response, hash);
            return { size: result.size, archiveSha256: result.hash.digest('hex') };
          }
          const contentRange = response.status === 206
            ? parseContentRange(response.headers.get('content-range'))
            : null;
          if (!contentRange || contentRange.start !== offset || contentRange.end > requestedEnd ||
              contentRange.end < contentRange.start || contentRange.total <= contentRange.end ||
              (total != null && contentRange.total !== total)) {
            if (response.body) await response.body.cancel();
            throw new Error(`Invalid archive range response: ${response.status} ${response.headers.get('content-range') || '(missing)'}`);
          }
          const result = await hashResponse(response, hash);
          const expectedSize = contentRange.end - contentRange.start + 1;
          if (result.size !== expectedSize) {
            throw new Error(`Incomplete archive range: expected ${expectedSize}, received ${result.size}`);
          }
          hash = result.hash;
          total = contentRange.total;
          offset = contentRange.end + 1;
          complete = true;
          break;
        } catch (error) {
          lastError = error;
        }
        if (attempt < attempts) await delay(Math.min(5000, 500 * (2 ** (attempt - 1))));
      }
      if (!complete) {
        throw new Error(`Remote archive identity failed: ${repo}/${file}: ${lastError.message}`, { cause: lastError });
      }
    }
    return { size: total, archiveSha256: hash.digest('hex') };
  }

  async function downloadArchive({ repo, file, size: expectedSize, registryEntry, destination }) {
    assertRepo(repo);
    assertArchiveFile(file);
    const attempts = Math.max(1, Number(options.downloadAttempts) || Number(options.fetchOptions?.attempts) || 4);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (options.transport === 'curl') {
      const total = Number(expectedSize ?? registryEntry?.size);
      if (!Number.isSafeInteger(total) || total <= 0) {
        throw new Error(`Curl archive download requires an expected size: ${repo}/${file}`);
      }
      const command = options.curlCommand || (process.platform === 'win32' ? 'curl.exe' : 'curl');
      const chunkSize = Math.max(1, Number(options.rangeChunkSize) || 16 * 1024 * 1024);
      let descriptor;
      let succeeded = false;
      try {
        descriptor = fs.openSync(destination, 'wx');
        for (let offset = 0; offset < total;) {
          const end = Math.min(total - 1, offset + chunkSize - 1);
          const expectedChunkSize = end - offset + 1;
          let lastError;
          let complete = false;
          for (let attempt = 1; attempt <= attempts; attempt++) {
            fs.ftruncateSync(descriptor, offset);
            let writeOffset = offset;
            try {
              const nonce = `${Date.now()}-download-${crypto.randomBytes(6).toString('hex')}`;
              const result = await curlRange(command, rawUrl(repo, file, nonce), {
                start: offset,
                end,
                timeoutMs: options.fetchOptions?.timeoutMs,
                noProxy: options.curlNoProxy,
                onChunk(chunk) {
                  for (let cursor = 0; cursor < chunk.length;) {
                    const written = fs.writeSync(
                      descriptor, chunk, cursor, chunk.length - cursor, writeOffset
                    );
                    if (written <= 0) throw new Error(`Unable to write archive range: ${repo}/${file}`);
                    cursor += written;
                    writeOffset += written;
                  }
                },
              });
              if (result.status === 200 && offset === 0 && result.size === total) {
                succeeded = true;
                return;
              }
              if (result.status !== 206 || result.size !== expectedChunkSize) {
                throw new Error(`Invalid curl archive range: HTTP ${result.status}, expected ${expectedChunkSize}, received ${result.size}: ${result.detail}`);
              }
              offset = end + 1;
              complete = true;
              break;
            } catch (error) {
              lastError = error;
            }
            if (attempt < attempts) await delay(Math.min(5000, 500 * (2 ** (attempt - 1))));
          }
          if (!complete) {
            throw new Error(`Remote archive download failed: ${repo}/${file}: ${lastError.message}`, { cause: lastError });
          }
        }
        succeeded = true;
        return;
      } finally {
        if (descriptor != null) fs.closeSync(descriptor);
        if (!succeeded) fs.rmSync(destination, { force: true });
      }
    }
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const nonce = `${Date.now()}-download-${crypto.randomBytes(6).toString('hex')}`;
        const response = await fetchArchive(rawUrl(repo, file, nonce), { ...options.fetchOptions, attempts: 1 });
        if (!response || !response.body) throw new Error(`Remote archive is missing: ${repo}/${file}`);
        await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination, { flags: 'wx' }));
        return;
      } catch (error) {
        lastError = error;
      }
      fs.rmSync(destination, { force: true });
      if (attempt < attempts) await delay(Math.min(5000, 500 * (2 ** (attempt - 1))));
    }
    throw new Error(`Remote archive download failed: ${repo}/${file}: ${lastError.message}`, { cause: lastError });
  }

  async function publishArchive({ repo, file, path: sourcePath }) {
    assertRepo(repo);
    assertArchiveFile(file);
    if (!sourcePath || !fs.statSync(sourcePath).isFile()) throw new Error(`Normalized archive is missing: ${sourcePath}`);
    mutateRepository(repo, file, 'add', sourcePath);
  }

  async function verifyArchive(expected) {
    const attempts = Math.max(1, Number(options.verifyAttempts) || 10);
    let actual = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      actual = await getArchiveIdentity(expected);
      if (actual && Number(actual.size) === Number(expected.size) &&
          actual.archiveSha256 === expected.archiveSha256) {
        return actual;
      }
      if (attempt < attempts) await delay(Math.min(10000, 1000 * (2 ** (attempt - 1))));
    }
    throw new Error(`Published archive verification failed: ${expected.repo}/${expected.file}`);
  }

  async function deleteArchive({ repo, file }) {
    assertRepo(repo);
    assertArchiveFile(file);
    mutateRepository(repo, file, 'delete');
  }

  function close() {
    clones.clear();
    if (!ownsWorkdir) return;
    const markerPath = path.join(workdir, MARKER);
    if (!fs.existsSync(markerPath) || fs.readFileSync(markerPath, 'utf8') !== markerToken) {
      throw new Error(`Refusing to clean unowned upload workspace: ${workdir}`);
    }
    fs.rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    ownsWorkdir = false;
  }

  return {
    close,
    deleteArchive,
    downloadArchive,
    getArchiveIdentity,
    getRepositoryReference,
    publishArchive,
    verifyArchive,
    workdir,
  };
}

module.exports = {
  DEFAULT_WORKDIR,
  archivePath,
  assertArchiveFile,
  assertRepo,
  buildRawArchiveUrl,
  createGitHubPackRemote,
  fetchArchive,
  pushCommitWithRetry,
};
