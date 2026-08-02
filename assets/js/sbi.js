(function() {
'use strict';

let fingerprints = null;
let clipWorker = null;
let clipWorkerReady = false;
let clipWorkerError = null;
const ENABLE_CLIP = false;

function setClipWorkerError(errorMsg) {
  clipWorkerReady = false;
  clipWorkerError = errorMsg || 'Unknown worker error';
  const badge = document.getElementById('sbi-ai-badge');
  const msg = document.getElementById('sbi-ai-msg');
  const dot = document.getElementById('sbi-ai-dot');
  const el = document.getElementById('sbi-clip-status');
  if (el) { el.hidden = false; el.textContent = 'AI: ' + clipWorkerError; el.dataset.state = 'error'; }
  if (badge) badge.dataset.state = 'error';
  if (msg) msg.textContent = 'Error: ' + clipWorkerError;
  if (dot) dot.style.background = '#ef4444';
}

function initClipWorker() {
  if (!ENABLE_CLIP) return;
  if (clipWorker) return;
  clipWorker = new Worker('/assets/js/sbi-worker.js', { type: 'module' });
  clipWorker.onmessage = ({ data }) => {
    const badge = document.getElementById('sbi-ai-badge');
    const popup = document.getElementById('sbi-ai-popup');
    const msg = document.getElementById('sbi-ai-msg');
    if (data.type === 'ready') {
      clipWorkerReady = true;
      clipWorkerError = null;
      if (badge) { badge.dataset.state = 'ready'; badge.title = 'AI Ready'; }
      if (msg) msg.textContent = 'AI model loaded and ready.';
      const dot = document.getElementById('sbi-ai-dot');
      if (dot) dot.style.background = '#22c55e';
      if (popup) popup.hidden = true;
    } else if (data.type === 'status') {
      const el = document.getElementById('sbi-clip-status');
      if (el) el.textContent = data.msg;
      if (badge) badge.dataset.state = clipWorkerReady ? 'ready' : 'loading';
      if (msg) msg.textContent = data.msg;
    } else if (data.type === 'results') {
      handleClipResults(data.scores);
    } else if (data.type === 'error') {
      setClipWorkerError(data.msg);
    }
  };
  clipWorker.onerror = e => setClipWorkerError(e.message || 'Worker runtime error');
  clipWorker.onmessageerror = () => setClipWorkerError('Worker message error');
  clipWorker.postMessage({ type: 'init' });
  const badge = document.getElementById('sbi-ai-badge');
  if (badge) badge.dataset.state = 'loading';
}

let _lastHashResults = [], _lastAllScores = {};
const SBI_FINGERPRINT_VERSION = 18;
const SBI_BASE_FINGERPRINT_SHARDS = ['widget', 'health', 'hunger', 'armor', 'diamond_sword', 'ender_pearl', 'splash_potion'];
const SBI_FOOD_FINGERPRINT_SHARD = 'food';
const SBI_FINGERPRINT_SHARD_PATH = '/data/sbi-fp/';
const SBI_FINGERPRINT_META_FILE = 'meta.json';
const SBI_ANCHOR_ITEM_TYPES = ['diamond_sword', 'ender_pearl', 'splash_potion'];
const SBI_CANDIDATE_MIN_PACKS = 24;
const SBI_CANDIDATE_FALLBACK_MARGIN = 0.006;
const SBI_CANDIDATE_FALLBACK_MIN_SCORE = 0.30;
const _fingerprintShardPromises = {};
let _fingerprintMetaPromise = null;
// AI (CLIP) is used as a rerank signal. We normalize CLIP scores per-query and
// apply it as a multiplicative factor on top of the hash score, so a weak CLIP
// match won't incorrectly drag down a strong hash match when the crop is correct.
const CLIP_RERANK_BASE = 0.35;
const CLIP_RERANK_WEIGHT = 0.65;
const CLIP_ONLY_SCALE = 0.72;
let _lastMatchDetails = {};
let _lastClipScores = {};
let _lastVisibleScores = {};
let _lastTestTimings = {};
let _lastMatchMetrics = {};
let _lastRankedResults = [];
let _lastSlotFeatures = [];
let _lastSearchPhase = 'hash';
let _lastDetectionMeta = null;
let _forceGlobalFallbackForTest = false;
let _benchmarkGroupTarget = 0;
let _benchmarkExcludedPacks = new Set();
let _previewImageUrl = '';
let _currentPreset = 'large';
let _pendingFile = null;
let _pendingImage = null;
let _pendingImageUrl = '';
let _autoSearch = false;
let _uploadPreviewResizeObserver = null;
const SLOT_COLOR_MAP = {
  diamond_sword: '#38bdf8',
  ender_pearl: '#c084fc',
  splash_potion: '#7f1d1d',
  steak: '#8b5a2b',
  golden_carrot: '#d4af37',
  none: '#000000',
};
const CROPBOX_COLORS = {
  armor:  'rgba(156,163,175,1)',
  health: 'rgba(255,77,79,1)',
  hunger: 'rgba(255,159,28,1)',
  hotbar: 'rgba(0,0,0,1)',
};
const CROPBOX_HUD_DIVIDERS = [8, 16, 24, 32, 40, 48, 56, 64, 72];
const CROPBOX_HOTBAR_DIVIDERS = [20, 40, 60, 80, 100, 120, 140, 160];
const CROPBOX_SPRITE_W = 182;
const CROPBOX_SPRITE_H = 48;
const CROPBOX_SLOT_COUNT = 9;
const CROPBOX_SLOT_LEFT = 1;
const CROPBOX_SLOT_STEP = 20;
const CROPBOX_SLOT_TOP = 28;
const CROPBOX_SLOT_SIZE = 20;
const CROPBOX_REGIONS = [
  { color: CROPBOX_COLORS.armor, x: 0, y: 0, w: 81, h: 9, dividerOffsets: CROPBOX_HUD_DIVIDERS, dividerInsetTop: 0, dividerInsetBottom: 0 },
  { color: CROPBOX_COLORS.health, x: 0, y: 10, w: 81, h: 9, dividerOffsets: CROPBOX_HUD_DIVIDERS, dividerInsetTop: 0, dividerInsetBottom: 0 },
  { color: CROPBOX_COLORS.hunger, x: 101, y: 10, w: 81, h: 9, dividerOffsets: CROPBOX_HUD_DIVIDERS, dividerInsetTop: 0, dividerInsetBottom: 0 },
  { color: CROPBOX_COLORS.hotbar, x: 1, y: 28, w: 180, h: 20, dividerOffsets: CROPBOX_HOTBAR_DIVIDERS, dividerInsetTop: 1, dividerInsetBottom: 1 },
];
const _scratchCanvases = {};
const MAX_GUI_SCALE = 18;
const STRICT_WIDGET_WIDTH_RATIOS = [0.21, 0.235, 0.26, 0.285, 0.31, 0.335];
const STRICT_WIDGET_HEIGHT_RATIOS = [0.044, 0.052, 0.06, 0.068, 0.076];
const STRICT_BOTTOM_OFFSET_UNIT_STEPS = [0, 1, 2, 3, 4, 6, 8];
const SLOT_ITEM_TYPES = ['diamond_sword', 'ender_pearl', 'splash_potion', 'steak', 'golden_carrot'];
const PER_TYPE_SCORE_ORDER = ['DS', 'EP', 'HL', 'SK/GC'];
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
      const resp = await fetch(`${SBI_FINGERPRINT_SHARD_PATH}${SBI_FINGERPRINT_META_FILE}?v=${SBI_FINGERPRINT_VERSION}`);
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
      const resp = await fetch(`${SBI_FINGERPRINT_SHARD_PATH}${shardFile}?v=${SBI_FINGERPRINT_VERSION}`);
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

function fmtPct(v) {
  if (!isFinite(v)) return '-';
  return (Math.max(0, Math.min(1, v)) * 100).toFixed(1) + '%';
}

function getDisplayedPctOrderValue(v) {
  if (!isFinite(v)) return -1;
  return Math.round(Math.max(0, Math.min(1, v)) * 1000);
}

function fmtRaw(v, digits) {
  if (!isFinite(v)) return '-';
  return Number(v).toFixed(digits || 4);
}

let _packNameIndex = null;
let _packNameIndexPromise = null;

async function ensurePackNameIndex() {
  if (_packNameIndex) return _packNameIndex;
  if (_packNameIndexPromise) return _packNameIndexPromise;
  _packNameIndexPromise = (async () => {
    const map = Object.create(null);
    try {
      const raw = await fetch(`/data/index.json?v=${SBI_FINGERPRINT_VERSION}`).then(r => r.json());
      for (const it of raw.items || []) {
        if (!it || !it.name) continue;
        const fallback = String(it.name).replace(/_/g, ' ');
        map[it.name] = {
          displayName: it.displayName || fallback,
          coloredName: it.coloredName || it.displayName || fallback,
        };
      }
    } catch (_) { /* keep empty map; fall back to slug names */ }
    _packNameIndex = map;
    return map;
  })();
  try {
    return await _packNameIndexPromise;
  } finally {
    _packNameIndexPromise = null;
  }
}

function getPackDisplayName(name) {
  const meta = _packNameIndex && _packNameIndex[name];
  if (meta && meta.displayName) return meta.displayName;
  return String(name || '').replace(/_/g, ' ');
}

function getPackColoredName(name) {
  const meta = _packNameIndex && _packNameIndex[name];
  if (meta && meta.coloredName) return meta.coloredName;
  return getPackDisplayName(name);
}

function normalizePackSearchTerm(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizePackSearchPhrase(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
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

function getDisplayScoreValue(row, info) {
  if (row && isFinite(row.displayScore)) return clamp01(row.displayScore);
  if (info && isFinite(info.displayScore)) return clamp01(info.displayScore);
  if (row && isFinite(row.score)) return clamp01(row.score);
  if (info && isFinite(info.finalScore)) return clamp01(info.finalScore);
  return 0;
}

function formatWidgetRect(rect) {
  return rect ? `x=${rect.x}, y=${rect.y}, w=${rect.w}, h=${rect.h}` : 'none';
}

function formatSearchInfo(info) {
  if (!info) return 'none';
  return `unit=${info.unit.toFixed(3)}${info.snappedUnit === undefined ? '' : `→${info.snappedUnit.toFixed(3)}`}, target=${info.targetUnit === undefined ? '-' : info.targetUnit.toFixed(3)}, off=${info.bottomOffset === undefined ? '-' : info.bottomOffset}, mode=${info.mode || 'strict'}, by=${info.bottomRatio === undefined ? '-' : info.bottomRatio.toFixed(3)}, g=${info.gridScore === undefined ? '-' : info.gridScore.toFixed(2)}, bp=${info.bottomPref === undefined ? '-' : info.bottomPref.toFixed(2)}, up=${info.unitPref === undefined ? '-' : info.unitPref.toFixed(2)}, wb=${info.widgetBoost === undefined ? '-' : info.widgetBoost.toFixed(3)}, hb=${info.hudBoost === undefined ? '-' : info.hudBoost.toFixed(3)}, sb=${info.slotBoost === undefined ? '-' : info.slotBoost.toFixed(3)}, conf=${Math.round(info.confidence)}`;
}

function getPerTypeScore(info, key) {
  return info && info.perTypeScores ? info.perTypeScores[key] : undefined;
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

function renderPerTypeScoreTip(info) {
  if (!info || !info.perTypeScores) return '';
  const pts = info.perTypeScores;
  return `<table><tr>${PER_TYPE_SCORE_ORDER.map(t => `<th>${t}</th>`).join('')}</tr><tr>${PER_TYPE_SCORE_ORDER.map(t => `<td>${pts[t] !== undefined ? fmtPct(pts[t]) : '-'}</td>`).join('')}</tr></table>`;
}

function positionScoreTip(panel, tip, td) {
  const panelRect = panel.getBoundingClientRect();
  const tdRect = td.getBoundingClientRect();
  const tipW = tip.offsetWidth;
  const tipH = tip.offsetHeight;
  let left = tdRect.left - panelRect.left + tdRect.width / 2 - tipW / 2;
  left = Math.max(0, Math.min(left, panelRect.width - tipW));
  tip.style.left = left + 'px';
  tip.style.top = (tdRect.top - panelRect.top - tipH - 4) + 'px';
}

function bindScoreTip(panel, wrap, tip, cellIndex) {
  if (!panel || !wrap || !tip) return;

  const showTip = (td, packName) => {
    const html = renderPerTypeScoreTip(_lastMatchDetails[packName]);
    if (!html) {
      tip.hidden = true;
      return;
    }
    tip.innerHTML = html;
    tip.hidden = false;
    positionScoreTip(panel, tip, td);
  };

  const hideTip = () => { tip.hidden = true; };
  const isTargetCell = td => td && td.cellIndex === cellIndex;
  let activePack = null;

  wrap.addEventListener('mouseover', e => {
    const td = e.target.closest('td');
    if (!isTargetCell(td)) return;
    const tr = td.closest('tr[data-pack]');
    if (tr) showTip(td, tr.dataset.pack);
  });

  wrap.addEventListener('mouseout', e => {
    const td = e.target.closest('td');
    if (isTargetCell(td)) hideTip();
  });

  wrap.addEventListener('click', e => {
    const td = e.target.closest('td');
    if (!isTargetCell(td)) return;
    const tr = td.closest('tr[data-pack]');
    if (!tr) return;
    if (activePack === tr.dataset.pack && !tip.hidden) {
      hideTip();
      activePack = null;
      return;
    }
    showTip(td, tr.dataset.pack);
    activePack = tr.dataset.pack;
  });
}

function revokePreviewImageUrl() {
  if (!_previewImageUrl) return;
  URL.revokeObjectURL(_previewImageUrl);
  _previewImageUrl = '';
}

function clearPreviewCacheImage() {
  const previewImage = document.getElementById('sbi-preview-image');
  clearPreviewCropbox();
  revokePreviewImageUrl();
  if (previewImage) {
    previewImage.hidden = true;
    previewImage.removeAttribute('src');
  }
}

function updatePreviewCacheImage(filename) {
  const canvas = document.getElementById('sbi-canvas');
  const previewImage = document.getElementById('sbi-preview-image');
  if (!canvas || !previewImage) return Promise.resolve();
  return new Promise(resolve => {
    canvas.toBlob(blob => {
      if (!blob) {
        clearPreviewCacheImage();
        resolve();
        return;
      }
      revokePreviewImageUrl();
      const file = typeof File === 'function'
        ? new File([blob], filename, { type: 'image/png' })
        : blob;
      _previewImageUrl = URL.createObjectURL(file);
      previewImage.src = _previewImageUrl;
      previewImage.alt = filename;
      previewImage.hidden = false;
      resolve();
    }, 'image/png');
  });
}

function hideCropboxElement(el) {
  if (!el) return;
  el.hidden = true;
  el.innerHTML = '';
  el.style.left = '';
  el.style.top = '';
  el.style.width = '';
  el.style.height = '';
  el.style.transform = '';
}

function clearPreviewCropbox() {
  hideCropboxElement(document.getElementById('sbi-preview-overlay'));
  const slotLayer = document.getElementById('sbi-preview-slot-layer');
  if (!slotLayer) return;
  slotLayer.hidden = true;
  slotLayer.innerHTML = '';
}

function formatSurfacePct(value, total) {
  return `${(value / total) * 100}%`;
}

function setCropboxRectStyle(el, rect, surfaceW, surfaceH) {
  el.style.left = formatSurfacePct(rect.x, surfaceW);
  el.style.top = formatSurfacePct(rect.y, surfaceH);
  el.style.width = formatSurfacePct(rect.w, surfaceW);
  el.style.height = formatSurfacePct(rect.h, surfaceH);
}

function buildCropboxRegions(widgetRect) {
  if (!widgetRect || !widgetRect.w) return [];
  const unit = widgetRect.w / CROPBOX_SPRITE_W;
  if (!isFinite(unit) || unit <= 0) return [];
  return CROPBOX_REGIONS.map(region => ({
    color: region.color,
    x: widgetRect.x + region.x * unit,
    y: widgetRect.y - 27 * unit + region.y * unit,
    w: region.w * unit,
    h: region.h * unit,
    dividerOffsets: Array.isArray(region.dividerOffsets) ? region.dividerOffsets.map(offset => offset * unit) : null,
    dividerInsetTop: (region.dividerInsetTop || 0) * unit,
    dividerInsetBottom: (region.dividerInsetBottom || 0) * unit,
  }));
}

function getWidgetSlotRect(widgetRect, index) {
  if (!widgetRect || !widgetRect.w || index < 0 || index >= CROPBOX_SLOT_COUNT) return null;
  const unit = widgetRect.w / CROPBOX_SPRITE_W;
  if (!isFinite(unit) || unit <= 0) return null;
  return {
    x: widgetRect.x + (CROPBOX_SLOT_LEFT + index * CROPBOX_SLOT_STEP) * unit,
    y: widgetRect.y + unit,
    sz: CROPBOX_SLOT_SIZE * unit,
  };
}

function getPendingWidgetRect(imgW, imgH, preset) {
  if (preset === 'auto') return null;
  return findDisplayWidgetRect(null, imgW, imgH, null, preset);
}

function appendCropboxDividers(box, region) {
  if (!box || !region || !Array.isArray(region.dividerOffsets) || !region.dividerOffsets.length) return;
  const insetTop = Math.max(0, region.dividerInsetTop || 0);
  const insetBottom = Math.max(0, region.dividerInsetBottom || 0);
  const innerHeight = Math.max(0, region.h - insetTop - insetBottom);
  if (!innerHeight) return;
  for (const offset of region.dividerOffsets) {
    if (!isFinite(offset) || offset <= 0 || offset >= region.w) continue;
    const divider = document.createElement('div');
    divider.className = 'sbi-cropbox-divider';
    divider.style.setProperty('--cropbox-color', region.color);
    divider.style.left = `calc(${(offset / region.w) * 100}% - 0.5px)`;
    divider.style.top = `${(insetTop / region.h) * 100}%`;
    divider.style.height = `${(innerHeight / region.h) * 100}%`;
    box.appendChild(divider);
  }
}

function renderCropboxLayer(layer, regions, surfaceW, surfaceH, className, fillAlpha) {
  if (!layer || !surfaceW || !surfaceH || !regions || !regions.length) {
    hideCropboxElement(layer);
    return;
  }
  layer.hidden = false;
  layer.innerHTML = '';
  for (const region of regions) {
    const box = document.createElement('div');
    box.className = className;
    box.style.setProperty('--cropbox-color', region.color);
    if (fillAlpha) box.style.background = alphaColor(region.color, fillAlpha);
    setCropboxRectStyle(box, region, surfaceW, surfaceH);
    appendCropboxDividers(box, region);
    layer.appendChild(box);
  }
}

function renderUploadCropbox(surfaceW, surfaceH) {
  renderCropboxLayer(
    document.getElementById('sbi-cropbox-overlay'),
    buildCropboxRegions(getPendingWidgetRect(surfaceW, surfaceH, _currentPreset)),
    surfaceW,
    surfaceH,
    'sbi-cropbox-region'
  );
}

function renderPreviewCropbox(surfaceW, surfaceH, widgetRect, slotTypes, slots) {
  renderCropboxLayer(
    document.getElementById('sbi-preview-overlay'),
    buildCropboxRegions(widgetRect),
    surfaceW,
    surfaceH,
    'sbi-cropbox-region'
  );

  const slotLayer = document.getElementById('sbi-preview-slot-layer');
  if (!slotLayer || !widgetRect) {
    if (slotLayer) {
      slotLayer.hidden = true;
      slotLayer.innerHTML = '';
    }
    return;
  }

  const regions = [];
  for (let i = 0; i < Math.min(CROPBOX_SLOT_COUNT, slotTypes ? slotTypes.length : 0); i++) {
    const slotType = slotTypes[i] || 'none';
    const color = SLOT_COLOR_MAP[slotType] || SLOT_COLOR_MAP.none;
    if (color === SLOT_COLOR_MAP.none) continue;
    const slot = Array.isArray(slots) ? (slots.find(entry => entry && entry.index === i) || slots[i]) : null;
    const rect = getSlotDisplayRect(slot || getWidgetSlotRect(widgetRect, i), surfaceW, surfaceH);
    if (!rect) continue;
    regions.push({ color, x: rect.x, y: rect.y, w: rect.sz, h: rect.sz });
  }
  renderCropboxLayer(slotLayer, regions, surfaceW, surfaceH, 'sbi-preview-slot-overlay', 0.18);
}

function summarizeSlotTypes(types) {
  if (!types || !types.length) return '-';
  const map = {
    diamond_sword: 'DS',
    ender_pearl: 'EP',
    splash_potion: 'HL',
    steak: 'SK',
    golden_carrot: 'GC',
    none: 'NN',
  };
  return types.map(t => map[t] || '?').join(' ');
}

function hasCompletedSearchResults() {
  const preview = document.getElementById('sbi-preview');
  return !!_pendingImage && !!_lastRankedResults.length && !!preview && !preview.hidden;
}

function setUploadReplaceHover(active) {
  const uploadEl = document.getElementById('sbi-upload');
  if (!uploadEl) return;
  uploadEl.classList.toggle('replace-hover', !!active && hasCompletedSearchResults() && !uploadEl.classList.contains('analyzing'));
}

function syncUploadPreviewState() {
  const uploadEl = document.getElementById('sbi-upload');
  if (!uploadEl) return;
  uploadEl.classList.toggle('has-image', !!_pendingImage);
  if (!hasCompletedSearchResults()) uploadEl.classList.remove('replace-hover');
}

function summarizeSlotType(type) {
  return summarizeSlotTypes([type || 'none']);
}

function getCurrentSlotTypesSummary() {
  const firstRanked = _lastRankedResults && _lastRankedResults.length ? _lastRankedResults[0] : null;
  if (firstRanked) {
    const info = _lastMatchDetails[firstRanked.name];
    if (info && info.slotTypes && info.slotTypes.length) return summarizeSlotTypes(info.slotTypes);
  }
  for (const info of Object.values(_lastMatchDetails || {})) {
    if (info && info.slotTypes && info.slotTypes.length) return summarizeSlotTypes(info.slotTypes);
  }
  return '-';
}

function renderDebugPanel(results, phase) {
  const panel = document.getElementById('sbi-debug');
  const meta = document.getElementById('sbi-debug-meta');
  const slotTypesEl = document.getElementById('sbi-debug-slot-types');
  const body = document.getElementById('sbi-debug-body');
  if (!panel || !meta || !slotTypesEl || !body) return;

  panel.hidden = false;
  const d = _lastDetectionMeta || {};
  const rect = formatWidgetRect(d.widgetRect);
  const s = d.searchInfo || null;
  const search = formatSearchInfo(s);
  const m = _lastMatchMetrics || {};
  const matchInfo = m.packCount
    ? ` | match=${m.fullScoreMode || m.candidateMode || 'all'} pre=${m.candidatePrefilterCount == null ? '-' : m.candidatePrefilterCount}/${m.packCount} coarse=${m.coarseScoreCount || 0}->${m.coarseSelectedCount || m.fullScoreCount || 0} full=${m.fullScoreCount || 0}${m.fallback ? ' fallback' : ''}`
    : '';
  meta.textContent =
    `phase=${phase} | slots=${d.slotCount || 0} | hud(heart/hunger/armor)=${d.heartCount || 0}/${d.hungerCount || 0}/${d.armorCount || 0} | widget=${rect} | search=${search}${matchInfo}` +
    (s && s.preTop ? `\npre=${s.preTop}` : '') +
    (s && s.autoCandidates ? `\nauto=${s.autoCandidates}` : '');
  slotTypesEl.textContent = `Slot Types: ${getCurrentSlotTypesSummary()}`;

  body.innerHTML = (results || []).slice(0, 10).map((r, i) => {
    const info = _lastMatchDetails[r.name] || {};
    return `<tr data-pack="${r.name.replace(/"/g, '&quot;')}">
      <td>${i + 1}</td>
      <td title="${r.name}">${r.name}</td>
      <td>${fmtPct(getDisplayScoreValue(r, info))}</td>
      <td>${fmtPct(info.slotScore)}</td>
      <td>${fmtPct(info.widgetScore)}</td>
      <td>${fmtPct(info.healthScore)}</td>
      <td>${fmtPct(info.hungerScore)}</td>
      <td>${fmtPct(info.armorScore)}</td>
    </tr>`;
  }).join('');
}

function renderScoreBreakdown() {
  const el = document.getElementById('sbi-breakdown-body');
  if (!el) return;

  const typeRows = Object.entries(SBI_SCORE_WEIGHTS.type).map(([k, v]) => {
    const label = summarizeSlotTypes([k]);
    return `<tr><td>${label}</td><td>${k}</td><td>${v.toFixed(2)}</td></tr>`;
  }).join('');
  el.innerHTML = `
    <div>Final score mixes Slot/HUD/Widget.</div>
    <table class="sbi-weight-table">
      <thead><tr><th>Item</th><th>Key</th><th>Weight</th></tr></thead>
      <tbody>${typeRows}</tbody>
    </table>
    <table class="sbi-weight-table">
      <thead><tr><th>HUD</th><th>Weight</th></tr></thead>
      <tbody>
        <tr><td>Health</td><td>${SBI_SCORE_WEIGHTS.hud.health.toFixed(2)}</td></tr>
        <tr><td>Hunger</td><td>${SBI_SCORE_WEIGHTS.hud.hunger.toFixed(2)}</td></tr>
        <tr><td>Armor</td><td>${SBI_SCORE_WEIGHTS.hud.armor.toFixed(2)}</td></tr>
      </tbody>
    </table>
    <div>Mix (with HUD): Slot ${SBI_SCORE_WEIGHTS.mix.slot.toFixed(2)}, HUD ${SBI_SCORE_WEIGHTS.mix.hud.toFixed(2)}, Widget ${SBI_SCORE_WEIGHTS.mix.widget.toFixed(2)}</div>
    <div>Mix (no HUD): Slot ${SBI_SCORE_WEIGHTS.mix.slotNoHud.toFixed(2)}, Widget ${SBI_SCORE_WEIGHTS.mix.widgetNoHud.toFixed(2)}</div>
  `;
}

function findPackScoreMatches(query) {
  if (!fingerprints || !fingerprints.packs) return [];
  const rawQuery = String(query || '').trim();
  const loweredQuery = rawQuery.toLowerCase();
  const phraseQuery = normalizePackSearchPhrase(rawQuery);
  const normalizedQuery = normalizePackSearchTerm(query);
  const tokens = phraseQuery ? phraseQuery.split(' ') : [];
  if (!rawQuery && !normalizedQuery && !tokens.length) return [];

  return Object.keys(fingerprints.packs).map(name => {
    const loweredName = name.toLowerCase();
    const displayName = getPackDisplayName(name);
    const exactDisplay = normalizePackSearchPhrase(displayName);
    const exactSpacedName = normalizePackSearchPhrase(name.replace(/_/g, ' '));
    const normalizedName = normalizePackSearchTerm(name);
    const normalizedDisplay = normalizePackSearchTerm(displayName);
    let rank = 0;
    if ((loweredQuery && loweredName === loweredQuery) || (phraseQuery && (exactDisplay === phraseQuery || exactSpacedName === phraseQuery))) rank = 5;
    else if (normalizedQuery && (normalizedName === normalizedQuery || normalizedDisplay === normalizedQuery)) rank = 4;
    else if ((loweredQuery && loweredName.includes(loweredQuery)) || (phraseQuery && (exactDisplay.includes(phraseQuery) || exactSpacedName.includes(phraseQuery)))) rank = 3;
    else if (normalizedQuery && (normalizedName.includes(normalizedQuery) || normalizedDisplay.includes(normalizedQuery))) rank = 2;
    else if (tokens.length && tokens.every(token => loweredName.includes(token) || displayName.toLowerCase().includes(token))) rank = 1;
    if (!rank) return null;
    const info = _lastMatchDetails[name] || {};
    const totalScore = isFinite(_lastVisibleScores[name]) ? _lastVisibleScores[name] : getDisplayScoreValue(null, info);
    return {
      name,
      displayName,
      rank,
      totalScore,
      displayedPctOrder: getDisplayedPctOrderValue(totalScore),
      slotScore: info.slotScore,
      widgetScore: info.widgetScore,
      healthScore: info.healthScore,
      hungerScore: info.hungerScore,
      armorScore: info.armorScore,
      slotCoverage: info.slotCoverage,
      slotCertainty: info.slotCertainty,
      perTypeScores: info.perTypeScores || {},
      slotTypes: info.slotTypes,
    };
  }).filter(Boolean).sort((a, b) =>
    b.displayedPctOrder - a.displayedPctOrder ||
    b.totalScore - a.totalScore ||
    b.rank - a.rank ||
    a.displayName.localeCompare(b.displayName)
  );
}

function escapeMarkdownCell(value) {
  return String(value == null ? '' : value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function updateExportButtonState() {
  const btn = document.getElementById('sbi-export-md-btn');
  if (!btn) return;
  btn.disabled = !_lastRankedResults.length;
}

function buildTop10Markdown() {
  const rows = (_lastRankedResults || []).slice(0, 10);
  if (!rows.length) return '';
  const d = _lastDetectionMeta || {};
  const s = d.searchInfo || null;
  const searchInput = document.getElementById('sbi-search-input');
  const query = searchInput ? searchInput.value.trim() : '';
  const top1Score = rows[0] ? getDisplayScoreValue(rows[0], _lastMatchDetails[rows[0].name] || {}) : 0;
  const top2Score = rows[1] ? getDisplayScoreValue(rows[1], _lastMatchDetails[rows[1].name] || {}) : 0;
  const lines = [
    '# Search by Image Analysis',
    '',
    `- Generated: ${new Date().toISOString()}`,
    `- Phase: ${_lastSearchPhase === 'ai' ? 'AI Enhanced' : 'Hash'}`,
    `- Search Query: ${escapeMarkdownCell(query || '-')}`,
    `- Widget: ${escapeMarkdownCell(formatWidgetRect(d.widgetRect))}`,
    `- Search: ${escapeMarkdownCell(formatSearchInfo(s))}`,
    `- Slots: ${d.slotCount || 0}`,
    `- Slot Types: ${escapeMarkdownCell(getCurrentSlotTypesSummary())}`,
    `- HUD: ${d.heartCount || 0}/${d.hungerCount || 0}/${d.armorCount || 0}`,
    `- Type Weights: DS=${SBI_SCORE_WEIGHTS.type.diamond_sword.toFixed(2)}, EP=${SBI_SCORE_WEIGHTS.type.ender_pearl.toFixed(2)}, HL=${SBI_SCORE_WEIGHTS.type.splash_potion.toFixed(2)}, SK=${SBI_SCORE_WEIGHTS.type.steak.toFixed(2)}, GC=${SBI_SCORE_WEIGHTS.type.golden_carrot.toFixed(2)}`,
    `- HUD Weights: HP=${SBI_SCORE_WEIGHTS.hud.health.toFixed(2)}, Hun=${SBI_SCORE_WEIGHTS.hud.hunger.toFixed(2)}, Arm=${SBI_SCORE_WEIGHTS.hud.armor.toFixed(2)}`,
    `- Mix Weights: withHUD=${SBI_SCORE_WEIGHTS.mix.slot.toFixed(2)}/${SBI_SCORE_WEIGHTS.mix.hud.toFixed(2)}/${SBI_SCORE_WEIGHTS.mix.widget.toFixed(2)}, noHUD=${SBI_SCORE_WEIGHTS.mix.slotNoHud.toFixed(2)}/${SBI_SCORE_WEIGHTS.mix.widgetNoHud.toFixed(2)}`,
    `- Top1 Margin: ${fmtRaw(top1Score - top2Score)}`,
    '',
    '## Top 10',
    '',
    '| # | Pack | Total | DS | EP | HL | SK/GC | Slot | Widget | HP | Hun | Arm | Cover | Cert | Dist | Shared | AnchorPen |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];

  rows.forEach((row, index) => {
    const info = _lastMatchDetails[row.name] || {};
    const packLabel = row.displayName && row.displayName !== row.name
      ? `${row.displayName} (${row.name})`
      : (row.displayName || row.name);
    lines.push(
      `| ${index + 1} | ${escapeMarkdownCell(packLabel)} | ${fmtRaw(getDisplayScoreValue(row, info))} | ${fmtRaw(getPerTypeScore(info, 'DS'))} | ${fmtRaw(getPerTypeScore(info, 'EP'))} | ${fmtRaw(getPerTypeScore(info, 'HL'))} | ${fmtRaw(getPerTypeScore(info, 'SK/GC'))} | ${fmtRaw(info.slotScore)} | ${fmtRaw(info.widgetScore)} | ${fmtRaw(info.healthScore)} | ${fmtRaw(info.hungerScore)} | ${fmtRaw(info.armorScore)} | ${fmtRaw(info.slotCoverage)} | ${fmtRaw(info.slotCertainty)} | ${fmtRaw(info.distinguishability)} | ${fmtRaw(info.sharedness)} | ${fmtRaw(info.anchorPenaltyApplied || info.anchorPenalty)} |`
    );
  });

  rows.forEach((row, index) => {
    const info = _lastMatchDetails[row.name] || {};
    const packLabel = row.displayName && row.displayName !== row.name
      ? `${row.displayName} (${row.name})`
      : (row.displayName || row.name);
    const slotBreakdown = Array.isArray(info.slotBreakdown) ? info.slotBreakdown : [];
    lines.push('');
    lines.push(`### ${index + 1}. ${escapeMarkdownCell(packLabel)}`);
    lines.push('');
    lines.push('| Slot | Type | Score | Alt | Cert | Activity | Quality | Variance |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (let slotIndex = 0; slotIndex < 9; slotIndex++) {
      const entry = slotBreakdown[slotIndex] || {};
      lines.push(
        `| ${slotIndex + 1} | ${escapeMarkdownCell(summarizeSlotType(entry.inferredType))} | ${fmtRaw(entry.score)} | ${fmtRaw(entry.altBest)} | ${fmtRaw(entry.certainty)} | ${fmtRaw(entry.activity)} | ${fmtRaw(entry.quality)} | ${fmtRaw(entry.variance)} |`
      );
    }
  });
  return lines.join('\n');
}

function exportCurrentAnalysis() {
  const markdown = buildTop10Markdown();
  if (!markdown) return;
  const now = new Date();
  const pad = v => String(v).padStart(2, '0');
  const filename = `sbi-top10-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.md`;
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function renderPackScoreSearch() {
  const input = document.getElementById('sbi-search-input');
  const meta = document.getElementById('sbi-search-meta');
  const slotTypesEl = document.getElementById('sbi-search-slot-types');
  const el = document.getElementById('sbi-search-results');
  if (!input || !meta || !slotTypesEl || !el) return;

  const query = input.value.trim();
  if (!Object.keys(_lastMatchDetails).length) {
    meta.textContent = 'Upload a screenshot to search current scores.';
    slotTypesEl.hidden = true;
    slotTypesEl.textContent = '';
    el.hidden = true;
    el.innerHTML = '';
    updateExportButtonState();
    return;
  }
  if (!query) {
    meta.textContent = 'Enter a pack name to inspect related score details.';
    slotTypesEl.hidden = true;
    slotTypesEl.textContent = '';
    el.hidden = true;
    el.innerHTML = '';
    updateExportButtonState();
    return;
  }

  const matches = findPackScoreMatches(query).slice(0, 30);
  meta.textContent = matches.length
    ? `Found ${matches.length} related pack${matches.length === 1 ? '' : 's'}.`
    : 'No related packs found.';
  if (!matches.length) {
    slotTypesEl.hidden = true;
    slotTypesEl.textContent = '';
    el.hidden = true;
    el.innerHTML = '';
    updateExportButtonState();
    return;
  }

  slotTypesEl.hidden = false;
  slotTypesEl.textContent = `Slot Types: ${getCurrentSlotTypesSummary()}`;
  el.hidden = false;
  el.innerHTML = `
    <table class="sbi-search-table">
      <thead>
        <tr><th>#</th><th>Pack</th><th>Total</th><th title="Hover or tap to show DS / EP / HL / SK/GC">Slot</th><th>Widget</th><th>HP</th><th>Hun</th><th>Arm</th><th>Cover</th><th>Cert</th></tr>
      </thead>
      <tbody>${matches.map((row, index) => `
        <tr data-pack="${row.name.replace(/"/g, '&quot;')}">
          <td>${index + 1}</td>
          <td title="${row.name}"><a href="/p/${encodeURIComponent(row.name)}/" target="_blank" rel="noopener noreferrer">${row.displayName}</a></td>
          <td>${fmtPct(row.totalScore)}</td>
          <td class="sbi-score-slot-cell" title="Hover or tap to show DS / EP / HL / SK/GC">${fmtPct(row.slotScore)}</td>
          <td>${fmtPct(row.widgetScore)}</td>
          <td>${fmtPct(row.healthScore)}</td>
          <td>${fmtPct(row.hungerScore)}</td>
          <td>${fmtPct(row.armorScore)}</td>
          <td>${fmtPct(row.slotCoverage)}</td>
          <td>${fmtPct(row.slotCertainty)}</td>
        </tr>
      `).join('')}</tbody>
    </table>
  `;
  updateExportButtonState();
}

function handleClipResults(clipScores) {
  if (!ENABLE_CLIP) return;
  const statusEl = document.getElementById('sbi-clip-status');
  const sortedClip = [...clipScores].sort((a, b) => b.clipScore - a.clipScore);
  // Build lookup: packName → normalized clip score (per-query range over returned top-K)
  const clipMap = {};
  const maxRaw = sortedClip.length ? sortedClip[0].clipScore : 0;
  const minRaw = sortedClip.length ? sortedClip[sortedClip.length - 1].clipScore : maxRaw;
  const denom = maxRaw - minRaw;
  for (const s of sortedClip) {
    const v = denom > 1e-6 ? (s.clipScore - minRaw) / denom : 0.5;
    clipMap[s.name] = clamp01(v);
  }
  _lastClipScores = clipMap;

  // Combine: hash with CLIP rerank (never let CLIP drag a strong hash match below zero-confidence floor)
  const combined = [];
  const allNames = new Set([
    ..._lastHashResults.map(r => r.name),
    ...sortedClip.slice(0, 40).map(s => s.name)
  ]);
  for (const name of allNames) {
    const hashScore = _lastAllScores[name] || 0;
    const hasClip = Object.prototype.hasOwnProperty.call(clipMap, name);
    const clipScore = hasClip ? clipMap[name] : 0;
    const hasHash = hashScore > 0;
    let score;
    if (hasHash && hasClip) score = hashScore * (CLIP_RERANK_BASE + CLIP_RERANK_WEIGHT * clipScore);
    else if (hasHash) score = hashScore;
    else if (hasClip) score = clipScore * CLIP_ONLY_SCALE;
    else score = 0;
    combined.push({ name, score });
  }
  combined.sort((a, b) => b.score - a.score);
  assignDisplayScores(combined, _lastMatchDetails);
  _lastVisibleScores = {};
  for (const row of combined) _lastVisibleScores[row.name] = getDisplayScoreValue(row, _lastMatchDetails[row.name]);
  _lastRankedResults = combined.slice();
  _lastSearchPhase = 'ai';
  const top10 = combined.slice(0, 10);
  renderResults(combined.slice(0, 50), 'AI Enhanced');
  renderDebugPanel(top10, 'ai');
  renderPackScoreSearch();
  updateExportButtonState();
  applyDebugVisibility();
  if (statusEl) { statusEl.hidden = true; statusEl.textContent = ''; statusEl.dataset.state = 'ready'; }

  const thumbCanvas = document.createElement('canvas');
  const origCanvas = document.getElementById('sbi-canvas');
  thumbCanvas.width = 320; thumbCanvas.height = Math.round(320 * origCanvas.height / origCanvas.width);
  thumbCanvas.getContext('2d').drawImage(origCanvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
  saveHistory(thumbCanvas.toDataURL('image/jpeg', 0.6), top10);
}

// --- Feature computation ---

// dHash per RGB channel: 192 bits (64 per channel), color-aware
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

function compareSpatialMetrics(extracted, packTex) {
  if (!extracted || !extracted.pix || !packTex || !packTex.pix) return null;
  const a = extracted.pix;
  const b = packTex.__pixBytes || (packTex.__pixBytes = base64ToBytes(packTex.pix));
  if (a.length !== b.length) return null;
  const size = Math.sqrt(a.length / 4);
  if (!Number.isInteger(size) || size < 4) return null;
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
    const canvas = document.createElement('canvas');
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
    : new ImageData(effectiveData, w, h);

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
  const widgetMasked = new ImageData(maskedData || maskWidgetItems(widgetStrip.data, 182, 22), 182, 22);
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

function bboxOfBoxes(boxes) {
  if (!boxes || !boxes.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of boxes) {
    if (!b) continue;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) return null;
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

function alphaColor(color, alpha) {
  if (!isFinite(alpha)) return color;
  const m = /^#([0-9a-f]{6})$/i.exec(color || '');
  if (m) {
    const hex = m[1];
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*[\d.]+\s*)?\)$/i.exec(color || '');
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
  return color;
}

function getSlotDisplayRect(slot, imgW, imgH) {
  if (!slot) return null;
  const src = slot.displayRect || slot;
  const sx = Math.round(src.x);
  const sy = Math.round(src.y);
  const ss = Math.max(2, Math.round(src.sz));
  let left = sx;
  let top = sy;
  let right = sx + ss;
  let bottom = sy + ss;
  if (left < 0) left = 0;
  if (top < 0) top = 0;
  if (right > imgW) right = imgW;
  if (bottom > imgH) bottom = imgH;
  const side = Math.min(right - left, bottom - top);
  if (side < 2) return null;
  return { x: left, y: top, sz: side };
}


function renderCropCanvas(id, imageData) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  if (!imageData) { canvas.classList.add('sbi-crop-hidden'); return; }
  canvas.classList.remove('sbi-crop-hidden');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext('2d').putImageData(imageData, 0, 0);
}

function renderItemCropCanvas(id, ctx, imgW, imgH, slot, outSize) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  if (!slot) { canvas.classList.add('sbi-crop-hidden'); return; }
  const sx = Math.round(slot.x);
  const sy = Math.round(slot.y);
  const sw = Math.max(2, Math.round(slot.sz));
  const sh = sw;
  if (sx < 0 || sy < 0 || sx + sw > imgW || sy + sh > imgH) { canvas.classList.add('sbi-crop-hidden'); return; }

  const size = outSize || Math.max(96, sw * 2);
  canvas.classList.remove('sbi-crop-hidden');
  canvas.width = size;
  canvas.height = size;
  const cctx = canvas.getContext('2d');
  cctx.imageSmoothingEnabled = false;
  cctx.fillStyle = '#141414';
  cctx.fillRect(0, 0, size, size);
  cctx.drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, size, size);
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

function renderCrops(ctx, imgW, imgH, widgetRect, hudFeatures, slots, slotTypes, preset) {
  const wrap = document.getElementById('sbi-crops');
  if (!wrap) return;
  if (!widgetRect) { wrap.hidden = true; return; }

  const aspect = imgH / Math.max(1, imgW);
  const dRect = aspect < 0.35 ? widgetRect : findDisplayWidgetRect(ctx, imgW, imgH, widgetRect, preset);
  const unit = dRect.w / 182;

  renderCropCanvas(
    'sbi-crop-hotbar',
    extractRegion(ctx, dRect.x, dRect.y, dRect.w, dRect.h, 256, Math.max(1, Math.round(256 * dRect.h / dRect.w)))
  );

  const iconH = 9 * unit;
  const barW = 81 * unit;
  const heartsY = dRect.y - 17 * unit;
  const armorY = heartsY - 10 * unit;
  const hudShift = getHudHorizontalShift(unit, imgW, imgH);
  const leftX = dRect.x + hudShift;
  const rightX = dRect.x + 101 * unit - hudShift;
  const renderBar = (id, x, y, w, h) => {
    const ix = Math.round(x), iy = Math.round(y), iw = Math.round(w), ih = Math.round(h);
    if (ix < 0 || iy < 0 || ix + iw > imgW || iy + ih > imgH || iw < 2 || ih < 2) {
      renderCropCanvas(id, null); return;
    }
    const outW = 256, outH = Math.max(1, Math.round(outW * ih / iw));
    renderCropCanvas(id, extractRegion(ctx, ix, iy, iw, ih, outW, outH));
  };
  renderBar('sbi-crop-armor', leftX, armorY, barW, iconH);
  renderBar('sbi-crop-health', leftX, heartsY, barW, iconH);
  renderBar('sbi-crop-hunger', rightX, heartsY, barW, iconH);

  const renderSlot = (id, index, outSize) => {
    const canvas = document.getElementById(id);
    if (!canvas) return;
    const rx = Math.round(dRect.x + (3 + index * 20) * unit);
    const ry = Math.round(dRect.y + 3 * unit);
    const rsz = Math.round(16 * unit);
    let left = Math.max(0, rx), top = Math.max(0, ry);
    let right = Math.min(imgW, rx + rsz), bottom = Math.min(imgH, ry + rsz);
    const side = Math.min(right - left, bottom - top);
    if (side < 2) { canvas.classList.add('sbi-crop-hidden'); return; }
    canvas.classList.remove('sbi-crop-hidden');
    canvas.width = outSize;
    canvas.height = outSize;
    const cctx = canvas.getContext('2d');
    cctx.imageSmoothingEnabled = false;
    cctx.fillStyle = '#141414';
    cctx.fillRect(0, 0, outSize, outSize);
    cctx.drawImage(ctx.canvas, left, top, side, side, 0, 0, outSize, outSize);
  };
  const renderSolidSlot = (id, outSize, fill) => {
    const canvas = document.getElementById(id);
    if (!canvas) return;
    canvas.classList.remove('sbi-crop-hidden');
    canvas.width = outSize;
    canvas.height = outSize;
    const cctx = canvas.getContext('2d');
    cctx.imageSmoothingEnabled = false;
    cctx.fillStyle = fill;
    cctx.fillRect(0, 0, outSize, outSize);
  };
  renderSlot('sbi-crop-ds', 0, 96);
  renderSlot('sbi-crop-ep', 1, 96);
  renderSlot('sbi-crop-hl', 5, 96);
  if (slotTypes && ['steak', 'golden_carrot'].includes(slotTypes[8])) renderSlot('sbi-crop-food', 8, 96);
  else renderSolidSlot('sbi-crop-food', 96, '#000000');

  wrap.hidden = false;
}

function buildClipCompositePixels(ctx, imgW, imgH, widgetRect, slots, slotTypes) {
  if (!widgetRect || !slots || !slots.length) return null;

  const W = 224, H = 224, HALF = 112;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const cctx = c.getContext('2d', { willReadFrequently: true });
  cctx.imageSmoothingEnabled = false;
  cctx.fillStyle = 'rgb(20,20,20)';
  cctx.fillRect(0, 0, W, H);

  // Top: hotbar widget strip
  cctx.drawImage(ctx.canvas, widgetRect.x, widgetRect.y, widgetRect.w, widgetRect.h, 0, 0, W, HALF);

  const swordSlot = pickSlotForClip(slots, slotTypes, 'diamond_sword', 0);
  const pearlSlot = pickSlotForClip(slots, slotTypes, 'ender_pearl', 1);

  const itemCanvas = document.createElement('canvas');
  itemCanvas.width = 16; itemCanvas.height = 16;
  const ictx = itemCanvas.getContext('2d', { willReadFrequently: true });
  ictx.imageSmoothingEnabled = false;

  const drawItem = (slot, dx, dy) => {
    if (!slot) return;
    const inset = Math.max(1, Math.round(slot.sz * 0.12));
    const sx = Math.round(slot.x + inset);
    const sy = Math.round(slot.y + inset);
    const sw = Math.max(2, Math.round(slot.sz - inset * 2));
    const sh = Math.max(2, Math.round(slot.sz - inset * 2));
    if (sx < 0 || sy < 0 || sx + sw > imgW || sy + sh > imgH) return;

    // Remove slot BG + HUD-like overlays to better match thumbnail composites (transparent texture over dark bg).
    const region = extractRegion(ctx, sx, sy, sw, sh, 16, 16);
    let eff = maskSlotNoise(region.data, 16, 16);
    eff = suppressSlotBackground(eff, 16, 16);
    eff = zeroRgbForTransparent(eff);
    ictx.putImageData(new ImageData(eff, 16, 16), 0, 0);
    cctx.drawImage(itemCanvas, 0, 0, 16, 16, dx, dy, HALF, HALF);
  };

  // Bottom: sword (left) + pearl (right), matching the embedding composite layout.
  drawItem(swordSlot, 0, HALF);
  drawItem(pearlSlot, HALF, HALF);

  const img = cctx.getImageData(0, 0, W, H);
  return img.data.buffer.slice(0);
}

// --- Hotbar extraction ---
// Strict proportional crop only: centered hotbar + fixed bottom ratio candidates
function extractHotbarSlots(ctx, imgW, imgH, preset) {
  const candidates = buildStrictCropCandidates(imgW, imgH);
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
    const score = (0.70 * gridScore + 0.30 * bottomPref) * (0.90 + 0.10 * unitPref);
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
    const boostedCombined = combinedBoost * geomBoost;
    const confidence = activeCount * 220 + totalActivity * 160 + totalQuality * 6 + hudCoverage * 700;
    const result = {
      unit: c.unit,
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
    const fixedRect = findDisplayWidgetRect(ctx, imgW, imgH, bestWidgetRect, preset);
    const bestGU = fixedRect && fixedRect.w ? (fixedRect.w / 182) : (bestWidgetRect.w / 182);
    if (fixedRect) {
      bestWidgetRect = fixedRect;
      bestWidgetFeatures = extractWidgetFeatures(ctx, bestWidgetRect);
      bestHudFeatures = extractHudFeatures(ctx, bestWidgetRect, imgW, imgH);
      for (let i = 0; i < bestSlots.length; i++) {
        bestSlots[i].displayRect = {
          x: bestWidgetRect.x + (1 + i * 20) * bestGU,
          y: bestWidgetRect.y + bestGU,
          sz: 20 * bestGU,
        };
      }
      if (bestSearchInfo) {
        bestSearchInfo.snappedUnit = bestGU;
        bestSearchInfo.bottomOffset = Math.max(0, Math.round(imgH - (bestWidgetRect.y + bestWidgetRect.h)));
        bestSearchInfo.mode = 'strict-ratio-snapped';
      }
    }
  }
  hydrateSlotVariants(ctx, bestSlots, imgW, imgH);

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
  if (!slot || !packTex) return null;
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
    if (!packData || !packData[targetType]) continue;
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

function scoreGlobalCoarseMatch(groupId, packData, anchorSlots, widgetFeatures, hudFeatures) {
  let weighted = 0, weights = 0;
  for (const anchor of (anchorSlots || [])) {
    const extracted = anchor.slot && anchor.slot.features;
    const packTex = packData && packData[anchor.type];
    if (!extracted || !packTex || !extracted.dhash || !packTex.dhash) continue;
    const packHash = packTex.__dhashBytes || (packTex.__dhashBytes = base64ToBytes(packTex.dhash));
    const hashBits = Math.max(1, Math.min(extracted.dhash.length, packHash.length) * 8);
    const hashSim = clamp01(1 - hammingDistance(extracted.dhash, packHash) / hashBits);
    const sigSim = signatureSimilarity(extracted.sig, packTex.sig, anchor.type);
    const colorSim = extracted.moments && packTex.moments
      ? clamp01(colorMomentSim(extracted.moments, packTex.moments))
      : 0;
    const rarity = getSurfaceRarity(groupId, anchor.type);
    const strength = anchor.strength || 1;
    weighted += (hashSim * 0.46 + sigSim * 0.34 + colorSim * 0.20) * rarity * strength;
    weights += strength;
  }
  return weights ? weighted / weights : null;
}

function selectGlobalCoarseEntries(allEntries, anchorSlots, widgetFeatures, hudFeatures, previousResults, metrics, mode) {
  const hasSignals = anchorSlots && anchorSlots.length;
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
      score: scoreGlobalCoarseMatch(entry[0], entry[1], anchorSlots, widgetFeatures, hudFeatures),
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

function matchPacks(slots, widgetFeatures, hudFeatures) {
  if (!slots.length) return { results: [], slotTypes: [], details: {} };
  const matchStart = nowMs();
  const inferenceStart = nowMs();
  const displaySlotTypes = inferDisplaySlotTypes(slots);
  const displayTypeCounts = countDisplaySlotTypes(displaySlotTypes);
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
  const candidatePlan = getSignaturePrefilterCandidates(slots, displaySlotTypes);
  const anchorSlots = candidatePlan && candidatePlan.anchorSlots
    ? candidatePlan.anchorSlots
    : getAnchorSlotsByType(slots, displaySlotTypes);
  const fullScoreEntries = candidatePlan
    ? selectCandidateFullScoreEntries(allPackEntries, candidatePlan, metrics)
    : selectGlobalCoarseEntries(allPackEntries, anchorSlots, widgetFeatures, hudFeatures, [], metrics, 'global-initial');
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
      info.finalScore = gatedRawScore;
      results.push({ name: row.name, score: gatedRawScore });
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
      'global-fallback'
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

function getPresetUnit(imgW, imgH, preset) {
  if (preset === 'auto') return 0;
  const base = getWide16By9Unit(imgW, imgH) || getMaxGuiScale(imgW, imgH);
  if (preset === 'small') return Math.max(1, Math.ceil(base) - 1);
  return base;
}

function scoreColor(pct) {
  if (pct >= 80) return '#22c55e';
  if (pct >= 65) return '#f59e0b';
  return '#ef4444';
}

const SBI_MODE_KEY = 'vale-sbi-display-mode';
function getSbiDisplayMode() {
  try { return localStorage.getItem(SBI_MODE_KEY) || 'lite'; } catch { return 'lite'; }
}
function setSbiDisplayMode(mode) {
  try { localStorage.setItem(SBI_MODE_KEY, mode); } catch {}
  updateModeToggleUI(mode);
  if (_lastRankedResults.length > 0) renderResults(_lastRankedResults.slice(0, 50));
}
function updateModeToggleUI(mode) {
  const toggle = document.getElementById('sbi-mode-toggle');
  if (!toggle) return;
  toggle.querySelectorAll('.sbi-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
}

const SBI_DEBUG_KEY = 'vale-sbi-debug-mode';
function getSbiDebugMode() {
  try { return localStorage.getItem(SBI_DEBUG_KEY) === 'true'; } catch { return false; }
}
function setSbiDebugMode(on) {
  try { localStorage.setItem(SBI_DEBUG_KEY, on ? 'true' : 'false'); } catch {}
  updateDebugModeUI();
  applyDebugVisibility();
}
function updateDebugModeUI() {
  const btn = document.getElementById('sbi-debug-toggle-btn');
  if (!btn) return;
  const on = getSbiDebugMode();
  btn.textContent = on ? 'Debug Mode: ON' : 'Debug Mode: OFF';
  btn.classList.toggle('active', on);
}
function applyDebugVisibility() {
  const on = getSbiDebugMode();
  const ids = ['sbi-crops', 'sbi-debug', 'sbi-breakdown', 'sbi-search-wrap'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('sbi-debug-only-hidden', !on);
  });
}

function getTextureThumbUrl(packName, fileName) {
  return `/thumbnails/${encodeURIComponent(packName)}/${fileName}`;
}

function renderLiteTextureThumb(packName, fileName) {
  const src = getTextureThumbUrl(packName, fileName);
  return `<img class="sbi-lite-item" data-sbi-animated-texture src="${src}" alt="" onerror="this.style.display='none'">`;
}

function activateAnimatedTextureThumb(img) {
  if (!img || img.dataset.sbiAnimatedReady === 'true') return;
  img.dataset.sbiAnimatedReady = 'true';
  const width = img.naturalWidth || 0;
  const height = img.naturalHeight || 0;
  if (!width || height <= width || height % width !== 0) {
    img.style.visibility = 'visible';
    return;
  }
  const frames = height / width;
  if (!Number.isInteger(frames) || frames <= 1) {
    img.style.visibility = 'visible';
    return;
  }
  const wrapper = document.createElement('div');
  wrapper.className = 'sbi-lite-item-anim';
  wrapper.style.backgroundImage = `url(${img.currentSrc || img.src})`;
  wrapper.style.backgroundSize = `100% ${frames * 100}%`;
  let frameTime = 2;
  fetch(`${img.currentSrc || img.src}.mcmeta`)
    .then(r => r.ok ? r.json() : null)
    .then(mcmeta => {
      if (mcmeta && mcmeta.animation && Number.isFinite(mcmeta.animation.frametime) && mcmeta.animation.frametime > 0) {
        frameTime = mcmeta.animation.frametime;
      }
    })
    .catch(() => null)
    .finally(() => {
      let currentFrame = 0;
      const updateFrame = () => {
        wrapper.style.backgroundPosition = `0 ${(currentFrame / Math.max(1, frames - 1)) * 100}%`;
      };
      updateFrame();
      const intervalId = window.setInterval(() => {
        if (!wrapper.isConnected) {
          window.clearInterval(intervalId);
          return;
        }
        currentFrame = (currentFrame + 1) % frames;
        updateFrame();
      }, frameTime * 50);
    });
  img.replaceWith(wrapper);
}

function bindAnimatedTextureThumbs(scope) {
  (scope || document).querySelectorAll('img[data-sbi-animated-texture]').forEach(img => {
    if (img.complete) activateAnimatedTextureThumb(img);
    else {
      img.style.visibility = 'hidden';
      img.addEventListener('load', () => activateAnimatedTextureThumb(img), { once: true });
    }
  });
}

function renderResultCard(r, i, mode) {
  const pct = Math.min(100, Math.round(getDisplayScoreValue(r, _lastMatchDetails[r.name]) * 100));
  const color = scoreColor(pct);
  const coverUrl = '/thumbnails/' + encodeURIComponent(r.name) + '/cover.png';
  const packPng = '/thumbnails/' + encodeURIComponent(r.name) + '/pack.png';
  const nameHtml = getPackColoredName(r.name);
  const rightContent = mode === 'lite'
    ? `<span class="sbi-lite-items">${[
        'diamond_sword.png',
        'ender_pearl.png',
        'splash_potion_of_healing.png',
        'steak.png',
        'golden_carrot.png',
      ].map(fileName => renderLiteTextureThumb(r.name, fileName)).join('')}</span>`
    : `<span class="sbi-divider"></span><img class="sbi-result-cover" src="${coverUrl}" onerror="this.src='${packPng}'">`;
  return `<a class="sbi-result-card" href="/p/${encodeURIComponent(r.name)}/" target="_blank" rel="noopener noreferrer">
      <span class="sbi-rank">${i + 1}</span>
      <span class="sbi-divider"></span>
      <span class="sbi-score" style="color:${color}">${pct}%</span>
      <span class="sbi-divider"></span>
      <img class="sbi-pack-icon" src="${packPng}" onerror="this.style.display='none'">
      <span class="sbi-result-name">${nameHtml}</span>
      ${rightContent}
    </a>`;
}

const SBI_PAGE_SIZE = 10;

function renderResults(results, label) {
  const container = document.getElementById('sbi-results');
  const modeToggle = document.getElementById('sbi-mode-toggle');
  if (results.length === 0) {
    container.innerHTML = '<p class="sbi-no-results">No matching packs found</p>';
    container.hidden = false;
    if (modeToggle) modeToggle.hidden = true;
    return;
  }
  let visible = SBI_PAGE_SIZE;
  const header = label ? `<div class="sbi-results-label">${label}</div>` : '';
  const mode = getSbiDisplayMode();

  function draw() {
    const shown = results.slice(0, visible);
    container.innerHTML = header + shown.map((r, i) => renderResultCard(r, i, mode)).join('')
      + (visible < results.length ? `<button class="sbi-action-btn sbi-show-more-btn" id="sbi-show-more">Show more results</button>` : '');
    bindAnimatedTextureThumbs(container);
    document.getElementById('sbi-show-more')?.addEventListener('click', () => {
      visible += SBI_PAGE_SIZE;
      draw();
    });
  }
  draw();
  container.hidden = false;
  if (modeToggle) { modeToggle.hidden = false; updateModeToggleUI(mode); }
}

function saveHistory(imageDataUrl, results) {
  const KEY = 'vale-sbi-history';
  let history = [];
  try { history = JSON.parse(localStorage.getItem(KEY)) || []; } catch {}
  history.unshift({
    id: Date.now(),
    timestamp: new Date().toISOString(),
    imageDataUrl,
    results: results.map(r => ({
      name: r.name, score: getDisplayScoreValue(r, _lastMatchDetails[r.name]),
      cover: '/thumbnails/' + r.name + '/cover.png',
      packPng: '/thumbnails/' + r.name + '/pack.png'
    }))
  });
  if (history.length > 5) history.length = 5;
  try { localStorage.setItem(KEY, JSON.stringify(history)); } catch {}
}

async function processImage(file) {
  const preview = document.getElementById('sbi-preview');
  const progress = document.getElementById('sbi-progress');
  const resultsEl = document.getElementById('sbi-results');
  const cropsEl = document.getElementById('sbi-crops');
  const debugPanel = document.getElementById('sbi-debug');
  const breakdownPanel = document.getElementById('sbi-breakdown');
  const debugBody = document.getElementById('sbi-debug-body');
  const debugMeta = document.getElementById('sbi-debug-meta');
  const uploadEl = document.getElementById('sbi-upload');
  const searchWrap = document.getElementById('sbi-search-wrap');
  const modeToggle = document.getElementById('sbi-mode-toggle');
  resultsEl.hidden = true;
  progress.hidden = false;
  preview.hidden = true;
  if (cropsEl) cropsEl.hidden = true;
  if (debugPanel) debugPanel.hidden = true;
  if (breakdownPanel) breakdownPanel.hidden = true;
  if (debugBody) debugBody.innerHTML = '';
  if (debugMeta) debugMeta.textContent = '';
  if (searchWrap) searchWrap.hidden = true;
  if (modeToggle) modeToggle.hidden = true;
  if (uploadEl) uploadEl.classList.add('analyzing');
  setUploadReplaceHover(false);
  clearPreviewCacheImage();
  _lastMatchDetails = {};
  _lastAllScores = {};
  _lastVisibleScores = {};
  _lastMatchMetrics = {};
  _lastRankedResults = [];
  _lastSearchPhase = 'hash';
  renderPackScoreSearch();
  updateExportButtonState();

  const img = new Image();
  const url = URL.createObjectURL(file);
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });

  const rawCanvas = document.createElement('canvas');
  rawCanvas.width = img.width;
  rawCanvas.height = img.height;
  const rawCtx = rawCanvas.getContext('2d', { willReadFrequently: true });
  rawCtx.drawImage(img, 0, 0);

  const canvas = document.getElementById('sbi-canvas');
  canvas.width = img.width; canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);

  try {
    await ensureFingerprints(SBI_BASE_FINGERPRINT_SHARDS);

    const { slots, widgetFeatures, widgetRect, hudFeatures, searchInfo } = extractHotbarSlots(rawCtx, img.width, img.height, _currentPreset);
    await ensureFingerprintsForSlots(slots);

    // Stage 1: Hash-based instant results
    const { results, slotTypes, details } = matchPacks(slots, widgetFeatures, hudFeatures);
    const stage1Top10 = results.slice(0, 10);    _lastMatchDetails = details || {};
    _lastClipScores = {};
    _lastDetectionMeta = {
      widgetRect,
      searchInfo,
      slotCount: slots.length,
      heartCount: hudFeatures && hudFeatures.hearts ? hudFeatures.hearts.length : 0,
      hungerCount: hudFeatures && hudFeatures.hunger ? hudFeatures.hunger.length : 0,
      armorCount: hudFeatures && hudFeatures.armor ? hudFeatures.armor.length : 0,
    };
    renderCrops(rawCtx, img.width, img.height, widgetRect, hudFeatures, slots, slotTypes, _currentPreset);

    // Phase 2: Show the raw screenshot and place the cropbox on a separate layer
    ctx.drawImage(rawCanvas, 0, 0);
    await updatePreviewCacheImage('cropbox_large_analysed.png');
    renderPreviewCropbox(img.width, img.height, widgetRect, slotTypes, slots);
    preview.hidden = false;
    progress.hidden = true;
    if (uploadEl) uploadEl.classList.remove('analyzing');
    syncUploadPreviewState();
    if (uploadEl && uploadEl.matches(':hover')) setUploadReplaceHover(true);
    if (searchWrap) searchWrap.hidden = false;
    if (breakdownPanel) breakdownPanel.hidden = false;
    _lastRankedResults = results.slice();
    renderResults(results.slice(0, 50));
    renderDebugPanel(stage1Top10, 'hash');
    _lastVisibleScores = {};
    for (const [name, info] of Object.entries(details)) _lastVisibleScores[name] = getDisplayScoreValue(null, info);
    _lastSearchPhase = 'hash';
    renderPackScoreSearch();
    updateExportButtonState();
    applyDebugVisibility();

    // Cache hash scores for later CLIP combination
    _lastHashResults = results.slice(0, 40);
    _lastAllScores = {};
    for (const [name, info] of Object.entries(details)) _lastAllScores[name] = isFinite(info.finalScore) ? info.finalScore : 0;

    // Stage 2: CLIP refinement (async)
    if (ENABLE_CLIP && widgetRect && slots.length > 0) {
      const statusEl = document.getElementById('sbi-clip-status');
      if (statusEl) { statusEl.hidden = true; statusEl.textContent = ''; }
      if (clipWorkerError) {
        if (statusEl) { statusEl.hidden = false; statusEl.textContent = 'AI unavailable: ' + clipWorkerError; statusEl.dataset.state = 'error'; }
      }

      if (!clipWorkerError && widgetRect.x >= 0 && widgetRect.y >= 0 && widgetRect.x + widgetRect.w <= img.width && widgetRect.y + widgetRect.h <= img.height) {
        const pixels = buildClipCompositePixels(rawCtx, img.width, img.height, widgetRect, slots, slotTypes);
        if (pixels) {
          const sendSearch = () => clipWorker.postMessage({ type: 'search', pixels, width: 224, height: 224 }, [pixels]);
          if (clipWorkerReady) sendSearch();
          else {
            const check = setInterval(() => {
              if (clipWorkerReady) {
                clearInterval(check);
                clearTimeout(waitTimeout);
                sendSearch();
              } else if (clipWorkerError) {
                clearInterval(check);
                clearTimeout(waitTimeout);
                if (statusEl) { statusEl.hidden = false; statusEl.textContent = 'AI unavailable: ' + clipWorkerError; statusEl.dataset.state = 'error'; }
              }
            }, 200);
            const waitTimeout = setTimeout(() => {
              clearInterval(check);
              if (!clipWorkerReady && statusEl) {
                statusEl.textContent = 'AI model still loading, showing hash results only.';
                statusEl.dataset.state = 'error';
              }
            }, 30000);
          }
        }
      }
    }

    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = 320; thumbCanvas.height = Math.round(320 * img.height / img.width);
    thumbCanvas.getContext('2d').drawImage(img, 0, 0, thumbCanvas.width, thumbCanvas.height);
    saveHistory(thumbCanvas.toDataURL('image/jpeg', 0.6), stage1Top10);
  } catch (e) {
    progress.hidden = true;
    if (uploadEl) uploadEl.classList.remove('analyzing');
    syncUploadPreviewState();
    const container = document.getElementById('sbi-results');
    container.innerHTML = '<p class="sbi-no-results">Error: ' + e.message + '</p>';
    container.hidden = false;
    console.error('SBI error:', e);
  }

  URL.revokeObjectURL(url);
}

function drawCropboxPreview() {
  renderUploadCropbox(1920, 1080);
}

function redrawUploadPreview() {
  if (!_pendingImage) { drawCropboxPreview(); return; }
  renderUploadCropbox(_pendingImage.width, _pendingImage.height);
}

function loadImagePreview(file) {
  _pendingFile = file;
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    _pendingImage = img;
    const imgEl = document.getElementById('sbi-cropbox-image');
    if (imgEl) {
      if (_pendingImageUrl) URL.revokeObjectURL(_pendingImageUrl);
      _pendingImageUrl = URL.createObjectURL(file);
      imgEl.src = _pendingImageUrl;
      imgEl.hidden = false;
    }
    URL.revokeObjectURL(url);
    redrawUploadPreview();
    syncUploadPreviewState();
    document.getElementById('sbi-search-btn').disabled = false;
    document.getElementById('sbi-clear-btn').disabled = false;
  };
  img.src = url;
}

function clearImagePreview() {
  _pendingFile = null;
  _pendingImage = null;
  const imgEl = document.getElementById('sbi-cropbox-image');
  if (imgEl) {
    imgEl.hidden = true;
    imgEl.removeAttribute('src');
  }
  if (_pendingImageUrl) {
    URL.revokeObjectURL(_pendingImageUrl);
    _pendingImageUrl = '';
  }
  drawCropboxPreview();
  syncUploadPreviewState();
  setUploadReplaceHover(false);
  document.getElementById('sbi-search-btn').disabled = true;
  document.getElementById('sbi-clear-btn').disabled = true;
}

function handleImageInput(file) {
  if (_autoSearch) {
    loadImagePreview(file);
    processImage(file);
  } else {
    loadImagePreview(file);
  }
}

function setPreset(preset) {
  _currentPreset = preset;
  try { localStorage.setItem('sbi-preset', preset); } catch {}
  document.querySelectorAll('.sbi-preset-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.preset === preset);
  });
  redrawUploadPreview();
}

function init() {
  const uploadEl = document.getElementById('sbi-upload');
  const fileInput = document.getElementById('sbi-file');

  // Load pack display/colored names for result rows (same source as homepage).
  ensurePackNameIndex().then(() => {
    if (_lastRankedResults.length > 0) renderResults(_lastRankedResults.slice(0, 50));
  });

  // Restore preset from localStorage
  try { _currentPreset = localStorage.getItem('sbi-preset') || 'large'; } catch {}
  document.querySelectorAll('.sbi-preset-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.preset === _currentPreset);
    btn.addEventListener('click', () => setPreset(btn.dataset.preset));
  });

  // Draw cropbox preview inside upload area
  drawCropboxPreview();
  if (_uploadPreviewResizeObserver) _uploadPreviewResizeObserver.disconnect();
  if (window.ResizeObserver) {
    _uploadPreviewResizeObserver = new ResizeObserver(() => redrawUploadPreview());
    _uploadPreviewResizeObserver.observe(uploadEl);
  } else {
    window.addEventListener('resize', redrawUploadPreview);
  }

  // Hide search wrap until analysis completes
  const searchWrap = document.getElementById('sbi-search-wrap');
  if (searchWrap) searchWrap.hidden = true;
  const breakdownPanel = document.getElementById('sbi-breakdown');
  if (breakdownPanel) breakdownPanel.hidden = !getSbiDebugMode();

  // Restore auto-search from localStorage
  const autoSearchCb = document.getElementById('sbi-auto-search');
  try { _autoSearch = localStorage.getItem('sbi-auto-search') === 'true'; } catch {}
  if (autoSearchCb) {
    autoSearchCb.checked = _autoSearch;
    autoSearchCb.addEventListener('change', () => {
      _autoSearch = autoSearchCb.checked;
      try { localStorage.setItem('sbi-auto-search', String(_autoSearch)); } catch {}
    });
  }

  uploadEl.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => { if (e.target.files[0]) handleImageInput(e.target.files[0]); });
  uploadEl.addEventListener('mouseenter', () => setUploadReplaceHover(true));
  uploadEl.addEventListener('mouseleave', () => setUploadReplaceHover(false));
  uploadEl.addEventListener('dragover', e => {
    e.preventDefault();
    uploadEl.classList.add('dragover');
    setUploadReplaceHover(true);
  });
  uploadEl.addEventListener('dragleave', () => {
    uploadEl.classList.remove('dragover');
    setUploadReplaceHover(false);
  });
  uploadEl.addEventListener('drop', e => {
    e.preventDefault(); uploadEl.classList.remove('dragover');
    setUploadReplaceHover(false);
    if (e.dataTransfer.files[0]) handleImageInput(e.dataTransfer.files[0]);
  });
  document.addEventListener('paste', e => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) { handleImageInput(item.getAsFile()); break; }
    }
  });

  // Search / Clear buttons
  const searchBtn = document.getElementById('sbi-search-btn');
  const clearBtn = document.getElementById('sbi-clear-btn');
  const exportBtn = document.getElementById('sbi-export-md-btn');
  if (searchBtn) searchBtn.addEventListener('click', () => { if (_pendingFile) processImage(_pendingFile); });
  if (clearBtn) clearBtn.addEventListener('click', () => clearImagePreview());
  if (exportBtn) exportBtn.addEventListener('click', () => exportCurrentAnalysis());

  const debugToggleBtn = document.getElementById('sbi-debug-toggle-btn');
  if (debugToggleBtn) {
    updateDebugModeUI();
    applyDebugVisibility();
    debugToggleBtn.addEventListener('click', () => setSbiDebugMode(!getSbiDebugMode()));
  }

  const searchInput = document.getElementById('sbi-search-input');
  if (searchInput) searchInput.addEventListener('input', () => renderPackScoreSearch());
  renderScoreBreakdown();
  renderPackScoreSearch();
  updateExportButtonState();

  // Mode toggle
  const modeToggle = document.getElementById('sbi-mode-toggle');
  if (modeToggle) {
    updateModeToggleUI(getSbiDisplayMode());
    modeToggle.querySelectorAll('.sbi-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => setSbiDisplayMode(btn.dataset.mode));
    });
  }
  if (ENABLE_CLIP) initClipWorker();

  // Debug table tooltip: hover (desktop) / tap (mobile)
  const debugPanel = document.getElementById('sbi-debug');
  const debugWrap = document.querySelector('.sbi-debug-wrap');
  const debugTip = document.getElementById('sbi-debug-tip');
  bindScoreTip(debugPanel, debugWrap, debugTip, 3);

  const searchPanel = document.getElementById('sbi-search-wrap');
  const searchResults = document.getElementById('sbi-search-results');
  const searchTip = document.getElementById('sbi-search-tip');
  bindScoreTip(searchPanel, searchResults, searchTip, 3);
}

window.__sbiTest = {
  handleImageInput,
  setForceGlobalFallback(value) {
    _forceGlobalFallbackForTest = !!value;
  },
  setBenchmarkCorpusSize(target, excludedPacks = []) {
    _benchmarkGroupTarget = Math.max(0, Number(target) || 0);
    _benchmarkExcludedPacks = new Set(Array.isArray(excludedPacks) ? excludedPacks : []);
  },
  getGroupId(packName) {
    return fingerprints && fingerprints._packToGroup ? fingerprints._packToGroup[packName] || null : null;
  },
  getPackResult(packName) {
    const rowIndex = (_lastRankedResults || []).findIndex(row => row && row.name === packName);
    const groupId = fingerprints && fingerprints._packToGroup ? fingerprints._packToGroup[packName] || null : null;
    const fullScored = !!(groupId && _lastMatchMetrics && Array.isArray(_lastMatchMetrics.fullScoreGroupIds)
      && _lastMatchMetrics.fullScoreGroupIds.includes(groupId));
    return {
      groupId,
      groupMembers: groupId ? getGroupMembers(groupId) : [],
      rank: rowIndex >= 0 ? rowIndex + 1 : null,
      fullScored,
      result: rowIndex >= 0 ? _lastRankedResults[rowIndex] : null,
      details: _lastMatchDetails && _lastMatchDetails[packName] ? _lastMatchDetails[packName] : null,
    };
  },
  getAnchorEvidence() {
    if (!fingerprints || !fingerprints.packs) return [];
    const slotTypes = inferDisplaySlotTypes(_lastSlotFeatures || []);
    const slotsByType = {};
    for (const slot of (_lastSlotFeatures || [])) {
      const type = slotTypes[slot.index];
      if (!SLOT_ITEM_TYPES.includes(type)) continue;
      if (!slotsByType[type]) slotsByType[type] = [];
      slotsByType[type].push(slot);
    }
    const groupIds = _lastMatchMetrics && Array.isArray(_lastMatchMetrics.fullScoreGroupIds)
      ? _lastMatchMetrics.fullScoreGroupIds
      : Object.keys(fingerprints.packs);
    return groupIds.map(groupId => {
      const packData = fingerprints.packs[groupId] || {};
      const members = getGroupMembers(groupId);
      const info = members.length && _lastMatchDetails ? _lastMatchDetails[members[0]] : null;
      const currentScore = info && isFinite(info.preRefinementScore)
        ? info.preRefinementScore
        : (info && isFinite(info.finalScore) ? info.finalScore : null);
      const types = {};
      for (const [type, typeSlots] of Object.entries(slotsByType)) {
        if (!packData[type]) continue;
        for (const slot of typeSlots) {
          const evidence = getSlotAnchorEvidence(slot, packData[type], type);
          if (evidence && (!types[type] || evidence.final > types[type].final)) types[type] = evidence;
        }
      }
      return {
        groupId,
        members,
        currentScore,
        productionRefinement: buildRefinementValues(currentScore, packData, slotsByType).values,
        types,
        ds: types.diamond_sword || null,
        ep: types.ender_pearl || null,
      };
    });
  },
  getSlotVariantImages(slotIndex) {
    const slot = (_lastSlotFeatures || []).find(row => row && row.index === slotIndex);
    if (!slot) return [];
    const variants = slot.variants && slot.variants.length ? slot.variants : [slot.features];
    return variants.filter(variant => variant && variant.pix).map(variant => {
      const canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 16;
      canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(variant.pix), 16, 16), 0, 0);
      return canvas.toDataURL('image/png');
    });
  },
  comparePackSlot(packName, slotIndex, type) {
    const groupId = fingerprints && fingerprints._packToGroup ? fingerprints._packToGroup[packName] : null;
    const packData = groupId && fingerprints.packs[groupId];
    const slot = (_lastSlotFeatures || []).find(row => row && row.index === slotIndex);
    const packTex = packData && packData[type];
    if (!groupId || !slot || !packTex) return null;
    const evidence = getSlotAnchorEvidence(slot, packTex, type, 'full');
    return {
      groupId,
      rarity: getSurfaceRarity(groupId, type),
      variants: evidence ? [{
        ...evidence,
        spatialShape: evidence.shape,
        spatialDirection: evidence.direction,
        spatialColor: evidence.color,
      }] : [],
    };
  },
  async processImage(file, preset) {
    if (preset) _currentPreset = preset;
    const timings = {};
    const mark = () => performance.now();
    // Headless-safe wrapper: core matching without DOM dependency
    let t = mark();
    const img = new Image();
    const url = URL.createObjectURL(file);
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    timings.decode = mark() - t;

    t = mark();
    const rawCanvas = document.createElement('canvas');
    rawCanvas.width = img.width; rawCanvas.height = img.height;
    const rawCtx = rawCanvas.getContext('2d', { willReadFrequently: true });
    rawCtx.drawImage(img, 0, 0);

    const canvas = document.getElementById('sbi-canvas') || document.createElement('canvas');
    canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    timings.canvas = mark() - t;

    t = mark();
    await ensureFingerprints(SBI_BASE_FINGERPRINT_SHARDS);
    timings.fingerprints = mark() - t;

    t = mark();
    const { slots, widgetFeatures, widgetRect, hudFeatures, searchInfo } = extractHotbarSlots(rawCtx, img.width, img.height, _currentPreset);
    timings.extract = mark() - t;
    _lastSlotFeatures = slots;
    t = mark();
    await ensureFingerprintsForSlots(slots);
    timings.food = mark() - t;
    timings.inflate = inflateFingerprintCorpusForBenchmark();
    if (timings.inflate > 0) {
      t = mark();
      await new Promise(resolve => setTimeout(resolve, 20));
      timings.inflateSettle = mark() - t;
    }
    t = mark();
    const { results, slotTypes, details } = matchPacks(slots, widgetFeatures, hudFeatures);
    timings.match = mark() - t;
    _lastMatchDetails = details || {};
    _lastDetectionMeta = {
      widgetRect, searchInfo,
      slotCount: slots.length,
      heartCount: hudFeatures && hudFeatures.hearts ? hudFeatures.hearts.length : 0,
      hungerCount: hudFeatures && hudFeatures.hunger ? hudFeatures.hunger.length : 0,
      armorCount: hudFeatures && hudFeatures.armor ? hudFeatures.armor.length : 0,
    };
    _lastVisibleScores = {};
    for (const [name, info] of Object.entries(details)) _lastVisibleScores[name] = getDisplayScoreValue(null, info);
    _lastRankedResults = results.slice();
    _lastSearchPhase = 'hash';
    t = mark();
    if (document.getElementById('sbi-results')) renderResults(results.slice(0, 50));
    timings.render = mark() - t;
    _lastTestTimings = timings;
    URL.revokeObjectURL(url);
  },
  getSummary(options = {}) {
    const detail = options && options.detail === 'compact' ? 'compact' : 'verbose';
    const meta = _lastDetectionMeta || {};
    const rankedLimit = detail === 'compact' ? 10 : 30;
    const summary = {
      ranked: (_lastRankedResults || []).slice(0, rankedLimit).map(r => {
        const info = _lastMatchDetails[r.name] || {};
        return {
          name: r.name,
          groupId: r.groupId || info.groupId || null,
          score: getDisplayScoreValue(r, info),
          slotComposite: info.slotScore,
          hudComposite: (info.healthScore != null || info.hungerScore != null || info.armorScore != null) ? ((info.healthScore||0)+(info.hungerScore||0)+(info.armorScore||0))/3 : null,
          widgetSim: info.widgetScore,
          healthSim: info.healthScore,
          hungerSim: info.hungerScore,
          armorSim: info.armorScore,
          coverage: info.slotCoverage,
          certainty: info.slotCertainty,
          distinguishability: info.distinguishability,
          sharedness: info.sharedness,
          anchorPenalty: info.anchorPenaltyApplied || info.anchorPenalty,
          anchorGaps: info.anchorGaps || {},
          strongAnchorCount: info.strongAnchorCount,
          perTypeScores: info.perTypeScores || {},
          criticalTypeScore: info.criticalTypeScore,
          criticalTypeShortfall: info.criticalTypeShortfall,
        };
      }),
      slotTypes: getCurrentSlotTypesSummary(),
      resultText: (_lastRankedResults || []).slice(0, 3).map(r => r.name).join(', '),
      timings: _lastTestTimings || {},
      debug: {
        slotCount: meta.slotCount || 0,
        widgetRect: meta.widgetRect || null,
        heartCount: meta.heartCount || 0,
        hungerCount: meta.hungerCount || 0,
        armorCount: meta.armorCount || 0,
        detailCount: Object.keys(_lastMatchDetails || {}).length,
        rankedCount: (_lastRankedResults || []).length,
        hasFingerprints: !!fingerprints,
        fingerprintPackCount: fingerprints && fingerprints._meta ? fingerprints._meta.packCount : 0,
        fingerprintGroupCount: fingerprints ? Object.keys(fingerprints.packs || {}).length : 0,
        loadedShardCount: fingerprints ? Object.keys(fingerprints._loadedShards || {}).length : 0,
        matchMetrics: _lastMatchMetrics || {},
      },
    };
    if (detail !== 'compact') {
      summary.slotFeatures = (_lastSlotFeatures || []).map(s => s ? {
        index: s.index,
        activity: s.activity,
        variance: s.variance,
        sig: s.features && s.features.sig ? {
          n: s.features.sig.n,
          coverage: s.features.sig.coverage,
          meanLum: s.features.sig.meanLum,
          meanR: s.features.sig.meanR,
          meanG: s.features.sig.meanG,
          meanB: s.features.sig.meanB,
          redFrac: s.features.sig.redFrac,
          yellowFrac: s.features.sig.yellowFrac,
          blueFrac: s.features.sig.blueFrac,
          darkFrac: s.features.sig.darkFrac,
        } : null,
      } : null);
    }
    return summary;
  },
};

init();
})();
