const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const AdmZip = require('adm-zip');
const sharp = require('sharp');

const SCHEMA_VERSION = 1;
const DEFAULT_LIMITS = {
  maxEntries: 50000,
  maxEntryBytes: 512 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
};
const RASTER_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.tif', '.tiff', '.avif', '.tga',
]);
const VISUAL_JSON_SEGMENTS = [
  '/models/', '/blockstates/', '/font/', '/shaders/', '/atlases/', '/optifine/', '/mcpatcher/',
];
const SHADER_EXTENSIONS = new Set(['.vsh', '.fsh', '.glsl']);
const SWORD_PATHS = {
  stone: [
    'assets/minecraft/textures/items/stone_sword.png',
    'assets/minecraft/textures/item/stone_sword.png',
  ],
  iron: [
    'assets/minecraft/textures/items/iron_sword.png',
    'assets/minecraft/textures/item/iron_sword.png',
  ],
  diamond: [
    'assets/minecraft/textures/items/diamond_sword.png',
    'assets/minecraft/textures/item/diamond_sword.png',
  ],
};

class PackFingerprintError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PackFingerprintError';
    this.code = code;
    this.details = details;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256Parts(...values) {
  const hash = crypto.createHash('sha256');
  for (const value of values) hash.update(value);
  return hash.digest('hex');
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
    return out;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function normalizeEntryPath(raw) {
  const normalized = String(raw || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length || parts.some(part => part === '..' || part.includes('\0'))) {
    throw new PackFingerprintError('unsafe_entry_path', `Unsafe zip entry path: ${raw}`);
  }
  return parts.join('/');
}

function getEntrySize(entry) {
  const value = entry && entry.header ? Number(entry.header.size) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function checkArchiveLimits(entries, limits) {
  const files = entries.filter(row => !row.entry.isDirectory);
  if (files.length > limits.maxEntries) {
    throw new PackFingerprintError('too_many_entries', `Archive has ${files.length} entries`, { count: files.length });
  }
  let total = 0;
  for (const row of files) {
    const size = getEntrySize(row.entry);
    if (size > limits.maxEntryBytes) {
      throw new PackFingerprintError('entry_too_large', `Archive entry is too large: ${row.path}`, { path: row.path, size });
    }
    total += size;
    if (total > limits.maxTotalBytes) {
      throw new PackFingerprintError('archive_expands_too_large', 'Archive uncompressed size exceeds the safety limit', { size: total });
    }
  }
}

function readZipRows(input, depth, limits) {
  if (depth > 10) throw new PackFingerprintError('nested_archive_depth', 'Nested archive depth exceeds 10');
  let zip;
  try {
    zip = new AdmZip(input);
  } catch (error) {
    throw new PackFingerprintError('invalid_zip', `Cannot read zip: ${error.message}`);
  }
  const rows = zip.getEntries().map(entry => ({ entry, path: normalizeEntryPath(entry.entryName) }));
  checkArchiveLimits(rows, limits);

  const files = rows.filter(row => !row.entry.isDirectory);
  const rootMeta = files.find(row => row.path.toLowerCase() === 'pack.mcmeta');
  if (rootMeta) return rows;

  const prefixes = new Set();
  for (const row of files) {
    const lower = row.path.toLowerCase();
    if (!lower.endsWith('/pack.mcmeta')) continue;
    prefixes.add(row.path.slice(0, row.path.length - 'pack.mcmeta'.length));
  }
  if (prefixes.size === 1) {
    const prefix = [...prefixes][0];
    const nestedRows = rows
      .filter(row => row.path.startsWith(prefix) && row.path.length > prefix.length)
      .map(row => ({ entry: row.entry, path: row.path.slice(prefix.length) }));
    checkArchiveLimits(nestedRows, limits);
    return nestedRows;
  }
  if (prefixes.size > 1) {
    throw new PackFingerprintError('ambiguous_pack_root', 'Archive contains multiple pack roots', { roots: [...prefixes].sort() });
  }

  const assetPrefixes = new Set();
  for (const row of files) {
    const lower = row.path.toLowerCase();
    const segments = lower.split('/');
    const basename = segments[segments.length - 1];
    if (segments.includes('__macosx') || basename.startsWith('._') || basename === '.ds_store') continue;
    if (lower.startsWith('assets/')) assetPrefixes.add('');
    else {
      const marker = lower.indexOf('/assets/');
      if (marker >= 0) assetPrefixes.add(row.path.slice(0, marker + 1));
    }
  }
  if (assetPrefixes.size === 1) {
    const prefix = [...assetPrefixes][0];
    if (!prefix) return rows;
    const nestedRows = rows
      .filter(row => row.path.startsWith(prefix) && row.path.length > prefix.length)
      .map(row => ({ entry: row.entry, path: row.path.slice(prefix.length) }));
    checkArchiveLimits(nestedRows, limits);
    return nestedRows;
  }
  if (assetPrefixes.size > 1) {
    throw new PackFingerprintError('ambiguous_pack_root', 'Archive contains multiple assets roots', { roots: [...assetPrefixes].sort() });
  }

  const innerZips = files.filter(row => path.posix.extname(row.path).toLowerCase() === '.zip');
  if (innerZips.length === 1) {
    return readZipRows(innerZips[0].entry.getData(), depth + 1, limits);
  }
  if (innerZips.length > 1) {
    throw new PackFingerprintError('ambiguous_nested_archive', 'Archive contains multiple nested zip files');
  }
  const nestedRar = files.find(row => path.posix.extname(row.path).toLowerCase() === '.rar');
  if (nestedRar) {
    throw new PackFingerprintError('nested_rar_requires_conversion', `Nested RAR requires conversion: ${nestedRar.path}`);
  }
  throw new PackFingerprintError('missing_pack_root', 'Archive does not contain pack.mcmeta at a resolvable root');
}

function classifyVisualPath(entryPath) {
  const lower = entryPath.toLowerCase();
  const segments = lower.split('/');
  const basename = segments[segments.length - 1];
  if (segments.includes('__macosx') || basename.startsWith('._') || basename === '.ds_store') return null;
  if (lower === 'pack.png' || lower === 'pack.mcmeta') return null;
  if (lower.endsWith('.png.mcmeta') || lower.endsWith('.mcmeta')) return 'json';

  const extension = path.posix.extname(lower);
  if (RASTER_EXTENSIONS.has(extension)) return 'raster';
  const padded = `/${lower}`;
  const inVisualTree = VISUAL_JSON_SEGMENTS.some(segment => padded.includes(segment));
  if (extension === '.json' && inVisualTree) return 'json';
  if (extension === '.properties' && (padded.includes('/optifine/') || padded.includes('/mcpatcher/'))) return 'properties';
  if (SHADER_EXTENSIONS.has(extension) && padded.includes('/shaders/')) return 'text';
  return null;
}

function isNormalizationRootBranding(entryPath) {
  if (entryPath.includes('/')) return false;
  const lower = entryPath.toLowerCase();
  return lower === 'pack..png' || lower === 'pack.png.png';
}

function decodeText(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    buffer = buffer.subarray(3);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return buffer.toString('latin1');
  }
}

function unescapeProperty(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\\') {
      out += text[i];
      continue;
    }
    if (++i >= text.length) {
      out += '\\';
      break;
    }
    const ch = text[i];
    if (ch === 't') out += '\t';
    else if (ch === 'n') out += '\n';
    else if (ch === 'r') out += '\r';
    else if (ch === 'f') out += '\f';
    else if (ch === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) {
      out += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16));
      i += 4;
    } else out += ch;
  }
  return out;
}

function hasContinuation(line) {
  let slashes = 0;
  for (let i = line.length - 1; i >= 0 && line[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
}

function canonicalizeProperties(buffer) {
  const physical = decodeText(buffer).replace(/\r\n?/g, '\n').split('\n');
  const logical = [];
  for (let i = 0; i < physical.length; i++) {
    let line = physical[i];
    while (hasContinuation(line) && i + 1 < physical.length) {
      line = line.slice(0, -1) + physical[++i].replace(/^\s+/, '');
    }
    logical.push(line);
  }

  const values = new Map();
  for (const raw of logical) {
    const line = raw.replace(/^\s+/, '');
    if (!line || line[0] === '#' || line[0] === '!') continue;
    let escaped = false;
    let separator = -1;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (!escaped && (ch === '=' || ch === ':' || /\s/.test(ch))) {
        separator = i;
        break;
      }
      if (ch === '\\') escaped = !escaped;
      else escaped = false;
    }
    const rawKey = separator < 0 ? line : line.slice(0, separator);
    let rawValue = separator < 0 ? '' : line.slice(separator);
    rawValue = rawValue.replace(/^\s*(?:=|:)?\s*/, '');
    values.set(unescapeProperty(rawKey), unescapeProperty(rawValue));
  }
  return Buffer.from(stableStringify([...values.entries()].sort((a, b) => a[0].localeCompare(b[0]))));
}

function canonicalizeConfig(kind, buffer, entryPath) {
  if (kind === 'json') {
    let value;
    try {
      value = JSON.parse(decodeText(buffer));
    } catch (error) {
      if (entryPath.toLowerCase().endsWith('.mcmeta')) {
        return Buffer.from(`invalid-mcmeta\0${decodeText(buffer).replace(/\r\n?/g, '\n')}`);
      }
      return Buffer.from(`invalid-json\0${decodeText(buffer).replace(/\r\n?/g, '\n')}`);
    }
    return Buffer.from(stableStringify(value));
  }
  if (kind === 'properties') return canonicalizeProperties(buffer);
  return Buffer.from(decodeText(buffer).replace(/\r\n?/g, '\n'));
}

async function hashRaster(buffer, entryPath) {
  let result;
  try {
    result = await sharp(buffer, { animated: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    return {
      pixelHash: sha256Parts(Buffer.from('invalid-raster\0'), buffer),
      info: { invalid: true, bytes: buffer.length },
      decodable: false,
    };
  }
  const info = {
    width: result.info.width,
    height: result.info.height,
    channels: result.info.channels,
    pages: result.info.pages || 1,
    pageHeight: result.info.pageHeight || result.info.height,
  };
  const header = Buffer.from(`${stableStringify(info)}\0`);
  return { pixelHash: sha256Parts(header, result.data), info, decodable: true };
}

function readEntryData(entry, entryPath) {
  try {
    return entry.getData();
  } catch (originalError) {
    try {
      const compressed = entry.getCompressedData();
      if (entry.header.method === 0) return compressed;
      if (entry.header.method === 8) return zlib.inflateRawSync(compressed);
    } catch (recoveryError) {
      throw new PackFingerprintError('unreadable_visual_entry', `Cannot read visual entry: ${entryPath}`, {
        path: entryPath,
        error: originalError.message,
        recoveryError: recoveryError.message,
      });
    }
    throw new PackFingerprintError('unreadable_visual_entry', `Cannot read visual entry: ${entryPath}`, {
      path: entryPath,
      error: originalError.message,
      method: entry.header.method,
    });
  }
}

let defaultSwordHashPromise = null;

async function loadDefaultSwordHashes(defaultTextureRoot) {
  if (!defaultTextureRoot && defaultSwordHashPromise) return defaultSwordHashPromise;
  const root = defaultTextureRoot || path.join(__dirname, '..', '..', 'Default_Texture');
  const load = async () => {
    const hashes = {};
    for (const [type, candidates] of Object.entries(SWORD_PATHS)) {
      const relative = candidates.find(candidate => fs.existsSync(path.join(root, candidate)));
      if (!relative) throw new PackFingerprintError('missing_default_sword', `Missing default ${type} sword texture`);
      hashes[type] = (await hashRaster(await fs.promises.readFile(path.join(root, relative)), relative)).pixelHash;
    }
    return hashes;
  };
  if (defaultTextureRoot) return load();
  defaultSwordHashPromise = load();
  return defaultSwordHashPromise;
}

async function fingerprintPack(zipPath, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const archiveSha256 = await sha256File(zipPath);
  const rows = readZipRows(zipPath, 0, limits);
  const seen = new Set();
  const leaves = [];
  const rasterHashes = new Map();

  for (const row of rows) {
    if (row.entry.isDirectory) continue;
    if (options.normalizationSource && isNormalizationRootBranding(row.path)) continue;
    const kind = classifyVisualPath(row.path);
    if (!kind) continue;
    if (seen.has(row.path)) {
      throw new PackFingerprintError('duplicate_visual_path', `Duplicate visual path: ${row.path}`, { path: row.path });
    }
    seen.add(row.path);
    const buffer = readEntryData(row.entry, row.path);

    if (kind === 'raster') {
      const raster = await hashRaster(buffer, row.path);
      if (raster.decodable) rasterHashes.set(row.path, raster.pixelHash);
      leaves.push({ path: row.path, kind, digest: raster.pixelHash, image: raster.info });
    } else {
      const canonical = canonicalizeConfig(kind, buffer, row.path);
      leaves.push({ path: row.path, kind, digest: sha256(canonical) });
    }
  }

  leaves.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = { schemaVersion: SCHEMA_VERSION, entries: leaves };
  const defaults = options.defaultSwordHashes || await loadDefaultSwordHashes(options.defaultTextureRoot);
  const swords = {};
  for (const [type, candidates] of Object.entries(SWORD_PATHS)) {
    const matched = candidates.find(candidate => rasterHashes.has(candidate));
    swords[type] = matched ? rasterHashes.get(matched) : defaults[type];
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    archiveSha256,
    visualContentHash: sha256(stableStringify(manifest)),
    visualEntryCount: leaves.length,
    swords,
    ...(options.includeManifest ? { manifest } : {}),
  };
}

module.exports = {
  DEFAULT_LIMITS,
  PackFingerprintError,
  SCHEMA_VERSION,
  SWORD_PATHS,
  canonicalizeProperties,
  classifyVisualPath,
  fingerprintPack,
  hashRaster,
  loadDefaultSwordHashes,
  sha256,
  stableStringify,
};
