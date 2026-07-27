const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runIngestion } = require('./upload-folder');

function parseArgs(argv) {
  const options = { list: 'Sakyvo', execute: true };
  const files = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--list') options.list = argv[++index];
    else if (arg === '--manifest') options.manifest = path.resolve(argv[++index]);
    else if (arg === '--dry-run') options.execute = false;
    else if (arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
    else files.push(path.resolve(arg));
  }
  if (!files.length) {
    throw new Error('Usage: node scripts/upload-pack.js <file1> [file2 ...] [--list <name>] [--manifest <json>] [--dry-run]');
  }
  return { files, options };
}

async function delegateUpload(inputPaths, options = {}, services = {}) {
  if (!Array.isArray(inputPaths) || !inputPaths.length) throw new Error('At least one source file is required');
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'vale-pack-source-'));
  try {
    const names = new Set();
    for (const input of inputPaths) {
      const sourcePath = path.resolve(input);
      const stat = fs.lstatSync(sourcePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Single-file upload accepts regular files only: ${sourcePath}`);
      }
      const name = path.basename(sourcePath);
      const key = name.toLowerCase();
      if (names.has(key)) throw new Error(`Duplicate staged source filename: ${name}`);
      names.add(key);
      fs.copyFileSync(sourcePath, path.join(staging, name));
    }
    return await runIngestion({
      list: 'Sakyvo',
      execute: true,
      skipBlockers: false,
      onlyRepoNum: null,
      duplicateResolutions: null,
      ...options,
      source: staging,
    }, services);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function main(argv = process.argv.slice(2)) {
  const { files, options } = parseArgs(argv);
  const plan = await delegateUpload(files, options);
  console.log(JSON.stringify(plan.summary, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  delegateUpload,
  main,
  parseArgs,
};
