const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  readJson,
  refreshContentIndexMetadata,
  validateContentIndex,
  writeJsonAtomic,
} = require('./lib/pack-content-index');
const { SCHEMA_VERSION: FINGERPRINT_SCHEMA_VERSION } = require('./lib/pack-content-fingerprint');

const ROOT = path.join(__dirname, '..');
const DEFAULTS = {
  registryPath: path.join(ROOT, 'data', 'pack-registry.json'),
  contentIndexPath: path.join(ROOT, 'data', 'internal', 'pack-content-index.json'),
  aliasesPath: path.join(ROOT, 'data', 'internal', 'pack-content-aliases.json'),
  pendingPath: path.join(ROOT, 'data', 'internal', 'pending-pack-replacements.json'),
  extractedPath: path.join(ROOT, 'data', 'extracted.json'),
  listsPath: path.join(ROOT, 'l', 'lists.json'),
  thumbnailsRoot: path.join(ROOT, 'thumbnails'),
  packDataRoot: path.join(ROOT, 'data', 'packs'),
  packPageRoot: path.join(ROOT, 'p'),
  workdir: path.join(ROOT, '..', '.vale-pack-upload'),
  baseUrl: 'https://vale.cc.cd',
};

function parseArgs(argv) {
  const args = { ...DEFAULTS, prepareSite: false, executeCleanup: false, only: null, runBuild: true };
  const pathOptions = {
    '--registry': 'registryPath',
    '--content-index': 'contentIndexPath',
    '--content-aliases': 'aliasesPath',
    '--pending-replacements': 'pendingPath',
    '--extracted': 'extractedPath',
    '--lists': 'listsPath',
    '--thumbnails': 'thumbnailsRoot',
    '--pack-data': 'packDataRoot',
    '--pack-pages': 'packPageRoot',
    '--workdir': 'workdir',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (pathOptions[arg]) args[pathOptions[arg]] = path.resolve(argv[++i]);
    else if (arg === '--base-url') args.baseUrl = argv[++i].replace(/\/$/, '');
    else if (arg === '--only') args.only = argv[++i];
    else if (arg === '--prepare-site') args.prepareSite = true;
    else if (arg === '--execute-cleanup') args.executeCleanup = true;
    else if (arg === '--execute') throw new Error('Use --prepare-site, deploy it, then use --execute-cleanup');
    else if (arg === '--dry-run') {}
    else if (arg === '--no-build') args.runBuild = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.prepareSite && args.executeCleanup) throw new Error('Choose either --prepare-site or --execute-cleanup');
  return args;
}

function run(command, args, options = {}) {
  const output = execFileSync(command, args, {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    timeout: options.timeout || 600000,
    windowsHide: true,
    input: options.input,
  });
  return typeof output === 'string' ? output.trim() : '';
}

function curlCommand() {
  return process.platform === 'win32' ? 'curl.exe' : 'curl';
}

function curlHeadSize(url) {
  const headers = run(curlCommand(), ['--fail', '--location', '--silent', '--show-error', '--head', url], { timeout: 120000 });
  const lengths = [...headers.matchAll(/^content-length:\s*(\d+)\s*$/gim)].map(match => Number(match[1]));
  if (!lengths.length) throw new Error(`Missing Content-Length for ${url}`);
  return lengths[lengths.length - 1];
}

function curlJson(url) {
  const raw = run(curlCommand(), ['--fail', '--location', '--silent', '--show-error', url], { timeout: 120000 });
  return JSON.parse(raw);
}

function rawUrl(file, registryEntry) {
  return `https://raw.githubusercontent.com/Sakyvo/${registryEntry.repo}/main/resourcepacks/${encodeURIComponent(file)}`;
}

function verifyRemoteArchive({ file, repo, size, archiveSha256 }) {
  if (!file || !repo || !size || !archiveSha256) throw new Error(`Missing remote archive verification data for ${file || '(unknown)'}`);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vale-pack-verify-'));
  const output = path.join(tempDir, 'pack.zip');
  try {
    const token = run('gh', ['auth', 'token']);
    const endpoint = `https://api.github.com/repos/Sakyvo/${encodeURIComponent(repo)}/contents/resourcepacks/${encodeURIComponent(file)}?ref=main`;
    run(curlCommand(), [
      '--fail', '--location', '--silent', '--show-error',
      '--connect-timeout', '20', '--max-time', '600',
      '--header', '@-', '--output', output, endpoint,
    ], {
      timeout: 660000,
      input: [
        'Accept: application/vnd.github.raw+json',
        `Authorization: Bearer ${token}`,
        'X-GitHub-Api-Version: 2022-11-28',
        'User-Agent: vale-pack-finalizer',
        '',
      ].join('\r\n'),
    });
    const actualSize = fs.statSync(output).size;
    if (actualSize !== Number(size)) throw new Error(`Remote size changed for ${repo}/${file}: expected=${size} actual=${actualSize}`);
    const actualHash = crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex');
    if (actualHash !== archiveSha256) throw new Error(`Remote archive changed after retain decision: ${repo}/${file}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function verifyReplacement(replacement, registry, options) {
  const incomingRegistry = registry[replacement.incomingFile];
  if (!incomingRegistry) throw new Error(`Incoming registry entry is missing: ${replacement.incomingFile}`);
  if (Number(incomingRegistry.size) !== Number(replacement.incomingSize)) {
    throw new Error(`Incoming registry size changed after retain decision: ${replacement.incomingFile}`);
  }
  const localDataPath = path.join(options.packDataRoot, `${replacement.incomingPackId}.json`);
  if (!fs.existsSync(localDataPath)) throw new Error(`Incoming generated pack data is missing: ${localDataPath}`);
  const localPack = JSON.parse(fs.readFileSync(localDataPath, 'utf8'));
  if (!localPack.downloads || !localPack.downloads.github || !localPack.downloads.github.includes(encodeURIComponent(replacement.incomingFile.replace(/\.zip$/i, '')))) {
    throw new Error(`Local public data does not point to the incoming archive: ${replacement.incomingPackId}`);
  }
  verifyRemoteArchive({
    file: replacement.incomingFile,
    repo: incomingRegistry.repo,
    size: replacement.incomingSize,
    archiveSha256: replacement.incomingArchiveSha256,
  });

  const deployedUrl = `${options.baseUrl}/data/packs/${encodeURIComponent(replacement.incomingPackId)}.json?verify=${Date.now()}`;
  const deployed = curlJson(deployedUrl);
  if (!deployed.downloads || deployed.downloads.github !== localPack.downloads.github) {
    throw new Error(`Deployed pack data does not match the incoming download: ${replacement.incomingPackId}`);
  }
  curlHeadSize(`${options.baseUrl}/p/${encodeURIComponent(replacement.incomingPackId)}/`);
}

function verifyDeployedCleanup(replacement, options) {
  const deployedIndex = curlJson(`${options.baseUrl}/data/index.json?verify=${Date.now()}`);
  const deployedNames = new Set((deployedIndex.items || []).map(row => row.name));
  if (!deployedNames.has(replacement.incomingPackId)) {
    throw new Error(`Deployed index is missing retained pack: ${replacement.incomingPackId}`);
  }
  for (const existing of replacement.existing) {
    if (deployedNames.has(existing.packId)) throw new Error(`Deployed index still references discarded pack: ${existing.packId}`);
  }
  const deployedLists = curlJson(`${options.baseUrl}/l/lists.json?verify=${Date.now()}`);
  for (const list of deployedLists) {
    for (const existing of replacement.existing) {
      if ((list.packs || []).includes(existing.packId)) {
        throw new Error(`Deployed List ${list.name} still references discarded pack: ${existing.packId}`);
      }
    }
  }
}

function cloneRepo(workdir, repo) {
  fs.mkdirSync(workdir, { recursive: true });
  const dir = path.join(workdir, repo);
  if (fs.existsSync(dir)) throw new Error(`Temporary cleanup clone already exists: ${dir}`);
  try {
    run('git', ['clone', '--filter=blob:none', '--no-checkout', `https://github.com/Sakyvo/${repo}.git`, dir], { stdio: 'inherit', timeout: 1200000 });
    run('git', ['sparse-checkout', 'init', '--no-cone'], { cwd: dir });
    run('git', ['checkout', 'main'], { cwd: dir, stdio: 'inherit', timeout: 1200000 });
    return dir;
  } catch (error) {
    cleanupClone(dir, workdir);
    throw error;
  }
}

function cleanupClone(dir, workdir) {
  const root = path.resolve(workdir) + path.sep;
  const target = path.resolve(dir);
  if (!target.startsWith(root)) throw new Error(`Refusing to remove clone outside workdir: ${target}`);
  fs.rmSync(target, { recursive: true, force: true });
  if (fs.existsSync(workdir) && fs.readdirSync(workdir).length === 0) fs.rmSync(workdir, { recursive: true, force: true });
}

function deleteRemoteArchives(replacements, workdir) {
  const byRepo = new Map();
  for (const replacement of replacements) {
    for (const existing of replacement.existing) {
      if (!byRepo.has(existing.repo)) byRepo.set(existing.repo, []);
      byRepo.get(existing.repo).push(existing);
    }
  }
  for (const [repo, entries] of byRepo) {
    const dir = cloneRepo(workdir, repo);
    try {
      let changed = false;
      for (const entry of entries) {
        const relative = path.posix.join('resourcepacks', entry.file);
        try {
          run('git', ['ls-files', '--error-unmatch', '--', relative], { cwd: dir });
        } catch {
          console.log(`Already absent: ${repo}/${entry.file}`);
          continue;
        }
        run('git', ['update-index', '--force-remove', '--', relative], { cwd: dir });
        changed = true;
      }
      if (changed) {
        run('git', ['commit', '-m', 'remove resolved duplicate pack identities'], { cwd: dir, stdio: 'inherit' });
        run('git', ['push', 'origin', 'main'], { cwd: dir, stdio: 'inherit', timeout: 1200000 });
      }
    } finally {
      cleanupClone(dir, workdir);
    }
  }
}

function safeRemoveChild(root, name, suffix = '') {
  const rootPath = path.resolve(root) + path.sep;
  const target = path.resolve(root, `${name}${suffix}`);
  if (!target.startsWith(rootPath)) throw new Error(`Refusing to remove path outside root: ${target}`);
  fs.rmSync(target, { recursive: true, force: true });
}

function upsertAliases(aliases, rows) {
  if (!aliases || aliases.schemaVersion !== 1 || !Array.isArray(aliases.entries)) aliases = { schemaVersion: 1, entries: [] };
  for (const row of rows) {
    const index = aliases.entries.findIndex(entry =>
      entry.sourceFile === row.sourceFile && entry.visualContentHash === row.visualContentHash
    );
    if (index >= 0) aliases.entries[index] = row;
    else aliases.entries.push(row);
  }
  aliases.entries.sort((a, b) => a.sourceFile.localeCompare(b.sourceFile));
  return aliases;
}

function applyLocalCleanup(options, replacements, state) {
  const { registry, contentIndex, extracted, lists, aliases, pending } = state;
  const removedFiles = new Set();
  const removedPackIds = new Map();
  const aliasRows = [];
  for (const replacement of replacements) {
    for (const existing of replacement.existing) {
      const indexed = contentIndex.packs[existing.file];
      removedFiles.add(existing.file);
      removedPackIds.set(existing.packId, replacement.incomingPackId);
      if (indexed) {
        aliasRows.push({
          sourceFile: existing.file,
          sourcePackId: existing.packId,
          archiveSha256: indexed.archiveSha256,
          visualContentHash: indexed.visualContentHash,
          retainedFile: replacement.incomingFile,
          retainedPackId: replacement.incomingPackId,
          reason: 'keep_incoming_cleanup',
          resolvedAt: new Date().toISOString(),
        });
      }
      delete registry[existing.file];
      delete contentIndex.packs[existing.file];
      safeRemoveChild(options.thumbnailsRoot, existing.packId);
      safeRemoveChild(options.packDataRoot, existing.packId, '.json');
      safeRemoveChild(options.packPageRoot, existing.packId);
    }
  }

  const nextExtracted = extracted.filter(row =>
    !removedFiles.has(`${row.originalName}.zip`) && !removedPackIds.has(row.packId)
  );
  for (const list of lists) {
    const seen = new Set();
    list.packs = (list.packs || []).map(packId => removedPackIds.get(packId) || packId).filter(packId => {
      if (seen.has(packId)) return false;
      seen.add(packId);
      return true;
    });
  }
  refreshContentIndexMetadata(contentIndex, registry);
  const nextAliases = upsertAliases(aliases, aliasRows);
  const selectedFiles = new Set(replacements.map(row => row.incomingFile));
  pending.entries = pending.entries.map(row => selectedFiles.has(row.incomingFile)
    ? { ...row, status: 'site_cleanup_pending_deployment', preparedAt: new Date().toISOString() }
    : row);

  writeJsonAtomic(options.registryPath, registry);
  writeJsonAtomic(options.contentIndexPath, contentIndex);
  writeJsonAtomic(options.aliasesPath, nextAliases);
  writeJsonAtomic(options.extractedPath, nextExtracted);
  writeJsonAtomic(options.listsPath, lists);
  writeJsonAtomic(options.pendingPath, pending);
}

function completePendingCleanup(options, replacements, pending) {
  const selectedFiles = new Set(replacements.map(row => row.incomingFile));
  pending.resolved = Array.isArray(pending.resolved) ? pending.resolved : [];
  for (const replacement of replacements) {
    pending.resolved.push({ ...replacement, status: 'remote_deleted', resolvedAt: new Date().toISOString() });
  }
  pending.entries = pending.entries.filter(row => !selectedFiles.has(row.incomingFile));
  writeJsonAtomic(options.pendingPath, pending);
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const registry = readJson(options.registryPath, {});
  const contentIndex = validateContentIndex(readJson(options.contentIndexPath, null), registry, FINGERPRINT_SCHEMA_VERSION);
  const pending = readJson(options.pendingPath, { schemaVersion: 1, entries: [], resolved: [] });
  if (pending.schemaVersion !== 1 || !Array.isArray(pending.entries)) throw new Error('Invalid pending replacement state');
  let replacements = pending.entries;
  if (options.only) replacements = replacements.filter(row => row.incomingFile === options.only || row.incomingPackId === options.only);
  const uploaded = replacements.filter(row => row.status === 'uploaded_pending_site_verification');
  const prepared = replacements.filter(row => row.status === 'site_cleanup_pending_deployment');
  if (!uploaded.length && !prepared.length) {
    console.log('No pending replacements matched.');
    return;
  }

  if (options.prepareSite) {
    if (!uploaded.length || prepared.length) throw new Error('Select only uploaded_pending_site_verification replacements for --prepare-site');
    for (const replacement of uploaded) verifyReplacement(replacement, registry, options);
    applyLocalCleanup(options, uploaded, {
      registry,
      contentIndex,
      extracted: readJson(options.extractedPath, []),
      lists: readJson(options.listsPath, []),
      aliases: readJson(options.aliasesPath, { schemaVersion: 1, entries: [] }),
      pending,
    });
    if (options.runBuild) {
      run(process.execPath, ['scripts/generate-index.js'], { cwd: ROOT, stdio: 'inherit' });
      run(process.execPath, ['scripts/build.js'], { cwd: ROOT, stdio: 'inherit' });
    }
    console.log('Site cleanup prepared. Commit, push, and wait for deployment before --execute-cleanup.');
    return;
  }

  if (options.executeCleanup) {
    if (!prepared.length || uploaded.length) throw new Error('Run --prepare-site and deploy before --execute-cleanup');
    for (const replacement of prepared) {
      verifyReplacement(replacement, registry, options);
      verifyDeployedCleanup(replacement, options);
      for (const existing of replacement.existing) verifyRemoteArchive(existing);
    }
    deleteRemoteArchives(prepared, options.workdir);
    completePendingCleanup(options, prepared, pending);
    console.log('Remote cleanup complete. Commit and push the resolved pending state.');
    return;
  }

  for (const replacement of uploaded) verifyReplacement(replacement, registry, options);
  for (const replacement of prepared) {
    verifyReplacement(replacement, registry, options);
    verifyDeployedCleanup(replacement, options);
  }
  console.log(`Verified ${uploaded.length} replacement(s) ready for --prepare-site and ${prepared.length} ready for --execute-cleanup.`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  applyLocalCleanup,
  completePendingCleanup,
  parseArgs,
  rawUrl,
  verifyRemoteArchive,
  verifyDeployedCleanup,
  verifyReplacement,
};
