const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { sanitizePreviewPngBuffer } = require('./thumbnail-preview-utils');
const { stableStringify } = require('./lib/pack-content-fingerprint');

const THUMB_DIR = path.join(__dirname, '..', 'thumbnails');
const OUT_FILE = path.join(__dirname, '..', 'data', 'sbi-fingerprints.json');
const SHARD_DIR = path.join(__dirname, '..', 'data', 'sbi-fp');
const META_FILE = path.join(SHARD_DIR, 'meta.json');
const SBI_FINGERPRINT_VERSION = 18;
const SBI_GROUP_SCHEMA_VERSION = 1;
const DEFAULT_SHARD_TARGET_BYTES = 32 * 1024 * 1024;
const GITHUB_FILE_LIMIT_BYTES = 100 * 1024 * 1024;
const ANCHOR_INDEX_KEYS = new Set(['diamond_sword', 'ender_pearl', 'splash_potion']);
const EXCLUDED_LIST_NAMES = ['Overlay', 'Conquest'];

// Note: crosshair removed — MC renders it via XOR blending, making screenshot comparison meaningless
const TEXTURES = [
  { key: 'diamond_sword', file: 'diamond_sword.png' },
  { key: 'ender_pearl', file: 'ender_pearl.png' },
  { key: 'splash_potion', files: ['splash_potion_of_healing.png', 'potion_bottle_splash.png'] },
  { key: 'steak', file: 'steak.png' },
  { key: 'golden_carrot', file: 'golden_carrot.png' },
];

// Hotbar widget region in vanilla widgets.png (256x256 base)
const HOTBAR_REGION = { x: 0, y: 0, w: 182, h: 22 };
const HUD_ICON_REGIONS = {
  health_empty: { x: 16, y: 0, w: 9, h: 9 },
  health_half: { x: 61, y: 0, w: 9, h: 9 },
  health_full: { x: 52, y: 0, w: 9, h: 9 },
  hunger_empty: { x: 16, y: 27, w: 9, h: 9 },
  hunger_half: { x: 61, y: 27, w: 9, h: 9 },
  hunger_full: { x: 52, y: 27, w: 9, h: 9 },
  armor_empty: { x: 16, y: 9, w: 9, h: 9 },
  armor_half: { x: 25, y: 9, w: 9, h: 9 },
  armor_full: { x: 34, y: 9, w: 9, h: 9 },
};

const SHARDS = [
  { name: 'diamond_sword', keys: ['diamond_sword'] },
  { name: 'ender_pearl', keys: ['ender_pearl'] },
  { name: 'splash_potion', keys: ['splash_potion'] },
  { name: 'food', keys: ['steak', 'golden_carrot'] },
  { name: 'widget', keys: ['hotbar_widget'] },
  { name: 'health', keys: ['health_empty', 'health_half', 'health_full'] },
  { name: 'hunger', keys: ['hunger_empty', 'hunger_half', 'hunger_full'] },
  { name: 'armor', keys: ['armor_empty', 'armor_half', 'armor_full'] },
];

function parseArgs(argv) {
  const args = { packList: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--pack-list') {
      args.packList = argv[++i] || null;
    } else if (arg.startsWith('--pack-list=')) {
      args.packList = arg.slice('--pack-list='.length);
    }
  }
  return args;
}

function loadPackAllowlist(filePath) {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  const data = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
  if (Array.isArray(data)) return new Set(data);
  if (data && data.packs && typeof data.packs === 'object') return new Set(Object.keys(data.packs));
  throw new Error(`Unsupported pack list format: ${resolved}`);
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

// dHash per RGB channel: 24 bytes (192 bits), color-aware
function computeDHash(pixels) {
  const bits = new Uint8Array(24);
  for (let ch = 0; ch < 3; ch++) {
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const li = (row * 9 + col) * 4 + ch;
        const ri = (row * 9 + col + 1) * 4 + ch;
        const bit = row * 8 + col;
        const byteIdx = ch * 8 + (bit >> 3);
        if (pixels[li] > pixels[ri])
          bits[byteIdx] |= (1 << (7 - (bit & 7)));
      }
    }
  }
  return Buffer.from(bits).toString('base64');
}

// Histogram: 48-bin RGB (16 per channel) + 24-bin hue (15° each) = 72 bins total
function computeHistogram(pixels, count) {
  const hist = new Float64Array(72);
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (pixels[i * 4 + 3] < 128) continue;
    const r = pixels[i * 4], g = pixels[i * 4 + 1], b = pixels[i * 4 + 2];
    total++;
    hist[Math.min(r >> 4, 15)]++;
    hist[16 + Math.min(g >> 4, 15)]++;
    hist[32 + Math.min(b >> 4, 15)]++;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d > 10) {
      let h;
      if (max === r) h = ((g - b) / d + 6) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      hist[48 + Math.min(Math.floor(h * 4), 23)]++;
    }
  }
  if (total > 0) for (let i = 0; i < 72; i++) hist[i] /= total;
  return Array.from(hist, v => Math.round(clamp01(v) * 255));
}

// Color moments: mean + std per channel (non-transparent pixels only)
function computeColorMoments(pixels, count) {
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let i = 0; i < count; i++) {
    if (pixels[i * 4 + 3] < 128) continue;
    sr += pixels[i * 4]; sg += pixels[i * 4 + 1]; sb += pixels[i * 4 + 2];
    n++;
  }
  if (!n) return [0, 0, 0, 0, 0, 0];
  const mr = sr / n, mg = sg / n, mb = sb / n;
  let vr = 0, vg = 0, vb = 0;
  for (let i = 0; i < count; i++) {
    if (pixels[i * 4 + 3] < 128) continue;
    vr += (pixels[i * 4] - mr) ** 2;
    vg += (pixels[i * 4 + 1] - mg) ** 2;
    vb += (pixels[i * 4 + 2] - mb) ** 2;
  }
  return [
    +(mr / 255).toFixed(5), +(mg / 255).toFixed(5), +(mb / 255).toFixed(5),
    +(Math.sqrt(vr / n) / 255).toFixed(5),
    +(Math.sqrt(vg / n) / 255).toFixed(5),
    +(Math.sqrt(vb / n) / 255).toFixed(5),
  ];
}

// Edge density: mean normalized gradient magnitude
function computeEdgeDensity(pixels, w, h) {
  let sum = 0, count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (pixels[i + 3] < 128) continue;
      if (x + 1 < w) {
        const ri = (y * w + x + 1) * 4;
        sum += Math.abs(pixels[i] - pixels[ri]) + Math.abs(pixels[i+1] - pixels[ri+1]) + Math.abs(pixels[i+2] - pixels[ri+2]);
        count++;
      }
      if (y + 1 < h) {
        const di = ((y+1) * w + x) * 4;
        sum += Math.abs(pixels[i] - pixels[di]) + Math.abs(pixels[i+1] - pixels[di+1]) + Math.abs(pixels[i+2] - pixels[di+2]);
        count++;
      }
    }
  }
  return count ? +(sum / (count * 3 * 255)).toFixed(5) : 0;
}

function computeSpatialPixels(pixels, w, h, targetSize = 16) {
  const out = Buffer.alloc(targetSize * targetSize * 4);
  for (let y = 0; y < targetSize; y++) {
    const sy = Math.min(h - 1, Math.floor((y + 0.5) * h / targetSize));
    for (let x = 0; x < targetSize; x++) {
      const sx = Math.min(w - 1, Math.floor((x + 0.5) * w / targetSize));
      const source = (sy * w + sx) * 4;
      const target = (y * targetSize + x) * 4;
      out[target] = pixels[source];
      out[target + 1] = pixels[source + 1];
      out[target + 2] = pixels[source + 2];
      out[target + 3] = pixels[source + 3];
    }
  }
  return out.toString('base64');
}

function computeItemSignature(pixels, w, h) {
  const centerX1 = Math.floor(w * 0.25);
  const centerX2 = Math.ceil(w * 0.75);
  const centerY1 = Math.floor(h * 0.25);
  const centerY2 = Math.ceil(h * 0.75);
  const edgeInsetX = Math.max(1, Math.floor(w * 0.1875));
  const edgeInsetY = Math.max(1, Math.floor(h * 0.1875));
  let n = 0, lumSum = 0, rSum = 0, gSum = 0, bSum = 0;
  let red = 0, yellow = 0, dark = 0, blue = 0;
  let centerN = 0, centerDark = 0, edgeN = 0, edgeDark = 0;
  let xSum = 0, ySum = 0;
  let leftN = 0, rightN = 0, topN = 0, bottomN = 0;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  const rowXSum = new Float64Array(h);
  const rowCount = new Uint16Array(h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (pixels[i + 3] < 128) continue;
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const isDark = lum < 72;
      n++;
      lumSum += lum;
      rSum += r;
      gSum += g;
      bSum += b;
      xSum += x;
      ySum += y;
      if (r > g + 30 && r > b + 30) red++;
      if (r > 160 && g > 140 && b < 140) yellow++;
      if (isDark) dark++;
      if (b > r + 12 && b > g + 8) blue++;
      if (x < w * 0.5) leftN++;
      else rightN++;
      if (y < h * 0.5) topN++;
      else bottomN++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      rowXSum[y] += x;
      rowCount[y]++;

      const inCenter = x >= centerX1 && x < centerX2 && y >= centerY1 && y < centerY2;
      if (inCenter) {
        centerN++;
        if (isDark) centerDark++;
      }
      const inEdge = x < edgeInsetX || x >= w - edgeInsetX || y < edgeInsetY || y >= h - edgeInsetY;
      if (inEdge) {
        edgeN++;
        if (isDark) edgeDark++;
      }
    }
  }

  if (!n) {
    return {
      n: 0,
      coverage: 0,
      meanLum: 0,
      meanR: 0,
      meanG: 0,
      meanB: 0,
      redFrac: 0,
      yellowFrac: 0,
      darkFrac: 0,
      blueFrac: 0,
      centerDarkFrac: 0,
      edgeDarkFrac: 0,
      centerX: 0,
      centerY: 0,
      lrBias: 0,
      tbBias: 0,
      mirrorFrac: 1,
      rowSlope: 0,
      bboxTop: 1,
      bboxBottom: 0,
      bboxLeft: 1,
      bboxRight: 0,
    };
  }

  let mirrorAgree = 0, mirrorPairs = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < Math.floor(w / 2); x++) {
      const li = (y * w + x) * 4 + 3;
      const ri = (y * w + (w - 1 - x)) * 4 + 3;
      const leftOn = pixels[li] >= 128;
      const rightOn = pixels[ri] >= 128;
      if (!leftOn && !rightOn) continue;
      mirrorPairs++;
      if (leftOn === rightOn) mirrorAgree++;
    }
  }

  let rowMeanY = 0, rowMeanX = 0, rowsUsed = 0;
  for (let y = 0; y < h; y++) {
    if (!rowCount[y]) continue;
    rowMeanY += y;
    rowMeanX += rowXSum[y] / rowCount[y];
    rowsUsed++;
  }
  if (rowsUsed) {
    rowMeanY /= rowsUsed;
    rowMeanX /= rowsUsed;
  }
  let rowCov = 0, rowVar = 0;
  for (let y = 0; y < h; y++) {
    if (!rowCount[y]) continue;
    const rowCenterX = rowXSum[y] / rowCount[y];
    rowCov += (y - rowMeanY) * (rowCenterX - rowMeanX);
    rowVar += (y - rowMeanY) ** 2;
  }

  const round = value => +value.toFixed(4);
  const widthDen = Math.max(1, w - 1);
  const heightDen = Math.max(1, h - 1);
  const rowSlope = rowVar ? (rowCov / rowVar) / Math.max(1, w / 2) : 0;
  return {
    n,
    coverage: round(n / (w * h)),
    meanLum: round(lumSum / n),
    meanR: round(rSum / n),
    meanG: round(gSum / n),
    meanB: round(bSum / n),
    redFrac: round(red / n),
    yellowFrac: round(yellow / n),
    darkFrac: round(dark / n),
    blueFrac: round(blue / n),
    centerDarkFrac: round(centerN ? (centerDark / centerN) : 0),
    edgeDarkFrac: round(edgeN ? (edgeDark / edgeN) : 0),
    centerX: round((xSum / n) / widthDen),
    centerY: round((ySum / n) / heightDen),
    lrBias: round((rightN - leftN) / n),
    tbBias: round((bottomN - topN) / n),
    mirrorFrac: round(mirrorPairs ? (mirrorAgree / mirrorPairs) : 1),
    rowSlope: round(rowSlope),
    bboxTop: round(minY < h ? (minY / heightDen) : 1),
    bboxBottom: round(maxY >= 0 ? (maxY / heightDen) : 0),
    bboxLeft: round(minX < w ? (minX / widthDen) : 1),
    bboxRight: round(maxX >= 0 ? (maxX / widthDen) : 0),
  };
}

function maskWidgetItems(pixels, w, h) {
  const out = Buffer.from(pixels);
  if (w < 40 || h < 12) return out;

  const sx = w / 182;
  const sy = h / 22;
  const itemSize = Math.max(1, Math.round(16 * Math.min(sx, sy)));
  const itemY = Math.round(3 * sy);
  const maskSize = Math.max(6, Math.min(itemSize - 2, Math.round(itemSize * 0.5)));
  const inset = Math.max(0, Math.floor((itemSize - maskSize) / 2));

  for (let i = 0; i < 9; i++) {
    const itemX = Math.round((3 + i * 20) * sx);
    const x1 = Math.max(0, itemX + inset);
    const x2 = Math.min(w, itemX + inset + maskSize);
    const y1 = Math.max(0, itemY + inset);
    const y2 = Math.min(h, itemY + inset + maskSize);
    for (let y = y1; y < y2; y++) {
      for (let x = x1; x < x2; x++) out[(y * w + x) * 4 + 3] = 0;
    }
  }

  return out;
}

function suppressWidgetHighlights(pixels, w, h) {
  const out = Buffer.from(pixels);
  const lum = [];
  for (let i = 0; i < w * h; i++) {
    const a = out[i * 4 + 3];
    if (a < 128) continue;
    lum.push(0.299 * out[i * 4] + 0.587 * out[i * 4 + 1] + 0.114 * out[i * 4 + 2]);
  }
  if (lum.length < 32) return out;
  lum.sort((a, b) => a - b);
  const thr = lum[Math.min(lum.length - 1, Math.floor(lum.length * 0.985))];
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    if (out[p + 3] < 128) continue;
    const L = 0.299 * out[p] + 0.587 * out[p + 1] + 0.114 * out[p + 2];
    if (L > thr) out[p + 3] = 0;
  }
  return out;
}

async function processTexture(filePath, spatialSize = 16) {
  const sanitized = await sanitizePreviewPngBuffer(await fs.promises.readFile(filePath));
  const img = sharp(sanitized.buffer);
  const meta = await img.metadata();
  const normalized = meta.height > meta.width && meta.height % meta.width === 0
    ? img.extract({ left: 0, top: 0, width: meta.width, height: meta.width })
    : img;
  return processSharpImage(normalized, 16, 16, true, spatialSize);
}

function scaleRegion(meta, region) {
  const scale = meta.width / 256;
  const left = Math.max(0, Math.round(region.x * scale));
  const top = Math.max(0, Math.round(region.y * scale));
  const width = Math.max(1, Math.round(region.w * scale));
  const height = Math.max(1, Math.round(region.h * scale));
  const safeWidth = Math.min(width, Math.max(1, meta.width - left));
  const safeHeight = Math.min(height, Math.max(1, meta.height - top));
  return { left, top, width: safeWidth, height: safeHeight };
}

async function processSharpImage(img, featureW, featureH, includePixels = true, spatialSize = 16) {
  const hashBuf = await img.clone().resize(9, 8, { fit: 'fill', kernel: 'nearest' }).raw().ensureAlpha().toBuffer();
  const dhash = computeDHash(hashBuf);
  const featBuf = await img.clone().resize(featureW, featureH, { fit: 'fill', kernel: 'nearest' }).raw().ensureAlpha().toBuffer();
  const count = featureW * featureH;
  const hist = computeHistogram(featBuf, count);
  const moments = computeColorMoments(featBuf, count);
  const edge = computeEdgeDensity(featBuf, featureW, featureH);
  const sig = computeItemSignature(featBuf, featureW, featureH);
  const result = { dhash, hist, moments, edge, sig };
  if (includePixels) {
    const spatialBuf = spatialSize === featureW && spatialSize === featureH
      ? featBuf
      : await img.clone().resize(spatialSize, spatialSize, { fit: 'fill', kernel: 'nearest' }).raw().ensureAlpha().toBuffer();
    result.pix = computeSpatialPixels(spatialBuf, spatialSize, spatialSize, spatialSize);
  }
  return result;
}

async function processHotbarWidget(widgetsPath) {
  const meta = await sharp(widgetsPath).metadata();
  const crop = scaleRegion(meta, HOTBAR_REGION);
  const normalized = await sharp(widgetsPath)
    .extract(crop)
    .resize(182, 22, { fit: 'fill', kernel: 'nearest' })
    .raw()
    .ensureAlpha()
    .toBuffer();
  const masked = maskWidgetItems(normalized, 182, 22);
  const featBuf = await sharp(masked, { raw: { width: 182, height: 22, channels: 4 } })
    .resize(16, 16, { fit: 'fill', kernel: 'nearest' })
    .raw()
    .ensureAlpha()
    .toBuffer();
  const clean = suppressWidgetHighlights(featBuf, 16, 16);
  const count = 16 * 16;
  return {
    hist: computeHistogram(clean, count),
    moments: computeColorMoments(clean, count),
    edge: computeEdgeDensity(clean, 16, 16),
  };
}

function bucketIndex(value, edges) {
  for (let i = 0; i < edges.length; i++) {
    if (value < edges[i]) return i;
  }
  return edges.length;
}

function getBucketKey(sig) {
  if (!sig) return '';
  const gbRatio = (sig.meanG || 0) / Math.max(1, sig.meanB || 0);
  return [
    bucketIndex(sig.darkFrac || 0, [0.25, 0.50, 0.75]),
    bucketIndex(sig.meanLum || 0, [64, 128, 192]),
    bucketIndex(sig.blueFrac || 0, [0.25, 0.50, 0.75]),
    bucketIndex(gbRatio, [0.5, 1.0, 1.5]),
  ].join('.');
}

function addIndexEntry(index, key, bucketKey, packName) {
  if (!bucketKey) return;
  if (!index[key]) index[key] = {};
  if (!index[key][bucketKey]) index[key][bucketKey] = [];
  index[key][bucketKey].push(packName);
}

function getDHashSegmentKeys(dhash) {
  if (!dhash) return [];
  const bytes = Buffer.from(dhash, 'base64');
  if (bytes.length < 24) return [];
  const keys = [];
  for (let offset = 0; offset + 4 <= 24; offset += 4) {
    keys.push(`${offset / 4}:${bytes.subarray(offset, offset + 4).toString('hex')}`);
  }
  return keys;
}

function addHashIndexEntries(index, key, dhash, packName) {
  if (!ANCHOR_INDEX_KEYS.has(key)) return;
  const segmentKeys = getDHashSegmentKeys(dhash);
  if (!segmentKeys.length) return;
  if (!index._hash) index._hash = {};
  if (!index._hash[key]) index._hash[key] = {};
  for (const segmentKey of segmentKeys) {
    if (!index._hash[key][segmentKey]) index._hash[key][segmentKey] = [];
    index._hash[key][segmentKey].push(packName);
  }
}

function buildShardPacks(packs, keys) {
  const shardPacks = {};
  const index = {};
  for (const packName of Object.keys(packs).sort((a, b) => a.localeCompare(b))) {
    const packData = packs[packName];
    const entry = {};
    for (const key of keys) {
      if (!packData[key]) continue;
      entry[key] = packData[key];
      addIndexEntry(index, key, getBucketKey(packData[key].sig), packName);
      addHashIndexEntries(index, key, packData[key].dhash, packName);
    }
    if (Object.keys(entry).length) shardPacks[packName] = entry;
  }
  return { shardPacks, index };
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function surfaceKey(value) {
  return sha256Text(stableStringify(value));
}

function buildGroupedData(packs, exclusionSummary = {}) {
  const surfaceKeys = [...new Set(SHARDS.flatMap(shard => shard.keys))].sort();
  const grouped = new Map();
  for (const packName of Object.keys(packs).sort((a, b) => a.localeCompare(b))) {
    const packData = packs[packName];
    const record = {};
    for (const key of surfaceKeys) record[key] = packData[key] || null;
    const digest = sha256Text(stableStringify(record));
    const groupId = `g:${digest}`;
    if (!grouped.has(groupId)) grouped.set(groupId, { representative: packName, members: [], packData });
    grouped.get(groupId).members.push(packName);
  }

  const groupPacks = {};
  const groups = {};
  for (const [groupId, group] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    group.members.sort((a, b) => a.localeCompare(b));
    group.representative = group.members[0];
    groupPacks[groupId] = group.packData;
    groups[groupId] = { representative: group.representative, members: group.members };
  }

  const frequencies = {};
  const groupSurfaceKeys = {};
  for (const [groupId, packData] of Object.entries(groupPacks)) {
    const keys = {};
    for (const key of surfaceKeys) {
      if (!packData[key]) continue;
      const exactKey = surfaceKey(packData[key]);
      keys[key] = exactKey;
      if (!frequencies[key]) frequencies[key] = {};
      frequencies[key][exactKey] = (frequencies[key][exactKey] || 0) + 1;
    }
    groupSurfaceKeys[groupId] = keys;
  }

  const groupCount = Object.keys(groupPacks).length;
  const maxIdf = Math.log((groupCount + 1) / 2) || 1;
  const rarity = {};
  for (const groupId of Object.keys(groupPacks)) {
    const values = {};
    for (const [key, exactKey] of Object.entries(groupSurfaceKeys[groupId])) {
      const count = frequencies[key][exactKey];
      const normalized = Math.max(0, Math.min(1, Math.log((groupCount + 1) / (count + 1)) / maxIdf));
      values[key] = {
        count,
        weight: +(0.35 + normalized * 0.65).toFixed(4),
      };
    }
    rarity[groupId] = values;
  }

  const meta = {
    version: SBI_FINGERPRINT_VERSION,
    schemaVersion: SBI_GROUP_SCHEMA_VERSION,
    packCount: Object.keys(packs).length,
    groupCount,
    excludedLists: EXCLUDED_LIST_NAMES,
    excludedCounts: exclusionSummary,
    groups,
    rarity,
  };
  return { groupPacks, meta };
}

function shardPayload(type, keys, packs, bucketKey) {
  const { shardPacks, index } = buildShardPacks(packs, keys);
  return {
    version: SBI_FINGERPRINT_VERSION,
    type,
    bucket: bucketKey,
    keys,
    packs: shardPacks,
    _index: index,
  };
}

function payloadBytes(payload) {
  return Buffer.byteLength(JSON.stringify(payload));
}

function stablePackBucket(packName) {
  return sha256Text(packName);
}

function splitShardEntries(type, keys, packs, targetBytes, hardLimitBytes, prefix = '') {
  const names = Object.keys(packs).sort((a, b) => a.localeCompare(b));
  const payload = shardPayload(type, keys, packs, prefix || 'all');
  const size = payloadBytes(payload);
  if (size <= targetBytes || names.length <= 1) {
    if (size > hardLimitBytes) {
      throw new Error(`SBI shard exceeds hard file limit: ${type}/${prefix || 'all'} (${size} bytes)`);
    }
    return [{ key: prefix || 'all', payload, size }];
  }

  const groups = new Map();
  const depth = prefix.length;
  for (const name of names) {
    const hash = stablePackBucket(name);
    const key = `${prefix}${hash[depth] || '0'}`;
    if (!groups.has(key)) groups.set(key, {});
    groups.get(key)[name] = packs[name];
  }
  if (groups.size < 2) {
    const midpoint = Math.ceil(names.length / 2);
    groups.set(`${prefix}0`, Object.fromEntries(names.slice(0, midpoint).map(name => [name, packs[name]])));
    groups.set(`${prefix}1`, Object.fromEntries(names.slice(midpoint).map(name => [name, packs[name]])));
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, group]) => splitShardEntries(type, keys, group, targetBytes, hardLimitBytes, key));
}

function writeShards(packs, meta, options = {}) {
  const shardDir = options.shardDir || SHARD_DIR;
  const metaFile = options.metaFile || path.join(shardDir, 'meta.json');
  const monolithicPath = options.monolithicPath || OUT_FILE;
  const targetBytes = Number(options.targetBytes) || DEFAULT_SHARD_TARGET_BYTES;
  const hardLimitBytes = Number(options.hardLimitBytes) || GITHUB_FILE_LIMIT_BYTES;
  fs.mkdirSync(shardDir, { recursive: true });

  const outputMeta = {
    ...meta,
    shards: {},
    observations: {},
  };
  const expected = new Set(['meta.json']);
  for (const shard of SHARDS) {
    const buckets = splitShardEntries(shard.name, shard.keys, packs, targetBytes, hardLimitBytes);
    outputMeta.shards[shard.name] = {
      keys: shard.keys,
      buckets: buckets.map(bucket => ({
        key: bucket.key,
        file: bucket.key === 'all' ? `${shard.name}.json` : `${shard.name}-${bucket.key}.json`,
        bytes: bucket.size,
      })),
    };
    for (const bucket of buckets) {
      const file = bucket.key === 'all' ? `${shard.name}.json` : `${shard.name}-${bucket.key}.json`;
      expected.add(file);
      fs.writeFileSync(path.join(shardDir, file), JSON.stringify(bucket.payload));
    }
    for (const key of shard.keys) {
      outputMeta.observations[key] = {
        shard: shard.name,
        files: outputMeta.shards[shard.name].buckets.map(bucket => bucket.file),
      };
    }
  }
  for (const file of fs.readdirSync(shardDir)) {
    if (!file.endsWith('.json') || expected.has(file)) continue;
    fs.rmSync(path.join(shardDir, file), { force: true });
  }
  fs.writeFileSync(metaFile, JSON.stringify(outputMeta));
  if (monolithicPath && fs.existsSync(monolithicPath)) fs.rmSync(monolithicPath, { force: true });
  return outputMeta;
}

async function processHudIcons(iconsPath) {
  const meta = await sharp(iconsPath).metadata();
  const out = {};
  for (const [key, region] of Object.entries(HUD_ICON_REGIONS)) {
    const crop = scaleRegion(meta, region);
    const img = sharp(iconsPath).extract(crop);
    const fw = region.fw || 16;
    const fh = region.fh || 16;
    out[key] = await processSharpImage(img, fw, fh, false);
  }
  return out;
}

function buildExclusionSet(lists) {
  const packs = new Set();
  const counts = {};
  for (const name of EXCLUDED_LIST_NAMES) {
    const list = lists.find(row => row.name === name);
    const members = list && Array.isArray(list.packs) ? list.packs : [];
    counts[name] = members.length;
    for (const packName of members) packs.add(packName);
  }
  return { packs, counts };
}

function loadExcludedPacks() {
  const listsPath = path.join(__dirname, '..', 'l', 'lists.json');
  if (!fs.existsSync(listsPath)) return { packs: new Set(), counts: {} };
  return buildExclusionSet(JSON.parse(fs.readFileSync(listsPath, 'utf-8')));
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const packAllowlist = loadPackAllowlist(args.packList);
  const excluded = loadExcludedPacks();
  const allDirs = fs.readdirSync(THUMB_DIR).filter(d =>
    fs.statSync(path.join(THUMB_DIR, d)).isDirectory()
  ).sort((a, b) => a.localeCompare(b));
  const eligibleDirs = allDirs.filter(d => !excluded.packs.has(d));
  const dirs = packAllowlist ? eligibleDirs.filter(d => packAllowlist.has(d)) : eligibleDirs;
  const skipped = allDirs.length - dirs.length;
  const allowlistNote = packAllowlist ? `, allowlist ${packAllowlist.size}` : '';
  console.log(`Processing ${dirs.length} packs${skipped ? ` (skipped ${skipped} overlay/unlisted${allowlistNote})` : ''}...`);
  const packs = {};
  let done = 0;
  for (const dir of dirs) {
    const packDir = path.join(THUMB_DIR, dir);
    const packData = {};
    for (const tex of TEXTURES) {
      const candidates = tex.files || [tex.file];
      let filePath = null;
      for (const f of candidates) {
        const p = path.join(packDir, f);
        if (fs.existsSync(p)) { filePath = p; break; }
      }
      if (!filePath) continue;
      try {
        const spatialSize = tex.key === 'diamond_sword' || tex.key === 'ender_pearl' ? 32 : 16;
        packData[tex.key] = await processTexture(filePath, spatialSize);
      } catch { /* skip broken */ }
    }
    // Process hotbar widget from widgets.png
    const widgetsPath = path.join(packDir, 'widgets.png');
    if (fs.existsSync(widgetsPath)) {
      try {
        packData.hotbar_widget = await processHotbarWidget(widgetsPath);
      } catch { /* skip broken */ }
    }
    const iconsPath = path.join(packDir, 'icons.png');
    if (fs.existsSync(iconsPath)) {
      try {
        Object.assign(packData, await processHudIcons(iconsPath));
      } catch { /* skip broken */ }
    }
    if (Object.keys(packData).length > 0) packs[dir] = packData;
    done++;
    if (done % 20 === 0) console.log(`  ${done}/${dirs.length}`);
  }
  const { groupPacks, meta } = buildGroupedData(packs, excluded.counts);
  const outputMeta = writeShards(groupPacks, meta);
  const result = { version: SBI_FINGERPRINT_VERSION, schemaVersion: SBI_GROUP_SCHEMA_VERSION, packs: groupPacks, meta: outputMeta };
  console.log(`Done. ${Object.keys(packs).length} packs in ${meta.groupCount} exact groups -> ${SHARD_DIR}`);
  return result;
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = {
  EXCLUDED_LIST_NAMES,
  SBI_GROUP_SCHEMA_VERSION,
  buildExclusionSet,
  buildGroupedData,
  loadExcludedPacks,
  main,
  surfaceKey,
  writeShards,
};
