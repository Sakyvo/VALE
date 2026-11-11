(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SbiEngine = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';

const SBI_FINGERPRINT_VERSION = 24;
const SBI_BASE_FINGERPRINT_SHARDS = ['widget', 'health', 'hunger', 'armor', 'diamond_sword', 'ender_pearl', 'splash_potion'];
const SBI_FOOD_FINGERPRINT_SHARD = 'food';
const SBI_FINGERPRINT_SHARD_PATH = '/data/sbi-fp/';
const SBI_FINGERPRINT_META_FILE = 'meta.json';
const SBI_ANCHOR_ITEM_TYPES = ['diamond_sword', 'ender_pearl', 'splash_potion'];
const SBI_CANDIDATE_MIN_PACKS = 24;
const SBI_CANDIDATE_FALLBACK_MARGIN = 0.006;
const SBI_CANDIDATE_FALLBACK_MIN_SCORE = 0.30;
const MAX_GUI_SCALE = 18;
const STRICT_WIDGET_WIDTH_RATIOS = [0.21, 0.235, 0.26, 0.285, 0.31, 0.335];
const STRICT_WIDGET_HEIGHT_RATIOS = [0.044, 0.052, 0.06, 0.068, 0.076];
const STRICT_BOTTOM_OFFSET_UNIT_STEPS = [0, 1, 2, 3, 4, 6, 8];
const SLOT_ITEM_TYPES = ['diamond_sword', 'ender_pearl', 'splash_potion', 'steak', 'golden_carrot'];
const SBI_SCORE_WEIGHTS = {
  type: { diamond_sword: 8.0, ender_pearl: 8.2, splash_potion: 4.8, steak: 0.45, golden_carrot: 0.45 },
  hud: { health: 6.4, hunger: 5.4, armor: 5.2 },
  mix: { slot: 0.44, hud: 0.36, widget: 0.20, slotNoHud: 0.74, widgetNoHud: 0.26 },
};
const SBI_REFINEMENT_RESULT_LIMIT = 28;
const SBI_FALLBACK_RETAINED_RESULT_LIMIT = 14;
const SBI_FULL_SCORE_LIMIT = 48;
const SBI_REFINEMENT_FEATURES = [
  { key: 'current', weight: 0.031304799 },
  { key: 'epHamming', type: 'ender_pearl', metric: 'hamming', weight: 0.022984414 },
  { key: 'epColor', type: 'ender_pearl', metric: 'color', weight: 0.042373585 },
  { key: 'potionColor', type: 'splash_potion', metric: 'color', weight: 0.034377795 },
  { key: 'carrotEdge', type: 'golden_carrot', metric: 'edge', weight: 0.040250787 },
  { key: 'dsColor', type: 'diamond_sword', metric: 'color', weight: 0.034571759 },
];
const SLOT_STRONG_MATCH_THRESHOLDS = {
  diamond_sword: 0.56,
  ender_pearl: 0.60,
  splash_potion: 0.50,
  steak: 0.58,
  golden_carrot: 0.58,
};

// Pack-side fingerprint helpers are available for tooling that has no canvas
// (the offline evaluation bench and the fingerprint generator).

const EMPTY_OPTIONS = Object.freeze({});

function resolveGlobalImageData() {
  try { return typeof ImageData !== 'undefined' ? ImageData : null; } catch (error) { return null; }
}

function createSbiEngine(options) {
  const opts = options || EMPTY_OPTIONS;
  const matcher = opts.matcher || 'legacy';
  if (!['legacy', 'aligned'].includes(matcher)) throw new Error('Unknown SBI matcher: ' + matcher);
  const createCanvas = opts.createCanvas || function () { return document.createElement('canvas'); };
  const ImageDataCtor = opts.ImageDataCtor || resolveGlobalImageData();
  const fetchImpl = opts.fetchImpl || (function (url) { return fetch(url); });

let fingerprints = null;
const _fingerprintShardPromises = {};
let _fingerprintMetaPromise = null;
let _lastMatchMetrics = {};
let _forceGlobalFallbackForTest = false;
let _benchmarkGroupTarget = 0;
let _benchmarkExcludedPacks = new Set();
const _scratchCanvases = {};
let alignedIndexPromise = null;
const nativeReferences = new Map();
const nativeReferencePromises = new Map();
let nativeReferenceBytes = 0;
const NATIVE_REFERENCE_CACHE_BYTES = 24 * 1024 * 1024;

function createFingerprintStore() {
  return {
    version: SBI_FINGERPRINT_VERSION,
    packs: {},
    _loadedShards: {},
    _shardIndexes: {},
    _meta: null,
    _packToGroup: {},
  };
}

function applyFingerprintMetadata(meta) {
  if (!meta || meta.version !== SBI_FINGERPRINT_VERSION || !meta.groups || !meta.rarity || !meta.shards || !meta.observations) {
    throw new Error('Fingerprint metadata is missing or incompatible');
  }
  if (!fingerprints) fingerprints = createFingerprintStore();
  fingerprints._meta = meta;
  fingerprints._packToGroup = {};
  for (const [groupId, group] of Object.entries(meta.groups)) {
    for (const member of (group.members || [])) fingerprints._packToGroup[member] = groupId;
  }
}

async function loadFingerprintMetadata() {
  if (!fingerprints) fingerprints = createFingerprintStore();
  if (fingerprints._meta) return;
  if (!_fingerprintMetaPromise) {
    _fingerprintMetaPromise = (async () => {
      const resp = await fetchImpl(`${SBI_FINGERPRINT_SHARD_PATH}${SBI_FINGERPRINT_META_FILE}?v=${SBI_FINGERPRINT_VERSION}`);
      if (!resp.ok) throw new Error('Failed to load fingerprint metadata (' + resp.status + ')');
      applyFingerprintMetadata(await resp.json());
    })();
  }
  await _fingerprintMetaPromise;
}

function mergeShardIndex(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (Array.isArray(value)) {
      const merged = new Set([...(target[key] || []), ...value]);
      target[key] = [...merged];
    } else if (value && typeof value === 'object') {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
      mergeShardIndex(target[key], value);
    }
  }
  return target;
}

function mergeFingerprintShard(shardFile, shard) {
  resetPackPalettes();
  if (!fingerprints) fingerprints = createFingerprintStore();
  const packs = shard && shard.packs ? shard.packs : {};
  for (const [packName, packData] of Object.entries(packs)) {
    if (!fingerprints.packs[packName]) fingerprints.packs[packName] = {};
    Object.assign(fingerprints.packs[packName], packData);
  }
  fingerprints._loadedShards[shardFile] = true;
  const logicalName = shard && shard.type ? shard.type : shardFile.replace(/\.json$/, '');
  if (shard && shard._index) {
    if (!fingerprints._shardIndexes[logicalName]) fingerprints._shardIndexes[logicalName] = {};
    mergeShardIndex(fingerprints._shardIndexes[logicalName], shard._index);
  }
}

// Issue 018: pixel buckets store { packName: { surfKey: { pix } } }. A shallow
// Object.assign would replace the whole surface object (losing dhash/hist/sig).
// Deep-merge so only the .pix field is added onto the existing coarse surface entry.
function mergePixelBucketShard(shardFile, shard) {
  resetPackPalettes();
  if (!fingerprints) fingerprints = createFingerprintStore();
  const packs = shard && shard.packs ? shard.packs : {};
  for (const [packName, packData] of Object.entries(packs)) {
    if (!fingerprints.packs[packName]) fingerprints.packs[packName] = {};
    const target = fingerprints.packs[packName];
    for (const [surfKey, surf] of Object.entries(packData)) {
      if (!target[surfKey] || typeof target[surfKey] !== 'object' || Array.isArray(target[surfKey])) target[surfKey] = {};
      if (surf && surf.pix !== undefined) {
        target[surfKey].pix = surf.pix;
        delete target[surfKey].__paletteCells;
      }
    }
  }
  fingerprints._loadedShards[shardFile] = true;
}

function resolveFingerprintShardFiles(shardNames) {
  const files = [];
  for (const shardName of shardNames) {
    const descriptor = fingerprints && fingerprints._meta && fingerprints._meta.shards
      ? fingerprints._meta.shards[shardName]
      : null;
    if (!descriptor || !Array.isArray(descriptor.buckets) || !descriptor.buckets.length) {
      throw new Error('Fingerprint metadata has no buckets for shard: ' + shardName);
    }
    for (const bucket of descriptor.buckets) {
      if (!bucket || !bucket.file) throw new Error('Fingerprint metadata has an invalid bucket for shard: ' + shardName);
      if (!files.includes(bucket.file)) files.push(bucket.file);
    }
  }
  return files;
}

async function loadFingerprintShard(shardFile) {
  if (!fingerprints) fingerprints = createFingerprintStore();
  if (fingerprints._loadedShards[shardFile]) return;
  if (!_fingerprintShardPromises[shardFile]) {
    _fingerprintShardPromises[shardFile] = (async () => {
      const resp = await fetchImpl(`${SBI_FINGERPRINT_SHARD_PATH}${shardFile}?v=${SBI_FINGERPRINT_VERSION}`);
      if (!resp.ok) throw new Error('Failed to load fingerprint shard: ' + shardFile + ' (' + resp.status + ')');
      const shard = await resp.json();
      if (shard.version !== SBI_FINGERPRINT_VERSION) throw new Error('Fingerprint shard version mismatch: ' + shardFile);
      mergeFingerprintShard(shardFile, shard);
    })();
  }
  await _fingerprintShardPromises[shardFile];
}

async function ensureFingerprints(shardNames) {
  const names = shardNames && shardNames.length ? shardNames : SBI_BASE_FINGERPRINT_SHARDS;
  await loadFingerprintMetadata();
  await Promise.all(resolveFingerprintShardFiles(names).map(loadFingerprintShard));
}

// Issue 018: load only the pixel buckets covering the given pack names.
// Coarse shards omit `pix`; after coarse ranking the client fetches just these
// buckets so `pix` participates in final scoring without downloading the whole corpus.
function resolvePixelBucketFilesForPacks(packNames) {
  const map = fingerprints && fingerprints._meta && fingerprints._meta.packToPixelBuckets
    ? fingerprints._meta.packToPixelBuckets
    : null;
  if (!map) return [];
  const files = new Set();
  for (const name of packNames) {
    const entry = map[name];
    if (!entry) continue;
    for (const file of Object.values(entry)) files.add(file);
  }
  return [...files];
}

async function ensurePixelBucketsForPacks(packNames) {
  await loadFingerprintMetadata();
  const files = resolvePixelBucketFilesForPacks(packNames);
  if (!files.length) return;
  await Promise.all(files.map(loadPixelBucketShard));
}

async function loadPixelBucketShard(shardFile) {
  if (!fingerprints) fingerprints = createFingerprintStore();
  if (fingerprints._loadedShards[shardFile]) return;
  if (!_fingerprintShardPromises[shardFile]) {
    _fingerprintShardPromises[shardFile] = (async () => {
      const resp = await fetchImpl(`${SBI_FINGERPRINT_SHARD_PATH}${shardFile}?v=${SBI_FINGERPRINT_VERSION}`);
      if (!resp.ok) throw new Error('Failed to load pixel bucket: ' + shardFile + ' (' + resp.status + ')');
      const shard = await resp.json();
      if (shard.version !== SBI_FINGERPRINT_VERSION) throw new Error('Pixel bucket version mismatch: ' + shardFile);
      mergePixelBucketShard(shardFile, shard);
    })();
  }
  await _fingerprintShardPromises[shardFile];
}

function getGroupInfo(groupId) {
  return fingerprints && fingerprints._meta && fingerprints._meta.groups
    ? fingerprints._meta.groups[groupId]
    : null;
}

function getGroupMembers(groupId) {
  const info = getGroupInfo(groupId);
  return info && Array.isArray(info.members) && info.members.length ? info.members : [groupId];
}

function inflateFingerprintCorpusForBenchmark() {
  if (!_benchmarkGroupTarget || !fingerprints || !fingerprints._meta) return 0;
  const currentCount = Object.keys(fingerprints.packs || {}).length;
  if (currentCount >= _benchmarkGroupTarget) return 0;
  const sourceIds = Object.keys(fingerprints.packs).filter(groupId =>
    !groupId.startsWith('bench:') && !getGroupMembers(groupId).some(name => _benchmarkExcludedPacks.has(name))
  );
  if (!sourceIds.length) throw new Error('No source groups are available for benchmark inflation');
  const started = nowMs();
  let added = 0;
  while (currentCount + added < _benchmarkGroupTarget) {
    const sourceId = sourceIds[added % sourceIds.length];
    const groupId = `bench:${String(added + 1).padStart(6, '0')}:${sourceId.slice(-16)}`;
    const member = `__benchmark_${String(added + 1).padStart(6, '0')}`;
    fingerprints.packs[groupId] = JSON.parse(JSON.stringify(fingerprints.packs[sourceId]));
    fingerprints._meta.groups[groupId] = { representative: member, members: [member] };
    fingerprints._meta.rarity[groupId] = JSON.parse(JSON.stringify(fingerprints._meta.rarity[sourceId] || {}));
    fingerprints._packToGroup[member] = groupId;
    added++;
  }
  fingerprints._meta.groupCount = currentCount + added;
  fingerprints._meta.packCount += added;
  return nowMs() - started;
}

function getSurfaceRarity(groupId, keys) {
  const rows = fingerprints && fingerprints._meta && fingerprints._meta.rarity
    ? fingerprints._meta.rarity[groupId]
    : null;
  if (!rows) return 1;
  const values = (Array.isArray(keys) ? keys : [keys])
    .map(key => rows[key] && rows[key].weight)
    .filter(value => typeof value === 'number' && isFinite(value));
  if (!values.length) return 1;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function applyRarityToSimilarity(similarity, groupId, keys) {
  const similarityValue = clamp01(similarity || 0);
  const rarity = getSurfaceRarity(groupId, keys);
  const strongEvidence = clamp01((similarityValue - 0.86) / 0.10);
  return similarityValue * (1 - (1 - rarity) * 0.12 * strongEvidence);
}

function shouldLoadFoodFingerprintShard(slots, slotTypes) {
  if (slotTypes && slotTypes.some(type => type === 'steak' || type === 'golden_carrot')) return true;
  for (const slot of (slots || [])) {
    if (!slot || slot.index < 2) continue;
    const sig = slot.features && slot.features.sig;
    if (!sig) continue;
    const steakLike = sig.meanR >= sig.meanB + 28 && sig.meanR >= sig.meanG + 10 && sig.blueFrac < 0.06 && sig.meanLum >= 70 && sig.meanLum <= 160;
    if (isStrongFoodColor(sig) || isFoodLikeTailSignature(sig) || steakLike) return true;
  }
  return false;
}

async function ensureFingerprintsForSlots(slots, slotTypes) {
  if (shouldLoadFoodFingerprintShard(slots, slotTypes)) await ensureFingerprints([SBI_FOOD_FINGERPRINT_SHARD]);
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

function getAdjacentBucketKeys(bucketKey) {
  const parts = String(bucketKey || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some(v => !Number.isInteger(v))) return [];
  const out = [];
  const walk = (idx, acc) => {
    if (idx === parts.length) {
      out.push(acc.join('.'));
      return;
    }
    for (let v = Math.max(0, parts[idx] - 1); v <= Math.min(3, parts[idx] + 1); v++) {
      acc.push(v);
      walk(idx + 1, acc);
      acc.pop();
    }
  };
  walk(0, []);
  return out;
}

function nowMs() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

function byteHex(byte) {
  return Number(byte || 0).toString(16).padStart(2, '0');
}

function getDHashSegmentKeysFromBytes(bytes) {
  if (!bytes || bytes.length < 24) return [];
  const keys = [];
  for (let offset = 0; offset + 4 <= 24; offset += 4) {
    keys.push((offset / 4) + ':' + byteHex(bytes[offset]) + byteHex(bytes[offset + 1]) + byteHex(bytes[offset + 2]) + byteHex(bytes[offset + 3]));
  }
  return keys;
}

function getShardNameForType(type) {
  if (type === 'steak' || type === 'golden_carrot') return SBI_FOOD_FINGERPRINT_SHARD;
  return type;
}

function getIndexCandidateNames(type, sig) {
  const shardName = getShardNameForType(type);
  const index = fingerprints && fingerprints._shardIndexes && fingerprints._shardIndexes[shardName];
  const typeIndex = index && index[type];
  if (!typeIndex) return null;
  const names = new Set();
  for (const key of getAdjacentBucketKeys(getBucketKey(sig))) {
    const bucketNames = typeIndex[key];
    if (!bucketNames) continue;
    for (const name of bucketNames) names.add(name);
  }
  return names;
}

function getHashIndexCandidateNames(type, features) {
  const shardName = getShardNameForType(type);
  const index = fingerprints && fingerprints._shardIndexes && fingerprints._shardIndexes[shardName];
  const typeIndex = index && index._hash && index._hash[type];
  if (!typeIndex || !features || !features.dhash) return null;
  const names = new Set();
  for (const key of getDHashSegmentKeysFromBytes(features.dhash)) {
    const segmentNames = typeIndex[key];
    if (!segmentNames) continue;
    for (const name of segmentNames) names.add(name);
  }
  return names;
}

function getAnchorSlotsByType(slots, slotTypes) {
  const byType = {};
  for (const slot of (slots || [])) {
    const type = slotTypes && slotTypes[slot.index];
    if (!type || !SBI_ANCHOR_ITEM_TYPES.includes(type)) continue;
    const sig = slot.features && slot.features.sig;
    if (!sig || !sig.n) continue;
    const activity = clamp01(slot.activity || 0);
    if (activity < 0.18) continue;
    const quality = slot.quality || 0;
    const strength = activity * 2 + Math.min(1, quality / 18) + (slot.index <= 1 ? 0.4 : 0);
    const current = byType[type];
    if (!current || strength > current.strength) byType[type] = { type, slot, strength };
  }
  return Object.values(byType).sort((a, b) => b.strength - a.strength);
}

function getSignaturePrefilterCandidates(slots, slotTypes) {
  if (!fingerprints || !fingerprints.packs || !fingerprints._shardIndexes) return null;
  const anchors = getAnchorSlotsByType(slots, slotTypes);
  if (!anchors.length) return null;
  const votes = {};
  let signalCount = 0;
  const byType = {};
  for (const anchor of anchors) {
    const type = anchor.type;
    const slot = anchor.slot;
    const bucketNames = getIndexCandidateNames(type, slot.features && slot.features.sig);
    const hashNames = getHashIndexCandidateNames(type, slot.features);
    const names = new Set();
    if (bucketNames) for (const name of bucketNames) names.add(name);
    if (hashNames) for (const name of hashNames) names.add(name);
    byType[type] = {
      bucketCount: bucketNames ? bucketNames.size : 0,
      hashCount: hashNames ? hashNames.size : 0,
      totalCount: names.size,
    };
    if (names.size < 5) continue;
    signalCount++;
    for (const name of names) votes[name] = (votes[name] || 0) + 1;
  }
  if (!signalCount) return null;

  const threshold = 1;
  const candidates = Object.keys(votes).filter(name => votes[name] >= threshold);
  if (candidates.length < SBI_CANDIDATE_MIN_PACKS) return null;
  return {
    names: new Set(candidates),
    votes,
    signalCount,
    byType,
    anchorSlots: anchors,
  };
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function getMaxGuiScale(imgW, imgH) {
  return Math.max(1, Math.min(MAX_GUI_SCALE, Math.floor(Math.min(imgW / 320, imgH / 240))));
}

function getWide16By9Unit(imgW, imgH) {
  if (!imgW || !imgH) return 0;
  if (Math.abs(imgW / imgH - 16 / 9) > 0.02) return 0;
  return ((imgW / 640) + (imgH / 360)) * 0.5;
}

function getHudHorizontalShift(unit, imgW, imgH) {
  // Keep HUD crops aligned to the XP bar endpoints.
  return 0;
}

function calibrateDisplayScore(score) {
  return clamp01(score);
}

function assignDisplayScores(results, details) {
  for (const row of (results || [])) {
    if (!row || !isFinite(row.score)) continue;
    row.displayScore = calibrateDisplayScore(row.score);
  }
  if (details) {
    for (const info of Object.values(details)) {
      if (!info || !isFinite(info.finalScore)) continue;
      info.displayScore = calibrateDisplayScore(info.finalScore);
    }
  }
  return null;
}

function getStrongMatchThreshold(type) {
  return SLOT_STRONG_MATCH_THRESHOLDS[type] || 0.54;
}

function countDisplaySlotTypes(slotTypes) {
  const counts = {};
  for (const type of (slotTypes || [])) {
    if (!type || type === 'none') continue;
    counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}

function getRepeatedTypeScale(type, typeCounts) {
  const count = Math.max(1, typeCounts[type] || 1);
  if (count <= 1) return 1;
  // splash_potion texture is often a white bottle + color overlay rendered at
  // runtime; packs that ship a pre-composited "of_healing" PNG end up with a
  // fingerprint that doesn't match fire-resistance / speed potions in the
  // screenshot. Down-weight harder so repeated potion slots don't dominate.
  return Math.pow(count, -(type === 'splash_potion' ? 0.55 : 0.35));
}

function getCriticalTypeMetrics(perTypeScores, typeCounts) {
  const ds = perTypeScores.DS || 0;
  const ep = perTypeScores.EP || 0;
  const hl = perTypeScores.HL || 0;
  const food = perTypeScores['SK/GC'] || 0;
  const wantsSword = !!typeCounts.diamond_sword;
  const wantsPearl = !!typeCounts.ender_pearl;
  const wantsPotion = !!typeCounts.splash_potion;
  const wantsFood = !!(typeCounts.steak || typeCounts.golden_carrot);
  return {
    score: clamp01(
      (wantsSword ? ds * 0.26 : 0) +
      (wantsPearl ? ep * 0.38 : 0) +
      (wantsPotion ? hl * 0.20 : 0) +
      (wantsFood ? food * 0.16 : 0)
    ),
    shortfall: clamp01(
      (wantsSword ? Math.max(0, 0.30 - ds) * 0.85 : 0) +
      (wantsPearl ? Math.max(0, 0.42 - ep) * 0.95 : 0) +
      (wantsPotion ? Math.max(0, 0.30 - hl) * 0.34 : 0) +
      (wantsFood ? Math.max(0, 0.52 - food) * 0.30 : 0)
    ),
  };
}

function getScoreValue(info, key) {
  const pts = info && info.perTypeScores;
  const v = pts ? pts[key] : 0;
  return isFinite(v) ? v : 0;
}

function scoreGap(best, current) {
  return Math.max(0, (isFinite(best) ? best : 0) - (isFinite(current) ? current : 0));
}

function buildAnchorDiagnostics(info, bestAnchors) {
  const ds = getScoreValue(info, 'DS');
  const ep = getScoreValue(info, 'EP');
  const hp = isFinite(info.healthScore) ? info.healthScore : 0;
  const widget = isFinite(info.widgetScore) ? info.widgetScore : 0;
  const anchorGaps = {
    ds: scoreGap(bestAnchors.ds, ds),
    ep: scoreGap(bestAnchors.ep, ep),
    hp: scoreGap(bestAnchors.hp, hp),
    widget: scoreGap(bestAnchors.widget, widget),
  };
  const strongCount = (ds >= 0.50 ? 1 : 0) + (ep >= 0.58 ? 1 : 0) + (widget >= 0.82 ? 1 : 0) + (hp >= 0.52 ? 1 : 0);
  const weakShared =
    (getScoreValue(info, 'SK/GC') >= 0.72 ? 0.22 : 0) +
    (widget >= 0.82 && anchorGaps.widget <= 0.03 ? 0.18 : 0) +
    (info.slotCoverage <= 0.12 ? 0.16 : 0) +
    (info.slotCertainty <= 0.03 ? 0.16 : 0);
  const sharedness = clamp01(weakShared - strongCount * 0.08);
  const strongPearl = bestAnchors.ep >= 0.50 && ep >= bestAnchors.ep - 0.07;
  const dsPenaltyGap = !strongPearl && (bestAnchors.ds >= 0.50 || anchorGaps.widget > 0.10)
    ? Math.max(0, anchorGaps.ds - 0.045)
    : 0;
  const epPenaltyGap = bestAnchors.ep >= 0.58 ? Math.max(0, anchorGaps.ep - 0.08) : Math.max(0, anchorGaps.ep - 0.16) * 0.5;
  const hpPenaltyGap = bestAnchors.hp >= 0.52 ? Math.max(0, anchorGaps.hp - 0.12) : 0;
  const anchorPenalty = Math.min(0.045,
    dsPenaltyGap * 0.12 +
    epPenaltyGap * 0.08 +
    Math.max(0, anchorGaps.widget - 0.10) * 0.07 +
    hpPenaltyGap * 0.04
  );
  const distinguishability = clamp01(
    0.46 +
    Math.min(0.24, (1 - sharedness) * 0.24) +
    Math.min(0.14, (info.slotCertainty || 0) * 1.8) +
    Math.min(0.12, (info.slotCoverage || 0) * 0.45) +
    strongCount * 0.035 -
    anchorPenalty * 1.8
  );
  return { anchorGaps, sharedness, strongAnchorCount: strongCount, anchorPenalty, distinguishability };
}

function computeDHash(imageData) {
  // imageData is from a 9x8 canvas
  const bits = new Uint8Array(24);
  for (let ch = 0; ch < 3; ch++) {
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const li = (row * 9 + col) * 4 + ch;
        const ri = (row * 9 + (col + 1)) * 4 + ch;
        const bit = row * 8 + col;
        const byteIdx = ch * 8 + (bit >> 3);
        if (imageData[li] > imageData[ri])
          bits[byteIdx] |= (1 << (7 - (bit & 7)));
      }
    }
  }
  return bits;
}

// Histogram: 48-bin RGB (16 per channel) + 24-bin hue (15° each) = 72 bins total
function computeHistogram(imageData, count, bgThreshold) {
  const hist = new Float64Array(72);
  let total = 0;
  for (let i = 0; i < count; i++) {
    const r = imageData[i * 4], g = imageData[i * 4 + 1], b = imageData[i * 4 + 2];
    const a = imageData[i * 4 + 3];
    if (a < 128) continue;
    if (bgThreshold && (0.299 * r + 0.587 * g + 0.114 * b) < bgThreshold) continue;
    total++;
    hist[Math.min(r >> 4, 15)]++;
    hist[16 + Math.min(g >> 4, 15)]++;
    hist[32 + Math.min(b >> 4, 15)]++;
    // Hue bin (24 bins = 15° each)
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
  return hist;
}

// Color moments: mean + std per RGB channel
function computeColorMoments(imageData, count, bgThreshold) {
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let i = 0; i < count; i++) {
    const r = imageData[i * 4], g = imageData[i * 4 + 1], b = imageData[i * 4 + 2];
    const a = imageData[i * 4 + 3];
    if (a < 128) continue;
    if (bgThreshold && (0.299 * r + 0.587 * g + 0.114 * b) < bgThreshold) continue;
    sr += r; sg += g; sb += b; n++;
  }
  if (!n) return [0, 0, 0, 0, 0, 0];
  const mr = sr / n, mg = sg / n, mb = sb / n;
  let vr = 0, vg = 0, vb = 0;
  for (let i = 0; i < count; i++) {
    const r = imageData[i * 4], g = imageData[i * 4 + 1], b = imageData[i * 4 + 2];
    const a = imageData[i * 4 + 3];
    if (a < 128) continue;
    if (bgThreshold && (0.299 * r + 0.587 * g + 0.114 * b) < bgThreshold) continue;
    vr += (r - mr) ** 2; vg += (g - mg) ** 2; vb += (b - mb) ** 2;
  }
  return [mr / 255, mg / 255, mb / 255,
          Math.sqrt(vr / n) / 255, Math.sqrt(vg / n) / 255, Math.sqrt(vb / n) / 255];
}

// Edge density: mean normalized gradient magnitude
function computeEdgeDensity(imageData, w, h) {
  let sum = 0, count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (imageData[i + 3] < 128) continue;
      if (x + 1 < w) {
        const ri = (y * w + x + 1) * 4;
        sum += Math.abs(imageData[i] - imageData[ri]) + Math.abs(imageData[i+1] - imageData[ri+1]) + Math.abs(imageData[i+2] - imageData[ri+2]);
        count++;
      }
      if (y + 1 < h) {
        const di = ((y+1) * w + x) * 4;
        sum += Math.abs(imageData[i] - imageData[di]) + Math.abs(imageData[i+1] - imageData[di+1]) + Math.abs(imageData[i+2] - imageData[di+2]);
        count++;
      }
    }
  }
  return count ? sum / (count * 3 * 255) : 0;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function hammingDistance(a, b) {
  let dist = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    let xor = a[i] ^ b[i];
    while (xor) { dist += xor & 1; xor >>= 1; }
  }
  return dist;
}

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function meanRgbDirSim(momA, momB) {
  if (!momA || !momB) return 0;
  const ar = momA[0], ag = momA[1], ab = momA[2];
  const br = momB[0], bg = momB[1], bb = momB[2];
  const dot = ar * br + ag * bg + ab * bb;
  const na = Math.sqrt(ar * ar + ag * ag + ab * ab);
  const nb = Math.sqrt(br * br + bg * bg + bb * bb);
  return (na && nb) ? dot / (na * nb) : 0;
}

function colorMomentSim(a, b) {
  // Distance between two 6-dim [meanR,meanG,meanB,stdR,stdG,stdB] vectors
  let d = 0;
  for (let i = 0; i < 6; i++) d += (a[i] - b[i]) ** 2;
  return 1 - Math.sqrt(d / 6);
}

// Pack textures for the anchor items live on a 32x32 grid while every extracted
// slot is 16x16. Comparing across grids used to bail out, which silently removed
// sword and pearl — the two most identifying types — from coarse scoring. Both
// sides are resampled to the coarser grid so neither invents detail.
function itemOverlayExcluded(x, y, width, height) {
  return (y + 0.5) / height >= 14 / 16 || ((x + 0.5) / width >= 10 / 16 && (y + 0.5) / height >= 10 / 16);
}

function resampleItemArea(image, size, excludeOverlays = true) {
  const { width, height, pixels } = image;
  const targetW = typeof size === 'number' ? size : size.width;
  const targetH = typeof size === 'number' ? size : size.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      !Number.isInteger(targetW) || !Number.isInteger(targetH) || targetW < 1 || targetH < 1 ||
      targetW > width || targetH > height || !pixels || pixels.length !== width * height * 4) {
    throw new Error('Invalid native item dimensions or attempted upsampling');
  }
  const out = new Float32Array(targetW * targetH * 4);
  const scaleX = width / targetW, scaleY = height / targetH;
  for (let y = 0; y < targetH; y++) for (let x = 0; x < targetW; x++) {
    if (excludeOverlays && itemOverlayExcluded(x, y, targetW, targetH)) continue;
    let weight = 0, alpha = 0, r = 0, g = 0, b = 0;
    for (let sy = Math.floor(y * scaleY); sy < Math.min(height, Math.ceil((y + 1) * scaleY)); sy++) {
      const wy = Math.min((y + 1) * scaleY, sy + 1) - Math.max(y * scaleY, sy);
      for (let sx = Math.floor(x * scaleX); sx < Math.min(width, Math.ceil((x + 1) * scaleX)); sx++) {
        if (excludeOverlays && itemOverlayExcluded(sx, sy, width, height)) continue;
        const w = wy * (Math.min((x + 1) * scaleX, sx + 1) - Math.max(x * scaleX, sx));
        const i = (sy * width + sx) * 4, a = pixels[i + 3] / 255;
        weight += w; alpha += a * w;
        r += pixels[i] * a * w; g += pixels[i + 1] * a * w; b += pixels[i + 2] * a * w;
      }
    }
    const i = (y * targetW + x) * 4;
    if (alpha) { out[i] = r / alpha; out[i + 1] = g / alpha; out[i + 2] = b / alpha; }
    if (weight) out[i + 3] = alpha / weight * 255;
  }
  return { width: targetW, height: targetH, pixels: out };
}

function compareNativeItem(query, reference) {
  const width = Math.min(query.width, reference.width), height = Math.min(query.height, reference.height);
  const a = resampleItemArea(query, { width, height }), b = resampleItemArea(reference, { width, height });
  // Weight by reference opacity only: transparent reference padding must not be
  // scored against unrelated screenshot background.
  let error = 0, weight = 0, pixelsCompared = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (itemOverlayExcluded(x, y, width, height)) continue;
    const i = (y * width + x) * 4;
    const w = b.pixels[i + 3] / 255;
    if (!w) continue;
    for (let c = 0; c < 3; c++) error += w * Math.abs(a.pixels[i + c] - b.pixels[i + c]);
    weight += w * 3; pixelsCompared++;
  }
  return { size: Math.min(width, height), width, height, pixelsCompared,
    score: weight ? Math.pow(clamp01(1 - error / (weight * 255)), 4) : 0 };
}

function alignSpatialPair(a, b) {
  const sizeA = Math.sqrt(a.length / 4);
  const sizeB = Math.sqrt(b.length / 4);
  if (!Number.isInteger(sizeA) || !Number.isInteger(sizeB) || sizeA < 4 || sizeB < 4) return null;
  if (sizeA === sizeB) return { a, b, size: sizeA };
  const size = Math.min(sizeA, sizeB);
  return {
    a: sizeA === size ? a : resizeRgbaNearest(a, sizeA, sizeA, size, size),
    b: sizeB === size ? b : resizeRgbaNearest(b, sizeB, sizeB, size, size),
    size,
  };
}

function compareSpatialMetrics(extracted, packTex) {
  if (!extracted || !extracted.pix || !packTex || !packTex.pix) return null;
  const rawB = packTex.__pixBytes || (packTex.__pixBytes = base64ToBytes(packTex.pix));
  const aligned = alignSpatialPair(extracted.pix, rawB);
  if (!aligned) return null;
  const { a, b, size } = aligned;
  let best = null;
  const shift = 1;
  for (let dy = -shift; dy <= shift; dy++) {
    for (let dx = -shift; dx <= shift; dx++) {
      let intersection = 0, union = 0, overlap = 0;
      let colorDistance = 0, direction = 0;
      for (let y = 0; y < size; y++) {
        const by = y - dy;
        for (let x = 0; x < size; x++) {
          const bx = x - dx;
          const ai = (y * size + x) * 4;
          const aOn = a[ai + 3] >= 128;
          const bIn = bx >= 0 && by >= 0 && bx < size && by < size;
          const bi = bIn ? (by * size + bx) * 4 : 0;
          const bOn = bIn && b[bi + 3] >= 128;
          if (aOn || bOn) union++;
          if (!aOn || !bOn) continue;
          intersection++;
          overlap++;
          const ar = a[ai], ag = a[ai + 1], ab = a[ai + 2];
          const br = b[bi], bg = b[bi + 1], bb = b[bi + 2];
          colorDistance += Math.abs(ar - br) + Math.abs(ag - bg) + Math.abs(ab - bb);
          const an = Math.sqrt(ar * ar + ag * ag + ab * ab);
          const bn = Math.sqrt(br * br + bg * bg + bb * bb);
          if (an && bn) direction += (ar * br + ag * bg + ab * bb) / (an * bn);
        }
      }
      if (!union || !overlap) continue;
      const shape = intersection / union;
      const color = clamp01(1 - colorDistance / (overlap * 3 * 255));
      const colorDirection = clamp01(direction / overlap);
      const score = shape * 0.62 + colorDirection * 0.25 + color * 0.13;
      if (!best || score > best.score) best = { score, shape, colorDirection, color, dx, dy };
    }
  }
  return best;
}

function compareSpatial(extracted, packTex) {
  const metrics = compareSpatialMetrics(extracted, packTex);
  return metrics ? metrics.score : null;
}

function getOpaqueSpatialPositions(owner, pixels, size) {
  if (owner.__opaqueSpatialPositions && owner.__opaqueSpatialPositions.size === size) {
    return owner.__opaqueSpatialPositions.positions;
  }
  const positions = [];
  for (let position = 0; position < size * size; position++) {
    if (pixels[position * 4 + 3] >= 128) positions.push(position);
  }
  owner.__opaqueSpatialPositions = { size, positions };
  return positions;
}

function compareSpatialColor(extracted, packTex) {
  if (!extracted || !extracted.pix || !packTex || !packTex.pix) return null;
  const a = extracted.pix;
  const b = packTex.__pixBytes || (packTex.__pixBytes = base64ToBytes(packTex.pix));
  if (a.length !== b.length) return null;
  const size = Math.sqrt(a.length / 4);
  if (!Number.isInteger(size) || size < 4) return null;
  const aPositions = getOpaqueSpatialPositions(extracted, a, size);
  const bPositions = getOpaqueSpatialPositions(packTex, b, size);
  if (!aPositions.length || !bPositions.length) return null;
  let bestAlignment = -1;
  let bestColor = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      let intersection = 0;
      let visibleB = 0;
      let colorDistance = 0;
      for (const position of bPositions) {
        const bx = position % size;
        const by = (position / size) | 0;
        if (bx + dx >= 0 && by + dy >= 0 && bx + dx < size && by + dy < size) visibleB++;
      }
      for (const position of aPositions) {
        const x = position % size;
        const y = (position / size) | 0;
        const bx = x - dx;
        const by = y - dy;
        if (bx < 0 || by < 0 || bx >= size || by >= size) continue;
        const bi = (by * size + bx) * 4;
        if (b[bi + 3] < 128) continue;
        const ai = position * 4;
        intersection++;
        colorDistance += Math.abs(a[ai] - b[bi]) + Math.abs(a[ai + 1] - b[bi + 1]) + Math.abs(a[ai + 2] - b[bi + 2]);
      }
      const union = aPositions.length + visibleB - intersection;
      if (!intersection || !union) continue;
      const shape = intersection / union;
      const color = clamp01(1 - colorDistance / (intersection * 3 * 255));
      const alignment = shape * 0.82 + color * 0.18;
      if (alignment > bestAlignment) {
        bestAlignment = alignment;
        bestColor = color;
      }
    }
  }
  return bestAlignment >= 0 ? bestColor : null;
}

function normalizePackHist(hist) {
  if (!hist || !hist.length) return hist;
  if (hist.__sbiNormalized) return hist;
  let max = 0;
  for (let i = 0; i < hist.length; i++) if (hist[i] > max) max = hist[i];
  if (max <= 1) return hist;
  const out = new Array(hist.length);
  for (let i = 0; i < hist.length; i++) out[i] = hist[i] / 255;
  out.__sbiNormalized = true;
  return out;
}

function compare(extracted, packTex) {
  // A coarsely-loaded pack can expose a surface that only carries `pix` (pixel
  // buckets are merged before every coarse shard is loaded). Such a surface has
  // no comparable hash payload, so it contributes nothing instead of throwing.
  if (!extracted || !packTex || typeof packTex.dhash !== 'string') return 0;
  const dhashA = extracted.dhash;
  const dhashB = packTex.__dhashBytes || (packTex.__dhashBytes = base64ToBytes(packTex.dhash));
  const hammingSim = 1 - hammingDistance(dhashA, dhashB) / 192;
  const histSim = cosineSimilarity(extracted.hist, packTex.__histFloat || (packTex.__histFloat = normalizePackHist(packTex.hist)));
  const momentSim = colorMomentSim(extracted.moments, packTex.moments);
  const edgeSim = 1 - Math.abs(extracted.edge - packTex.edge);
  const base = 0.30 * hammingSim + 0.35 * histSim + 0.20 * momentSim + 0.15 * edgeSim;
  return base;
}

function compareWidget(extracted, packWidget) {
  const histSim = cosineSimilarity(extracted.hist, packWidget.__histFloat || (packWidget.__histFloat = normalizePackHist(packWidget.hist)));
  const momentSim = colorMomentSim(extracted.moments, packWidget.moments);
  const edgeA = typeof extracted.edge === 'number' ? extracted.edge : 0;
  const edgeB = typeof packWidget.edge === 'number' ? packWidget.edge : 0;
  const edgeSim = 1 - Math.abs(edgeA - edgeB);
  const dirSim = clamp01(meanRgbDirSim(extracted.moments, packWidget.moments));
  const chromaA = extracted && extracted.moments ? Math.max(extracted.moments[0], extracted.moments[1], extracted.moments[2]) - Math.min(extracted.moments[0], extracted.moments[1], extracted.moments[2]) : 0;
  const chromaB = packWidget && packWidget.moments ? Math.max(packWidget.moments[0], packWidget.moments[1], packWidget.moments[2]) - Math.min(packWidget.moments[0], packWidget.moments[1], packWidget.moments[2]) : 0;
  const chromaSim = clamp01(1 - Math.abs(chromaA - chromaB) / (Math.max(chromaA, chromaB) + 0.08));
  const base = 0.40 * histSim + 0.22 * momentSim + 0.18 * edgeSim + 0.14 * dirSim + 0.06 * chromaSim;
  const colorGate = 0.72 + 0.18 * Math.min(histSim, dirSim) + 0.10 * histSim;
  return base * colorGate;
}

// --- Region extraction helpers ---
function getScratchContext(key, w, h, options) {
  let entry = _scratchCanvases[key];
  if (!entry) {
    const canvas = createCanvas();
    entry = { canvas, ctx: canvas.getContext('2d', options || undefined) };
    _scratchCanvases[key] = entry;
  }
  if (entry.canvas.width !== w) entry.canvas.width = w;
  if (entry.canvas.height !== h) entry.canvas.height = h;
  return entry.ctx;
}

function extractRegion(ctx, x, y, w, h, targetW, targetH) {
  const tctx = getScratchContext(`extract:${targetW}x${targetH}`, targetW, targetH);
  tctx.imageSmoothingEnabled = false;
  tctx.clearRect(0, 0, targetW, targetH);
  tctx.drawImage(ctx.canvas, x, y, w, h, 0, 0, targetW, targetH);
  return tctx.getImageData(0, 0, targetW, targetH);
}

function resizeImageDataNearest(imageData, srcW, srcH, dstW, dstH) {
  const sctx = getScratchContext(`resize-src:${srcW}x${srcH}`, srcW, srcH);
  sctx.putImageData(imageData, 0, 0);
  const dctx = getScratchContext(`resize-dst:${dstW}x${dstH}`, dstW, dstH);
  dctx.imageSmoothingEnabled = false;
  dctx.clearRect(0, 0, dstW, dstH);
  dctx.drawImage(sctx.canvas, 0, 0, srcW, srcH, 0, 0, dstW, dstH);
  return dctx.getImageData(0, 0, dstW, dstH);
}

function maskWidgetItems(data, w, h) {
  const out = new Uint8ClampedArray(data);
  if (w < 40 || h < 12) return out;

  // Normalize to vanilla widget strip (182x22): item squares live at x=3+i*20, y=3, size=16.
  // Keep slot-frame/background color signal by masking only center icon area.
  const sx = w / 182;
  const sy = h / 22;
  const itemSize = Math.max(1, Math.round(16 * Math.min(sx, sy)));
  const itemY = Math.round(3 * sy);
  const maskSize = Math.max(6, Math.min(itemSize - 2, Math.round(itemSize * 0.5)));
  const inset = Math.max(0, Math.floor((itemSize - maskSize) / 2));

  for (let i = 0; i < 9; i++) {
    const itemX = Math.round((3 + i * 20) * sx);
    const x1 = Math.max(0, itemX + inset), x2 = Math.min(w, itemX + inset + maskSize);
    const y1 = Math.max(0, itemY + inset), y2 = Math.min(h, itemY + inset + maskSize);
    for (let y = y1; y < y2; y++) {
      for (let x = x1; x < x2; x++) out[(y * w + x) * 4 + 3] = 0;
    }
  }
  return out;
}

function suppressWidgetHighlights(data, w, h) {
  const out = new Uint8ClampedArray(data);
  const lum = [];
  for (let i = 0; i < w * h; i++) {
    const a = out[i * 4 + 3];
    if (a < 128) continue;
    const r = out[i * 4], g = out[i * 4 + 1], b = out[i * 4 + 2];
    lum.push(0.299 * r + 0.587 * g + 0.114 * b);
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

function computeWidgetGridScore(data, w, h) {
  if (!data || w < 80 || h < 10) return 0;
  const edgeX = new Float64Array(Math.max(1, w - 1));
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x + 1 < w; x++) {
      const i = row + x * 4;
      if (data[i + 3] < 128 || data[i + 7] < 128) continue;
      const l1 = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const l2 = 0.299 * data[i + 4] + 0.587 * data[i + 5] + 0.114 * data[i + 6];
      edgeX[x] += Math.abs(l1 - l2);
    }
  }

  const boundaryMask = new Uint8Array(edgeX.length);
  const scale = w / 182;
  let bSum = 0, bCount = 0;
  const bVals = [];
  for (let k = 0; k <= 9; k++) {
    const b = Math.round(k * 20 * scale);
    let m = 0;
    for (let dx = -1; dx <= 1; dx++) {
      const x = b + dx;
      if (x < 0 || x >= edgeX.length) continue;
      boundaryMask[x] = 1;
      m = Math.max(m, edgeX[x]);
    }
    bSum += m;
    bCount++;
    bVals.push(m);
  }
  let iSum = 0, iCount = 0;
  for (let x = 0; x < edgeX.length; x++) {
    if (boundaryMask[x]) continue;
    iSum += edgeX[x];
    iCount++;
  }
  const bAvg = bCount ? (bSum / bCount) : 0;
  const iAvg = iCount ? (iSum / iCount) : 0;
  const iBase = iAvg + 1e-6;
  bVals.sort((a, b) => a - b);
  const bP30 = bVals[Math.min(bVals.length - 1, Math.floor(bVals.length * 0.3))] || 0;
  let strong = 0;
  const thr = iAvg * 1.3;
  for (const v of bVals) if (v > thr) strong++;
  const coverage = clamp01((strong - 4) / 6);
  const ratio = bP30 / iBase;
  return clamp01((ratio - 1) / 2) * (0.65 + 0.35 * coverage);
}

function maskSlotNoise(data, w, h, preserveBottom) {
  const out = new Uint8ClampedArray(data);
  const durabilityY = Math.floor(h * 0.78);
  const countX = Math.floor(w * 0.58);
  const countY = Math.floor(h * 0.58);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if ((!preserveBottom && y >= durabilityY) || (x >= countX && y >= countY)) out[i + 3] = 0;
    }
  }
  return out;
}

function zeroRgbForTransparent(data) {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) { data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; }
  }
  return data;
}

function suppressSlotBackground(data, w, h) {
  if (w * h > 24 * 24) return data;

  const out = new Uint8ClampedArray(data);
  const cornerSize = Math.max(1, Math.min(3, Math.floor(Math.min(w, h) / 4)));
  let sr = 0, sg = 0, sb = 0, n = 0;
  const corners = [
    [0, 0],
    [w - cornerSize, 0],
    [0, h - cornerSize],
    [w - cornerSize, h - cornerSize],
  ];
  for (const [cx, cy] of corners) {
    for (let yy = 0; yy < cornerSize; yy++) {
      for (let xx = 0; xx < cornerSize; xx++) {
        const x = cx + xx, y = cy + yy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = (y * w + x) * 4;
        const a = out[i + 3];
        if (a < 128) continue;
        sr += out[i]; sg += out[i + 1]; sb += out[i + 2]; n++;
      }
    }
  }
  if (!n) return out;
  const br = sr / n, bg = sg / n, bb = sb / n;
  const thr2 = 5200;

  const seen = new Uint8Array(w * h);
  const q = [];
  const push = (x, y) => {
    const idx = y * w + x;
    if (seen[idx]) return;
    const i = idx * 4;
    if (out[i + 3] < 128) return;
    const dr = out[i] - br;
    const dg = out[i + 1] - bg;
    const db = out[i + 2] - bb;
    if (dr * dr + dg * dg + db * db > thr2) return;
    seen[idx] = 1;
    q.push(idx);
  };
  push(0, 0);
  push(w - 1, 0);
  push(0, h - 1);
  push(w - 1, h - 1);

  while (q.length) {
    const idx = q.pop();
    const x = idx % w;
    const y = Math.floor(idx / w);
    if (x > 0) push(x - 1, y);
    if (x + 1 < w) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y + 1 < h) push(x, y + 1);
  }

  for (let i = 0; i < seen.length; i++) {
    if (!seen[i]) continue;
    const p = i * 4;
    out[p] = 0; out[p + 1] = 0; out[p + 2] = 0; out[p + 3] = 0;
  }
  return out;
}

function buildSlotVariants(ctx, x, y, sz, imgW, imgH, options = {}) {
  const variants = [];
  const offsets = [
    [0, 0],
    [-0.12, 0],
    [0.12, 0],
    [0, -0.12],
    [0, -0.24],
    [0, 0.12],
  ];
  const inset = Math.max(1, Math.round(sz * 0.12));
  const iw = Math.max(4, sz - inset * 2);
  const ih = Math.max(4, sz - inset * 2);
  const shiftPx = Math.max(1, Math.round(sz * 0.1));
  const targetSize = options.spatialSize || 16;
  for (const [ox, oy] of offsets) {
    const sx = x + inset + Math.round(ox * shiftPx);
    const sy = y + inset + Math.round(oy * shiftPx);
    if (sx < 0 || sy < 0 || sx + iw > imgW || sy + ih > imgH) continue;
    const region = extractRegion(ctx, sx, sy, iw, ih, targetSize, targetSize);
    variants.push(computeFeatures(region, targetSize, targetSize, true, 'slot', options));
  }
  return variants;
}

function computeItemSignature(imageData, w, h) {
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
      const p = (y * w + x) * 4;
      const a = imageData[p + 3];
      if (a < 128) continue;
      const r = imageData[p], g = imageData[p + 1], b = imageData[p + 2];
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
      const leftOn = imageData[li] >= 128;
      const rightOn = imageData[ri] >= 128;
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
  const widthDen = Math.max(1, w - 1);
  const heightDen = Math.max(1, h - 1);
  const rowSlope = rowVar ? (rowCov / rowVar) / Math.max(1, w / 2) : 0;

  return {
    n,
    coverage: n / (w * h),
    meanLum: lumSum / n,
    meanR: rSum / n,
    meanG: gSum / n,
    meanB: bSum / n,
    redFrac: red / n,
    yellowFrac: yellow / n,
    darkFrac: dark / n,
    blueFrac: blue / n,
    centerDarkFrac: centerN ? (centerDark / centerN) : 0,
    edgeDarkFrac: edgeN ? (edgeDark / edgeN) : 0,
    centerX: (xSum / n) / widthDen,
    centerY: (ySum / n) / heightDen,
    lrBias: (rightN - leftN) / n,
    tbBias: (bottomN - topN) / n,
    mirrorFrac: mirrorPairs ? (mirrorAgree / mirrorPairs) : 1,
    rowSlope,
    bboxTop: minY < h ? (minY / heightDen) : 1,
    bboxBottom: maxY >= 0 ? (maxY / heightDen) : 0,
    bboxLeft: minX < w ? (minX / widthDen) : 1,
    bboxRight: maxX >= 0 ? (maxX / widthDen) : 0,
  };
}

function computeFeatures(imageData, w, h, isScreenshot, mode, options = {}) {
  const BG_THRESHOLD = isScreenshot ? 50 : 0;
  let effectiveData = (isScreenshot && mode === 'slot')
    ? maskSlotNoise(imageData.data, w, h, options.preserveBottom)
    : imageData.data;
  if (isScreenshot && mode === 'slot') {
    effectiveData = suppressSlotBackground(effectiveData, w, h);
    effectiveData = zeroRgbForTransparent(effectiveData);
  }

  // Lightweight slot signature for robust item-type inference (computed on alpha-only pixels; no BG_THRESHOLD).
  let sig = null;
  if (mode === 'slot' || mode === 'hud') {
    sig = computeItemSignature(effectiveData, w, h);
  }
  const effectiveImage = (effectiveData === imageData.data)
    ? imageData
    : new ImageDataCtor(effectiveData, w, h);

  // Resize source to 9x8 for dHash
  const sctx = getScratchContext(`feature-src:${w}x${h}`, w, h);
  sctx.putImageData(effectiveImage, 0, 0);
  const tctx = getScratchContext('feature-dhash:9x8', 9, 8);
  tctx.imageSmoothingEnabled = true;
  tctx.clearRect(0, 0, 9, 8);
  tctx.drawImage(sctx.canvas, 0, 0, 9, 8);
  const dhash = computeDHash(tctx.getImageData(0, 0, 9, 8).data);
  const hist = computeHistogram(effectiveData, w * h, BG_THRESHOLD);
  const moments = computeColorMoments(effectiveData, w * h, BG_THRESHOLD);
  const edge = computeEdgeDensity(effectiveData, w, h);
  const spatialSize = options.spatialSize || 16;
  const pix = mode === 'slot'
    ? new Uint8Array(resizeImageDataNearest(effectiveImage, w, h, spatialSize, spatialSize).data)
    : null;
  return { dhash, hist, moments, edge, sig, pix };
}

function tryExtractFeature(ctx, x, y, w, h, imgW, imgH, targetW, targetH) {
  const ix = Math.round(x), iy = Math.round(y), iw = Math.round(w), ih = Math.round(h);
  if (iw <= 1 || ih <= 1) return null;
  if (ix < 0 || iy < 0 || ix + iw > imgW || iy + ih > imgH) return null;
  const region = extractRegion(ctx, ix, iy, iw, ih, targetW, targetH);
  return computeFeatures(region, targetW, targetH, true, 'hud');
}

function buildWidgetFeatures(widgetStrip, maskedData) {
  const widgetMasked = new ImageDataCtor(maskedData || maskWidgetItems(widgetStrip.data, 182, 22), 182, 22);
  const widgetRegion = resizeImageDataNearest(widgetMasked, 182, 22, 16, 16);
  const widgetClean = suppressWidgetHighlights(widgetRegion.data, 16, 16);
  return {
    hist: computeHistogram(widgetClean, 256, 0),
    moments: computeColorMoments(widgetClean, 256, 0),
    edge: computeEdgeDensity(widgetClean, 16, 16)
  };
}

function extractWidgetFeatures(ctx, widgetRect) {
  const ix = Math.round(widgetRect.x), iy = Math.round(widgetRect.y);
  const iw = Math.round(widgetRect.w), ih = Math.round(widgetRect.h);
  if (iw <= 1 || ih <= 1) return null;
  return buildWidgetFeatures(extractRegion(ctx, ix, iy, iw, ih, 182, 22));
}

function extractHudFeatures(ctx, widgetRect, imgW, imgH) {
  if (!widgetRect) return null;
  const unit = widgetRect.w / 182;
  if (!isFinite(unit) || unit <= 0) return null;

  const iconSize = Math.max(4, 9 * unit);
  let heartsY = widgetRect.y - 17 * unit;
  let armorY = heartsY - 10 * unit;
  const yShift = armorY < 0 ? -armorY : (heartsY < 0 ? -heartsY : 0);
  heartsY += yShift;
  armorY += yShift;

  const hearts = [];
  const hunger = [];
  const armor = [];
  const heartBoxes = [];
  const hungerBoxes = [];
  const armorBoxes = [];
  const hudShift = getHudHorizontalShift(unit, imgW, imgH);
  const leftHudShift = hudShift;
  const rightHudShift = -hudShift;

  for (let i = 0; i < 10; i++) {
    const heartX = widgetRect.x + (i * 8) * unit + leftHudShift;
    const hungerX = widgetRect.x + (182 - 9 - i * 8) * unit + rightHudShift;

    const heartFeat = tryExtractFeature(ctx, heartX, heartsY, iconSize, iconSize, imgW, imgH, 16, 16);
    const hungerFeat = tryExtractFeature(ctx, hungerX, heartsY, iconSize, iconSize, imgW, imgH, 16, 16);
    const armorFeat = tryExtractFeature(ctx, heartX, armorY, iconSize, iconSize, imgW, imgH, 16, 16);

    if (heartFeat) { hearts.push(heartFeat); heartBoxes.push({ x: heartX, y: heartsY, w: iconSize, h: iconSize }); }
    if (hungerFeat) { hunger.push(hungerFeat); hungerBoxes.push({ x: hungerX, y: heartsY, w: iconSize, h: iconSize }); }
    if (armorFeat) { armor.push(armorFeat); armorBoxes.push({ x: heartX, y: armorY, w: iconSize, h: iconSize }); }
  }

  return { hearts, hunger, armor, heartBoxes, hungerBoxes, armorBoxes };
}

function estimateWidgetCandidates(widgetFeatures, topK) {
  if (!widgetFeatures || !fingerprints || !fingerprints.packs) return { best: 0, bestName: '', top: [] };
  const top = [];
  let best = 0, bestName = '';
  for (const [name, packData] of Object.entries(fingerprints.packs)) {
    if (!packData.hotbar_widget) continue;
    const sim = compareWidget(widgetFeatures, packData.hotbar_widget);
    if (sim > best) { best = sim; bestName = name; }
    if (topK > 0) {
      top.push({ name, sim });
      top.sort((a, b) => b.sim - a.sim);
      if (top.length > topK) top.length = topK;
    }
  }
  return { best, bestName, top };
}

function estimateHudConfidence(hudFeatures, packNames) {
  if (!hudFeatures || !fingerprints || !fingerprints.packs) return { best: 0, bestName: '' };
  const names = (packNames && packNames.length) ? packNames : Object.keys(fingerprints.packs);
  let best = 0, bestName = '';
  for (const name of names) {
    const p = fingerprints.packs[name];
    if (!p) continue;
    const healthSim = compareHudCells(hudFeatures.hearts, [p.health_empty, p.health_half, p.health_full], 'health');
    const hungerSim = compareHudCells(hudFeatures.hunger, [p.hunger_empty, p.hunger_half, p.hunger_full], 'hunger');
    const armorSim = compareHudCells(hudFeatures.armor, [p.armor_empty, p.armor_half, p.armor_full], 'armor');

    let hudWeighted = 0, hudWeights = 0;
    if (healthSim > 0) { hudWeighted += healthSim * SBI_SCORE_WEIGHTS.hud.health; hudWeights += SBI_SCORE_WEIGHTS.hud.health; }
    if (hungerSim > 0) { hudWeighted += hungerSim * SBI_SCORE_WEIGHTS.hud.hunger; hudWeights += SBI_SCORE_WEIGHTS.hud.hunger; }
    if (armorSim > 0) { hudWeighted += armorSim * SBI_SCORE_WEIGHTS.hud.armor; hudWeights += SBI_SCORE_WEIGHTS.hud.armor; }
    const hudComposite = hudWeights ? (hudWeighted / hudWeights) : 0;

    if (hudComposite > best) { best = hudComposite; bestName = name; }
  }
  return { best, bestName };
}

function estimateSlotConfidence(slots, packNames) {
  if (!slots || !slots.length || !fingerprints || !fingerprints.packs) return { best: 0, bestName: '' };
  const names = (packNames && packNames.length) ? packNames : Object.keys(fingerprints.packs);
  const slotTypes = inferDisplaySlotTypes(slots);
  const swordSlot = pickSlotForClip(slots, slotTypes, 'diamond_sword', 0);
  const pearlSlot = pickSlotForClip(slots, slotTypes, 'ender_pearl', 1);
  const potionSlot = pickSlotForClip(slots, slotTypes, 'splash_potion', 5);

  let best = 0, bestName = '';
  for (const name of names) {
    const p = fingerprints.packs[name];
    if (!p) continue;
    let sum = 0, wSum = 0;
    if (swordSlot && (swordSlot.activity || 0) >= 0.28 && p.diamond_sword) {
      sum += compareSlotToType(swordSlot, p.diamond_sword, 'diamond_sword') * 1.0;
      wSum += 1.0;
    }
    if (pearlSlot && (pearlSlot.activity || 0) >= 0.28 && p.ender_pearl) {
      sum += compareSlotToType(pearlSlot, p.ender_pearl, 'ender_pearl') * 1.0;
      wSum += 1.0;
    }
    if (potionSlot && (potionSlot.activity || 0) >= 0.28 && p.splash_potion) {
      sum += compareSlotToType(potionSlot, p.splash_potion, 'splash_potion') * 0.4;
      wSum += 0.4;
    }
    const score = wSum ? (sum / wSum) : 0;
    if (score > best) { best = score; bestName = name; }
  }
  return { best, bestName };
}

function buildStrictCropCandidates(imgW, imgH) {
  const unitSet = new Set();
  const aspect = imgH / Math.max(1, imgW);
  const isHudCrop = aspect < 0.35;
  const maxWidgetW = imgW * (isHudCrop ? 1.02 : 0.92);
  const maxWidgetH = imgH * (isHudCrop ? 0.78 : 0.2);
  const maxScale = getMaxGuiScale(imgW, imgH);
  const maxCandidateUnit = isHudCrop
    ? Math.max(maxScale, Math.min(MAX_GUI_SCALE, Math.ceil(Math.max(maxWidgetW / 182, maxWidgetH / 22))))
    : maxScale;

  // Prefer Minecraft-like GUI scale factors (integer), plus ratio-consistent fallbacks for rescaled screenshots.
  for (let u = 1; u <= maxScale; u++) unitSet.add(u.toFixed(3));
  const denseMax = isHudCrop ? maxCandidateUnit : Math.min(maxCandidateUnit, maxScale + 0.75);
  for (let u = 1.0; u <= denseMax + 1e-6; u += 0.05) unitSet.add(u.toFixed(3));
  const wideUnit = getWide16By9Unit(imgW, imgH);
  if (!isHudCrop && wideUnit >= 1 && wideUnit <= maxCandidateUnit) unitSet.add(wideUnit.toFixed(3));

  // Hotbar-only crops: the widget can span (almost) the full image width.
  // These units are harmless for full screenshots (filtered out by range).
  const uFullW = imgW / 182;
  if (isFinite(uFullW)) {
    if (uFullW >= 0.8 && uFullW <= maxCandidateUnit) unitSet.add(uFullW.toFixed(3));
    const ur = Math.round(uFullW);
    if (ur >= 1 && ur <= maxCandidateUnit) unitSet.add(ur.toFixed(3));
  }
  const uFullH = imgH / 22;
  if (isFinite(uFullH)) {
    if (uFullH >= 0.8 && uFullH <= maxCandidateUnit) unitSet.add(uFullH.toFixed(3));
    const ur = Math.round(uFullH);
    if (ur >= 1 && ur <= maxCandidateUnit) unitSet.add(ur.toFixed(3));
  }

  for (const rw of STRICT_WIDGET_WIDTH_RATIOS) {
    const unitW = imgW * rw / 182;
    for (const rh of STRICT_WIDGET_HEIGHT_RATIOS) {
      const unitH = imgH * rh / 22;
      if (Math.abs(unitW - unitH) > 0.24) continue;
      unitSet.add(((unitW + unitH) * 0.5).toFixed(3));
    }
  }

  // Legacy union fallback (keeps behavior for unusual crops/aspects).
  if (unitSet.size < 6) {
    for (const ratio of STRICT_WIDGET_WIDTH_RATIOS) unitSet.add((imgW * ratio / 182).toFixed(3));
    for (const ratio of STRICT_WIDGET_HEIGHT_RATIOS) unitSet.add((imgH * ratio / 22).toFixed(3));
  }
  const units = Array.from(unitSet).map(Number).filter(u => u >= 1.0 && u <= maxCandidateUnit).sort((a, b) => a - b);
  const out = [];
  for (const unit of units) {
    const widgetW = 182 * unit;
    const widgetH = 22 * unit;
    if (widgetW > maxWidgetW || widgetH > maxWidgetH) continue;
    const cx = (imgW - widgetW) / 2;
    const xSet = new Set([cx.toFixed(3)]);
    if (isHudCrop) {
      xSet.add('0.000');
      xSet.add((imgW - widgetW).toFixed(3));
    }
    const xCandidates = Array.from(xSet).map(Number).filter(x => isFinite(x) && x >= 0 && x + widgetW <= imgW + 1e-3);
    const bottomOffsets = new Set(STRICT_BOTTOM_OFFSET_UNIT_STEPS.map(s => Math.round(s * unit)));
    for (const bottomOffset of bottomOffsets) {
      const bottomRatio = bottomOffset / imgH;
      const widgetY = imgH - widgetH - bottomOffset;
      if (widgetY < 0 || widgetY + widgetH > imgH) continue;
      for (const widgetX of xCandidates) {
        if (widgetX < 0 || widgetX + widgetW > imgW) continue;
        out.push({ unit, bottomRatio, bottomOffset, widgetX, widgetY, widgetW, widgetH });
      }
    }
  }
  return out;
}

function extractSlotFeatures(ctx, x, y, sz, imgW, imgH, index, options = {}) {
  const sx = Math.round(x);
  const sy = Math.round(y);
  const ss = Math.round(sz);
  if (sx < 0 || sy < 0 || sx + ss > imgW || sy + ss > imgH) return null;

  const inset = Math.max(1, Math.round(ss * 0.12));
  const iw = Math.max(4, ss - inset * 2);
  const ih = Math.max(4, ss - inset * 2);
  if (sx + inset < 0 || sy + inset < 0 || sx + inset + iw > imgW || sy + inset + ih > imgH) return null;

  const region = extractRegion(ctx, sx + inset, sy + inset, iw, ih, 16, 16);
  let lumSum = 0, lumSqSum = 0;
  for (let p = 0; p < 256; p++) {
    const lum = 0.299 * region.data[p * 4] + 0.587 * region.data[p * 4 + 1] + 0.114 * region.data[p * 4 + 2];
    lumSum += lum;
    lumSqSum += lum * lum;
  }
  const mean = lumSum / 256;
  const variance = lumSqSum / 256 - mean * mean;
  const features = computeFeatures(region, 16, 16, true, 'slot');
  const variants = options.withVariants === false ? null : buildSlotVariants(ctx, sx, sy, ss, imgW, imgH);
  if (variants && !variants.length) variants.push(features);

  // Variance on empty slots can be deceptively high due to gradients; gate against that.
  const varScore = clamp01((variance - 220) / 1500);
  const edgeScore = clamp01((features.edge - 0.02) / 0.08);
  const activity = 0.62 * varScore + 0.38 * edgeScore;
  const quality = Math.sqrt(Math.max(0, variance)) * (0.55 + features.edge) * (0.45 + activity);

  const pad = Math.max(1, Math.round(ss * 0.125));
  const fullSz = Math.max(ss + 2, Math.round(ss * 1.25));
  const displayRect = { x: sx - pad, y: sy - pad, sz: fullSz };
  return { index, features, variants, x: sx, y: sy, sz: ss, displayRect, quality, activity, variance };
}

function hydrateSlotVariants(ctx, slots, imgW, imgH) {
  for (const slot of (slots || [])) {
    if (!slot || slot.variants) continue;
    slot.variants = buildSlotVariants(ctx, slot.x, slot.y, slot.sz, imgW, imgH);
    if (!slot.variants.length && slot.features) slot.variants.push(slot.features);
    if (slot.index === 0 || slot.index === 1) {
      slot.refineVariants = buildSlotVariants(ctx, slot.x, slot.y, slot.sz, imgW, imgH, { preserveBottom: true, spatialSize: 32 });
    }
  }
  return slots;
}

function pickSlotForClip(slots, slotTypes, wantedType, fallbackIndex) {
  if (Array.isArray(slotTypes) && slotTypes.length === 9) {
    const idx = slotTypes.indexOf(wantedType);
    if (idx >= 0) {
      const byIndex = slots.find(s => s && s.index === idx);
      if (byIndex) return byIndex;
      if (slots[idx]) return slots[idx];
    }
  }
  const fb = slots.find(s => s && s.index === fallbackIndex) || slots[fallbackIndex];
  return fb || slots[0] || null;
}

function findDisplayWidgetRect(ctx, imgW, imgH, hintRect, preset) {
  const maxScale = getMaxGuiScale(imgW, imgH);
  const detectedScale = hintRect && hintRect.w ? (hintRect.w / 182) : 0;
  const preferredScale = getPresetUnit(imgW, imgH, preset);
  const u = preferredScale >= 1
    ? preferredScale
    : Math.max(1, Math.min(maxScale, Math.round(detectedScale || maxScale)));
  const w = 182 * u, h = 22 * u;
  const x = Math.round((imgW - w) / 2);
  const bottomOffset = hintRect
    ? Math.max(0, Math.round(imgH - (hintRect.y + hintRect.h)))
    : 0;
  const y = imgH - h - bottomOffset;
  if (x < 0 || y < 0 || x + w > imgW) return hintRect;
  return { x, y, w, h };
}

function detectHotbarFrameCandidates(ctx, imgW, imgH) {
  const top = Math.max(1, Math.floor(imgH * 0.72));
  const rgba = ctx.getImageData(0, top - 1, imgW, imgH - top + 1).data;
  const edges = [];
  const gapLimit = Math.max(1, Math.round(imgW / 960));
  const edgeThreshold = 18;
  for (let y = top; y < imgH; y++) {
    let start = -1, gap = 0, strength = 0;
    for (let x = 0; x <= imgW; x++) {
      const i = ((y - top + 1) * imgW + x) * 4;
      const j = i - imgW * 4;
      const difference = x < imgW ? Math.abs(rgba[i] - rgba[j]) + Math.abs(rgba[i + 1] - rgba[j + 1]) + Math.abs(rgba[i + 2] - rgba[j + 2]) : 0;
      const edge = difference >= edgeThreshold;
      if (edge) { if (start < 0) start = x; gap = 0; strength += difference; }
      else if (start >= 0 && (++gap > gapLimit || x === imgW)) {
        const width = x - gap + 1 - start;
        if (width >= imgW * 0.12 && width <= imgW * 0.99 && Math.abs(start + width / 2 - imgW / 2) < width * 0.08) {
          edges.push({ x: start, y, width, strength: strength / width });
        }
        start = -1; gap = 0; strength = 0;
      }
    }
  }
  const candidates = [];
  if (matcher === 'aligned') {
    const boundaryStrength = (x, y, width) => {
      const row = Math.round(y), left = Math.max(0, Math.round(x));
      const right = Math.min(imgW, Math.round(x + width));
      if (row < top || row >= imgH || right <= left) return 0;
      let sum = 0;
      for (let column = left; column < right; column++) {
        const i = ((row - top + 1) * imgW + column) * 4, j = i - imgW * 4;
        sum += Math.abs(rgba[i] - rgba[j]) + Math.abs(rgba[i + 1] - rgba[j + 1]) + Math.abs(rgba[i + 2] - rgba[j + 2]);
      }
      return sum / (right - left);
    };
    // Outer borders can expose either side of their last pixel; inset borders
    // need the same inset restored on both axes. Width validates vertical scale.
    for (const edge of edges) for (const bottom of edges) {
      if (bottom.y <= edge.y) continue;
      for (const inset of [0, 1]) for (const span of [22 - 2 * inset, 21 - 2 * inset]) {
        const unit = Math.round((bottom.y - edge.y) / span * 20) / 20;
        if (unit < 0.8 || unit > MAX_GUI_SCALE) continue;
        // Custom frames may indent their top and bottom edges differently.
        // Vertical inset sets the slot origin; horizontal insets only validate scale.
        const horizontalInsets = [inset, inset + 1];
        const fitWidth = width => Math.min(...horizontalInsets.map(horizontalInset =>
          Math.abs(width - (182 - 2 * horizontalInset) * unit)));
        const widthError = Math.max(fitWidth(edge.width), fitWidth(bottom.width));
        const tolerance = Math.max(2, unit);
        if (widthError > tolerance || Math.abs(edge.x + edge.width / 2 - imgW / 2) > 2 * unit ||
            Math.abs(bottom.x + bottom.width / 2 - imgW / 2) > 2 * unit) continue;
        const widgetW = 182 * unit, widgetH = 22 * unit;
        const widgetX = Math.round((imgW - widgetW) / 2), widgetY = Math.round(edge.y - inset * unit);
        if (widgetX < 0 || widgetY < 0 || widgetY + widgetH > imgH + 1) continue;
        const bottomOffset = Math.max(0, imgH - widgetY - widgetH);
        const outerTop = boundaryStrength(widgetX, widgetY, widgetW);
        const outerBottom = Math.max(boundaryStrength(widgetX, widgetY + widgetH, widgetW),
          boundaryStrength(widgetX, widgetY + widgetH - unit, widgetW));
        // An internal stripe alone must not move the rectangle past its visible frame.
        const boundarySupport = Math.sqrt(clamp01(outerTop / edgeThreshold) * clamp01(outerBottom / edgeThreshold));
        candidates.push({ unit, widgetX, widgetY, widgetW, widgetH, bottomOffset,
          bottomRatio: bottomOffset / imgH,
          frameConfidence: 1 - 0.15 * widthError / tolerance - 0.04 * inset
            + 0.08 * Math.min(1, Math.min(edge.strength, bottom.strength) / 128) + 0.2 * boundarySupport });
      }
    }
    const unique = new Map();
    for (const candidate of candidates) {
      const key = [candidate.widgetX, candidate.widgetY, candidate.widgetW, candidate.widgetH].join(',');
      if (!unique.has(key) || unique.get(key).frameConfidence < candidate.frameConfidence) unique.set(key, candidate);
    }
    return [...unique.values()].sort((a, b) => b.frameConfidence - a.frameConfidence).slice(0, 12);
  }
  for (const edge of edges) {
    const estimated = edge.width / 181;
    // Frame alpha can hide its final logical column. Nearby 0.05-scale values
    // are hypotheses only; frame agreement, not integer GUI rounding, ranks them.
    const unit = Math.round(estimated * 20) / 20;
    if (unit < 0.8 || unit > MAX_GUI_SCALE || Math.abs(edge.x + edge.width / 2 - imgW / 2) > 2 * unit) continue;
    const verticalError = other => Math.abs(other.y - edge.y - 21 * unit);
    const bottom = edges.filter(other => other.y > edge.y &&
      verticalError(other) <= Math.max(1, unit * 0.4) &&
      Math.abs(other.width - edge.width) <= 4 * unit && Math.abs(other.x - edge.x) <= 3 * unit)
      .sort((a, b) => Math.abs(a.width - edge.width) - Math.abs(b.width - edge.width)
        || verticalError(a) - verticalError(b))[0];
    if (!bottom) continue;
    // A selected-slot border can widen the horizontal edge. Use the paired
    // top/bottom separation to refine scale rather than stretching that border.
    const frameUnit = Math.round((bottom.y - edge.y) / 21 * 20) / 20;
    const widgetW = 182 * frameUnit, widgetH = 22 * frameUnit;
    const widgetX = Math.round((imgW - widgetW) / 2), widgetY = edge.y;
    if (widgetY + widgetH > imgH + 1) continue;
    candidates.push({ unit: frameUnit, widgetX, widgetY, widgetW, widgetH,
      bottomOffset: Math.max(0, imgH - widgetY - widgetH),
      bottomRatio: Math.max(0, imgH - widgetY - widgetH) / imgH,
      frameConfidence: 1 - Math.min(1, Math.abs(bottom.width - edge.width) / Math.max(1, edge.width)) });
  }
  return candidates.filter(candidate => !candidates.some(outer =>
    outer.widgetW > candidate.widgetW && outer.widgetW - candidate.widgetW <= 6 * outer.unit &&
    outer.widgetY <= candidate.widgetY && candidate.widgetY - outer.widgetY <= 3 * outer.unit &&
    Math.abs(outer.bottomOffset - candidate.bottomOffset) <= 2 * outer.unit &&
    outer.frameConfidence >= candidate.frameConfidence))
    .sort((a, b) => b.frameConfidence - a.frameConfidence || b.widgetW - a.widgetW).slice(0, 12);
}

function extractHotbarSlots(ctx, imgW, imgH, preset) {
  const frameCandidates = detectHotbarFrameCandidates(ctx, imgW, imgH);
  const candidates = [...frameCandidates, ...buildStrictCropCandidates(imgW, imgH)];
  const aspect = imgH / Math.max(1, imgW);
  const isHudCrop = aspect < 0.35;
  const baseUnit = getWide16By9Unit(imgW, imgH);
  const targetUnit = isHudCrop ? 0 : (preset === 'auto' ? 0 : (preset === 'small' ? Math.max(1, Math.ceil(baseUnit) - 1) : baseUnit));
  const PRE_K = isHudCrop ? 80 : (preset === 'auto' ? 56 : 42);
  const PER_UNIT_K = isHudCrop ? 14 : 9;
  const preByUnit = new Map();
  const mustByUnit = new Map();
  const all = [];
  let bestSlots = [];
  let bestConfidence = -Infinity;
  let bestBoost = -Infinity;
  let bestWidgetFeatures = null;
  let bestWidgetRect = null;
  let bestHudFeatures = null;
  let bestSearchInfo = null;
  const bestAutoByRoundedUnit = new Map();
  const isBetterCandidate = (nextScore, nextConfidence, prevScore, prevConfidence) => {
    const scoreDelta = nextScore - prevScore;
    return scoreDelta > 0.001 || (Math.abs(scoreDelta) <= 0.001 && nextConfidence > prevConfidence);
  };
  const applyCandidate = (candidate, rankScore, mode, extraInfo) => {
    bestConfidence = candidate.confidence;
    bestBoost = rankScore;
    bestSlots = candidate.slots;
    bestWidgetFeatures = candidate.widgetFeatures;
    bestWidgetRect = candidate.widgetRect;
    bestHudFeatures = candidate.hudFeatures;
    bestSearchInfo = {
      mode,
      unit: candidate.unit,
      bottomRatio: candidate.bottomRatio,
      bottomOffset: candidate.bottomOffset,
      confidence: candidate.confidence,
      targetUnit: candidate.unitPrefTarget,
      combinedBoost: candidate.boostedCombined,
      rankScore,
      widgetBoost: candidate.widgetBoost,
      hudBoost: candidate.hudBoost,
      slotBoost: candidate.slotBoost,
      gridScore: candidate.gridScore,
      frameConfidence: candidate.frameConfidence || 0,
      bottomPref: candidate.bottomPref,
      unitPref: candidate.unitPref,
      preTop: candidate.preTop,
      widgetBest: candidate.widgetBest,
      hudBest: candidate.hudBest,
      slotBest: candidate.slotBest,
      ...(extraInfo || {}),
    };
  };
  const getAutoUnitOptions = () => {
    const rounded = Math.max(1, Math.round(baseUnit || 0));
    if (!rounded) return [];
    return rounded > 1 ? [rounded - 1, rounded] : [rounded];
  };
  const scoreAutoScaleCandidate = (candidate, maxConfidence) => {
    const confidenceNorm = clamp01(candidate.confidence / Math.max(1, maxConfidence));
    const integerFit = clamp01(1 - Math.abs(candidate.unit - candidate.roundedUnit) / 0.35);
    const geomScore = 0.62 * confidenceNorm + 0.18 * candidate.gridScore + 0.12 * candidate.bottomPref + 0.08 * integerFit;
    return geomScore * (0.88 + 0.12 * candidate.boostedCombined);
  };
  const shouldPreferLargerAutoUnit = (smaller, larger, smallerScore, largerScore) => {
    if (!smaller || !larger) return false;
    if (larger.roundedUnit <= smaller.roundedUnit) return false;
    const scoreRatio = largerScore / Math.max(smallerScore, 1e-6);
    const boostRatio = larger.boostedCombined / Math.max(smaller.boostedCombined, 1e-6);
    const confidenceRatio = larger.confidence / Math.max(smaller.confidence, 1);
    return scoreRatio >= 0.985 && boostRatio >= 0.965 && confidenceRatio >= 0.90;
  };

  for (const c of candidates) {
    const wx = Math.round(c.widgetX);
    const wy = Math.round(c.widgetY);
    const ww = Math.round(c.widgetW);
    const wh = Math.round(c.widgetH);
    if (wx < 0 || wy < 0 || wx + ww > imgW || wy + wh > imgH) continue;

    const widgetStrip = extractRegion(ctx, wx, wy, ww, wh, 182, 22);
    const maskedStrip = maskWidgetItems(widgetStrip.data, 182, 22);
    const gridScore = computeWidgetGridScore(maskedStrip, 182, 22);
    const bottomPref = clamp01(1 - (c.bottomOffset || 0) / (c.unit * 4 + 1e-6));
    const unitRounded = Math.max(1, Math.round(c.unit));
    const unitPrefTarget = targetUnit >= 1 ? targetUnit : unitRounded;
    const unitPref = clamp01(1 - Math.abs(c.unit - unitPrefTarget) / (targetUnit >= 1 ? 0.08 : 0.18));
    const score = matcher === 'aligned' && c.frameConfidence
      ? c.frameConfidence + 0.05 * gridScore
      : (0.70 * gridScore + 0.30 * bottomPref) * (0.90 + 0.10 * unitPref) + (c.frameConfidence || 0);
    const entry = { c, wx, wy, ww, wh, widgetStrip, maskedStrip, gridScore, bottomPref, unitPref, unitPrefTarget, score, unitRounded };
    all.push(entry);

    const list = preByUnit.get(unitRounded) || [];
    if (list.length < PER_UNIT_K || score > list[list.length - 1].score) {
      list.push(entry);
      list.sort((a, b) => b.score - a.score);
      if (list.length > PER_UNIT_K) list.length = PER_UNIT_K;
      preByUnit.set(unitRounded, list);
    }

    if ((c.bottomOffset || 0) === 0) {
      const prev = mustByUnit.get(unitRounded);
      if (!prev) {
        mustByUnit.set(unitRounded, entry);
      } else {
        const d1 = Math.abs(c.unit - unitRounded);
        const d0 = Math.abs(prev.c.unit - unitRounded);
        if (d1 + 1e-6 < d0 || (Math.abs(d1 - d0) <= 1e-6 && score > prev.score)) mustByUnit.set(unitRounded, entry);
      }
    }
  }

  const pre = [];
  const seen = new Set();
  const keyOf = (cand) => `${cand.wx},${cand.wy},${cand.ww},${cand.wh}`;
  const add = (cand) => {
    if (!cand) return;
    const k = keyOf(cand);
    if (seen.has(k)) return;
    seen.add(k);
    pre.push(cand);
  };

  const must = Array.from(mustByUnit.values()).sort((a, b) => b.score - a.score);
  for (const cand of must) add(cand);
  const merged = [];
  for (const list of preByUnit.values()) merged.push(...list);
  merged.sort((a, b) => b.score - a.score);
  for (const cand of merged) { if (pre.length >= PRE_K) break; add(cand); }
  if (pre.length < PRE_K) {
    all.sort((a, b) => b.score - a.score);
    for (const cand of all) { if (pre.length >= PRE_K) break; add(cand); }
  }

  const preTop = [...pre].sort((a, b) => b.score - a.score).slice(0, 8).map(p =>
    `u=${p.c.unit.toFixed(2)} off=${p.c.bottomOffset || 0} g=${p.gridScore.toFixed(2)} b=${p.bottomPref.toFixed(2)} s=${p.score.toFixed(2)}`
  ).join(' | ');

  for (const cand of pre) {
    const c = cand.c;
    const unit = c.unit;
    const itemOffX = 3 * unit;
    const itemW = 16 * unit;
    const slotStep = 20 * unit;
    const itemY = cand.wy + 3 * unit;

    const slots = [];
    let activeCount = 0;
    let totalActivity = 0;
    let totalQuality = 0;
    for (let i = 0; i < 9; i++) {
      const x = cand.wx + itemOffX + i * slotStep;
      const slot = extractSlotFeatures(ctx, x, itemY, itemW, imgW, imgH, i, { withVariants: false });
      if (!slot) continue;
      slot.displayRect = {
        x: cand.wx + (1 + i * 20) * unit,
        y: cand.wy + unit,
        sz: 20 * unit,
      };
      slots.push(slot);
      totalActivity += slot.activity;
      totalQuality += slot.quality;
      if (slot.activity >= 0.28) activeCount++;
    }
    if (slots.length !== 9) continue;

    const widgetFeatures = buildWidgetFeatures(cand.widgetStrip, cand.maskedStrip);
    const widgetRect = { x: cand.wx, y: cand.wy, w: cand.ww, h: cand.wh };
    const hudFeatures = extractHudFeatures(ctx, widgetRect, imgW, imgH);

    const widgetCand = estimateWidgetCandidates(widgetFeatures, 8);
    const widgetBoost = widgetCand.best;
    const hudCand = hudFeatures
      ? estimateHudConfidence(hudFeatures, widgetCand.top.map(t => t.name))
      : { best: 0, bestName: '' };
    const hudBoost = hudCand.best;
    const slotCand = estimateSlotConfidence(slots, widgetCand.top.map(t => t.name));
    const slotBoost = slotCand.best;

    // For full screenshots, HUD icon alignment is a stronger geometric anchor than
    // widget-strip color/texture, which can overfit to a too-small centered crop.
    const baseBoost = hudFeatures
      ? (0.25 * widgetBoost + 0.65 * hudBoost + 0.10 * slotBoost)
      : (0.70 * widgetBoost + 0.30 * slotBoost);
    // Full screenshots use integer GUI scale; strongly prefer near-integer units
    // to prevent HUD-driven selection of fractional units that shift the crop.
    const unitPrefW = isHudCrop || preset === 'auto' ? 0.08 : (preset === 'small' ? 0.85 : 0.50);
    const combinedBoost = baseBoost
      * (0.78 + 0.22 * cand.gridScore)
      * (0.86 + 0.14 * cand.bottomPref)
      * ((1 - unitPrefW) + unitPrefW * (cand.unitPref || 0));
    const hudCoverage = hudFeatures
      ? ((hudFeatures.hearts.length + hudFeatures.hunger.length + hudFeatures.armor.length) / 30)
      : 0;
    const geomBoost = hudFeatures ? (0.82 + 0.18 * clamp01(hudCoverage)) : 1;
    const boostedCombined = matcher === 'aligned'
      ? cand.score
      : combinedBoost * geomBoost + (c.frameConfidence || 0);
    const confidence = activeCount * 220 + totalActivity * 160 + totalQuality * 6 + hudCoverage * 700;
    const result = {
      unit: c.unit,
      frameConfidence: c.frameConfidence || 0,
      roundedUnit: cand.unitRounded,
      bottomRatio: c.bottomRatio,
      bottomOffset: c.bottomOffset || 0,
      confidence,
      unitPrefTarget: cand.unitPrefTarget,
      boostedCombined,
      widgetBoost,
      hudBoost,
      slotBoost,
      gridScore: cand.gridScore,
      bottomPref: cand.bottomPref,
      unitPref: cand.unitPref,
      preTop,
      widgetBest: widgetCand.bestName,
      hudBest: hudCand.bestName,
      slotBest: slotCand.bestName,
      slots,
      widgetFeatures,
      widgetRect,
      hudFeatures,
    };

    const prevAutoByUnit = bestAutoByRoundedUnit.get(cand.unitRounded);
    if (!prevAutoByUnit || isBetterCandidate(confidence, boostedCombined, prevAutoByUnit.confidence, prevAutoByUnit.boostedCombined)) {
      bestAutoByRoundedUnit.set(cand.unitRounded, result);
    }
    if (isBetterCandidate(boostedCombined, confidence, bestBoost, bestConfidence)) {
      applyCandidate(result, boostedCombined, 'strict-ratio');
    }
  }

  if (preset === 'auto' && !isHudCrop && baseUnit >= 1) {
    const autoUnits = getAutoUnitOptions();
    const autoCandidates = autoUnits.map(unit => bestAutoByRoundedUnit.get(unit)).filter(Boolean);
    if (autoCandidates.length >= 2) {
      const maxConfidence = Math.max(1, ...autoCandidates.map(candidate => candidate.confidence));
      const scoredCandidates = autoCandidates.map(candidate => ({
        candidate,
        autoScore: scoreAutoScaleCandidate(candidate, maxConfidence),
      }));
      let autoBest = null;
      let autoBestScore = -Infinity;
      for (const { candidate, autoScore } of scoredCandidates) {
        if (!autoBest || isBetterCandidate(autoScore, candidate.confidence, autoBestScore, autoBest.confidence)) {
          autoBest = candidate;
          autoBestScore = autoScore;
        }
      }
      const smallerAuto = scoredCandidates.find(row => row.candidate.roundedUnit === autoUnits[0]);
      const largerAuto = scoredCandidates.find(row => row.candidate.roundedUnit === autoUnits[autoUnits.length - 1]);
      const preferLargerAuto = smallerAuto && largerAuto
        && autoBest === smallerAuto.candidate
        && shouldPreferLargerAutoUnit(smallerAuto.candidate, largerAuto.candidate, smallerAuto.autoScore, largerAuto.autoScore);
      if (preferLargerAuto) {
        autoBest = largerAuto.candidate;
        autoBestScore = largerAuto.autoScore;
      }
      if (autoBest) {
        applyCandidate(autoBest, autoBestScore, 'strict-auto-scale', {
          autoUnits: autoUnits.join('/'),
          autoScaleScore: autoBestScore,
          autoScaleDecision: preferLargerAuto ? 'prefer-larger-if-close' : 'top-score',
          autoCandidates: scoredCandidates
            .map(row => `u${row.candidate.roundedUnit}:${row.autoScore.toFixed(3)}/c${Math.round(row.candidate.confidence)}/b${row.candidate.boostedCombined.toFixed(3)}`)
            .join(' | '),
        });
      }
    }
  }

  // For full screenshots, snap the detected widget to the nearest valid GUI scale
  // for the current screenshot instead of forcing a 1080p-sized crop.
  if (!isHudCrop && bestWidgetRect) {
    const fixedRect = bestSearchInfo && bestSearchInfo.frameConfidence
      ? bestWidgetRect : findDisplayWidgetRect(ctx, imgW, imgH, bestWidgetRect, preset);
    const bestGU = fixedRect && fixedRect.w ? (fixedRect.w / 182) : (bestWidgetRect.w / 182);
    if (fixedRect) {
      bestWidgetRect = fixedRect;
      bestWidgetFeatures = extractWidgetFeatures(ctx, bestWidgetRect);
      bestHudFeatures = extractHudFeatures(ctx, bestWidgetRect, imgW, imgH);
      bestSlots = Array.from({ length: 9 }, (_, index) => {
        const slot = extractSlotFeatures(ctx, bestWidgetRect.x + (3 + index * 20) * bestGU,
          bestWidgetRect.y + 3 * bestGU, 16 * bestGU, imgW, imgH, index, { withVariants: false });
        if (slot) slot.displayRect = {
          x: bestWidgetRect.x + (1 + index * 20) * bestGU,
          y: bestWidgetRect.y + bestGU,
          sz: 20 * bestGU,
        };
        return slot;
      }).filter(Boolean);
      if (bestSearchInfo) {
        bestSearchInfo.detectedUnit = bestSearchInfo.unit;
        bestSearchInfo.unit = bestGU;
        bestSearchInfo.snappedUnit = bestGU;
        bestSearchInfo.bottomOffset = Math.max(0, Math.round(imgH - (bestWidgetRect.y + bestWidgetRect.h)));
        bestSearchInfo.mode = 'strict-ratio-snapped';
      }
    }
  }
  hydrateSlotVariants(ctx, bestSlots, imgW, imgH);
  for (const slot of bestSlots) {
    slot.native = { width: slot.sz, height: slot.sz,
      rect: { x: slot.x, y: slot.y, w: slot.sz, h: slot.sz },
      pixels: ctx.getImageData(slot.x, slot.y, slot.sz, slot.sz).data };
  }

  return {
    slots: bestSlots,
    widgetFeatures: bestWidgetFeatures,
    widgetRect: bestWidgetRect,
    hudFeatures: bestHudFeatures,
    searchInfo: bestSearchInfo,
  };
}

function compareHudVariant(extracted, tex, hudType) {
  let sim = compare(extracted, tex);
  if (hudType === 'health' && extracted && tex && extracted.sig && tex.sig) {
    const dir = clamp01(meanRgbDirSim(extracted.moments, tex.moments));
    const gbSim = metricSimilarity(
      signatureMeanRatio(extracted.sig, 'meanG', 'meanB'),
      signatureMeanRatio(tex.sig, 'meanG', 'meanB'),
      0.34
    );
    const rbSim = metricSimilarity(
      signatureMeanRatio(extracted.sig, 'meanR', 'meanB'),
      signatureMeanRatio(tex.sig, 'meanR', 'meanB'),
      0.40
    );
    // Sharper color discrimination: red vs blue hearts should not look similar
    sim *= (0.02 + 0.12 * dir + 0.34 * gbSim + 0.52 * rbSim);
  }
  if (hudType === 'hunger' && extracted && tex && extracted.sig && tex.sig) {
    const dir = clamp01(meanRgbDirSim(extracted.moments, tex.moments));
    const rbSim = metricSimilarity(
      signatureMeanRatio(extracted.sig, 'meanR', 'meanB'),
      signatureMeanRatio(tex.sig, 'meanR', 'meanB'),
      0.30
    );
    const yellowSim = metricSimilarity(extracted.sig.yellowFrac, tex.sig.yellowFrac, 0.14);
    const lumSim = metricSimilarity(extracted.sig.meanLum, tex.sig.meanLum, 28);
    sim *= (0.04 + 0.22 * dir + 0.36 * rbSim + 0.22 * yellowSim + 0.16 * lumSim);
  }
  return sim;
}

function compareHudCells(cells, variants, hudType) {
  if (!cells || cells.length === 0) return 0;
  const texList = (variants || []).filter(Boolean);
  if (!texList.length) return 0;
  const sims = [];
  for (const cell of cells) {
    let best = 0;
    for (const tex of texList) best = Math.max(best, compareHudVariant(cell, tex, hudType));
    sims.push(best);
  }
  sims.sort((a, b) => b - a);
  const take = Math.max(4, Math.min(sims.length, Math.ceil(sims.length * 0.7)));
  let sum = 0;
  for (let i = 0; i < take; i++) sum += sims[i];
  const avgTop = take ? sum / take : 0;
  // Blend avgTop with peak cell. Peak rewards packs that have at least one
  // clearly-matching HUD cell even when others are noisy / empty / occluded.
  const peak = sims[0] || 0;
  return avgTop * 0.40 + peak * 0.60;
}

function metricSimilarity(a, b, spread) {
  if (!isFinite(a) || !isFinite(b) || !isFinite(spread) || spread <= 0) return 0;
  return clamp01(1 - Math.abs(a - b) / spread);
}

function signatureSimilarity(extractedSig, packSig, targetType) {
  if (!extractedSig || !packSig) return 0;
  if (targetType === 'diamond_sword') {
    const shapeReady = typeof extractedSig.centerX === 'number' && typeof packSig.centerX === 'number';
    const shapeSim = shapeReady ? clamp01(
      metricSimilarity(extractedSig.coverage, packSig.coverage, 0.12) * 0.18 +
      metricSimilarity(extractedSig.centerX, packSig.centerX, 0.12) * 0.14 +
      metricSimilarity(extractedSig.centerY, packSig.centerY, 0.10) * 0.06 +
      metricSimilarity(extractedSig.lrBias, packSig.lrBias, 0.18) * 0.04 +
      metricSimilarity(extractedSig.tbBias, packSig.tbBias, 0.20) * 0.04 +
      metricSimilarity(extractedSig.rowSlope, packSig.rowSlope, 0.08) * 0.20 +
      metricSimilarity(extractedSig.bboxTop, packSig.bboxTop, 0.10) * 0.14 +
      metricSimilarity(extractedSig.bboxBottom, packSig.bboxBottom, 0.18) * 0.10 +
      metricSimilarity(extractedSig.bboxLeft, packSig.bboxLeft, 0.12) * 0.06 +
      metricSimilarity(extractedSig.bboxRight, packSig.bboxRight, 0.12) * 0.04 +
      metricSimilarity(extractedSig.mirrorFrac, packSig.mirrorFrac, 0.20) * 0.02
    ) : 0;
    const colorSim = clamp01(
      metricSimilarity(extractedSig.darkFrac, packSig.darkFrac, 0.18) * 0.22 +
      metricSimilarity(extractedSig.centerDarkFrac, packSig.centerDarkFrac, 0.18) * 0.16 +
      metricSimilarity(extractedSig.blueFrac, packSig.blueFrac, 0.12) * 0.24 +
      metricSimilarity(extractedSig.meanLum, packSig.meanLum, 22) * 0.14 +
      metricSimilarity(
        signatureMeanRatio(extractedSig, 'meanR', 'meanB'),
        signatureMeanRatio(packSig, 'meanR', 'meanB'),
        0.12
      ) * 0.14 +
      metricSimilarity(
        signatureMeanRatio(extractedSig, 'meanG', 'meanB'),
        signatureMeanRatio(packSig, 'meanG', 'meanB'),
        0.12
      ) * 0.10
    );
    return shapeReady ? clamp01(shapeSim * 0.52 + colorSim * 0.48) : colorSim;
  }
  if (targetType === 'ender_pearl') {
    const sigBiasSim = metricSimilarity(
      signatureBlueGreenBias(extractedSig),
      signatureBlueGreenBias(packSig),
      0.26
    );
    const extractedNeutral = Math.abs(extractedSig.meanR - extractedSig.meanG) <= 24 && Math.abs(extractedSig.meanG - extractedSig.meanB) <= 24;
    const packNeutral = Math.abs(packSig.meanR - packSig.meanG) <= 10 && Math.abs(packSig.meanG - packSig.meanB) <= 10;
    const logoLike = extractedNeutral && packNeutral &&
      (extractedSig.coverage || 0) >= 0.40 && (packSig.coverage || 0) >= 0.42 &&
      (packSig.darkFrac || 0) >= 0.74 && (packSig.edgeDarkFrac || 0) >= 0.84 &&
      (packSig.mirrorFrac || 0) < 0.94;
    if (logoLike) {
      return clamp01(
        metricSimilarity(extractedSig.coverage, packSig.coverage, 0.20) * 0.22 +
        metricSimilarity(extractedSig.meanLum, packSig.meanLum + 34, 42) * 0.18 +
        metricSimilarity(extractedSig.darkFrac, packSig.darkFrac - 0.28, 0.34) * 0.14 +
        metricSimilarity(extractedSig.centerDarkFrac, packSig.centerDarkFrac - 0.22, 0.34) * 0.12 +
        metricSimilarity(extractedSig.edgeDarkFrac, packSig.edgeDarkFrac - 0.28, 0.34) * 0.08 +
        metricSimilarity(extractedSig.centerX, packSig.centerX, 0.18) * 0.08 +
        metricSimilarity(extractedSig.centerY, packSig.centerY, 0.18) * 0.08 +
        metricSimilarity(extractedSig.mirrorFrac, packSig.mirrorFrac, 0.16) * 0.06 +
        metricSimilarity(extractedSig.rowSlope, packSig.rowSlope, 0.06) * 0.04
      );
    }
    // Pack-vs-slot dark asymmetry: very heavy dark interior (darkFrac > 0.80)
    // in pack texture but runtime slot suppression has masked the dark center
    // (orb-style EP textures). Brightness/dark-fraction and R/B metrics become
    // meaningless when meanR ≈ 0; lean on G/B hue direction and bias instead.
    const darkAsym = (packSig.darkFrac || 0) > 0.80 && (extractedSig.darkFrac || 0) < 0.20;
    if (darkAsym) {
      return clamp01(
        metricSimilarity(extractedSig.darkFrac, packSig.darkFrac, 0.40) * 0.02 +
        metricSimilarity(extractedSig.centerDarkFrac, packSig.centerDarkFrac, 0.40) * 0.02 +
        metricSimilarity(extractedSig.edgeDarkFrac, packSig.edgeDarkFrac, 0.40) * 0.01 +
        metricSimilarity(extractedSig.blueFrac, packSig.blueFrac, 0.20) * 0.02 +
        metricSimilarity(extractedSig.meanLum, packSig.meanLum, 80) * 0.02 +
        metricSimilarity(extractedSig.coverage, packSig.coverage, 0.30) * 0.02 +
        metricSimilarity(extractedSig.mirrorFrac, packSig.mirrorFrac, 0.18) * 0.04 +
        metricSimilarity(
          signatureMeanRatio(extractedSig, 'meanG', 'meanB'),
          signatureMeanRatio(packSig, 'meanG', 'meanB'),
          0.50
        ) * 0.75 +
        sigBiasSim * 0.10
      );
    }
    return clamp01(
      metricSimilarity(extractedSig.darkFrac, packSig.darkFrac, 0.16) * 0.14 +
      metricSimilarity(extractedSig.centerDarkFrac, packSig.centerDarkFrac, 0.16) * 0.14 +
      metricSimilarity(extractedSig.edgeDarkFrac, packSig.edgeDarkFrac, 0.18) * 0.05 +
      metricSimilarity(extractedSig.blueFrac, packSig.blueFrac, 0.10) * 0.10 +
      metricSimilarity(extractedSig.meanLum, packSig.meanLum, 18) * 0.14 +
      metricSimilarity(extractedSig.coverage, packSig.coverage, 0.08) * 0.04 +
      metricSimilarity(extractedSig.mirrorFrac, packSig.mirrorFrac, 0.14) * 0.03 +
      metricSimilarity(
        signatureMeanRatio(extractedSig, 'meanR', 'meanB'),
        signatureMeanRatio(packSig, 'meanR', 'meanB'),
        0.14
      ) * 0.18 +
      metricSimilarity(
        signatureMeanRatio(extractedSig, 'meanG', 'meanB'),
        signatureMeanRatio(packSig, 'meanG', 'meanB'),
        0.14
      ) * 0.06 +
      sigBiasSim * 0.12
    );
  }
  if (targetType === 'splash_potion') {
    return clamp01(
      metricSimilarity(extractedSig.coverage, packSig.coverage, 0.16) * 0.16 +
      metricSimilarity(extractedSig.centerX, packSig.centerX, 0.18) * 0.04 +
      metricSimilarity(extractedSig.centerY, packSig.centerY, 0.18) * 0.04 +
      metricSimilarity(extractedSig.lrBias, packSig.lrBias, 0.34) * 0.03 +
      metricSimilarity(extractedSig.tbBias, packSig.tbBias, 0.42) * 0.06 +
      metricSimilarity(extractedSig.mirrorFrac, packSig.mirrorFrac, 0.16) * 0.14 +
      metricSimilarity(extractedSig.rowSlope, packSig.rowSlope, 0.06) * 0.05 +
      metricSimilarity(extractedSig.bboxTop, packSig.bboxTop, 0.12) * 0.05 +
      metricSimilarity(extractedSig.bboxBottom, packSig.bboxBottom, 0.12) * 0.12 +
      metricSimilarity(extractedSig.bboxLeft, packSig.bboxLeft, 0.22) * 0.03 +
      metricSimilarity(extractedSig.bboxRight, packSig.bboxRight, 0.18) * 0.03 +
      metricSimilarity(extractedSig.edgeDarkFrac, packSig.edgeDarkFrac, 0.22) * 0.10 +
      metricSimilarity(extractedSig.redFrac, packSig.redFrac, 0.12) * 0.08 +
      metricSimilarity(extractedSig.meanLum, packSig.meanLum, 20) * 0.07
    );
  }
  return 0;
}

function colorRatio(moments, numeratorIndex, denominatorIndex) {
  if (!moments) return 0;
  return moments[numeratorIndex] / Math.max(1e-6, moments[denominatorIndex]);
}

function signatureMeanRatio(sig, numeratorKey, denominatorKey) {
  if (!sig) return 0;
  return (sig[numeratorKey] || 0) / Math.max(1, sig[denominatorKey] || 0);
}

function signatureBlueGreenBias(sig) {
  if (!sig) return 0;
  return ((sig.meanG || 0) - (sig.meanR || 0)) / Math.max(1, sig.meanB || 0);
}

function compareSlotVariant(extracted, packTex, targetType) {
  let sim = compare(extracted, packTex);
  const genericSim = sim;
  if (targetType === 'diamond_sword') {
    const dir = clamp01(meanRgbDirSim(extracted.moments, packTex.moments));
    const rbSim = metricSimilarity(colorRatio(extracted.moments, 0, 2), colorRatio(packTex.moments, 0, 2), 0.22);
    const gbSim = metricSimilarity(colorRatio(extracted.moments, 1, 2), colorRatio(packTex.moments, 1, 2), 0.22);
    const blueSim = extracted.sig && packTex.sig
      ? metricSimilarity(extracted.sig.blueFrac, packTex.sig.blueFrac, 0.18)
      : 1;
    const darkSim = extracted.sig && packTex.sig
      ? metricSimilarity(extracted.sig.darkFrac, packTex.sig.darkFrac, 0.22)
      : 1;
    const coverSim = extracted.sig && packTex.sig
      ? metricSimilarity(extracted.sig.coverage, packTex.sig.coverage, 0.10)
      : 1;
    const lumSim = extracted.sig && packTex.sig
      ? metricSimilarity(extracted.sig.meanLum, packTex.sig.meanLum, 24)
      : 1;
    sim *= (0.04 + 0.18 * dir + 0.16 * rbSim + 0.12 * gbSim + 0.18 * blueSim + 0.14 * darkSim + 0.10 * coverSim + 0.08 * lumSim);
  }
  if (targetType === 'ender_pearl') {
    const dir = clamp01(meanRgbDirSim(extracted.moments, packTex.moments));
    const rbSim = metricSimilarity(colorRatio(extracted.moments, 0, 2), colorRatio(packTex.moments, 0, 2), 0.16);
    const gbSim = metricSimilarity(colorRatio(extracted.moments, 1, 2), colorRatio(packTex.moments, 1, 2), 0.16);
    const sigRbSim = extracted.sig && packTex.sig
      ? metricSimilarity(
        signatureMeanRatio(extracted.sig, 'meanR', 'meanB'),
        signatureMeanRatio(packTex.sig, 'meanR', 'meanB'),
        0.14
      )
      : 1;
    const sigGbSim = extracted.sig && packTex.sig
      ? metricSimilarity(
        signatureMeanRatio(extracted.sig, 'meanG', 'meanB'),
        signatureMeanRatio(packTex.sig, 'meanG', 'meanB'),
        0.14
      )
      : 1;
    const sigBiasSim = extracted.sig && packTex.sig
      ? metricSimilarity(
        signatureBlueGreenBias(extracted.sig),
        signatureBlueGreenBias(packTex.sig),
        0.26
      )
      : 1;
    const blueSim = extracted.sig && packTex.sig
      ? metricSimilarity(extracted.sig.blueFrac, packTex.sig.blueFrac, 0.14)
      : 1;
    const darkSim = extracted.sig && packTex.sig
      ? metricSimilarity(extracted.sig.centerDarkFrac, packTex.sig.centerDarkFrac, 0.18)
      : 1;
    const edgeDarkSim = extracted.sig && packTex.sig
      ? metricSimilarity(extracted.sig.edgeDarkFrac, packTex.sig.edgeDarkFrac, 0.20)
      : 1;
    const coverSim = extracted.sig && packTex.sig
      ? metricSimilarity(extracted.sig.coverage, packTex.sig.coverage, 0.10)
      : 1;
    const lumSim = extracted.sig && packTex.sig
      ? metricSimilarity(extracted.sig.meanLum, packTex.sig.meanLum, 16)
      : 1;
    const colorGate = 0.16 + 0.22 * sigRbSim + 0.12 * sigGbSim + 0.20 * sigBiasSim + 0.10 * darkSim + 0.08 * lumSim + 0.08 * rbSim + 0.04 * gbSim;
    sim *= (0.02 + 0.08 * dir + 0.10 * rbSim + 0.08 * gbSim + 0.16 * sigRbSim + 0.10 * sigGbSim + 0.16 * sigBiasSim + 0.08 * blueSim + 0.08 * darkSim + 0.03 * edgeDarkSim + 0.04 * coverSim + 0.07 * lumSim);
    sim *= colorGate;
  }
  if (targetType === 'splash_potion') {
    const dir = clamp01(meanRgbDirSim(extracted.moments, packTex.moments));
    const rbSim = metricSimilarity(colorRatio(extracted.moments, 0, 2), colorRatio(packTex.moments, 0, 2), 0.42);
    const gbSim = metricSimilarity(colorRatio(extracted.moments, 1, 2), colorRatio(packTex.moments, 1, 2), 0.42);
    const edgeSim = extracted.sig && packTex.sig
      ? metricSimilarity(extracted.sig.edgeDarkFrac, packTex.sig.edgeDarkFrac, 0.38)
      : 1;
    const mirrorSim = extracted.sig && packTex.sig
      ? metricSimilarity(extracted.sig.mirrorFrac, packTex.sig.mirrorFrac, 0.18)
      : 1;
    const bottomSim = extracted.sig && packTex.sig
      ? metricSimilarity(extracted.sig.bboxBottom, packTex.sig.bboxBottom, 0.12)
      : 1;
    const coverSim = extracted.sig && packTex.sig
      ? metricSimilarity(extracted.sig.coverage, packTex.sig.coverage, 0.16)
      : 1;
    const redSim = extracted.sig && packTex.sig
      ? metricSimilarity(extracted.sig.redFrac, packTex.sig.redFrac, 0.14)
      : 1;
    const lumSim = extracted.sig && packTex.sig
      ? metricSimilarity(extracted.sig.meanLum, packTex.sig.meanLum, 20)
      : 1;
    sim *= (0.04 + 0.10 * dir + 0.08 * rbSim + 0.06 * gbSim + 0.12 * edgeSim + 0.18 * mirrorSim + 0.16 * bottomSim + 0.12 * coverSim + 0.08 * redSim + 0.06 * lumSim);
  }
  if ((targetType === 'diamond_sword' || targetType === 'ender_pearl' || targetType === 'splash_potion') && extracted.sig && packTex.sig) {
    const sigSim = signatureSimilarity(extracted.sig, packTex.sig, targetType);
    if (targetType === 'diamond_sword') {
      sim = sim * 0.46 + sigSim * 0.54;
      sim = genericSim * 0.85 + sim * 0.15;
    }
    else if (targetType === 'ender_pearl') {
      sim = sim * 0.36 + sigSim * 0.64;
      // Cyan EP match bonus: screenshot EP was classified via the cyan/teal
      // bypass and pack EP is a super-dark orb with pure cyan rim (R≈0,
      // G/B≈1.0). Only genuine cyan/teal EP pearls with near-zero red and
      // balanced green-blue qualify — filters out dark-blue and dark-green.
      if (extracted.sig.n < 70 && extracted.sig.coverage < 0.22 &&
          extracted.sig.meanG > 100 && extracted.sig.meanB > 100 &&
          (packTex.sig.darkFrac || 0) > 0.80 &&
          packTex.sig.meanG > 20 && packTex.sig.meanB > 20 &&
          packTex.sig.meanG >= packTex.sig.meanB &&
          packTex.sig.meanR < 5 &&
          Math.abs(packTex.sig.meanG / Math.max(1, packTex.sig.meanB) - 1) < 0.03) {
        sim = Math.min(1, sim + 0.18);
      }
    }
    else sim = sim * 0.40 + sigSim * 0.60;
  }
  return sim;
}

function compareSlotToType(slot, packTex, targetType) {
  if (!slot) return 0;
  const variants = slot.variants && slot.variants.length ? slot.variants : (slot.features ? [slot.features] : []);
  let best = 0;
  for (const v of variants) {
    const sim = compareSlotVariant(v, packTex, targetType);
    if (sim > best) best = sim;
  }
  return best;
}

function getSlotAnchorEvidence(slot, packTex, targetType, spatialMode = 'full') {
  if (!slot || !packTex || typeof packTex.dhash !== 'string') return null;
  const refineVariants = (targetType === 'diamond_sword' || targetType === 'ender_pearl')
    ? slot.refineVariants
    : null;
  const variants = refineVariants && refineVariants.length
    ? refineVariants
    : (slot.variants && slot.variants.length ? slot.variants : (slot.features ? [slot.features] : []));
  const packHash = packTex.__dhashBytes || (packTex.__dhashBytes = base64ToBytes(packTex.dhash));
  let bestVariant = null;
  let bestFinal = -Infinity;
  for (const variant of variants) {
    const final = compareSlotVariant(variant, packTex, targetType);
    if (final > bestFinal) {
      bestFinal = final;
      bestVariant = variant;
    }
  }
  if (!bestVariant) return null;
  const spatial = spatialMode === 'full'
    ? compareSpatialMetrics(bestVariant, packTex)
    : (spatialMode === 'color' ? { color: compareSpatialColor(bestVariant, packTex) } : null);
  if (spatialMode !== 'none' && (!spatial || typeof spatial.color !== 'number' || !isFinite(spatial.color))) return null;
  return {
    final: bestFinal,
    base: compare(bestVariant, packTex),
    hamming: 1 - hammingDistance(bestVariant.dhash, packHash) / 192,
    histogram: cosineSimilarity(bestVariant.hist, packTex.__histFloat || (packTex.__histFloat = normalizePackHist(packTex.hist))),
    moments: colorMomentSim(bestVariant.moments, packTex.moments),
    edge: 1 - Math.abs(bestVariant.edge - packTex.edge),
    spatial: spatial ? spatial.score : null,
    shape: spatial ? spatial.shape : null,
    direction: spatial ? spatial.colorDirection : null,
    color: spatial ? spatial.color : null,
    signature: signatureSimilarity(bestVariant.sig, packTex.sig, targetType),
  };
}

function groupObservedSlotsByType(slots, slotTypes) {
  const grouped = {};
  for (const slot of (slots || [])) {
    const type = slotTypes && slotTypes[slot.index];
    if (!SLOT_ITEM_TYPES.includes(type)) continue;
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push(slot);
  }
  return grouped;
}

function getBestTypeRefinementEvidence(typeSlots, packTex, type, spatialMode) {
  let best = null;
  for (const slot of (typeSlots || [])) {
    const evidence = getSlotAnchorEvidence(slot, packTex, type, spatialMode);
    if (evidence && (!best || evidence.final > best.final)) best = evidence;
  }
  return best;
}

function buildRefinementValues(currentScore, packData, slotsByType, cachedEvidence) {
  const evidence = cachedEvidence || {};
  const values = [];
  for (const feature of SBI_REFINEMENT_FEATURES) {
    if (!feature.type) {
      values.push(currentScore || 0);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(evidence, feature.type)) {
      const includeColor = SBI_REFINEMENT_FEATURES.some(row =>
        row.type === feature.type && ['color', 'spatial', 'shape', 'direction'].includes(row.metric)
      );
      evidence[feature.type] = packData && packData[feature.type]
        ? getBestTypeRefinementEvidence(slotsByType[feature.type], packData[feature.type], feature.type, includeColor ? 'color' : 'none')
        : null;
    }
    const row = evidence[feature.type];
    values.push(row && isFinite(row[feature.metric]) ? row[feature.metric] : 0);
  }
  return { evidence, values };
}

function applyBoundedTextureRefinement(results, packEntries, slots, slotTypes, details, runMetrics, evidenceCache) {
  if (!results || results.length < 2 || !packEntries || !packEntries.length) return results;
  const started = nowMs();
  const currentRows = [...results].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const finalistRows = currentRows.slice(0, SBI_REFINEMENT_RESULT_LIMIT);
  const finalists = new Set(finalistRows.map(row => row.name));
  const currentScores = new Map(currentRows.map(row => [row.name, row.score]));
  const slotsByType = groupObservedSlotsByType(slots, slotTypes);
  const packsById = new Map(packEntries);
  const rows = finalistRows.map(({ name: groupId }) => {
    const packData = packsById.get(groupId) || {};
    const currentScore = currentScores.get(groupId) || 0;
    const cachedEvidence = evidenceCache && evidenceCache.get(groupId);
    const refinement = buildRefinementValues(currentScore, packData, slotsByType, cachedEvidence);
    if (evidenceCache && !cachedEvidence) evidenceCache.set(groupId, refinement.evidence);
    return { groupId, ...refinement };
  });

  const means = new Array(SBI_REFINEMENT_FEATURES.length).fill(0);
  const deviations = new Array(SBI_REFINEMENT_FEATURES.length).fill(1);
  for (let i = 0; i < means.length; i++) {
    for (const row of rows) means[i] += row.values[i];
    means[i] /= rows.length;
    let variance = 0;
    for (const row of rows) variance += (row.values[i] - means[i]) ** 2;
    deviations[i] = Math.sqrt(variance / rows.length) || 1;
  }

  const rankScores = new Map();
  for (const row of rows) {
    let rankScore = 0;
    for (let i = 0; i < SBI_REFINEMENT_FEATURES.length; i++) {
      rankScore += ((row.values[i] - means[i]) / deviations[i]) * SBI_REFINEMENT_FEATURES[i].weight;
    }
    rankScores.set(row.groupId, rankScore);
  }

  const refined = currentRows.filter(row => finalists.has(row.name));
  for (const row of refined) {
    const info = details[row.name];
    const rankScore = rankScores.get(row.name) || 0;
    if (info) {
      info.preRefinementScore = row.score;
      info.refinementScore = rankScore;
      info.finalScore = clamp01(0.5 + rankScore);
    }
    row.score = clamp01(0.5 + rankScore);
  }
  refined.sort((a, b) => {
    const scoreDiff = (rankScores.get(b.name) || 0) - (rankScores.get(a.name) || 0);
    return scoreDiff || a.name.localeCompare(b.name);
  });
  runMetrics.refinementCorpusCount = rows.length;
  runMetrics.refinementResultCount = refined.length;
  runMetrics.refinementMs = nowMs() - started;
  return refined;
}

function getBestFingerprintSlotSimilarity(slot, targetType, cache) {
  if (!slot || !targetType || !fingerprints || !fingerprints.packs) return 0;
  const key = `${slot.index}:${targetType}`;
  if (cache && Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
  const indexedNames = new Set();
  const bucketNames = getIndexCandidateNames(targetType, slot.features && slot.features.sig);
  const hashNames = getHashIndexCandidateNames(targetType, slot.features);
  if (bucketNames) for (const name of bucketNames) indexedNames.add(name);
  if (hashNames) for (const name of hashNames) indexedNames.add(name);
  const packRows = indexedNames.size >= 8
    ? [...indexedNames].map(name => fingerprints.packs[name]).filter(Boolean)
    : Object.values(fingerprints.packs);
  let best = 0;
  for (const packData of packRows) {
    if (!packData || !packData[targetType] || typeof packData[targetType].dhash !== 'string') continue;
    const sim = compareSlotToType(slot, packData[targetType], targetType);
    if (sim > best) best = sim;
  }
  if (cache) cache[key] = best;
  return best;
}

function isStrongFoodColor(sig) {
  return !!(sig && sig.yellowFrac >= 0.18 && sig.redFrac < 0.10 && sig.meanLum >= 96);
}

function isFoodLikeTailSignature(sig) {
  if (!sig) return false;
  const coolPotionStack = sig.blueFrac >= 0.22 && sig.coverage <= 0.30 && sig.meanB >= sig.meanG + 18 && sig.meanLum >= 88;
  if (coolPotionStack) return false;
  const warm = sig.meanR >= sig.meanB + 6 && sig.meanG >= sig.meanB - 2;
  return (
    (sig.yellowFrac >= 0.14 && sig.redFrac <= 0.16 && sig.meanLum >= 84) ||
    (sig.yellowFrac >= 0.09 && warm && sig.meanLum >= 82) ||
    (sig.yellowFrac >= 0.08 && sig.meanLum >= 94) ||
    (sig.yellowFrac >= 0.05 && sig.meanR >= sig.meanB + 10 && sig.meanLum >= 72) ||
    // Steak: brown-red, warm, low blue, moderate lightness
    (sig.meanR >= sig.meanB + 28 && sig.meanR >= sig.meanG + 10 && sig.meanLum >= 70 && sig.meanLum <= 160 && sig.blueFrac < 0.06)
  );
}

function isPotionLikeSignature(sig) {
  if (!sig) return false;
  const warmPotion = sig.redFrac >= 0.045 && sig.yellowFrac < 0.14;
  const coolPotion = sig.blueFrac >= 0.10 && sig.yellowFrac < 0.08 && sig.meanLum <= 108;
  const bottleShape = sig.coverage <= 0.74 && sig.mirrorFrac >= 0.26 && sig.bboxBottom >= 0.50;
  return bottleShape && (warmPotion || coolPotion || sig.edgeDarkFrac >= 0.10);
}

function inferPrimaryWeaponSlotType(slot, sig, cache) {
  if (!slot || slot.index !== 0 || !sig) return '';
  if (!fingerprints || !fingerprints.packs) return '';
  const dsBest = getBestFingerprintSlotSimilarity(slot, 'diamond_sword', cache);
  const epBest = getBestFingerprintSlotSimilarity(slot, 'ender_pearl', cache);
  const activity = clamp01(slot.activity || 0);
  const quality = slot.quality || 0;
  const swordLike = sig.coverage <= 0.52 && Math.abs(sig.rowSlope) >= 0.045 && sig.bboxTop <= 0.38 && sig.bboxBottom >= 0.50;
  const wideSwordLike = sig.coverage <= 0.74 && Math.abs(sig.rowSlope) >= 0.028 && sig.bboxTop <= 0.24 && sig.bboxBottom >= 0.68;
  const thinDarkSwordLike = sig.coverage <= 0.46 && Math.abs(sig.rowSlope) >= 0.020 && sig.bboxTop <= 0.46 && sig.bboxBottom >= 0.46 && sig.darkFrac >= 0.18;
  const blueWeaponLike = sig.blueFrac >= 0.18 || (sig.meanB > sig.meanR + 28 && sig.meanB > sig.meanG + 16);
  const strongHeldItem = activity >= 0.52 && quality >= 16;

  if ((swordLike || sig.blueFrac >= 0.03) && dsBest >= 0.40 && dsBest >= epBest - 0.02) return 'diamond_sword';
  if (thinDarkSwordLike && activity >= 0.28 && dsBest >= 0.24 && dsBest >= epBest - 0.12 && sig.yellowFrac < 0.10) return 'diamond_sword';
  if (strongHeldItem && (wideSwordLike || blueWeaponLike) && dsBest >= 0.28 && dsBest >= epBest - 0.08 && sig.yellowFrac < 0.12) return 'diamond_sword';
  if (activity >= 0.28 && quality >= 8 && blueWeaponLike && sig.darkFrac >= 0.18 && dsBest >= 0.22 && dsBest >= epBest - 0.14 && sig.yellowFrac < 0.10) return 'diamond_sword';
  if (epBest >= 0.56 && epBest > dsBest + 0.04 && sig.meanLum < 92) return 'ender_pearl';
  return '';
}

function inferMiddleConsumableSlotType(slot, sig, cache) {
  if (!slot || slot.index < 2 || slot.index > 7 || !sig) return '';
  if (!fingerprints || !fingerprints.packs) return '';
  const potionBest = getBestFingerprintSlotSimilarity(slot, 'splash_potion', cache);
  const steakBest = getBestFingerprintSlotSimilarity(slot, 'steak', cache);
  const carrotBest = getBestFingerprintSlotSimilarity(slot, 'golden_carrot', cache);
  const foodBest = Math.max(steakBest, carrotBest);
  const potionLike = isPotionLikeSignature(sig) || sig.redFrac >= 0.055 || (sig.meanR > sig.meanB + 4 && sig.meanR > sig.meanG - 2);
  const coolPotionStack = sig.coverage <= 0.30 && sig.blueFrac >= 0.22 && sig.meanB >= sig.meanG + 18 && sig.meanLum >= 88;
  const strongFoodColor = isStrongFoodColor(sig);
  const latePotionSlot = slot.index >= 5;
  const potionThreshold = latePotionSlot ? 0.30 : 0.28;
  const potionMargin = latePotionSlot ? 0.18 : 0.12;
  const potionLikeMargin = latePotionSlot ? 0.24 : 0.18;
  const foodMargin = latePotionSlot ? 0.18 : 0.12;

  if (coolPotionStack && potionBest >= 0.30 && potionBest >= foodBest - 0.40) return 'splash_potion';
  if (potionBest >= potionThreshold && (potionBest >= foodBest - potionMargin || (potionLike && !strongFoodColor && potionBest >= foodBest - potionLikeMargin))) return 'splash_potion';
  if (latePotionSlot && potionLike && !strongFoodColor && !isFoodLikeTailSignature(sig) && potionBest >= 0.24 && potionBest >= foodBest - 0.10) return 'splash_potion';
  if (foodBest >= 0.52 && foodBest > potionBest + foodMargin && strongFoodColor) return steakBest >= carrotBest ? 'steak' : 'golden_carrot';
  return '';
}

function inferTrailingConsumableSlotType(slot, sig, cache) {
  if (!slot || slot.index !== 8 || !sig) return '';
  if (!fingerprints || !fingerprints.packs) return '';
  const steakBest = getBestFingerprintSlotSimilarity(slot, 'steak', cache);
  const carrotBest = getBestFingerprintSlotSimilarity(slot, 'golden_carrot', cache);
  const potionBest = getBestFingerprintSlotSimilarity(slot, 'splash_potion', cache);
  const foodType = steakBest >= carrotBest ? 'steak' : 'golden_carrot';
  const foodBest = Math.max(steakBest, carrotBest);
  const strongFoodColor = isStrongFoodColor(sig);
  const looksLikeFood = isFoodLikeTailSignature(sig);
  const potionLike = isPotionLikeSignature(sig) || sig.redFrac >= 0.05 || (sig.meanR > sig.meanB + 6 && sig.meanR > sig.meanG - 2);
  const weakFoodColor = sig.yellowFrac >= 0.04 && sig.meanR >= sig.meanB + 8 && sig.meanLum >= 70;
  // Steak-specific: brown-red, low blue, warm tone
  const steakLike = sig.meanR >= sig.meanB + 28 && sig.meanR >= sig.meanG + 10 && sig.blueFrac < 0.06 && sig.meanLum >= 70 && sig.meanLum <= 160;

  if (foodBest >= 0.78 && foodBest >= potionBest + 0.16) return foodType;
  // Steak color takes precedence over weak potion match
  if (steakLike && steakBest >= 0.40 && steakBest >= potionBest - 0.10) return 'steak';
  if (!strongFoodColor && !steakLike && potionBest >= 0.34 && (potionBest >= foodBest - 0.06 || (potionLike && potionBest >= foodBest - 0.12))) return 'splash_potion';
  if (foodBest >= 0.46 && strongFoodColor && (foodBest >= potionBest - 0.03 || looksLikeFood)) return foodType;
  if (foodBest >= 0.52 && weakFoodColor && foodBest >= potionBest - 0.08) return foodType;
  if (foodBest >= 0.58 && looksLikeFood && !potionLike) return foodType;
  if (potionLike && !looksLikeFood && !steakLike && potionBest >= 0.24) return 'splash_potion';
  return '';
}

function inferLogoPearlSlotType(slot, sig, cache) {
  if (!slot || slot.index !== 1 || !sig) return '';
  if (!fingerprints || !fingerprints.packs) return '';
  const activity = clamp01(slot.activity || 0);
  if (activity < 0.60) return '';
  if (sig.redFrac >= 0.06 || sig.yellowFrac >= 0.08) return '';
  if (sig.coverage < 0.40 || sig.coverage > 0.82) return '';
  if (sig.meanLum < 70 || sig.meanLum > 125) return '';
  const maxRgb = Math.max(sig.meanR, sig.meanG, sig.meanB);
  const minRgb = Math.min(sig.meanR, sig.meanG, sig.meanB);
  const neutralLogo = Math.abs(sig.meanR - sig.meanG) <= 20 && sig.meanB >= sig.meanR - 5;
  if (!neutralLogo && maxRgb - minRgb > 38) return '';
  const epBest = getBestFingerprintSlotSimilarity(slot, 'ender_pearl', cache);
  const dsBest = getBestFingerprintSlotSimilarity(slot, 'diamond_sword', cache);
  if (epBest >= 0.28 || epBest >= dsBest - 0.06) return 'ender_pearl';
  return '';
}

function inferCanonicalPvPWeaponSlotType(slot, sig, inferredTypes, cache) {
  if (!slot || slot.index !== 0 || !sig) return '';
  const hasPearl = inferredTypes[1] === 'ender_pearl';
  const totalPotionCount = inferredTypes.slice(2, 9).filter(type => type === 'splash_potion').length;
  const tailType = inferredTypes[8];
  const hasConsumableTail = tailType === 'steak' || tailType === 'golden_carrot' || tailType === 'splash_potion' || tailType === 'none';
  const activity = clamp01(slot.activity || 0);
  const variance = slot.variance || 0;
  const strongPotionLayout = totalPotionCount >= 5 || (totalPotionCount >= 3 && tailType !== 'ender_pearl');
  if (!hasPearl || totalPotionCount < 3 || !hasConsumableTail) return '';
  if (activity < (strongPotionLayout ? 0.24 : 0.38) || variance < (strongPotionLayout ? 260 : 420) || sig.n <= 0) return '';
  if (sig.yellowFrac >= 0.16 || sig.redFrac >= 0.24) return '';
  const dsBest = getBestFingerprintSlotSimilarity(slot, 'diamond_sword', cache);
  const epBest = getBestFingerprintSlotSimilarity(slot, 'ender_pearl', cache);
  const swordLike = sig.coverage <= 0.68
    && Math.abs(sig.rowSlope) >= 0.012
    && sig.bboxTop <= 0.46
    && sig.bboxBottom >= 0.42;
  const wideSwordLike = sig.coverage <= 0.76
    && Math.abs(sig.rowSlope) >= 0.028
    && sig.bboxTop <= 0.24
    && sig.bboxBottom >= 0.68;
  const thinDarkSwordLike = sig.coverage <= 0.50
    && Math.abs(sig.rowSlope) >= 0.015
    && sig.bboxTop <= 0.54
    && sig.bboxBottom >= 0.42
    && sig.darkFrac >= 0.16;
  const blueWeaponLike = sig.blueFrac >= 0.18 || (sig.meanB > sig.meanR + 28 && sig.meanB > sig.meanG + 16);
  if (dsBest >= 0.24 || dsBest >= epBest - (strongPotionLayout ? 0.16 : 0.10) || swordLike || thinDarkSwordLike || (activity >= 0.75 && (wideSwordLike || blueWeaponLike))) return 'diamond_sword';
  if (strongPotionLayout && dsBest >= 0.16 && blueWeaponLike && (swordLike || thinDarkSwordLike || Math.abs(sig.rowSlope) >= 0.012)) return 'diamond_sword';
  return '';
}

function applyCanonicalMiddlePotionSlots(orderedSlots, inferredTypes, cache) {
  if (!Array.isArray(orderedSlots) || !Array.isArray(inferredTypes)) return;
  const hasPearl = inferredTypes[1] === 'ender_pearl';
  const tailType = inferredTypes[8];
  const hasConsumableTail = tailType === 'steak' || tailType === 'golden_carrot' || tailType === 'splash_potion' || tailType === 'none';
  if (!hasPearl || !hasConsumableTail) return;
  const candidates = [];

  for (const slotIndex of [2, 3, 4, 5, 6, 7]) {
    const slot = orderedSlots.find(entry => entry && entry.index === slotIndex);
    const sig = slot && slot.features ? slot.features.sig : null;
    if (!slot || !sig) continue;
    const activity = clamp01(slot.activity || 0);
    const potionBest = getBestFingerprintSlotSimilarity(slot, 'splash_potion', cache);
    const steakBest = getBestFingerprintSlotSimilarity(slot, 'steak', cache);
    const carrotBest = getBestFingerprintSlotSimilarity(slot, 'golden_carrot', cache);
    const foodBest = Math.max(steakBest, carrotBest);
    const strongFoodColor = isStrongFoodColor(sig);
    const looksLikeFood = isFoodLikeTailSignature(sig);
    const potionLike = isPotionLikeSignature(sig) || sig.redFrac >= 0.05 || (sig.meanR > sig.meanB + 4 && sig.meanR > sig.meanG - 2);
    const coolPotionStack = sig.coverage <= 0.30 && sig.blueFrac >= 0.22 && sig.meanB >= sig.meanG + 18 && sig.meanLum >= 88;
    const minActivity = slotIndex >= 5 ? 0.42 : 0.34;
    const closeness = slotIndex >= 5 ? 0.30 : 0.20;
    if (activity < minActivity) continue;
    if (strongFoodColor || (!coolPotionStack && looksLikeFood && foodBest > potionBest + 0.08)) continue;
    if (potionBest < 0.20 && !potionLike && !coolPotionStack && sig.redFrac < 0.03) continue;
    candidates.push({ slotIndex, potionBest, foodBest, potionLike, closeness, coolPotionStack });
  }
  const lateCandidateCount = candidates.filter(candidate => candidate.slotIndex >= 5).length;
  if (candidates.length < 3 || lateCandidateCount < 2) return;
  for (const candidate of candidates) {
    if (candidate.potionBest >= candidate.foodBest - candidate.closeness || candidate.potionLike || candidate.coolPotionStack) {
      inferredTypes[candidate.slotIndex] = 'splash_potion';
    }
  }
}

function sharpenSimilarityScore(v) {
  const x = clamp01(v);
  return clamp01(1 / (1 + Math.exp(-12 * (x - 0.40))));
}

function inferDisplaySlotTypes(slots) {
  const out = new Array(9).fill('none');
  if (!slots || !slots.length) return out;

  const ordered = [...slots].sort((a, b) => a.index - b.index);
  const fingerprintScoreCache = {};
  for (const slot of ordered) {
    if (!slot || slot.index < 0 || slot.index > 8) continue;

    const activity = clamp01(slot.activity || 0);
    const variance = slot.variance || 0;
    if (activity < 0.22 || variance < 180) {
      out[slot.index] = 'none';
      continue;
    }

    const sig = slot.features && slot.features.sig;
    if (!sig || sig.n <= 0 || !isFinite(sig.meanLum) || !isFinite(sig.meanR) || !isFinite(sig.meanB)) {
      out[slot.index] = 'none';
      continue;
    }

    const blueStrong = (sig.meanB > sig.meanR + 35) && (sig.meanB > sig.meanG + 25);
    const compactBlue = blueStrong && (sig.n < 70 || sig.coverage < 0.22);
    const strongFoodColor = isStrongFoodColor(sig);

    // Food (GC / gapple both render as GC in the UI summary).
    if (strongFoodColor && (slot.index === 8 || sig.yellowFrac >= 0.22)) {
      out[slot.index] = 'golden_carrot';
      continue;
    }

    if (slot.index >= 2 && sig.redFrac >= 0.09 && sig.yellowFrac < 0.10) {
      out[slot.index] = 'splash_potion';
      continue;
    }

    if (slot.index === 0 && compactBlue) {
      out[slot.index] = 'diamond_sword';
      continue;
    }

    if (slot.index !== 0 && sig.redFrac < 0.05 && sig.yellowFrac < 0.08 && sig.n >= 24 &&
        sig.meanB > sig.meanR + 60 && sig.meanG > sig.meanR + 60 &&
        Math.abs(sig.meanG - sig.meanB) <= 40 && sig.meanG >= 110 && sig.meanB >= 110) {
      out[slot.index] = 'ender_pearl';
      continue;
    }

    if (slot.index !== 0 && sig.redFrac < 0.05 && sig.yellowFrac < 0.08 && (sig.n >= 70 || sig.coverage >= 0.22) &&
        (sig.meanLum < 80 || (sig.meanB > sig.meanR + 40 && sig.meanG > sig.meanR + 20))) {
      out[slot.index] = 'ender_pearl';
      continue;
    }

    const primaryWeaponType = inferPrimaryWeaponSlotType(slot, sig, fingerprintScoreCache);
    if (primaryWeaponType) {
      out[slot.index] = primaryWeaponType;
      continue;
    }

    const trailingConsumableType = inferTrailingConsumableSlotType(slot, sig, fingerprintScoreCache);
    if (trailingConsumableType) {
      out[slot.index] = trailingConsumableType;
      continue;
    }

    const middleConsumableType = inferMiddleConsumableSlotType(slot, sig, fingerprintScoreCache);
    if (middleConsumableType) {
      out[slot.index] = middleConsumableType;
      continue;
    }

    const logoPearlType = inferLogoPearlSlotType(slot, sig, fingerprintScoreCache);
    if (logoPearlType) {
      out[slot.index] = logoPearlType;
      continue;
    }

    // Health potions: red-heavy.
    if (slot.index < 2 && sig.redFrac >= 0.09 && sig.yellowFrac < 0.10) {
      out[slot.index] = 'splash_potion';
      continue;
    }

    // Small blue silhouettes are swords far more often than pearls.
    if (slot.index !== 0 && compactBlue) {
      out[slot.index] = 'diamond_sword';
      continue;
    }

    // Bright cyan/teal ender pearls with a small footprint (custom packs like
    // Tory v1 Revamp): R clearly below G and B, G ≈ B, both bright. Colour
    // signal alone is strong enough — no n/coverage gate.
    if (slot.index === 0 && sig.redFrac < 0.05 && sig.yellowFrac < 0.08 && sig.n >= 24 &&
        sig.meanB > sig.meanR + 60 && sig.meanG > sig.meanR + 60 &&
        Math.abs(sig.meanG - sig.meanB) <= 40 &&
        sig.meanG >= 110 && sig.meanB >= 110) {
      out[slot.index] = 'ender_pearl';
      continue;
    }

    // Ender pearl: dark + low warm colors, OR bright cyan/teal orb
    if (slot.index === 0 && sig.redFrac < 0.05 && sig.yellowFrac < 0.08 && (sig.n >= 70 || sig.coverage >= 0.22) &&
        (sig.meanLum < 80 || (sig.meanB > sig.meanR + 40 && sig.meanG > sig.meanR + 20))) {
      out[slot.index] = 'ender_pearl';
      continue;
    }

    if (sig.n < 70) {
      out[slot.index] = blueStrong ? 'diamond_sword' : 'none';
      continue;
    }

    // Fallback: for larger silhouettes, prefer pearls over swords.
    out[slot.index] = blueStrong ? 'ender_pearl' : 'none';
  }

  const slot0 = ordered.find(slot => slot && slot.index === 0);
  const slot0Sig = slot0 && slot0.features ? slot0.features.sig : null;
  if (out.slice(2, 8).filter(type => type === 'splash_potion').length < 3) {
    applyCanonicalMiddlePotionSlots(ordered, out, fingerprintScoreCache);
  }
  if (out[0] === 'none') {
    const canonicalWeaponType = inferCanonicalPvPWeaponSlotType(slot0, slot0Sig, out, fingerprintScoreCache);
    if (canonicalWeaponType) out[0] = canonicalWeaponType;
  }

  return out;
}

// --- Matching ---

function getCandidateFullScoreLimit(packCount) {
  return Math.min(SBI_FULL_SCORE_LIMIT, Math.max(1, packCount || 0));
}

function scoreCoarseAnchorMatch(packData, anchorSlots) {
  let weighted = 0, weights = 0;
  for (const anchor of (anchorSlots || [])) {
    const type = anchor.type;
    const tex = packData && packData[type];
    if (!tex) continue;
    const slot = anchor.slot;
    const activity = clamp01(slot.activity || 0);
    const quality = clamp01((slot.quality || 0) / 18);
    const positionBonus = slot.index <= 1 ? 1.35 : 1.0;
    const w = (SBI_SCORE_WEIGHTS.type[type] || 1) * positionBonus * (0.55 + activity) * (0.70 + quality * 0.40);
    weighted += compareSlotToType(slot, tex, type) * w;
    weights += w;
  }
  return weights ? weighted / weights : 0;
}

function selectCandidateFullScoreEntries(allEntries, candidatePlan, metrics) {
  if (!candidatePlan || !candidatePlan.names || !candidatePlan.names.size) return allEntries;
  const candidateEntries = allEntries.filter(([name]) => candidatePlan.names.has(name));
  const packCount = allEntries.length;
  metrics.candidatePrefilterCount = candidateEntries.length;
  metrics.candidateSignalCount = candidatePlan.signalCount || 0;
  metrics.candidateByType = candidatePlan.byType || {};
  metrics.candidateMode = 'prefilter';
  if (!candidateEntries.length) return allEntries;

  const limit = getCandidateFullScoreLimit(packCount);
  if (candidateEntries.length <= limit) {
    metrics.coarseScoreCount = 0;
    return candidateEntries;
  }

  const coarseStart = nowMs();
  const rows = candidateEntries.map(entry => {
    const name = entry[0];
    const vote = candidatePlan.votes && candidatePlan.votes[name] ? candidatePlan.votes[name] : 0;
    return { entry, vote, score: scoreCoarseAnchorMatch(entry[1], candidatePlan.anchorSlots) };
  }).sort((a, b) => b.score - a.score || b.vote - a.vote || a.entry[0].localeCompare(b.entry[0]));

  const selected = new Set();
  const voteRows = [...rows].sort((a, b) => b.vote - a.vote || b.score - a.score);
  for (const row of voteRows.slice(0, Math.min(32, limit))) selected.add(row.entry[0]);
  for (const row of rows) {
    if (selected.size >= limit) break;
    selected.add(row.entry[0]);
  }

  metrics.coarseScoreCount = rows.length;
  metrics.coarseSelectedCount = selected.size;
  metrics.coarseMs = nowMs() - coarseStart;
  return allEntries.filter(([name]) => selected.has(name));
}

// Coarse ranking decides which groups ever reach the full scorer, so it has to be
// the strongest cheap signal available. Palette agreement after removing the
// empty-slot plate is that signal: it is what separates recolours across the
// corpus, and it costs one sparse intersection per slot per group.
function scoreGlobalCoarseMatch(groupId, packData, slotProfiles) {
  const profiles = slotProfiles || [];
  if (!profiles.length){
    return null;
  }
  let total = 0;
  let counted = 0;
  for (const profile of profiles) {
    let best = 0;
    for (const type of SLOT_ITEM_TYPES) {
      const surface = packData && packData[type];
      if (!surface || typeof surface.pix !== 'string') continue;
      const cells = surface.__paletteCells
        || (surface.__paletteCells = paletteSparse(base64ToBytes(surface.pix)));
      const value = sparseIntersection(profile, cells);
      if (value > best) best = value;
    }
    total += best;
    counted++;
  }
  return counted ? total / counted : null;
}

// Per-slot palettes with the empty-slot plate removed, computed once per match.
function buildSlotProfiles(slots) {
  const live = selectLiveSlots(slots);
  if (!live.length) return [];
  const views = live.map(slot => slotViewAt16(slot.features.pix));
  const plate = views.length >= 3 && views.every(Boolean) ? medianDeviationPlate(views) : null;
  const plateCells = plate ? paletteSparse(plate) : null;
  return views.map(view => {
    const raw = paletteSparse(view);
    return plateCells ? subtractPlateSparse(raw, plateCells, PLATE_SUBTRACTION) : raw;
  });
}

function selectGlobalCoarseEntries(allEntries, anchorSlots, widgetFeatures, hudFeatures, previousResults, metrics, mode, slotProfiles) {
  const hasSignals = slotProfiles && slotProfiles.length;
  if (!hasSignals) return allEntries;
  const started = nowMs();
  const hasPreviousResults = previousResults && previousResults.length;
  const limit = hasPreviousResults ? SBI_REFINEMENT_RESULT_LIMIT : getCandidateFullScoreLimit(allEntries.length);
  const selected = new Set();
  const retainedLimit = hasPreviousResults ? Math.min(SBI_FALLBACK_RETAINED_RESULT_LIMIT, limit) : 0;
  for (const row of (previousResults || []).slice(0, retainedLimit)) selected.add(row.name);

  const needed = Math.max(0, limit - selected.size);
  const topRows = [];
  const compareRows = (a, b) => (b.score || 0) - (a.score || 0) || a.entry[0].localeCompare(b.entry[0]);
  for (const entry of allEntries) {
    const row = {
      entry,
      score: scoreGlobalCoarseMatch(entry[0], entry[1], slotProfiles),
    };
    if (!needed || selected.has(entry[0])) continue;
    let low = 0;
    let high = topRows.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (compareRows(row, topRows[middle]) < 0) high = middle;
      else low = middle + 1;
    }
    if (low >= needed) continue;
    topRows.splice(low, 0, row);
    if (topRows.length > needed) topRows.pop();
  }
  for (const row of topRows) selected.add(row.entry[0]);
  metrics.candidateMode = mode;
  metrics.globalCoarseCount = allEntries.length;
  metrics.globalCoarseSelectedCount = selected.size;
  metrics.globalCoarseMs = (metrics.globalCoarseMs || 0) + (nowMs() - started);
  return allEntries.filter(([groupId]) => selected.has(groupId));
}

function shouldRunFullScoreFallback(results, metrics, totalPackCount, details) {
  if (_forceGlobalFallbackForTest) return (metrics.fullScoreCount || 0) < totalPackCount;
  if (!metrics || metrics.candidateMode === 'all') return false;
  if ((metrics.fullScoreCount || 0) >= totalPackCount) return false;
  const ranked = [...(results || [])].sort((a, b) => {
    const aInfo = details && details[a.name];
    const bInfo = details && details[b.name];
    const aScore = aInfo && isFinite(aInfo.preRefinementScore) ? aInfo.preRefinementScore : a.score;
    const bScore = bInfo && isFinite(bInfo.preRefinementScore) ? bInfo.preRefinementScore : b.score;
    return bScore - aScore;
  });
  if (ranked.length < 10) return true;
  const getScore = row => {
    const info = row && details && details[row.name];
    return info && isFinite(info.preRefinementScore) ? info.preRefinementScore : (row && isFinite(row.score) ? row.score : 0);
  };
  const top1 = getScore(ranked[0]);
  const top2 = getScore(ranked[1]);
  if (top1 < SBI_CANDIDATE_FALLBACK_MIN_SCORE) return true;
  return (top1 - top2) < SBI_CANDIDATE_FALLBACK_MARGIN;
}

function expandGroupedOutput(output, metrics) {
  const results = [];
  const details = {};
  for (const row of (output.results || [])) {
    const groupId = row.name;
    const members = getGroupMembers(groupId);
    const groupDetails = output.details[groupId] || {};
    for (const member of members) {
      results.push({ ...row, name: member, groupId });
      details[member] = { ...groupDetails, groupId, groupMembers: members };
    }
  }
  metrics.expandedResultCount = results.length;
  return { results, slotTypes: output.slotTypes, details };
}

// Palette matching: a pack's identity lives in its colour scheme far more than in
// its edge layout, because every PvP pack draws the same five items. The pack side
// derives 12-cube RGB histograms from the already-shipped pixel payloads, so no
// fingerprint regeneration is required; the query side uses the extracted slot
// pixels. Alpha-masked, so transparent padding cannot vote.
// 24 bins per axis: fine enough to separate near-identical recolours of the same
// item, coarse enough to survive screenshot gamma and JPEG drift.
const PALETTE_BINS = 24;
const PALETTE_MIN_COVERAGE = 0.02;
// Share of the score that comes from pixel agreement; palette carries the rest.
const SPATIAL_RERANK_WEIGHT = 0.15;
// Weight of the legacy composite inside the final score. The palette ranking is
// the validated signal; the composite only breaks near-ties.
const LEGACY_COMPOSITE_WEIGHT = 0.25;
// Pixel reranking is a tie-breaker, so it only runs on this many palette leaders.
const SPATIAL_RERANK_SHORTLIST = 200;
// How much of the empty-slot plate to subtract from a slot's palette before
// matching. The plate dominates the histogram, so removing it exposes the item.
const PLATE_SUBTRACTION = 0.7;
let _packPalettes = null;

// Sparse form of a palette histogram: only non-empty cells. A 16x16 slot holds at
// most 256 distinct pixels, so intersecting sparse entries is orders of magnitude
// cheaper than walking all bins^3 cells, and yields the same number.
function paletteSparse(pixels, bins) {
  const size = bins || PALETTE_BINS;
  const cells = new Map();
  let opaque = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 64) continue;
    const r = Math.min(size - 1, pixels[i] * size >> 8);
    const g = Math.min(size - 1, pixels[i + 1] * size >> 8);
    const b = Math.min(size - 1, pixels[i + 2] * size >> 8);
    const key = (r * size + g) * size + b;
    cells.set(key, (cells.get(key) || 0) + 1);
    opaque++;
  }
  if (opaque) for (const [key, count] of cells) cells.set(key, count / opaque);
  return cells;
}

function sparseIntersection(a, b) {
  let sum = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [key, value] of small) {
    const other = large.get(key);
    if (other !== undefined) sum += value < other ? value : other;
  }
  return sum;
}

function subtractPlateSparse(sparse, plateCells, keep) {
  const out = new Map();
  let sum = 0;
  for (const [key, value] of sparse) {
    const residual = value - (plateCells.get(key) || 0) * keep;
    if (residual > 0) { out.set(key, residual); sum += residual; }
  }
  if (sum > 0) for (const [key, value] of out) out.set(key, value / sum);
  return out;
}

function paletteHistogram(pixels, bins) {
  const size = bins || PALETTE_BINS;
  const hist = new Float32Array(size * size * size);
  let opaque = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 64) continue;
    const r = Math.min(size - 1, pixels[i] * size >> 8);
    const g = Math.min(size - 1, pixels[i + 1] * size >> 8);
    const b = Math.min(size - 1, pixels[i + 2] * size >> 8);
    hist[(r * size + g) * size + b]++;
    opaque++;
  }
  if (opaque) for (let i = 0; i < hist.length; i++) hist[i] /= opaque;
  return hist;
}

// A slot's histogram is dominated by the empty-slot plate, which is identical for
// every pack. Subtracting it leaves the item's own colours, which is the part that
// identifies a pack.
function subtractPlateFromHistogram(hist, plate, keep) {
  const out = new Float32Array(hist.length);
  let sum = 0;
  for (let i = 0; i < hist.length; i++) {
    const value = hist[i] - plate[i] * keep;
    if (value > 0) { out[i] = value; sum += value; }
  }
  if (sum > 0) for (let i = 0; i < out.length; i++) out[i] /= sum;
  return out;
}

function paletteIntersection(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] < b[i] ? a[i] : b[i];
  return sum;
}

function slotPixelCoverage(pixels) {
  if (!pixels || !pixels.length) return 0;
  let opaque = 0;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] >= 64) opaque++;
  return opaque / (pixels.length / 4);
}

// An empty hotbar slot is fully opaque plate, so coverage alone never recognises
// it. What does distinguish it is that every empty slot is pixel-identical to
// every other empty slot: the median slot image IS the empty plate, and slots
// that deviate from it are the ones holding items.
const EMPTY_SLOT_DEVIATION = 0.02;

function slotViewAt16(pixels) {
  if (!pixels) return null;
  const size = Math.sqrt(pixels.length / 4);
  if (!Number.isInteger(size) || size < 4) return null;
  return size === 16 ? pixels : resizeRgbaNearest(pixels, size, size, 16, 16);
}

function medianDeviationPlate(views) {
  const length = views[0].length;
  const column = new Array(views.length);
  const median = new Uint8ClampedArray(length);
  for (let i = 0; i < length; i++) {
    for (let k = 0; k < views.length; k++) column[k] = views[k][i];
    column.sort((x, y) => x - y);
    median[i] = column[Math.floor(views.length / 2)];
  }
  return median;
}

function medianDeviation(views) {
  if (!views.length) return [];
  const length = views[0].length;
  const median = medianDeviationPlate(views);
  const perPixel = length / 4 * 3 * 255;
  return views.map(view => {
    let sum = 0;
    for (let i = 0; i < length; i += 4) {
      sum += Math.abs(view[i] - median[i]) + Math.abs(view[i + 1] - median[i + 1]) + Math.abs(view[i + 2] - median[i + 2]);
    }
    return sum / perPixel;
  });
}

function selectLiveSlots(slots) {
  const list = (slots || []).filter(slot => slot && slot.features && slot.features.pix);
  if (!list.length) return [];
  if (list.length < 3) return list;
  const views = list.map(slot => slotViewAt16(slot.features.pix));
  const deviations = medianDeviation(views.filter(Boolean));
  const live = list.filter((slot, index) => (deviations[index] || 0) > EMPTY_SLOT_DEVIATION);
  // Nine identical items would make the median an item and drop everything;
  // fall back to the full list rather than scoring nothing.
  return live.length ? live : list;
}

function buildPackPalettes() {
  if (_packPalettes) return _packPalettes;
  const table = new Map();
  for (const [groupId, surfaces] of Object.entries(fingerprints.packs || {})) {
    const perType = {};
    for (const type of SLOT_ITEM_TYPES) {
      const surface = surfaces[type];
      if (!surface || typeof surface.pix !== 'string') continue;
      const bytes = base64ToBytes(surface.pix);
      perType[type] = { cells: paletteSparse(bytes), pix: bytes, surface };
    }
    if (Object.keys(perType).length) table.set(groupId, perType);
  }
  _packPalettes = table;
  return table;
}

function resetPackPalettes() {
  _packPalettes = null;
}

// Score every group by how strongly its colour scheme explains the observed slots.
// Each live slot claims its single best type, so a slot cannot vote for a type it
// does not look like; the group score averages those claims, which keeps one lucky
// slot from carrying a whole pack.
// Score every group by how well its item colours explain the observed live slots.
// Each live slot claims its single best type, so a slot cannot vote for a type it
// does not resemble; the group score averages those claims plus a small share of
// pixel agreement, which breaks ties between recolours of the same item.
function scorePaletteCandidates(slots) {
  const table = buildPackPalettes();
  const liveSlots = selectLiveSlots(slots);
  if (!liveSlots.length) return { scores: new Map(), liveSlotCount: 0 };

  const views = liveSlots.map(slot => slotViewAt16(slot.features.pix));
  const plate = views.length >= 3 && views.every(Boolean) ? medianDeviationPlate(views) : null;
  const plateCells = plate ? paletteSparse(plate) : null;
  const slotHists = views.map(view => {
    const raw = paletteSparse(view || liveSlots[0].features.pix);
    return plateCells ? subtractPlateSparse(raw, plateCells, PLATE_SUBTRACTION) : raw;
  });

  // Pass 1: palette-only over every group. Cheap enough to cover the whole corpus.
  const palette = new Map();
  const bestTypes = new Map();
  for (const [groupId, perType] of table) {
    let total = 0;
    const types = [];
    for (let index = 0; index < liveSlots.length; index++) {
      let best = 0;
      let bestType = null;
      for (const type of SLOT_ITEM_TYPES) {
        const reference = perType[type];
        if (!reference) continue;
        const value = sparseIntersection(slotHists[index], reference.cells);
        if (value > best) { best = value; bestType = type; }
      }
      total += best;
      types.push(bestType);
    }
    palette.set(groupId, total / liveSlots.length);
    bestTypes.set(groupId, types);
  }

  // Pass 2: pixel agreement only for the groups the palette already liked. Running
  // it over the whole corpus costs seconds per image and cannot rescue a group the
  // palette ranked far down.
  const shortlist = [...palette.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, SPATIAL_RERANK_SHORTLIST);

  const scores = new Map();
  for (const [groupId, paletteScore] of shortlist) {
    const perType = table.get(groupId);
    const types = bestTypes.get(groupId);
    let spatialSum = 0;
    for (let index = 0; index < liveSlots.length; index++) {
      const type = types[index];
      const entry = type && perType[type];
      if (!entry || !entry.surface) continue;
      const spatial = compareSpatial(liveSlots[index].features, entry.surface);
      if (spatial != null) spatialSum += spatial;
    }
    const spatialMean = spatialSum / liveSlots.length;
    scores.set(groupId, paletteScore * (1 - SPATIAL_RERANK_WEIGHT) + spatialMean * SPATIAL_RERANK_WEIGHT);
  }
  // Full portrait: every group ranked by palette alone. Callers that need a total
  // ordering (result presentation) use this; `scores` carries the shortlist that
  // also saw pixel agreement.
  return { scores, palette, liveSlotCount: liveSlots.length };
}


function matchPacks(slots, widgetFeatures, hudFeatures) {
  if (!slots.length) return { results: [], slotTypes: [], details: {} };
  const matchStart = nowMs();
  const inferenceStart = nowMs();
  const displaySlotTypes = inferDisplaySlotTypes(slots);
  const displayTypeCounts = countDisplaySlotTypes(displaySlotTypes);
  // Empty slots are pixel-identical plates; keeping them in the average dilutes
  // every pack equally and lets the plate colour vote.
  const liveSlotIndexes = new Set(selectLiveSlots(slots).map(slot => slot.index));
  const inferenceMs = nowMs() - inferenceStart;
  const allPackEntries = Object.entries(fingerprints.packs);
  const metrics = {
    packCount: fingerprints && fingerprints._meta ? fingerprints._meta.packCount : allPackEntries.length,
    groupCount: allPackEntries.length,
    candidateMode: 'all',
    candidatePrefilterCount: null,
    candidateSignalCount: 0,
    candidateByType: {},
    coarseScoreCount: 0,
    coarseSelectedCount: 0,
    coarseMs: 0,
    globalCoarseCount: 0,
    globalCoarseSelectedCount: 0,
    globalCoarseMs: 0,
    fullScoreCount: allPackEntries.length,
    fallback: false,
    inferenceMs,
    runs: [],
  };

  const candidateStart = nowMs();
  const slotProfiles = buildSlotProfiles(slots);
  // The palette ranking is the validated signal (see .docs/SBI_SEARCH.md), so it
  // both selects candidates and orders the final results.
  const paletteScores = scorePaletteCandidates(slots).scores;
  const anchorSlots = getAnchorSlotsByType(slots, displaySlotTypes);
  // The palette profile decides the candidate set: the dhash/signature prefilter
  // this replaced ranked genuinely different items as similar and dropped the
  // right group before it could be scored.
  const fullScoreEntries = selectGlobalCoarseEntries(
    allPackEntries, anchorSlots, widgetFeatures, hudFeatures, [], metrics, 'global-initial', slotProfiles
  );
  metrics.candidateGroupIds = fullScoreEntries.map(([groupId]) => groupId);
  metrics.candidatePlanningMs = nowMs() - candidateStart;

  const fullScoreBaseCache = new Map();
  const refinementEvidenceCache = new Map();
  const widgetScoreCache = new Map();
  const runFullScore = (packEntries, label) => {
    const runStart = nowMs();
    const ITEM_TYPES = SLOT_ITEM_TYPES;
    const TYPE_WEIGHT = SBI_SCORE_WEIGHTS.type;
    const results = [];
    const details = {};
    const scoredRows = [];
    const hasPearlAnchor = !!displayTypeCounts.ender_pearl;
    const runMetrics = {
      label,
      packCount: packEntries.length,
      scoreEvaluations: 0,
      scoreCacheHits: 0,
      widgetMs: 0,
      scoreMs: 0,
      rankMs: 0,
      totalMs: 0,
    };
    metrics.runs.push(runMetrics);
    metrics.fullScoreMode = label;
    const runGroupIds = packEntries.map(entry => entry[0]);
    metrics.fullScoreGroupIds = [...new Set([...(metrics.fullScoreGroupIds || []), ...runGroupIds])];
    metrics.fullScoreCount = metrics.fullScoreGroupIds.length;
    metrics.fullScoreMembers = metrics.fullScoreGroupIds.flatMap(getGroupMembers);

    let maxWidgetSim = 0;
    const widgetSimCache = {};
    const widgetStart = nowMs();
    if (widgetFeatures) {
      for (const [packName, packData] of packEntries) {
        if (!packData.hotbar_widget) continue;
        let sim = widgetScoreCache.get(packName);
        if (sim == null) {
          sim = compareWidget(widgetFeatures, packData.hotbar_widget);
          widgetScoreCache.set(packName, sim);
        }
        widgetSimCache[packName] = sim;
        if (sim > maxWidgetSim) maxWidgetSim = sim;
      }
    }
    runMetrics.widgetMs = nowMs() - widgetStart;

    const scoreStart = nowMs();
    for (const [packName, packData] of packEntries) {
      const cachedBase = fullScoreBaseCache.get(packName);
      if (cachedBase) {
        runMetrics.scoreCacheHits++;
        const info = { ...cachedBase.info };
        if (maxWidgetSim > 0.75 && info.widgetScore < 0.55) {
          info.rawScore = clamp01(info.rawScore - 0.075);
        }
        details[packName] = info;
        if (cachedBase.canRank) scoredRows.push({ name: packName, info });
        continue;
      }
      runMetrics.scoreEvaluations++;
      let slotWeighted = 0, slotWeights = 0;
      let slotPenalty = 0, certaintySum = 0;
      let activeSlots = 0, strongSlots = 0;
      let widgetSim = 0, healthSim = 0, hungerSim = 0, armorSim = 0;
      const perTypeScores = {};
      const slotBreakdown = new Array(9).fill(null);
      const topSlotContribs = [];

      for (const slot of slots) {
        if (!liveSlotIndexes.has(slot.index)) continue;
        const activity = clamp01(slot.activity || 0);
        const targetType = displaySlotTypes[slot.index] || 'none';
        const baseEntry = {
          index: slot.index,
          inferredType: targetType,
          activity,
          quality: slot.quality || 0,
          variance: slot.variance || 0,
          score: null,
          altBest: null,
          certainty: null,
        };
        slotBreakdown[slot.index] = baseEntry;

        if (activity < 0.18) continue;
        let forceType = null, forceTypeW = 0;
        let forceSim = 0;
        if (targetType === 'none' && activity >= 0.60) {
          let best = 0;
          for (const t of ITEM_TYPES) {
            const tw = TYPE_WEIGHT[t] || 0;
            if (tw <= 0 || !packData[t]) continue;
            const s = compareSlotToType(slot, packData[t], t);
            const score = s * tw;
            if (score > best) { best = score; forceType = t; forceTypeW = tw; forceSim = s; }
          }
          if (best < 0.02 || forceSim < 0.08) { forceType = null; forceTypeW = 0; forceSim = 0; }
        }
        const effectiveType = targetType !== 'none' ? targetType : forceType;
        if (!effectiveType) continue;
        const isFallback = !!(forceType && targetType === 'none');
        const typeW = isFallback ? forceTypeW * 0.75 : (TYPE_WEIGHT[effectiveType] || 0);
        if (typeW <= 0) continue;
        const targetTex = packData[effectiveType];
        if (!targetTex) continue;

        const sim = compareSlotToType(slot, targetTex, effectiveType);
        const shortKey = effectiveType === 'steak' || effectiveType === 'golden_carrot' ? 'SK/GC' :
          effectiveType === 'diamond_sword' ? 'DS' : effectiveType === 'ender_pearl' ? 'EP' :
          effectiveType === 'splash_potion' ? 'HL' : null;
        if (shortKey && (!perTypeScores[shortKey] || sim > perTypeScores[shortKey])) perTypeScores[shortKey] = sim;
        let altBest = 0;
        for (const type of ITEM_TYPES) {
          if (type === effectiveType) continue;
          if ((TYPE_WEIGHT[type] || 0) <= 0) continue;
          if (!packData[type]) continue;
          altBest = Math.max(altBest, compareSlotToType(slot, packData[type], type));
        }

        activeSlots++;
        const certainty = Math.max(0, sim - altBest);
        slotBreakdown[slot.index] = {
          index: slot.index,
          inferredType: effectiveType,
          activity,
          quality: slot.quality || 0,
          variance: slot.variance || 0,
          score: sim,
          altBest,
          certainty,
        };
        const qualityNorm = clamp01((slot.quality || 0) / 13);
        const repeatedTypeScale = getRepeatedTypeScale(effectiveType, displayTypeCounts);
        const positionBonus = (slot.index === 0 || slot.index === 1) ? 1.8 : 1.0;
        const w = typeW * repeatedTypeScale * positionBonus * (0.45 + 0.9 * activity) * (0.6 + 0.6 * qualityNorm);
        const evidenceSim = applyRarityToSimilarity(sim, packName, effectiveType);
        slotWeighted += evidenceSim * w;
        slotWeights += w;
        const contrib = { sim: evidenceSim, w, value: evidenceSim * w };
        let insertAt = topSlotContribs.length;
        while (insertAt > 0 && contrib.value > topSlotContribs[insertAt - 1].value) insertAt--;
        if (insertAt < 3) {
          topSlotContribs.splice(insertAt, 0, contrib);
          if (topSlotContribs.length > 3) topSlotContribs.length = 3;
        }
        certaintySum += certainty;
        const strongThreshold = getStrongMatchThreshold(effectiveType);
        if (sim >= strongThreshold) strongSlots++;
        else slotPenalty += (strongThreshold - sim) * (0.8 + activity * 0.7);
      }
      const slotScore = slotWeights ? (slotWeighted / slotWeights) : 0;
      let topSlotScore = 0;
      if (topSlotContribs.length) {
        const k = topSlotContribs.length;
        let tw = 0, tsum = 0;
        for (let i = 0; i < k; i++) { tsum += topSlotContribs[i].sim * topSlotContribs[i].w; tw += topSlotContribs[i].w; }
        topSlotScore = tw ? (tsum / tw) : 0;
      }
      const slotCoverage = activeSlots ? (strongSlots / activeSlots) : 0;
      const slotPenaltyNorm = activeSlots ? (slotPenalty / activeSlots) : 0;
      const slotCertainty = activeSlots ? (certaintySum / activeSlots) : 0;
      const blendedSlot = slotScore * 0.55 + topSlotScore * 0.45;
      let slotComposite = blendedSlot * (0.78 + 0.22 * slotCoverage) + Math.min(0.10, slotCertainty * 0.55);
      slotComposite -= slotPenaltyNorm * 0.30;
      slotComposite = clamp01(slotComposite);
      if (slotComposite < 0.15) {
        const reliability = clamp01(slotComposite / 0.20);
        slotComposite = slotComposite * reliability + 0.20 * (1 - reliability);
      }

      if (widgetFeatures && packData.hotbar_widget) {
        widgetSim = applyRarityToSimilarity(widgetSimCache[packName] || 0, packName, 'hotbar_widget');
      }

      let hudWeighted = 0, hudWeights = 0;
      if (hudFeatures) {
        healthSim = applyRarityToSimilarity(
          compareHudCells(hudFeatures.hearts, [packData.health_empty, packData.health_half, packData.health_full], 'health'),
          packName,
          ['health_empty', 'health_half', 'health_full']
        );
        hungerSim = applyRarityToSimilarity(
          compareHudCells(hudFeatures.hunger, [packData.hunger_empty, packData.hunger_half, packData.hunger_full], 'hunger'),
          packName,
          ['hunger_empty', 'hunger_half', 'hunger_full']
        );
        armorSim = applyRarityToSimilarity(
          compareHudCells(hudFeatures.armor, [packData.armor_empty, packData.armor_half, packData.armor_full], 'armor'),
          packName,
          ['armor_empty', 'armor_half', 'armor_full']
        );

        if (healthSim > 0) { hudWeighted += healthSim * SBI_SCORE_WEIGHTS.hud.health; hudWeights += SBI_SCORE_WEIGHTS.hud.health; }
        if (hungerSim > 0) { hudWeighted += hungerSim * SBI_SCORE_WEIGHTS.hud.hunger; hudWeights += SBI_SCORE_WEIGHTS.hud.hunger; }
        if (armorSim > 0) { hudWeighted += armorSim * SBI_SCORE_WEIGHTS.hud.armor; hudWeights += SBI_SCORE_WEIGHTS.hud.armor; }
      }

      const hudComposite = hudWeights ? (hudWeighted / hudWeights) : 0;
      let canRank = !!slotWeights && activeSlots >= 3;
      if (!canRank && slotWeights && activeSlots >= 2 && slotComposite >= 0.24 && (widgetSim >= 0.22 || hudComposite >= 0.40)) canRank = true;
      const criticalTypeMetrics = getCriticalTypeMetrics(perTypeScores, displayTypeCounts);
      let rawScore;
      if (hudWeights > 0) rawScore = slotComposite * SBI_SCORE_WEIGHTS.mix.slot + hudComposite * SBI_SCORE_WEIGHTS.mix.hud + widgetSim * SBI_SCORE_WEIGHTS.mix.widget;
      else rawScore = slotComposite * SBI_SCORE_WEIGHTS.mix.slotNoHud + widgetSim * SBI_SCORE_WEIGHTS.mix.widgetNoHud;

      rawScore += criticalTypeMetrics.score * 0.16;
      rawScore += slotCoverage * 0.08 + Math.min(0.04, slotCertainty * 0.65);
      rawScore -= criticalTypeMetrics.shortfall * 0.16;
      rawScore -= slotPenaltyNorm * 0.14;
      rawScore = clamp01(rawScore);

      const baseInfo = {
        finalScore: 0,
        rawScore,
        slotScore: slotComposite,
        widgetScore: widgetSim,
        healthScore: healthSim,
        hungerScore: hungerSim,
        armorScore: armorSim,
        slotCoverage,
        slotCertainty,
        criticalTypeScore: criticalTypeMetrics.score,
        criticalTypeShortfall: criticalTypeMetrics.shortfall,
        slotTypes: displaySlotTypes,
        perTypeScores,
        slotBreakdown,
      };
      fullScoreBaseCache.set(packName, { canRank, info: baseInfo });
      const info = { ...baseInfo };
      if (maxWidgetSim > 0.75 && widgetSim < 0.55) {
        info.rawScore = clamp01(info.rawScore - 0.075);
      }
      details[packName] = info;
      if (canRank) scoredRows.push({ name: packName, info });
    }
    runMetrics.scoreMs = nowMs() - scoreStart;
    metrics.fullScoreEvaluations = (metrics.fullScoreEvaluations || 0) + runMetrics.scoreEvaluations;
    metrics.fullScoreCacheHits = (metrics.fullScoreCacheHits || 0) + runMetrics.scoreCacheHits;

    const rankStart = nowMs();
    const bestEP = hasPearlAnchor
      ? scoredRows.reduce((best, row) => Math.max(best, (row.info.perTypeScores && row.info.perTypeScores.EP) || 0), 0)
      : 0;
    const bestDS = displayTypeCounts.diamond_sword
      ? scoredRows.reduce((best, row) => Math.max(best, (row.info.perTypeScores && row.info.perTypeScores.DS) || 0), 0)
      : 0;
    const bestHP = scoredRows.reduce((best, row) => Math.max(best, row.info.healthScore || 0), 0);
    const bestAnchors = { ds: bestDS, ep: bestEP, hp: bestHP, widget: maxWidgetSim };
    const enableEPGate = bestEP >= 0.58;
    const enableDSGate = bestDS >= 0.50;
    const enableWeakDSDiscriminator = displayTypeCounts.diamond_sword && bestDS >= 0.30 && bestDS < 0.50 && maxWidgetSim >= 0.75;
    for (const row of scoredRows) {
      const info = row.info;
      let gatedRawScore = info.rawScore;
      const anchorDiagnostics = buildAnchorDiagnostics(info, bestAnchors);
      info.anchorGaps = anchorDiagnostics.anchorGaps;
      info.sharedness = anchorDiagnostics.sharedness;
      info.strongAnchorCount = anchorDiagnostics.strongAnchorCount;
      info.anchorPenalty = anchorDiagnostics.anchorPenalty;
      info.distinguishability = anchorDiagnostics.distinguishability;
      if (enableEPGate) {
        const ep = (info.perTypeScores && info.perTypeScores.EP) || 0;
        let cap = null;
        if (ep < bestEP - 0.14) cap = 0.38;
        else if (ep < bestEP - 0.08) cap = 0.46;
        if (cap != null && gatedRawScore > cap) {
          gatedRawScore = cap;
          info.epGate = { bestEP, ep, cap };
        }
      }
      if (enableDSGate) {
        const ds = (info.perTypeScores && info.perTypeScores.DS) || 0;
        const ep = (info.perTypeScores && info.perTypeScores.EP) || 0;
        const pearlProtectsSword = hasPearlAnchor && bestEP >= 0.50 && ep >= bestEP - 0.07;
        let cap = null;
        if (!pearlProtectsSword && ds < bestDS - 0.14) cap = 0.38;
        else if (!pearlProtectsSword && ds < bestDS - 0.10) cap = 0.41;
        if (cap != null && gatedRawScore > cap) {
          gatedRawScore = cap;
          info.dsGate = { bestDS, ds, cap };
        }
      }
      if (enableWeakDSDiscriminator) {
        const ds = (info.perTypeScores && info.perTypeScores.DS) || 0;
        const ep = (info.perTypeScores && info.perTypeScores.EP) || 0;
        const dsGap = bestDS - ds;
        const widgetGap = maxWidgetSim - (info.widgetScore || 0);
        const pearlProtectsSword = hasPearlAnchor && bestEP >= 0.50 && ep >= bestEP - 0.07;
        if (!pearlProtectsSword && dsGap > 0.045 && widgetGap > 0.10) {
          const penalty = Math.min(0.025, 0.012 + Math.min(0.013, (dsGap - 0.045) * 0.12 + (widgetGap - 0.10) * 0.05));
          gatedRawScore = Math.max(0, gatedRawScore - penalty);
          info.weakDsPenalty = { bestDS, ds, maxWidgetSim, widget: info.widgetScore || 0, penalty };
        }
      }
      if (anchorDiagnostics.anchorPenalty > 0) {
        const penalty = Math.min(0.035, anchorDiagnostics.anchorPenalty * (0.55 + anchorDiagnostics.sharedness * 0.65));
        gatedRawScore = Math.max(0, gatedRawScore - penalty);
        info.anchorPenaltyApplied = penalty;
      }
      if (anchorDiagnostics.sharedness >= 0.34 && anchorDiagnostics.strongAnchorCount <= 1) {
        const penalty = Math.min(0.018, (anchorDiagnostics.sharedness - 0.30) * 0.05);
        gatedRawScore = Math.max(0, gatedRawScore - penalty);
        info.sharednessPenalty = penalty;
      }
      info.rawScore = gatedRawScore;
      const paletteScore = paletteScores.get(row.name);
      info.paletteScore = paletteScore == null ? null : paletteScore;
      // Palette agreement decides the winner; the legacy composite stays as a
      // tie-breaker and as the diagnostic breakdown.
      info.finalScore = paletteScore == null
        ? gatedRawScore
        : paletteScore * (1 - LEGACY_COMPOSITE_WEIGHT) + gatedRawScore * LEGACY_COMPOSITE_WEIGHT;
      results.push({ name: row.name, score: info.finalScore });
    }

    results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const refinedResults = applyBoundedTextureRefinement(
      results,
      packEntries,
      slots,
      displaySlotTypes,
      details,
      runMetrics,
      refinementEvidenceCache
    );
    assignDisplayScores(refinedResults, details);
    runMetrics.rankMs = nowMs() - rankStart;
    runMetrics.totalMs = nowMs() - runStart;
    return { results: refinedResults.slice(0, SBI_REFINEMENT_RESULT_LIMIT), slotTypes: displaySlotTypes, details };
  };

  const initialMode = metrics.candidateMode === 'prefilter' ? 'candidate'
    : metrics.candidateMode === 'global-initial' ? 'global'
      : 'all';
  let output = runFullScore(fullScoreEntries, initialMode);
  if (shouldRunFullScoreFallback(output.results, metrics, allPackEntries.length, output.details)) {
    metrics.fallback = true;
    const initiallyScored = new Set(fullScoreEntries.map(([groupId]) => groupId));
    const fallbackEntries = selectGlobalCoarseEntries(
      allPackEntries,
      anchorSlots,
      widgetFeatures,
      hudFeatures,
      output.results,
      metrics,
      'global-fallback',
      slotProfiles
    );
    const fallbackOutput = runFullScore(fallbackEntries, 'fallback');
    const fallbackWinner = fallbackOutput.results[0] && fallbackOutput.results[0].name;
    metrics.fallbackPromotedNewGroup = !!fallbackWinner && !initiallyScored.has(fallbackWinner);
    if (metrics.fallbackPromotedNewGroup) output = fallbackOutput;
  }
  const expansionStart = nowMs();
  const expanded = expandGroupedOutput(output, metrics);
  metrics.expansionMs = nowMs() - expansionStart;
  metrics.totalMs = nowMs() - matchStart;
  _lastMatchMetrics = metrics;
  return expanded;
}

async function loadAlignedIndex() {
  if (!alignedIndexPromise) alignedIndexPromise = (async () => {
    const response = await fetchImpl(`/data/sbi-fp/aligned/index.json?v=${SBI_FINGERPRINT_VERSION}`);
    if (!response.ok) throw new Error('Aligned reference index unavailable');
    const index = await response.json();
    if (index.version !== SBI_FINGERPRINT_VERSION || index.alignmentVersion !== 1 ||
        !index.groups || !Array.isArray(index.textures)) throw new Error('Incompatible aligned reference index');
    for (const texture of index.textures) {
      if (!/^textures\/[a-f0-9]{64}\.png$/.test(texture.file) || !Number.isInteger(texture.width) ||
          texture.width < 1 || !Number.isInteger(texture.height) || texture.height < 1) throw new Error('Invalid native reference');
      texture.preview = { width: texture.coarseSize, height: texture.coarseSize, pixels: base64ToBytes(texture.coarse) };
      if (texture.preview.pixels.length !== texture.coarseSize ** 2 * 4) throw new Error('Invalid reference preview');
      texture.palette = paletteSparse(texture.preview.pixels);
    }
    if (matcher === 'aligned') {
      fingerprints = createFingerprintStore();
      fingerprints._meta = index;
      for (const [groupId, group] of Object.entries(index.groups)) {
        fingerprints.packs[groupId] = {};
        for (const member of group.members) fingerprints._packToGroup[member] = groupId;
      }
    }
    return index;
  })().catch(error => { alignedIndexPromise = null; throw error; });
  return alignedIndexPromise;
}

async function decodeNativeReference(bytes) {
  if (opts.decodeReference) return opts.decodeReference(bytes);
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  try {
    const canvas = createCanvas();
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, pixels: ctx.getImageData(0, 0, bitmap.width, bitmap.height).data };
  } finally { bitmap.close(); }
}

async function loadNativeReference(texture) {
  if (nativeReferences.has(texture.file)) {
    const entry = nativeReferences.get(texture.file);
    nativeReferences.delete(texture.file); nativeReferences.set(texture.file, entry);
    return entry.image;
  }
  if (!nativeReferencePromises.has(texture.file)) {
    const pending = fetchNativeReference(texture).finally(() => nativeReferencePromises.delete(texture.file));
    nativeReferencePromises.set(texture.file, pending);
  }
  return nativeReferencePromises.get(texture.file);
}

async function fetchNativeReference(texture) {
  const response = await fetchImpl(`/data/sbi-fp/aligned/${texture.file}?v=${SBI_FINGERPRINT_VERSION}`);
  if (!response.ok) throw new Error('Native reference unavailable: ' + texture.file);
  const encoded = await response.arrayBuffer();
  if (encoded.byteLength !== texture.bytes) throw new Error('Native reference byte length mismatch');
  const hash = Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', encoded)),
    byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== texture.sha256) throw new Error('Native reference hash mismatch');
  const image = await decodeNativeReference(encoded);
  if (image.width !== texture.width || image.height !== texture.height) throw new Error('Native reference dimensions changed');
  const bytes = image.pixels.byteLength;
  while (nativeReferences.size && nativeReferenceBytes + bytes > NATIVE_REFERENCE_CACHE_BYTES) {
    const key = nativeReferences.keys().next().value;
    nativeReferenceBytes -= nativeReferences.get(key).bytes;
    nativeReferences.delete(key);
  }
  if (bytes <= NATIVE_REFERENCE_CACHE_BYTES) {
    nativeReferences.set(texture.file, { image, bytes }); nativeReferenceBytes += bytes;
  }
  return image;
}

async function searchAlignedObservation(observation, options = {}) {
  const started = nowMs();
  const index = await loadAlignedIndex();
  const slots = (observation.slots || []).filter(slot => slot.native);
  if (!slots.length) return { results: [], stage1Results: [], details: {}, slotTypes: [], candidateGroupIds: [], metrics: { refinementSizes: [] } };
  const hasStructure = image => {
    let first = -1;
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      if (itemOverlayExcluded(x, y, image.width, image.height)) continue;
      const i = (y * image.width + x) * 4;
      if (first < 0) { first = i; continue; }
      for (let c = 0; c < 4; c++) if (image.pixels[i + c] !== image.pixels[first + c]) return true;
    }
    return false;
  };
  const structured = slots.filter(slot => hasStructure(slot.native));
  const evidence = structured.length ? structured : slots;
  const uninformativeSlotIndexes = slots.filter(slot => !evidence.includes(slot)).map(slot => slot.index);
  const queries = [];
  for (const slot of evidence) {
    const duplicate = queries.find(query => {
      const a = query.slot.native, b = slot.native;
      if (a.width !== b.width || a.height !== b.height) return false;
      for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
        if (itemOverlayExcluded(x, y, a.width, a.height)) continue;
        const i = (y * a.width + x) * 4;
        for (let c = 0; c < 4; c++) if (a.pixels[i + c] !== b.pixels[i + c]) return false;
      }
      return true;
    });
    if (duplicate) { duplicate.slotIndexes.push(slot.index); continue; }
    const preview = resampleItemArea(slot.native, Math.min(16, slot.native.width, slot.native.height));
    queries.push({ slot, slotIndexes: [slot.index], preview, palette: paletteSparse(preview.pixels) });
  }
  const similarities = queries.map(query => index.textures.map(texture => {
    const color = sparseIntersection(query.palette, texture.palette);
    const spatial = compareNativeItem(query.preview, texture.preview).score;
    return 0.5 * color + 0.5 * spatial;
  }));
  const groups = Object.entries(index.groups);
  const ranked = groups.map(([groupId, group]) => {
    const ids = [...new Set(SLOT_ITEM_TYPES.flatMap(type => group.items[type] || []))];
    const values = queries.map((_, slot) => Math.max(0, ...ids.map(id => similarities[slot][id])));
    return { groupId, group, ids, score: values.reduce((a, b) => a + b, 0) / values.length };
  }).sort((a, b) => b.score - a.score || a.groupId.localeCompare(b.groupId));
  const limit = options.shortlist || 48;
  const candidates = ranked.slice(0, limit);
  const candidateGroupIds = candidates.map(row => row.groupId);
  const stage1Results = candidates.flatMap(row => row.group.members.map(name => ({
    name, groupId: row.groupId, score: row.score, displayScore: row.score,
  })));
  const coarseMs = nowMs() - started;
  const refineStart = nowMs();
  const refinementSizes = new Set();
  const pairScores = new Map();
  for (const candidate of candidates) {
    const scores = queries.map(() => 0);
    for (const id of candidate.ids) {
      let matches = pairScores.get(id);
      if (!matches) {
        const reference = await loadNativeReference(index.textures[id]);
        matches = queries.map(query => {
          const match = compareNativeItem(query.slot.native, reference);
          refinementSizes.add(match.size);
          return match.score;
        });
        pairScores.set(id, matches);
      }
      for (let s = 0; s < scores.length; s++) scores[s] = Math.max(scores[s], matches[s]);
    }
    candidate.score = scores.reduce((a, b) => a + b, 0) / scores.length;
  }
  candidates.sort((a, b) => b.score - a.score || a.groupId.localeCompare(b.groupId));
  const results = [], details = {};
  for (const row of candidates) for (const name of row.group.members) {
    results.push({ name, groupId: row.groupId, score: row.score, displayScore: row.score });
    details[name] = { groupId: row.groupId, groupMembers: row.group.members, rawScore: row.score, finalScore: row.score };
  }
  const refineMs = nowMs() - refineStart;
  const metrics = { candidateGroupIds, fullScoreGroupIds: candidateGroupIds, fullScoreMembers: results.map(row => row.name),
    groupCount: groups.length, fullScoreCount: candidates.length, coarseMs, refineMs, totalMs: nowMs() - started,
    refinementSizes: [...refinementSizes].sort((a, b) => a - b), nativeReferenceBytes,
    observedSlotCount: slots.length, distinctSlotCount: queries.length, uninformativeSlotIndexes,
    evidenceSlots: queries.map(query => query.slotIndexes) };
  _lastMatchMetrics = metrics;
  return { results, details, slotTypes: [], stage1Results, candidateGroupIds, metrics };
}

async function prepareSearch() {
  if (matcher === 'aligned') await loadAlignedIndex();
  else await ensureFingerprints();
}

async function searchObservation(observation) {
  if (matcher === 'aligned') return searchAlignedObservation(observation);
  const { slots, widgetFeatures, hudFeatures } = observation;
  await ensureFingerprints();
  await ensureFingerprintsForSlots(slots);
  const coarse = matchPacks(slots, widgetFeatures, hudFeatures);
  let output = coarse;
  const coarseMetrics = getMatchMetricsSnapshot();
  if (fingerprints._meta && fingerprints._meta.packToPixelBuckets) {
    await ensurePixelBucketsForPacks(Object.keys(fingerprints.packs));
    output = matchPacks(slots, widgetFeatures, hudFeatures);
  }
  return { ...output, stage1Results: coarse.results,
    candidateGroupIds: (_lastMatchMetrics.candidateGroupIds || []).slice(),
    metrics: { ...getMatchMetricsSnapshot(), coarsePass: coarseMetrics } };
}

function getMatchMetricsSnapshot() {
  return { ..._lastMatchMetrics };
}

function getPresetUnit(imgW, imgH, preset) {
  if (preset === 'auto') return 0;
  const base = getWide16By9Unit(imgW, imgH) || getMaxGuiScale(imgW, imgH);
  if (preset === 'small') return Math.max(1, Math.ceil(base) - 1);
  return base;
}


  // Node-side pack texture fingerprint, mirroring the generator: nearest-neighbour
  // resizes from raw RGBA, base64 payloads as stored in data/sbi-fp shards.
  function computeTextureFingerprint(rgba, w, h, spatialSize) {
    const size = spatialSize || 16;
    const hashPixels = resizeRgbaNearest(rgba, w, h, 9, 8);
    const featurePixels = resizeRgbaNearest(rgba, w, h, 16, 16);
    return {
      dhash: bytesToBase64(computeDHash(hashPixels)),
      hist: computeHistogram(featurePixels, 256),
      moments: computeColorMoments(featurePixels, 256),
      edge: computeEdgeDensity(featurePixels, 16, 16),
      sig: computeItemSignature(featurePixels, 16, 16),
      pix: bytesToBase64(resizeRgbaNearest(rgba, w, h, size, size)),
    };
  }

  function bytesToBase64(bytes) {
    const view = bytes.buffer
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new Uint8Array(bytes);
    return Buffer.from(view).toString('base64');
  }

  function resizeRgbaNearest(rgba, srcW, srcH, dstW, dstH) {
    const out = new Uint8ClampedArray(dstW * dstH * 4);
    for (let y = 0; y < dstH; y++) {
      const sy = Math.min(srcH - 1, Math.floor((y + 0.5) * srcH / dstH));
      for (let x = 0; x < dstW; x++) {
        const sx = Math.min(srcW - 1, Math.floor((x + 0.5) * srcW / dstW));
        const s = (sy * srcW + sx) * 4;
        const d = (y * dstW + x) * 4;
        out[d] = rgba[s];
        out[d + 1] = rgba[s + 1];
        out[d + 2] = rgba[s + 2];
        out[d + 3] = rgba[s + 3];
      }
    }
    return out;
  }

  return {
    createFingerprintStore,
    applyFingerprintMetadata,
    loadFingerprintMetadata,
    mergeShardIndex,
    mergeFingerprintShard,
    mergePixelBucketShard,
    resolveFingerprintShardFiles,
    loadFingerprintShard,
    ensureFingerprints,
    resolvePixelBucketFilesForPacks,
    ensurePixelBucketsForPacks,
    loadPixelBucketShard,
    getGroupInfo,
    getGroupMembers,
    inflateFingerprintCorpusForBenchmark,
    getSurfaceRarity,
    applyRarityToSimilarity,
    shouldLoadFoodFingerprintShard,
    ensureFingerprintsForSlots,
    bucketIndex,
    getBucketKey,
    getAdjacentBucketKeys,
    nowMs,
    byteHex,
    getDHashSegmentKeysFromBytes,
    getShardNameForType,
    getIndexCandidateNames,
    getHashIndexCandidateNames,
    getAnchorSlotsByType,
    getSignaturePrefilterCandidates,
    clamp01,
    getMaxGuiScale,
    getWide16By9Unit,
    getHudHorizontalShift,
    calibrateDisplayScore,
    assignDisplayScores,
    getStrongMatchThreshold,
    countDisplaySlotTypes,
    getRepeatedTypeScale,
    getCriticalTypeMetrics,
    getScoreValue,
    scoreGap,
    buildAnchorDiagnostics,
    computeDHash,
    computeHistogram,
    computeColorMoments,
    computeEdgeDensity,
    base64ToBytes,
    hammingDistance,
    cosineSimilarity,
    meanRgbDirSim,
    colorMomentSim,
    compareSpatialMetrics,
    compareSpatial,
    compareNativeItem,
    resampleItemArea,
    itemOverlayExcluded,
    paletteHistogram,
    paletteIntersection,
    slotPixelCoverage,
    selectLiveSlots,
    resizeRgbaNearest,
    medianDeviationPlate,
    paletteSparse,
    sparseIntersection,
    paletteHistogram,
    paletteIntersection,
    buildPackPalettes,
    resetPackPalettes,
    scorePaletteCandidates,
    getOpaqueSpatialPositions,
    compareSpatialColor,
    normalizePackHist,
    compare,
    compareWidget,
    getScratchContext,
    extractRegion,
    resizeImageDataNearest,
    maskWidgetItems,
    suppressWidgetHighlights,
    computeWidgetGridScore,
    maskSlotNoise,
    zeroRgbForTransparent,
    suppressSlotBackground,
    buildSlotVariants,
    computeItemSignature,
    computeFeatures,
    tryExtractFeature,
    buildWidgetFeatures,
    extractWidgetFeatures,
    extractHudFeatures,
    estimateWidgetCandidates,
    estimateHudConfidence,
    estimateSlotConfidence,
    buildStrictCropCandidates,
    extractSlotFeatures,
    hydrateSlotVariants,
    pickSlotForClip,
    findDisplayWidgetRect,
    extractHotbarSlots,
    compareHudVariant,
    compareHudCells,
    metricSimilarity,
    signatureSimilarity,
    colorRatio,
    signatureMeanRatio,
    signatureBlueGreenBias,
    compareSlotVariant,
    compareSlotToType,
    getSlotAnchorEvidence,
    groupObservedSlotsByType,
    getBestTypeRefinementEvidence,
    buildRefinementValues,
    applyBoundedTextureRefinement,
    getBestFingerprintSlotSimilarity,
    isStrongFoodColor,
    isFoodLikeTailSignature,
    isPotionLikeSignature,
    inferPrimaryWeaponSlotType,
    inferMiddleConsumableSlotType,
    inferTrailingConsumableSlotType,
    inferLogoPearlSlotType,
    inferCanonicalPvPWeaponSlotType,
    applyCanonicalMiddlePotionSlots,
    sharpenSimilarityScore,
    inferDisplaySlotTypes,
    getCandidateFullScoreLimit,
    scoreCoarseAnchorMatch,
    selectCandidateFullScoreEntries,
    scoreGlobalCoarseMatch,
    selectGlobalCoarseEntries,
    shouldRunFullScoreFallback,
    expandGroupedOutput,
    matchPacks,
    searchObservation,
    prepareSearch,
    searchAlignedObservation,
    loadAlignedIndex,
    getPresetUnit,
    computeTextureFingerprint,
    get store() { return fingerprints; },
    getLastMatchMetrics() { return _lastMatchMetrics; },
    resetMatchMetrics() { _lastMatchMetrics = {}; },
    setForceGlobalFallbackForTest(value) { _forceGlobalFallbackForTest = !!value; },
    setBenchmarkGroupTarget(target) { _benchmarkGroupTarget = Math.max(0, Number(target) || 0); },
    setBenchmarkExcludedPacks(excludedPacks) { _benchmarkExcludedPacks = new Set(Array.isArray(excludedPacks) ? excludedPacks : []); },
    SBI_FINGERPRINT_VERSION,
  };
}

const standaloneEngine = createSbiEngine();

return {
  createSbiEngine,
  computeTextureFingerprint: standaloneEngine.computeTextureFingerprint,
  resampleItemArea: standaloneEngine.resampleItemArea,
  itemOverlayExcluded: standaloneEngine.itemOverlayExcluded,
  constants: {
    SBI_FINGERPRINT_VERSION,
    SBI_BASE_FINGERPRINT_SHARDS,
    SBI_FOOD_FINGERPRINT_SHARD,
    SBI_ANCHOR_ITEM_TYPES,
    MAX_GUI_SCALE,
    STRICT_WIDGET_WIDTH_RATIOS,
    STRICT_WIDGET_HEIGHT_RATIOS,
    STRICT_BOTTOM_OFFSET_UNIT_STEPS,
    SLOT_ITEM_TYPES,
    SBI_SCORE_WEIGHTS,
    SBI_REFINEMENT_RESULT_LIMIT,
    SBI_FALLBACK_RETAINED_RESULT_LIMIT,
    SBI_FULL_SCORE_LIMIT,
    SBI_REFINEMENT_FEATURES,
    SLOT_STRONG_MATCH_THRESHOLDS,
  },
};
});
