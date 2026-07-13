const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { getPackIdFromZipName } = require('./pack-utils');
const {
  SCHEMA_VERSION: FINGERPRINT_SCHEMA_VERSION,
  fingerprintPack,
} = require('./lib/pack-content-fingerprint');
const {
  INDEX_SCHEMA_VERSION,
  buildDuplicateGroups,
  canonicalRegistry,
  computeRegistryDigest,
  readJson,
  sourceKey,
  writeJsonAtomic,
} = require('./lib/pack-content-index');

const ROOT = path.join(__dirname, '..');
const DEFAULT_REGISTRY_PATH = path.join(ROOT, 'data', 'pack-registry.json');
const DEFAULT_EXTRACTED_PATH = path.join(ROOT, 'data', 'extracted.json');
const DEFAULT_INDEX_PATH = path.join(ROOT, 'data', 'internal', 'pack-content-index.json');
const DEFAULT_REPORT_PATH = path.join(ROOT, 'docs', 'PACK_CONTENT_DUPLICATES.md');

function parseArgs(argv) {
  const args = {
    registry: DEFAULT_REGISTRY_PATH,
    extracted: DEFAULT_EXTRACTED_PATH,
    output: DEFAULT_INDEX_PATH,
    report: DEFAULT_REPORT_PATH,
    owner: 'Sakyvo',
    limit: null,
    only: null,
    rebuild: false,
    maxAttempts: 3,
    concurrency: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--registry') args.registry = path.resolve(argv[++i]);
    else if (arg === '--extracted') args.extracted = path.resolve(argv[++i]);
    else if (arg === '--output' || arg === '--index') args.output = path.resolve(argv[++i]);
    else if (arg === '--report') args.report = path.resolve(argv[++i]);
    else if (arg === '--no-report') args.report = null;
    else if (arg === '--owner') args.owner = argv[++i];
    else if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--only') args.only = argv[++i];
    else if (arg === '--rebuild') args.rebuild = true;
    else if (arg === '--max-attempts') args.maxAttempts = Number(argv[++i]);
    else if (arg === '--concurrency') args.concurrency = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.limit != null && (!Number.isInteger(args.limit) || args.limit <= 0)) throw new Error('--limit must be a positive integer');
  if (!Number.isInteger(args.maxAttempts) || args.maxAttempts <= 0) throw new Error('--max-attempts must be a positive integer');
  if (!Number.isInteger(args.concurrency) || args.concurrency <= 0 || args.concurrency > 8) {
    throw new Error('--concurrency must be an integer from 1 to 8');
  }
  return args;
}

function loadPackIdMap(extractedPath) {
  const out = new Map();
  for (const row of readJson(extractedPath, [])) {
    if (!row || !row.originalName || !row.packId) continue;
    out.set(`${row.originalName}.zip`, row.packId);
  }
  return out;
}

function rawDownloadUrl(owner, file, entry) {
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(entry.repo)}/main/resourcepacks/${encodeURIComponent(file)}`;
}

async function downloadToFile(url, outputPath, expectedSize) {
  const command = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const args = [
    '--fail', '--location', '--silent', '--show-error',
    '--connect-timeout', '20', '--max-time', '600',
    '--output', outputPath, url,
  ];
  let stderr = '';
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    child.stderr.on('data', chunk => {
      if (stderr.length < 16384) stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`curl_exit_${code}: ${stderr.trim() || 'download failed'}`));
    });
  });
  const bytes = fs.statSync(outputPath).size;
  if (expectedSize && bytes !== expectedSize) throw new Error(`download_size_mismatch expected=${expectedSize} actual=${bytes}`);
  return { bytes };
}

let githubTokenPromise = null;
let preferGitHubApi = false;

async function getGitHubToken() {
  if (!githubTokenPromise) {
    githubTokenPromise = new Promise((resolve, reject) => {
      const command = process.platform === 'win32' ? 'gh.exe' : 'gh';
      const child = spawn(command, ['auth', 'token'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { if (stdout.length < 16384) stdout += chunk.toString('utf8'); });
      child.stderr.on('data', chunk => { if (stderr.length < 16384) stderr += chunk.toString('utf8'); });
      child.on('error', reject);
      child.on('exit', code => {
        const token = stdout.trim();
        if (code === 0 && token) resolve(token);
        else reject(new Error(`gh_auth_exit_${code}: ${stderr.trim() || 'no token available'}`));
      });
    });
  }
  return githubTokenPromise;
}

async function downloadViaGitHubApi(owner, file, registryEntry, outputPath) {
  const command = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(registryEntry.repo)}/contents/resourcepacks/${encodeURIComponent(file)}?ref=main`;
  const token = await getGitHubToken();
  let stderr = '';
  await new Promise((resolve, reject) => {
    const child = spawn(command, [
      '--fail', '--location', '--silent', '--show-error',
      '--connect-timeout', '20', '--max-time', '600',
      '--header', '@-', '--output', outputPath, endpoint,
    ], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    child.stderr.on('data', chunk => {
      if (stderr.length < 16384) stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`github_api_curl_exit_${code}: ${stderr.trim() || 'download failed'}`));
    });
    child.stdin.end([
      'Accept: application/vnd.github.raw+json',
      `Authorization: Bearer ${token}`,
      'X-GitHub-Api-Version: 2022-11-28',
      'User-Agent: vale-pack-scanner',
      '',
    ].join('\r\n'));
  });
}

async function delay(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function scanOne(owner, file, registryEntry, maxAttempts) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vale-pack-scan-'));
  const tempZip = path.join(tempDir, 'pack.zip');
  const url = rawDownloadUrl(owner, file, registryEntry);
  try {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (preferGitHubApi) {
          await downloadViaGitHubApi(owner, file, registryEntry, tempZip);
        } else {
          try {
            await downloadToFile(url, tempZip, Number(registryEntry.size) || 0);
          } catch (rawError) {
            fs.rmSync(tempZip, { force: true });
            try {
              await downloadViaGitHubApi(owner, file, registryEntry, tempZip);
              if (rawError.message.includes('curl_exit_35')) preferGitHubApi = true;
            } catch (apiError) {
              throw new Error(`${rawError.message}; ${apiError.message}`);
            }
          }
        }
        const bytes = fs.statSync(tempZip).size;
        const expectedSize = Number(registryEntry.size) || 0;
        if (expectedSize && bytes !== expectedSize) {
          throw new Error(`download_size_mismatch expected=${expectedSize} actual=${bytes}`);
        }
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        fs.rmSync(tempZip, { force: true });
        if (attempt < maxAttempts) await delay(500 * attempt);
      }
    }
    if (lastError) throw lastError;
    const fingerprint = await fingerprintPack(tempZip);
    return { ...fingerprint, downloadUrl: url };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

function renderReport(index) {
  const lines = [
    '# Pack Content Duplicate Scan',
    '',
    `Registry entries: ${index.registryCount}`,
    `Indexed entries: ${Object.keys(index.packs).length}`,
    `Complete: ${index.complete ? 'yes' : 'no'}`,
    `Failures: ${index.failures.length}`,
    `Exact duplicate groups: ${index.duplicateGroups.length}`,
    '',
    'No entry in this report is deleted automatically.',
    '',
  ];
  for (let i = 0; i < index.duplicateGroups.length; i++) {
    const group = index.duplicateGroups[i];
    lines.push(`## Group ${i + 1}`, '', `Visual hash: \`${group.visualContentHash}\``, '');
    for (const member of group.members) lines.push(`- \`${member.packId}\` (\`${member.file}\`, \`${member.repo}\`)`);
    lines.push('');
  }
  if (index.failures.length) {
    lines.push('## Scan Failures', '');
    for (const failure of index.failures) lines.push(`- \`${failure.file}\`: ${String(failure.error).replace(/\r?\n/g, ' ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

function checkpoint(args, registry, packs, failures, selectedCount, isFullSelection) {
  const registryFiles = new Set(Object.keys(registry));
  const currentPacks = {};
  for (const file of Object.keys(packs).sort()) {
    if (registryFiles.has(file)) currentPacks[file] = packs[file];
  }
  const failureRows = [...failures.values()].sort((a, b) => a.file.localeCompare(b.file));
  const complete = isFullSelection && Object.keys(currentPacks).length === Object.keys(registry).length && failureRows.length === 0;
  const index = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    fingerprintSchemaVersion: FINGERPRINT_SCHEMA_VERSION,
    registryDigest: computeRegistryDigest(registry),
    registryCount: Object.keys(registry).length,
    selectedCount,
    complete,
    generatedAt: new Date().toISOString(),
    packs: currentPacks,
    failures: failureRows,
    duplicateGroups: buildDuplicateGroups(currentPacks),
  };
  writeJsonAtomic(args.output, index);
  if (args.report) {
    fs.mkdirSync(path.dirname(args.report), { recursive: true });
    fs.writeFileSync(args.report, renderReport(index));
  }
  return index;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const registry = readJson(args.registry, null);
  if (!registry || Array.isArray(registry)) throw new Error(`Invalid or missing registry: ${args.registry}`);
  const packIds = loadPackIdMap(args.extracted);
  const previous = args.rebuild ? null : readJson(args.output, null);
  const compatiblePrevious = previous && previous.schemaVersion === INDEX_SCHEMA_VERSION &&
    previous.fingerprintSchemaVersion === FINGERPRINT_SCHEMA_VERSION;
  const packs = compatiblePrevious ? { ...(previous.packs || {}) } : {};
  const failures = new Map();
  if (compatiblePrevious && Array.isArray(previous.failures)) {
    for (const failure of previous.failures) failures.set(failure.file, failure);
  }

  let files = Object.keys(registry).sort((a, b) => {
    const repoDiff = (Number(registry[a].repoNum) || 0) - (Number(registry[b].repoNum) || 0);
    return repoDiff || a.localeCompare(b);
  });
  if (args.only) files = files.filter(file => file === args.only || file.toLowerCase().includes(args.only.toLowerCase()));
  if (args.limit != null) files = files.slice(0, args.limit);
  if (!files.length) throw new Error('No registry entries matched the scan selection');
  const isFullSelection = !args.only && args.limit == null;

  console.log(`Scanning ${files.length} of ${Object.keys(registry).length} registry entries with concurrency ${args.concurrency}...`);
  const pending = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const entry = registry[file];
    const key = sourceKey(file, entry);
    const cached = packs[file];
    if (cached && cached.sourceKey === key && cached.visualContentHash) {
      failures.delete(file);
      console.log(`[${i + 1}/${files.length}] cached ${file}`);
      continue;
    }
    pending.push({ index: i, file, entry, key });
  }

  let nextPending = 0;
  async function worker() {
    while (nextPending < pending.length) {
      const job = pending[nextPending++];
      const { index, file, entry, key } = job;
      console.log(`[${index + 1}/${files.length}] scan ${file}`);
      try {
        const result = await scanOne(args.owner, file, entry, args.maxAttempts);
        packs[file] = {
          packId: packIds.get(file) || getPackIdFromZipName(file),
          repo: entry.repo,
          repoNum: Number(entry.repoNum) || 0,
          size: Number(entry.size) || result.size,
          sourceKey: key,
          archiveSha256: result.archiveSha256,
          visualContentHash: result.visualContentHash,
          visualEntryCount: result.visualEntryCount,
          swords: result.swords,
        };
        failures.delete(file);
      } catch (error) {
        failures.set(file, {
          file,
          repo: entry.repo,
          code: error.code || 'scan_failed',
          error: error.message,
        });
        console.error(`  failed ${file}: ${error.code || 'scan_failed'} ${error.message}`);
      }
      checkpoint(args, registry, packs, failures, files.length, false);
    }
  }
  await Promise.all(Array.from({ length: Math.min(args.concurrency, pending.length) }, () => worker()));

  const index = checkpoint(args, registry, packs, failures, files.length, isFullSelection);
  console.log(JSON.stringify({
    complete: index.complete,
    indexed: Object.keys(index.packs).length,
    failures: index.failures.length,
    duplicateGroups: index.duplicateGroups.length,
    output: args.output,
  }, null, 2));
  return index.failures.length ? 2 : 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  parseArgs,
  rawDownloadUrl,
  renderReport,
};
