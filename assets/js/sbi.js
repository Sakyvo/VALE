(function() {
'use strict';

const matcher = new URLSearchParams(window.location.search).get('matcher') === 'aligned' ? 'aligned' : 'legacy';
const engine = SbiEngine.createSbiEngine({
  matcher,
  createCanvas: () => document.createElement('canvas'),
  ImageDataCtor: window.ImageData,
  fetchImpl: (url) => fetch(url),
});

const {
  assignDisplayScores,
  buildRefinementValues,
  clamp01,
  ensureFingerprints,
  ensureFingerprintsForSlots,
  ensurePixelBucketsForPacks,
  extractHotbarSlots,
  extractRegion,
  findDisplayWidgetRect,
  getGroupMembers,
  getHudHorizontalShift,
  getSlotAnchorEvidence,
  getSurfaceRarity,
  inferDisplaySlotTypes,
  inflateFingerprintCorpusForBenchmark,
  maskSlotNoise,
  matchPacks,
  searchObservation,
  prepareSearch,
  pickSlotForClip,
  suppressSlotBackground,
  zeroRgbForTransparent,
} = engine;

const {
  SBI_BASE_FINGERPRINT_SHARDS,
  SBI_FINGERPRINT_VERSION,
  SBI_SCORE_WEIGHTS,
  SLOT_ITEM_TYPES,
} = SbiEngine.constants;
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
let _lastRankedResults = [];
let _lastSlotFeatures = [];
let _lastSearchPhase = 'hash';
let _lastDetectionMeta = null;
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
const PER_TYPE_SCORE_ORDER = ['DS', 'EP', 'HL', 'SK/GC'];

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
          assetBase: it.assetBase || null,
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
  const m = engine.getLastMatchMetrics() || {};
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
  if (!engine.store || !engine.store.packs) return [];
  const rawQuery = String(query || '').trim();
  const loweredQuery = rawQuery.toLowerCase();
  const phraseQuery = normalizePackSearchPhrase(rawQuery);
  const normalizedQuery = normalizePackSearchTerm(query);
  const tokens = phraseQuery ? phraseQuery.split(' ') : [];
  if (!rawQuery && !normalizedQuery && !tokens.length) return [];

  return Object.keys(engine.store.packs).map(name => {
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

function getPackAssetBase(name) {
  const meta = _packNameIndex && _packNameIndex[name];
  return (meta && meta.assetBase) || null;
}

function getTextureThumbUrl(packName, fileName) {
  return valeAssetUrl(packName, fileName, getPackAssetBase(packName));
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
  const coverUrl = valeAssetUrl(r.name, 'cover.png', getPackAssetBase(r.name));
  const packPng = valeAssetUrl(r.name, 'pack.png', getPackAssetBase(r.name));
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
      cover: valeAssetUrl(r.name, 'cover.png', getPackAssetBase(r.name)),
      packPng: valeAssetUrl(r.name, 'pack.png', getPackAssetBase(r.name))
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
  engine.resetMatchMetrics();
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
    await prepareSearch();

    const observation = extractHotbarSlots(rawCtx, img.width, img.height, _currentPreset);
    const { slots, widgetFeatures, widgetRect, hudFeatures, searchInfo } = observation;
    const matched = await searchObservation(observation);
    const { results, slotTypes, details } = matched;
    const stage1Top10 = matched.stage1Results.slice(0, 10);
    _lastMatchDetails = details;
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
    engine.setForceGlobalFallbackForTest(!!value);
  },
  setBenchmarkCorpusSize(target, excludedPacks = []) {
    engine.setBenchmarkGroupTarget(Math.max(0, Number(target) || 0));
    engine.setBenchmarkExcludedPacks(Array.isArray(excludedPacks) ? excludedPacks : []);
  },
  getGroupId(packName) {
    return engine.store && engine.store._packToGroup ? engine.store._packToGroup[packName] || null : null;
  },
  getPackResult(packName) {
    const rowIndex = (_lastRankedResults || []).findIndex(row => row && row.name === packName);
    const groupId = engine.store && engine.store._packToGroup ? engine.store._packToGroup[packName] || null : null;
    const fullScored = !!(groupId && engine.getLastMatchMetrics() && Array.isArray(engine.getLastMatchMetrics().fullScoreGroupIds)
      && engine.getLastMatchMetrics().fullScoreGroupIds.includes(groupId));
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
    if (!engine.store || !engine.store.packs) return [];
    const slotTypes = inferDisplaySlotTypes(_lastSlotFeatures || []);
    const slotsByType = {};
    for (const slot of (_lastSlotFeatures || [])) {
      const type = slotTypes[slot.index];
      if (!SLOT_ITEM_TYPES.includes(type)) continue;
      if (!slotsByType[type]) slotsByType[type] = [];
      slotsByType[type].push(slot);
    }
    const groupIds = engine.getLastMatchMetrics() && Array.isArray(engine.getLastMatchMetrics().fullScoreGroupIds)
      ? engine.getLastMatchMetrics().fullScoreGroupIds
      : Object.keys(engine.store.packs);
    return groupIds.map(groupId => {
      const packData = engine.store.packs[groupId] || {};
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
    const groupId = engine.store && engine.store._packToGroup ? engine.store._packToGroup[packName] : null;
    const packData = groupId && engine.store.packs[groupId];
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
    await prepareSearch();
    timings.fingerprints = mark() - t;

    t = mark();
    const observation = extractHotbarSlots(rawCtx, img.width, img.height, _currentPreset);
    const { slots, widgetFeatures, widgetRect, hudFeatures, searchInfo } = observation;
    timings.extract = mark() - t;
    _lastSlotFeatures = slots;
    t = mark();
    if (matcher === 'legacy') await ensureFingerprintsForSlots(slots);
    timings.food = mark() - t;
    timings.inflate = matcher === 'legacy' ? inflateFingerprintCorpusForBenchmark() : 0;
    if (timings.inflate > 0) {
      t = mark();
      await new Promise(resolve => setTimeout(resolve, 20));
      timings.inflateSettle = mark() - t;
    }
    t = mark();
    const { results, slotTypes, details } = await searchObservation(observation);
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
      matcher,
      fingerprintVersion: SBI_FINGERPRINT_VERSION,
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
        hasFingerprints: !!engine.store,
        fingerprintPackCount: engine.store && engine.store._meta ? engine.store._meta.packCount : 0,
        fingerprintGroupCount: engine.store ? Object.keys(engine.store.packs || {}).length : 0,
        loadedShardCount: engine.store ? Object.keys(engine.store._loadedShards || {}).length : 0,
        matchMetrics: engine.getLastMatchMetrics() || {},
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
