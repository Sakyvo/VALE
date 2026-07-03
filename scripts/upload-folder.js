const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getPackIdFromZipName } = require('./pack-utils');

const REPO_OWNER = 'Sakyvo';
const REPO_PREFIX = 'packs-';
const MAX_REPO_SIZE = 5 * 1024 * 1024 * 1024;
const GITHUB_FILE_LIMIT = 100 * 1024 * 1024;
const BATCH_SIZE = 500 * 1024 * 1024;
const FULL_MARKER = '!  FULL  !';

const ROOT = path.join(__dirname, '..');
const REGISTRY_PATH = path.join(ROOT, 'data', 'pack-registry.json');
const INDEX_PATH = path.join(ROOT, 'data', 'index.json');
const LISTS_PATH = path.join(ROOT, 'l', 'lists.json');
const LIST_PAGE_TEMPLATE = path.join(ROOT, 'l', 'test', 'index.html');

function parseArgs(argv) {
  const out = {
    source: null,
    list: 'Sakyvo',
    workdir: path.join(ROOT, '..', '.vale-pack-upload'),
    manifest: null,
    execute: false,
    skipBlockers: false,
    onlyRepoNum: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--source') out.source = argv[++i];
    else if (arg === '--list') out.list = argv[++i];
    else if (arg === '--workdir') out.workdir = argv[++i];
    else if (arg === '--manifest') out.manifest = argv[++i];
    else if (arg === '--execute') out.execute = true;
    else if (arg === '--dry-run') out.execute = false;
    else if (arg === '--skip-blockers') out.skipBlockers = true;
    else if (arg === '--only-repo') {
      const raw = argv[++i];
      out.onlyRepoNum = Number(String(raw).replace(/^packs-/, ''));
    }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!out.source) throw new Error('Usage: node scripts/upload-folder.js --source <folder> [--list Sakyvo] [--execute]');
  return out;
}

function repoName(n) {
  return `${REPO_PREFIX}${String(n).padStart(3, '0')}`;
}

function run(cmd, args, opts = {}) {
  const output = execFileSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    encoding: 'utf-8',
    stdio: opts.stdio || 'pipe',
    timeout: opts.timeout || 600000,
  });
  return typeof output === 'string' ? output.trim() : '';
}

function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : fallback;
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getSourceFiles(source) {
  return fs.readdirSync(source)
    .filter(f => f.toLowerCase().endsWith('.zip'))
    .map(file => {
      const fullPath = path.join(source, file);
      const stat = fs.statSync(fullPath);
      return {
        file,
        path: fullPath,
        size: stat.size,
        mtime: stat.mtimeMs,
        packId: getPackIdFromZipName(file),
      };
    })
    .sort((a, b) => a.mtime - b.mtime || a.file.localeCompare(b.file));
}

function summarize(entries) {
  const counts = {};
  for (const entry of entries) counts[entry.action] = (counts[entry.action] || 0) + 1;
  return counts;
}

function buildPlan(opts) {
  if (!fs.existsSync(opts.source)) throw new Error(`Source folder not found: ${opts.source}`);

  const registry = readJson(REGISTRY_PATH, {});
  const index = readJson(INDEX_PATH, { items: [] });
  const existingIds = new Map(index.items.map(p => [p.name.toLowerCase(), p.name]));
  const sourceFiles = getSourceFiles(opts.source);
  const groups = new Map();

  for (const source of sourceFiles) {
    const key = source.packId.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(source);
  }

  const repoUsed = {};
  for (const entry of Object.values(registry)) {
    if (!entry || !entry.repoNum || !entry.size) continue;
    repoUsed[entry.repoNum] = (repoUsed[entry.repoNum] || 0) + entry.size;
  }

  let repoNum = Math.max(1, ...Object.keys(repoUsed).map(Number));
  let used = repoUsed[repoNum] || 0;
  const fullRepoNums = new Set();
  const entries = [];
  const listPackIds = [];
  const uploadEntries = [];
  const extractPackIds = [];

  for (const files of groups.values()) {
    const first = files[0];
    const existingId = existingIds.get(first.packId.toLowerCase());
    const finalPackId = existingId || first.packId;
    const registered = files.find(f => registry[f.file]);
    const uploadable = files.find(f => f.size <= GITHUB_FILE_LIMIT);

    if (existingId) {
      listPackIds.push(finalPackId);
      files.forEach((f, idx) => entries.push({
        file: f.file,
        packId: finalPackId,
        size: f.size,
        action: idx === 0 ? 'skip_existing_pack_id' : 'skip_source_duplicate',
        reason: idx === 0 ? 'pack_id_already_in_index' : 'same_pack_id_as_group_canonical',
      }));
      continue;
    }

    if (registered) {
      listPackIds.push(finalPackId);
      extractPackIds.push(finalPackId);
      files.forEach(f => entries.push({
        file: f.file,
        packId: finalPackId,
        size: f.size,
        action: f === registered ? 'skip_exact_registry_extract' : 'skip_source_duplicate',
        reason: f === registered ? 'zip_filename_already_in_registry' : 'same_pack_id_as_group_canonical',
        repo: registry[registered.file].repo,
        repoNum: registry[registered.file].repoNum,
      }));
      continue;
    }

    if (!uploadable) {
      files.forEach((f, idx) => entries.push({
        file: f.file,
        packId: finalPackId,
        size: f.size,
        action: idx === 0 ? 'blocked_oversize' : 'blocked_oversize_duplicate',
        reason: 'github_git_file_limit_100mb',
      }));
      continue;
    }

    while (used + uploadable.size > MAX_REPO_SIZE) {
      fullRepoNums.add(repoNum);
      repoNum += 1;
      used = repoUsed[repoNum] || 0;
    }

    const upload = {
      file: uploadable.file,
      path: uploadable.path,
      packId: finalPackId,
      size: uploadable.size,
      action: 'upload_new',
      repo: repoName(repoNum),
      repoNum,
    };
    used += uploadable.size;
    repoUsed[repoNum] = used;
    listPackIds.push(finalPackId);
    extractPackIds.push(finalPackId);
    uploadEntries.push(upload);
    entries.push(upload);

    files.filter(f => f !== uploadable).forEach(f => entries.push({
      file: f.file,
      packId: finalPackId,
      size: f.size,
      action: 'skip_source_duplicate',
      reason: 'same_pack_id_as_group_canonical',
    }));
  }

  const blockers = entries.filter(e => e.action.startsWith('blocked_'));
  return {
    source: opts.source,
    list: opts.list,
    generatedAt: new Date().toISOString(),
    summary: {
      sourceFiles: sourceFiles.length,
      uniquePackIds: groups.size,
      listPackIds: listPackIds.length,
      uploadFiles: uploadEntries.length,
      uploadBytes: uploadEntries.reduce((sum, e) => sum + e.size, 0),
      blockers: blockers.length,
      actions: summarize(entries),
      fullRepoNums: [...fullRepoNums].sort((a, b) => a - b),
    },
    listPackIds,
    extractPackIds,
    uploadEntries,
    blockers,
    entries,
  };
}

function ensureRepo(workdir, num) {
  fs.mkdirSync(workdir, { recursive: true });
  const name = repoName(num);
  const dir = path.join(workdir, name);
  if (fs.existsSync(path.join(dir, '.git'))) {
    const status = run('git', ['status', '--short'], { cwd: dir });
    if (!status) run('git', ['pull', '--ff-only'], { cwd: dir, stdio: 'inherit' });
    else console.log(`${name}: local pending changes found; continuing without pull.`);
    return dir;
  }

  try {
    run('git', ['clone', `https://github.com/${REPO_OWNER}/${name}.git`, dir], { stdio: 'inherit' });
  } catch (cloneErr) {
    fs.mkdirSync(dir, { recursive: true });
    run('git', ['init'], { cwd: dir });
    run('git', ['remote', 'add', 'origin', `https://github.com/${REPO_OWNER}/${name}.git`], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\nResource pack storage for VALE.\n`);
    fs.mkdirSync(path.join(dir, 'resourcepacks'), { recursive: true });
    run('git', ['add', '.'], { cwd: dir });
    run('git', ['commit', '-m', 'init'], { cwd: dir });
    run('git', ['branch', '-M', 'main'], { cwd: dir });
    run('gh', ['repo', 'create', `${REPO_OWNER}/${name}`, '--public', '-y'], { cwd: dir, stdio: 'inherit' });
    run('git', ['push', '-u', 'origin', 'main'], { cwd: dir, stdio: 'inherit' });
  }
  try {
    run('git', ['branch', '-M', 'main'], { cwd: dir });
  } catch {}
  return dir;
}

function commitRepoBatches(repoDir, repo, files, markFull) {
  const rpDir = path.join(repoDir, 'resourcepacks');
  fs.mkdirSync(rpDir, { recursive: true });

  let batch = [];
  let batchSize = 0;
  let batchNum = 0;
  const flush = () => {
    if (!batch.length) return;
    batchNum += 1;
    for (const item of batch) {
      run('git', ['add', '--', path.join('resourcepacks', item.file)], { cwd: repoDir });
    }
    if (markFull && fs.existsSync(path.join(repoDir, FULL_MARKER))) {
      run('git', ['add', '--', FULL_MARKER], { cwd: repoDir });
    }
    const status = run('git', ['status', '--short'], { cwd: repoDir });
    if (status) {
      run('git', ['commit', '-m', `add Sakyvo packs batch ${batchNum}`], { cwd: repoDir, stdio: 'inherit' });
      run('git', ['push', 'origin', 'main'], { cwd: repoDir, stdio: 'inherit', timeout: 1200000 });
    }
    batch = [];
    batchSize = 0;
  };

  for (const item of files) {
    fs.copyFileSync(item.path, path.join(rpDir, item.file));
    batch.push(item);
    batchSize += item.size;
    if (batchSize >= BATCH_SIZE) flush();
  }
  if (markFull) fs.writeFileSync(path.join(repoDir, FULL_MARKER), 'This repository has reached its storage limit.\n');
  flush();
}

function updateLists(listName, packIds) {
  const lists = readJson(LISTS_PATH, []);
  let list = lists.find(l => l.name === listName);
  if (!list) {
    list = { name: listName, cover: '', description: '', packs: [] };
    lists.push(list);
  }
  for (const packId of packIds) {
    if (!list.packs.includes(packId)) list.packs.push(packId);
  }
  writeJson(LISTS_PATH, lists);

  const listDir = path.join(ROOT, 'l', listName);
  const pagePath = path.join(listDir, 'index.html');
  if (!fs.existsSync(pagePath)) {
    const template = fs.existsSync(LIST_PAGE_TEMPLATE)
      ? fs.readFileSync(LIST_PAGE_TEMPLATE, 'utf-8')
      : fs.readFileSync(path.join(ROOT, 'l', 'index.html'), 'utf-8');
    fs.mkdirSync(listDir, { recursive: true });
    fs.writeFileSync(pagePath, template);
  }
}

function executePlan(opts, plan) {
  if (plan.blockers.length && !opts.skipBlockers) {
    throw new Error(`Dry-run has ${plan.blockers.length} blocker(s); resolve them before --execute.`);
  }

  const registry = readJson(REGISTRY_PATH, {});
  const byRepo = new Map();
  for (const item of plan.uploadEntries) {
    if (!byRepo.has(item.repoNum)) byRepo.set(item.repoNum, []);
    byRepo.get(item.repoNum).push(item);
  }

  const repoNums = new Set([...byRepo.keys(), ...plan.summary.fullRepoNums]);
  for (const num of [...repoNums].sort((a, b) => a - b)) {
    if (opts.onlyRepoNum && num !== opts.onlyRepoNum) continue;
    const repoDir = ensureRepo(opts.workdir, num);
    const files = byRepo.get(num) || [];
    const markFull = plan.summary.fullRepoNums.includes(num);
    if (files.length || markFull) commitRepoBatches(repoDir, repoName(num), files, markFull);
  }

  for (const item of plan.uploadEntries) {
    registry[item.file] = { repo: item.repo, repoNum: item.repoNum, size: item.size };
  }
  writeJson(REGISTRY_PATH, registry);
  updateLists(opts.list, plan.listPackIds);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const plan = buildPlan(opts);
  if (opts.manifest) writeJson(path.resolve(opts.manifest), plan);

  console.log(JSON.stringify(plan.summary, null, 2));
  if (plan.blockers.length) {
    console.log('\nBlockers:');
    for (const b of plan.blockers) {
      console.log(`  ${b.file} (${(b.size / 1024 / 1024).toFixed(1)} MB): ${b.reason}`);
    }
  }

  if (!opts.execute) {
    console.log('\nDry-run only. Re-run with --execute after reviewing the manifest.');
    return;
  }
  executePlan(opts, plan);
  console.log('\nUpload/List update complete.');
}

main();
