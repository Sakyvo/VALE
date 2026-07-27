const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  SCHEMA_VERSION: FINGERPRINT_SCHEMA_VERSION,
  stableStringify,
} = require('./pack-content-fingerprint');
const { readJson, validateContentIndex } = require('./pack-content-index');
const { sha256File } = require('./pack-normalizer');
const { createGitHubPackRemote, fetchArchive } = require('./github-pack-remote');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_SITE_BASE_URL = 'https://vale.cc.cd/';

function productionPaths(overrides = {}) {
  return {
    registryPath: path.join(ROOT, 'data', 'pack-registry.json'),
    contentIndexPath: path.join(ROOT, 'data', 'internal', 'pack-content-index.json'),
    siteIndexPath: path.join(ROOT, 'data', 'index.json'),
    listsPath: path.join(ROOT, 'l', 'lists.json'),
    extractedPath: path.join(ROOT, 'data', 'extracted.json'),
    auditPath: path.join(ROOT, 'data', 'internal', 'pack-normalization-audit.json'),
    thumbnailsRoot: path.join(ROOT, 'thumbnails'),
    packDataRoot: path.join(ROOT, 'data', 'packs'),
    packPageRoot: path.join(ROOT, 'p'),
    pagesRoot: path.join(ROOT, 'data', 'pages'),
    sbiShardRoot: path.join(ROOT, 'data', 'sbi-fp'),
    sbiMetaPath: path.join(ROOT, 'data', 'sbi-fp', 'meta.json'),
    legacySbiPath: path.join(ROOT, 'data', 'sbi-fingerprints.json'),
    tombstonePath: path.join(ROOT, 'data', 'internal', 'pack-normalization-illegal-tombstones.json'),
    ...overrides,
  };
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: options.stdio || 'inherit',
    timeout: options.timeout || 4 * 60 * 60 * 1000,
    ...options,
  });
}

function assertProductionPrerequisites(phase) {
  run('git', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
  run(process.platform === 'win32' ? 'curl.exe' : 'curl', ['--version'], {
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
  });
  if (phase === 'stage' || phase === 'cleanup') {
    run('gh', ['auth', 'status'], { stdio: 'inherit', timeout: 30000 });
  }
}

function safePackPath(root, packId, suffix = '') {
  const base = path.resolve(root) + path.sep;
  const target = path.resolve(root, `${packId}${suffix}`);
  if (!target.startsWith(base)) throw new Error(`Pack identity escapes generated root: ${packId}`);
  return target;
}

async function mapConcurrent(items, concurrency, worker) {
  let cursor = 0;
  let failure;
  const workers = Array.from({ length: Math.max(1, Math.min(Number(concurrency) || 1, items.length || 1)) }, async () => {
    while (!failure) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        await worker(items[index], index);
      } catch (error) {
        failure = error;
      }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
}

function collectAssetTargets(single, collection) {
  const targets = [];
  for (const entry of single.entries || []) {
    if (entry.status === 'deferred' || !entry.target) continue;
    if (!entry.visibility.public && !entry.siteSnapshot?.extracted) continue;
    targets.push({ ...entry.target, packId: entry.packId });
  }
  for (const entry of collection.entries || []) {
    if (entry.status === 'deferred') continue;
    if (!entry.visibility.public && !entry.siteSnapshot?.extracted) continue;
    for (const product of entry.products || []) {
      if (!product.reused) targets.push(product);
    }
  }
  const unique = new Map();
  for (const target of targets) unique.set(`${target.repo}\0${target.file}`, target);
  return [...unique.values()];
}

function withNonce(url, nonce) {
  const value = new URL(url);
  value.searchParams.set('vale-normalization', nonce);
  return value.href;
}

function siteUrl(baseUrl, relativePath, nonce) {
  return withNonce(new URL(relativePath.replace(/^\//, ''), baseUrl).href, nonce);
}

async function readDeployedJson(baseUrl, relativePath, nonce, fetchOptions) {
  const response = await fetchArchive(siteUrl(baseUrl, relativePath, nonce), fetchOptions);
  if (!response) throw new Error(`Deployed JSON is missing: ${relativePath}`);
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`Deployed JSON is invalid (${relativePath}): ${error.message}`);
  }
}

async function assertDeployedResource(url, label, fetchOptions, method = 'GET') {
  const response = await fetchArchive(url, { ...fetchOptions, method });
  if (!response) throw new Error(`Deployed resource is missing: ${label}`);
  if (response.body) await response.body.cancel();
}

async function assertDeployedAbsent(baseUrl, relativePath, nonce, fetchOptions) {
  const response = await fetchArchive(siteUrl(baseUrl, relativePath, nonce), fetchOptions);
  if (!response) return;
  if (response.body) await response.body.cancel();
  throw new Error(`Retired deployed resource remains: ${relativePath}`);
}

async function verifyDeploymentOnce(options) {
  const baseUrl = new URL(options.baseUrl || DEFAULT_SITE_BASE_URL);
  if (!['https:', 'http:'].includes(baseUrl.protocol)) throw new Error(`Invalid deployment base URL: ${baseUrl.href}`);
  const nonce = options.approvalDigest || crypto.randomBytes(12).toString('hex');
  const fetchOptions = { attempts: options.requestAttempts || 3, timeoutMs: options.requestTimeoutMs || 60000 };
  const registry = readJson(options.registryPath, {});
  const siteIndex = readJson(options.siteIndexPath, { items: [] });
  const lists = readJson(options.listsPath, []);
  const extracted = readJson(options.extractedPath, []);
  const contentIndex = validateContentIndex(
    readJson(options.contentIndexPath, null),
    registry,
    FINGERPRINT_SCHEMA_VERSION
  );
  const deployed = {
    registry: await readDeployedJson(baseUrl, '/data/pack-registry.json', nonce, fetchOptions),
    siteIndex: await readDeployedJson(baseUrl, '/data/index.json', nonce, fetchOptions),
    lists: await readDeployedJson(baseUrl, '/l/lists.json', nonce, fetchOptions),
    extracted: await readDeployedJson(baseUrl, '/data/extracted.json', nonce, fetchOptions),
  };
  for (const [name, local] of Object.entries({ registry, siteIndex, lists, extracted })) {
    if (stableStringify(deployed[name]) !== stableStringify(local)) {
      throw new Error(`Deployed ${name} does not match the prepared catalog`);
    }
  }
  if (options.sbiMetaPath) {
    const localMeta = readJson(options.sbiMetaPath, null);
    const deployedMeta = await readDeployedJson(baseUrl, '/data/sbi-fp/meta.json', nonce, fetchOptions);
    if (stableStringify(deployedMeta) !== stableStringify(localMeta)) {
      throw new Error('Deployed SBI metadata does not match the prepared catalog');
    }
  }
  if (options.legacySbiPath && fs.existsSync(options.legacySbiPath)) {
    throw new Error(`Legacy monolithic SBI artifact remains locally: ${options.legacySbiPath}`);
  }
  await assertDeployedAbsent(baseUrl, '/data/sbi-fingerprints.json', nonce, fetchOptions);

  const knownPackIds = new Set(Object.values(contentIndex.packs).map(entry => entry.packId));
  for (const list of lists) {
    const seen = new Set();
    for (const packId of list.packs || []) {
      if (!knownPackIds.has(packId)) throw new Error(`Prepared List ${list.name} references missing pack ID: ${packId}`);
      if (seen.has(packId)) throw new Error(`Prepared List ${list.name} contains duplicate pack ID: ${packId}`);
      seen.add(packId);
    }
  }

  await mapConcurrent(siteIndex.items || [], options.deploymentConcurrency || 8, async item => {
    const dataPath = safePackPath(options.packDataRoot, item.name, '.json');
    const pack = readJson(dataPath, null);
    if (!pack) throw new Error(`Prepared pack data is missing: ${item.name}`);
    const registryEntry = registry[`${pack.id}.zip`];
    if (!registryEntry) throw new Error(`Prepared pack lacks registry coverage: ${item.name}`);
    const expectedDownload = typeof options.downloadUrlBuilder === 'function'
      ? options.downloadUrlBuilder(pack, registryEntry)
      : `https://raw.githubusercontent.com/${options.owner || 'Sakyvo'}/${registryEntry.repo}/main/resourcepacks/${encodeURIComponent(pack.id)}.zip`;
    if (!pack.downloads || pack.downloads.github !== expectedDownload) {
      throw new Error(`Prepared pack download URL mismatch: ${item.name}`);
    }
    const deployedPack = await readDeployedJson(baseUrl, `/data/packs/${encodeURIComponent(item.name)}.json`, nonce, fetchOptions);
    if (stableStringify(deployedPack) !== stableStringify(pack)) {
      throw new Error(`Deployed pack data does not match: ${item.name}`);
    }
    await assertDeployedResource(
      siteUrl(baseUrl, `/p/${encodeURIComponent(item.name)}/`, nonce),
      `pack route ${item.name}`,
      fetchOptions
    );
    await assertDeployedResource(withNonce(pack.downloads.github, nonce), `pack download ${item.name}`, fetchOptions, 'HEAD');
  });

  const reviewByFile = new Map((options.review.entries || []).map(entry => [entry.file, entry]));
  const retired = (options.manifest.entries || []).filter(entry => {
    if (reviewByFile.get(entry.file)?.decision?.action === 'defer') return false;
    return entry.normalization.classification === 'illegal' || entry.normalization.collection;
  });
  for (const entry of retired) {
    const packId = entry.visibility.packId;
    if (knownPackIds.has(packId)) throw new Error(`Retired pack identity remains in content index: ${packId}`);
    if (entry.visibility.public) {
      await assertDeployedAbsent(baseUrl, `/data/packs/${encodeURIComponent(packId)}.json`, nonce, fetchOptions);
      await assertDeployedAbsent(baseUrl, `/p/${encodeURIComponent(packId)}/`, nonce, fetchOptions);
    }
  }
  return {
    registryCount: Object.keys(registry).length,
    publicPackCount: (siteIndex.items || []).length,
    listCount: lists.length,
  };
}

function createProductionServices(options) {
  assertProductionPrerequisites(options.phase);
  const remote = createGitHubPackRemote({
    owner: options.owner || 'Sakyvo',
    mutation: options.phase === 'stage' || options.phase === 'cleanup',
    workdir: options.remoteWorkdir,
    transport: options.archiveTransport || 'curl',
    fetchOptions: { timeoutMs: options.archiveRequestTimeoutMs },
    rangeChunkSize: options.archiveRangeChunkBytes,
  });
  const extractedProducts = new Map();
  let deploymentVerified = false;

  async function prepareAssets({ single, collection }) {
    const targets = collectAssetTargets(single, collection);
    if (!targets.length) return { extracted: 0 };
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'vale-normalization-assets-'));
    const inputDir = path.join(workspace, 'packs');
    const manifestPath = path.join(workspace, 'extract-manifest.json');
    fs.mkdirSync(inputDir, { recursive: true });
    try {
      await mapConcurrent(targets, options.assetConcurrency || 4, async target => {
        const destination = path.join(inputDir, target.file);
        await remote.downloadArchive({ ...target, destination });
        const actual = { size: fs.statSync(destination).size, archiveSha256: await sha256File(destination) };
        if (Number(actual.size) !== Number(target.size) || actual.archiveSha256 !== target.archiveSha256) {
          throw new Error(`Asset source changed during download: ${target.repo}/${target.file}`);
        }
      });
      fs.writeFileSync(manifestPath, JSON.stringify({ extractPackIds: targets.map(target => target.packId) }, null, 2));
      run(process.execPath, [
        'scripts/extract-textures.js', '--input', inputDir, '--merge', '--manifest', manifestPath,
        '--replace-existing', '--strict',
      ]);
      const extracted = readJson(options.extractedPath, []);
      for (const target of targets) {
        const row = extracted.find(entry => entry.packId === target.packId);
        if (!row) throw new Error(`Extraction result is missing after asset preparation: ${target.packId}`);
        extractedProducts.set(target.packId, row);
      }
      return { extracted: targets.length };
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }

  async function generateCatalog() {
    run(process.execPath, ['scripts/detect-special-packs.js']);
    run(process.execPath, ['scripts/generate-index.js']);
    run(process.execPath, ['scripts/build.js']);
    run(process.execPath, ['scripts/generate-sbi-data.js']);
  }

  async function verifyCatalogDeployment({ manifest, review }) {
    const deadline = Date.now() + (Number(options.deploymentTimeoutMs) || 20 * 60 * 1000);
    let lastError;
    do {
      try {
        const result = await verifyDeploymentOnce({
          ...options,
          manifest,
          review,
          approvalDigest: review.approvalDigest,
        });
        deploymentVerified = true;
        return result;
      } catch (error) {
        lastError = error;
        if (Date.now() >= deadline) break;
        console.error(`Deployment not ready: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, Number(options.deploymentPollMs) || 15000));
      }
    } while (Date.now() < deadline);
    throw lastError;
  }

  return {
    services: {
      remote,
      prepareAssets,
      generateCatalog,
      verifyCatalogDeployment,
      verifyDeployment: async () => deploymentVerified,
      extractProduct(product) {
        const row = extractedProducts.get(product.packId);
        if (!row) throw new Error(`Prepared collection extraction is missing: ${product.packId}`);
        return row;
      },
      classifyManagedLists: () => [],
    },
    close: () => remote.close(),
  };
}

module.exports = {
  DEFAULT_SITE_BASE_URL,
  assertProductionPrerequisites,
  collectAssetTargets,
  createProductionServices,
  mapConcurrent,
  productionPaths,
  safePackPath,
  verifyDeploymentOnce,
};
