const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');

const NORMALIZATION_SCHEMA_VERSION = 1;
const MAX_NESTING_DEPTH = 10;
const DEFAULT_ARCHIVE_LIMITS = {
  maxEntries: 50_000,
  maxEntryBytes: 512 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
};
const SAFETY_CODES = new Set([
  'unsafe_entry_path',
  'link_entry',
  'colliding_output_paths',
  'too_many_entries',
  'entry_too_large',
  'archive_expands_too_large',
]);
const FIXED_ZIP_TIME = new Date('1980-01-01T00:00:00.000Z');
const JUNK_NAMES = new Set(['__macosx', '.ds_store', 'thumbs.db', 'desktop.ini']);

class PackNormalizationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PackNormalizationError';
    this.code = code;
    this.details = details;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  await new Promise((resolve, reject) => {
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

function normalizeEntryPath(raw) {
  const original = String(raw || '');
  if (original.includes('\0') || /^[a-z]:[\\/]/i.test(original) || /^[\\/]/.test(original)) {
    throw new PackNormalizationError('unsafe_entry_path', `Unsafe ZIP entry path: ${raw}`, { path: raw });
  }
  const value = original.replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = value.split('/').filter(part => part && part !== '.');
  if (!parts.length || parts.some(part => part === '..')) {
    throw new PackNormalizationError('unsafe_entry_path', `Unsafe ZIP entry path: ${raw}`, { path: raw });
  }
  return parts.join('/');
}

function isJunkName(name) {
  return JUNK_NAMES.has(String(name).toLowerCase());
}

function readMagic(filePath, length = 8) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const magic = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, magic, 0, magic.length, 0);
    return magic.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function detectFileKind(filePath) {
  const magic = readMagic(filePath);
  if (magic.length >= 2 && magic[0] === 0x50 && magic[1] === 0x4b) return 'zip';
  if (magic.length >= 4 && magic.subarray(0, 4).equals(Buffer.from('Rar!'))) return 'rar_archive';
  if (magic.length >= 6 && magic.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) {
    return 'sevenz_archive';
  }
  return 'not_zip';
}

function hasZipMagic(filePath) {
  return detectFileKind(filePath) === 'zip';
}

function hasZipEndRecord(value) {
  const buffer = Buffer.isBuffer(value) ? value : fs.readFileSync(value);
  return buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) >= 0;
}

function readArchive(filePath) {
  if (!hasZipEndRecord(filePath)) {
    throw new PackNormalizationError('corrupt_zip', 'ZIP archive has no end-of-central-directory record');
  }
  try {
    return new AdmZip(filePath);
  } catch (error) {
    throw new PackNormalizationError('corrupt_zip', `Cannot read ZIP archive: ${error.message}`);
  }
}

function checkRowsSafety(rows, limits) {
  if (rows.length > limits.maxEntries) {
    throw new PackNormalizationError('too_many_entries', `Archive has ${rows.length} entries`, { count: rows.length });
  }
  const seen = new Set();
  let total = 0;
  for (const row of rows) {
    const collisionKey = row.path.normalize('NFC').toLowerCase();
    if (seen.has(collisionKey)) {
      throw new PackNormalizationError('colliding_output_paths', `Archive has colliding paths: ${row.path}`, { path: row.path });
    }
    seen.add(collisionKey);
    const entry = row.entry;
    if (entry && (entry.header.encrypted || (Number(entry.header.flags) & 1) !== 0)) {
      throw new PackNormalizationError('encrypted_zip', `Encrypted ZIP entry: ${row.path}`, { path: row.path });
    }
    if (entry) {
      const attr = Number(entry.attr ?? entry.header.attr ?? 0) >>> 0;
      const unixMode = (attr >>> 16) & 0xf000;
      if (unixMode === 0xa000) {
        throw new PackNormalizationError('link_entry', `ZIP link entry: ${row.path}`, { path: row.path });
      }
    }
    const size = Number.isFinite(Number(row.size)) ? Number(row.size)
      : Number(entry && entry.header ? entry.header.size : 0);
    if (size > limits.maxEntryBytes) {
      throw new PackNormalizationError('entry_too_large', `ZIP entry exceeds the expanded-size limit: ${row.path}`, { path: row.path, size });
    }
    total += Math.max(0, size);
    if (total > limits.maxTotalBytes) {
      throw new PackNormalizationError('archive_expands_too_large', 'Archive exceeds the total expanded-size limit', { size: total });
    }
  }
}

function readZipRows(zip, limits = DEFAULT_ARCHIVE_LIMITS) {
  const rows = zip.getEntries().map(entry => ({
    entry,
    path: normalizeEntryPath(entry.entryName),
    read: () => entry.getData(),
  }));
  checkRowsSafety(rows, limits);
  return rows;
}

function readDirectoryRows(root, limits = DEFAULT_ARCHIVE_LIMITS) {
  const rows = [];
  let entryCount = 0;
  let totalBytes = 0;
  function visit(dir, prefix) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const item of entries) {
      entryCount += 1;
      if (entryCount > limits.maxEntries) {
        throw new PackNormalizationError('too_many_entries', `Directory has more than ${limits.maxEntries} entries`);
      }
      const fullPath = path.join(dir, item.name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        throw new PackNormalizationError('link_entry', `Linked source entry is not allowed: ${item.name}`, { path: item.name });
      }
      const relative = normalizeEntryPath(prefix ? `${prefix}/${item.name}` : item.name);
      if (stat.isDirectory()) {
        visit(fullPath, relative);
      } else if (stat.isFile()) {
        if (stat.size > limits.maxEntryBytes) {
          throw new PackNormalizationError('entry_too_large', `Directory entry exceeds the expanded-size limit: ${relative}`, { path: relative, size: stat.size });
        }
        totalBytes += stat.size;
        if (totalBytes > limits.maxTotalBytes) {
          throw new PackNormalizationError('archive_expands_too_large', 'Directory exceeds the total expanded-size limit', { size: totalBytes });
        }
        rows.push({ entry: null, path: relative, read: () => fs.readFileSync(fullPath), size: stat.size });
      }
    }
  }
  visit(root, '');
  checkRowsSafety(rows, limits);
  return rows;
}

function isDirectoryRow(row) {
  return Boolean(row.entry && row.entry.isDirectory);
}

function readRow(row) {
  try {
    return row.read ? row.read() : row.entry.getData();
  } catch (error) {
    throw new PackNormalizationError('corrupt_zip', `Cannot read ZIP entry ${row.path}: ${error.message}`, { path: row.path });
  }
}

function isMcmetaVariant(name) {
  const lower = name.toLowerCase();
  return (lower === 'pack.mcmeta' && name !== 'pack.mcmeta') ||
    lower === 'pack.mcmeta.mcmeta' || lower === 'pack.mcmeta.txt';
}

function isPngVariant(name) {
  const lower = name.toLowerCase();
  return (lower === 'pack.png' && name !== 'pack.png') ||
    lower === 'pack..png' || lower === 'pack.png.png';
}

function isJunkPath(entryPath) {
  return entryPath.split('/').some(isJunkName);
}

function isDeadPath(entryPath) {
  const parts = entryPath.split('/');
  return parts.length >= 3 && parts[0] === 'assets' && parts[2] === 'records';
}

function hasLunarEscape(raw) {
  for (let index = 0; index < raw.length;) {
    if (raw[index] !== 0x5c) {
      index += 1;
      continue;
    }
    const next = raw[index + 1];
    if ([0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].includes(next)) {
      index += 2;
      continue;
    }
    if (next === 0x75 && raw.subarray(index + 2, index + 6).length === 4 &&
        /^[0-9a-f]{4}$/i.test(raw.subarray(index + 2, index + 6).toString('ascii'))) {
      index += 6;
      continue;
    }
    return true;
  }
  return false;
}

function patchLunarEscapes(raw) {
  const out = [];
  for (let index = 0; index < raw.length;) {
    if (raw[index] !== 0x5c) {
      out.push(raw[index++]);
      continue;
    }
    const next = raw[index + 1];
    if ([0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].includes(next)) {
      out.push(raw[index], next);
      index += 2;
      continue;
    }
    if (next === 0x75 && raw.subarray(index + 2, index + 6).length === 4 &&
        /^[0-9a-f]{4}$/i.test(raw.subarray(index + 2, index + 6).toString('ascii'))) {
      for (const value of raw.subarray(index, index + 6)) out.push(value);
      index += 6;
      continue;
    }
    index += 1;
  }
  return Buffer.from(out);
}

function generatedMcmeta(name) {
  return Buffer.from(JSON.stringify({ pack: { pack_format: 1, description: name } }));
}

function productMcmeta(raw, name) {
  if (!hasLunarEscape(raw)) return raw;
  const patched = patchLunarEscapes(raw);
  const text = patched.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
    ? patched.subarray(3).toString('utf8')
    : patched.toString('utf8');
  try {
    JSON.parse(text.replace(/[\x00-\x1f]/g, ' '));
    return patched;
  } catch {
    return generatedMcmeta(name);
  }
}

function rootFacts(rows, prefix = '') {
  const files = rows.filter(row => !isDirectoryRow(row) && row.path.startsWith(prefix));
  const relative = files.map(row => ({ ...row, path: row.path.slice(prefix.length) }));
  const hasAssets = relative.some(row => row.path.startsWith('assets/'));
  const hasMcmeta = relative.some(row => row.path === 'pack.mcmeta');
  const hasPng = relative.some(row => row.path === 'pack.png');
  const rootFiles = relative.filter(row => !row.path.includes('/'));
  const mcmetaVariant = hasMcmeta ? null : rootFiles.find(row => isMcmetaVariant(row.path)) || null;
  const pngVariant = hasPng ? null : rootFiles.find(row => isPngVariant(row.path)) || null;
  const roots = new Set(relative.filter(row => !isJunkPath(row.path)).map(row => row.path.split('/')[0]));
  const extras = [...roots].filter(root =>
    root !== 'assets' && root !== 'pack.mcmeta' && root !== 'pack.png' &&
    !isMcmetaVariant(root) && !isPngVariant(root)
  );
  const deadPath = relative.some(row => isDeadPath(row.path));
  const metadata = hasMcmeta ? relative.find(row => row.path === 'pack.mcmeta') : mcmetaVariant;
  const lunarEscape = metadata ? hasLunarEscape(readRow(metadata)) : false;
  return {
    relative,
    hasAssets,
    hasMcmeta,
    hasPng,
    mcmetaVariant,
    pngVariant,
    extras,
    deadPath,
    lunarEscape,
  };
}

const HIGH_VERSION_CAUSE = 'high_version';

// Minecraft generation is read from texture directory layout, never from a declared
// pack_format: real 1.8 packs declare unreliably (see .docs/adr/0002). Plural
// textures/items|blocks is low-version evidence and wins outright.
function textureVersionSignal(rows, prefix = '') {
  let high = false;
  for (const row of rows || []) {
    const path = typeof row === 'string' ? row : row.path;
    if (typeof path !== 'string' || !path.startsWith(prefix)) continue;
    const relative = path.slice(prefix.length);
    if (/(^|\/)textures\/(items|blocks)\//.test(relative)) return 'low';
    const isDirectory = (typeof row === 'object' && row.directory) || relative.endsWith('/');
    if (isDirectory) {
      if (/(^|\/)textures\/block\/$/.test(relative)) high = true;
      continue;
    }
    if (/(^|\/)textures\/(item|block)\//.test(relative)) high = true;
  }
  return high ? 'high' : 'none';
}

function repairCauses(facts) {
  const causes = [];
  if (!facts.hasMcmeta) causes.push('mcmeta_rescue');
  if (facts.pngVariant) causes.push('png_rescue');
  if (facts.extras.length) causes.push('root_extras');
  if (facts.deadPath) causes.push('dead_path');
  if (facts.lunarEscape) causes.push('lunar_escape');
  return causes;
}

function childDirectories(rows, prefix) {
  const children = new Set();
  for (const row of rows) {
    if (!row.path.startsWith(prefix)) continue;
    const relative = row.path.slice(prefix.length);
    const slash = relative.indexOf('/');
    if (slash <= 0) continue;
    const name = relative.slice(0, slash);
    if (!isJunkName(name)) children.add(name);
  }
  return [...children].sort((a, b) => a.localeCompare(b));
}

function childFiles(rows, prefix) {
  return rows
    .filter(row => !isDirectoryRow(row) && row.path.startsWith(prefix))
    .filter(row => {
      const relative = row.path.slice(prefix.length);
      return relative && !relative.includes('/') && !isJunkName(relative);
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

function stemOf(name) {
  const extension = path.posix.extname(name);
  return extension ? name.slice(0, -extension.length) : name;
}

function sanitizeProductName(name) {
  let value = String(name || '')
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  if (!value) value = 'Pack';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) value = `_${value}`;
  return value;
}

function findCoreLayers(rows, prefix, depth, name, state, limits) {
  if (depth > MAX_NESTING_DEPTH) {
    state.hitDepthLimit = true;
    return;
  }
  const facts = rootFacts(rows, prefix);
  if (facts.hasAssets) {
    state.layers.push({ rows, prefix, depth, name, facts });
    return;
  }

  for (const child of childDirectories(rows, prefix)) {
    findCoreLayers(rows, `${prefix}${child}/`, depth + 1, child, state, limits);
  }
  for (const row of childFiles(rows, prefix)) {
    let data;
    try {
      data = readRow(row);
    } catch {
      state.corruptNestedArchive = true;
      continue;
    }
    if (data.length < 2 || data[0] !== 0x50 || data[1] !== 0x4b) continue;
    try {
      if (!hasZipEndRecord(data)) throw new PackNormalizationError('corrupt_zip', 'Nested ZIP is truncated');
      const nestedRows = readZipRows(new AdmZip(data), limits);
      findCoreLayers(nestedRows, '', depth + 1, stemOf(path.posix.basename(row.path)), state, limits);
    } catch (error) {
      if (error instanceof PackNormalizationError && SAFETY_CODES.has(error.code)) throw error;
      state.corruptNestedArchive = true;
    }
  }
}

function inspectSource(filePath, options = {}) {
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...(options.limits || {}) };
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) {
    throw new PackNormalizationError('link_entry', 'Linked source entries are not allowed');
  }
  const sourceType = stat.isDirectory() ? 'directory' : 'file';
  if (sourceType === 'file') {
    const kind = detectFileKind(filePath);
    if (kind !== 'zip') {
      throw new PackNormalizationError(kind, `Unsupported source file: ${kind}`);
    }
  }
  const zip = sourceType === 'file' ? readArchive(filePath) : null;
  const rows = sourceType === 'file' ? readZipRows(zip, limits) : readDirectoryRows(filePath, limits);
  const sourceName = stemOf(path.basename(filePath));
  const search = { layers: [], hitDepthLimit: false, corruptNestedArchive: false };
  findCoreLayers(rows, '', 0, sourceName, search, limits);
  if (!search.layers.length) {
    if (search.hitDepthLimit) {
      throw new PackNormalizationError('too_deep', `Pack nesting exceeds ${MAX_NESTING_DEPTH} layers`);
    }
    if (search.corruptNestedArchive) {
      throw new PackNormalizationError('corrupt_zip', 'Nested ZIP data cannot be read');
    }
    throw new PackNormalizationError('no_core_found', 'Archive has no resolvable assets root');
  }
  // The signal's boundary is the matched inner pack: a high-version core layer never
  // propagates to its container, and never affects sibling packs (.docs/adr/0002).
  const highVersionLayer = search.layers.some(
    layer => textureVersionSignal(rows, layer.prefix) === 'high'
  );
  if (highVersionLayer) {
    return {
      classification: HIGH_VERSION_CAUSE,
      causes: [HIGH_VERSION_CAUSE],
      sourceType,
      zip,
      rows,
      prefix: search.layers[0].prefix,
      layers: search.layers,
    };
  }
  const root = search.layers[0].facts;
  const wrongExtension = sourceType === 'file' && !path.basename(filePath).endsWith('.zip');
  const rootCauses = root.hasAssets ? repairCauses(root) : [];
  const isRootProduct = search.layers.length === 1 && search.layers[0].depth === 0 && search.layers[0].prefix === '';
  if (isRootProduct && rootCauses.length === 0 && sourceType === 'file' && !wrongExtension) {
    return {
      classification: 'normal',
      causes: [],
      sourceType,
      zip,
      rows,
      prefix: '',
      layers: search.layers,
    };
  }
  const causes = [
    ...(sourceType === 'directory' && isRootProduct ? ['folder_container'] : []),
    ...(wrongExtension ? ['wrong_extension'] : []),
    ...(!isRootProduct || search.layers.length > 1 ? ['nested_container'] : []),
    ...search.layers.flatMap(layer => repairCauses(layer.facts)),
  ].filter((cause, index, all) => all.indexOf(cause) === index);
  return {
    classification: 'repairable',
    causes,
    sourceType,
    zip,
    rows,
    prefix: search.layers[0].prefix,
    layers: search.layers,
  };
}

function productName(filePath, prefix) {
  if (!prefix) return path.basename(filePath, path.extname(filePath));
  return path.posix.basename(prefix.slice(0, -1)) || path.basename(filePath, path.extname(filePath));
}

function buildProductRows(rows, prefix, name) {
  const facts = rootFacts(rows, prefix);
  const selectedMcmeta = facts.hasMcmeta
    ? facts.relative.find(row => row.path === 'pack.mcmeta')
    : facts.mcmetaVariant;
  const selectedPng = facts.hasPng
    ? facts.relative.find(row => row.path === 'pack.png')
    : facts.pngVariant;
  const selected = [];
  for (const row of facts.relative) {
    if (!row.path || isJunkPath(row.path) || isDeadPath(row.path)) continue;
    let target = null;
    if (row.path.startsWith('assets/')) target = row.path;
    else if (row === selectedMcmeta) target = 'pack.mcmeta';
    else if (row === selectedPng) target = 'pack.png';
    if (!target) continue;
    const data = target === 'pack.mcmeta' ? productMcmeta(readRow(row), name) : readRow(row);
    const key = target.normalize('NFC').toLowerCase();
    if (selected.some(item => item.path.normalize('NFC').toLowerCase() === key)) {
      throw new PackNormalizationError('colliding_output_paths', `Normalized output paths collide: ${target}`, { path: target });
    }
    selected.push({ path: target, data });
  }
  if (!selected.some(row => row.path === 'pack.mcmeta')) {
    selected.push({ path: 'pack.mcmeta', data: generatedMcmeta(name) });
  }
  return selected.sort((a, b) => a.path.localeCompare(b.path));
}

function writeDeterministicZip(rows, outputPath, prefix, name) {
  const zip = new AdmZip();
  const selected = buildProductRows(rows, prefix, name);

  for (const row of selected) {
    zip.addFile(row.path, row.data, '', 0o644);
    const entry = zip.getEntry(row.path);
    entry.header.time = FIXED_ZIP_TIME;
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  zip.writeZip(outputPath);
}

async function normalizePack(filePath, options = {}) {
  const sourcePath = path.resolve(filePath);
  const outputDir = options.outputDir ? path.resolve(options.outputDir) : null;
  const sourceStat = fs.lstatSync(sourcePath);
  const sourceType = sourceStat.isSymbolicLink() ? 'link' : sourceStat.isDirectory() ? 'directory' : 'file';
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...(options.limits || {}) };
  let inspected;
  try {
    inspected = inspectSource(sourcePath, { limits });
  } catch (error) {
    if (!(error instanceof PackNormalizationError)) throw error;
    const sourceArchiveSha256 = sourceType === 'file' && sourceStat.isFile() ? await sha256File(sourcePath) : null;
    const classification = SAFETY_CODES.has(error.code) ? 'blocked' : 'illegal';
    return {
      schemaVersion: NORMALIZATION_SCHEMA_VERSION,
      sourcePath,
      sourceType,
      sourceArchiveSha256,
      classification,
      causes: [error.code],
      details: error.details,
      products: [],
    };
  }
  const sourceArchiveSha256 = inspected.sourceType === 'file'
    ? await sha256File(sourcePath)
    : sha256(Buffer.concat(inspected.rows
      .filter(row => !isDirectoryRow(row))
      .sort((a, b) => a.path.localeCompare(b.path))
      .flatMap(row => [Buffer.from(`${row.path}\0`), readRow(row)])));

  if (inspected.classification === HIGH_VERSION_CAUSE) {
    return {
      schemaVersion: NORMALIZATION_SCHEMA_VERSION,
      sourcePath,
      sourceType: inspected.sourceType,
      sourceArchiveSha256,
      classification: HIGH_VERSION_CAUSE,
      causes: [HIGH_VERSION_CAUSE],
      details: {},
      products: [],
    };
  }

  if (inspected.classification === 'normal') {
    return {
      schemaVersion: NORMALIZATION_SCHEMA_VERSION,
      sourcePath,
      sourceType: inspected.sourceType,
      sourceArchiveSha256,
      classification: 'normal',
      causes: [],
      products: [{
        name: path.basename(sourcePath, path.extname(sourcePath)),
        path: sourcePath,
        classification: 'normal',
        archiveSha256: sourceArchiveSha256,
      }],
    };
  }

  if (!outputDir) throw new PackNormalizationError('output_required', 'Repairable archives require an output directory');
  const usedNames = new Map();
  const products = [];
  for (const layer of inspected.layers) {
    const sourceName = layer.name || productName(sourcePath, layer.prefix);
    const baseName = sanitizeProductName(sourceName);
    const key = baseName.toLowerCase();
    const ordinal = usedNames.get(key) || 0;
    usedNames.set(key, ordinal + 1);
    const name = ordinal ? `${baseName} (${ordinal})` : baseName;
    const outputPath = path.join(outputDir, `${name}.zip`);
    writeDeterministicZip(layer.rows, outputPath, layer.prefix, name);
    const product = inspectSource(outputPath, { limits });
    if (product.classification !== 'normal') {
      throw new PackNormalizationError('normalization_failed', 'Normalized output is not a Normal pack');
    }
    products.push({
      name,
      sourceName,
      path: outputPath,
      classification: product.classification,
      causes: repairCauses(layer.facts),
      archiveSha256: await sha256File(outputPath),
    });
  }
  return {
    schemaVersion: NORMALIZATION_SCHEMA_VERSION,
    sourcePath,
    sourceType: inspected.sourceType,
    sourceArchiveSha256,
    classification: inspected.classification,
    collection: products.length > 1,
    causes: inspected.causes,
    products,
  };
}

module.exports = {
  NORMALIZATION_SCHEMA_VERSION,
  HIGH_VERSION_CAUSE,
  textureVersionSignal,
  inspectPackSource: inspectSource,
  DEFAULT_ARCHIVE_LIMITS,
  MAX_NESTING_DEPTH,
  PackNormalizationError,
  isJunkName,
  hasLunarEscape,
  normalizeEntryPath,
  normalizePack,
  patchLunarEscapes,
  sanitizeProductName,
  sha256,
  sha256File,
};
