'use strict';

// Offline SBI evaluation bench.
//
// `npm run sbi:eval` validates/builds a provenance-keyed cache, then evaluates the
// production path over the complete manifest. `palette` is a component experiment.
// Optional: --manifest <path> --tier light --limit N --stride N --report <path>.

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const readline = require('node:readline');

const ROOT = path.join(__dirname, '..');
const CORPUS_DIR = path.join(ROOT, 'test_img', 'synthetic');
const CACHE_DIR = path.join(ROOT, '.target', 'sbi-bench');
const FINGERPRINT_DIR = path.join(ROOT, 'data', 'sbi-fp');

const TYPES = ['diamond_sword', 'ender_pearl', 'splash_potion', 'steak', 'golden_carrot'];
const HISTORY_BINS = 12;

function loadSamples({ manifestPath = path.join(CORPUS_DIR, 'manifest.json'), tier = 'light', limit = 0, stride = 1, role = null } = {}) {
  if (role !== null && !['acceptance', 'development'].includes(role)) throw new Error('Invalid evaluation role');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.images)) throw new Error('Invalid corpus manifest');
  if (manifest.schemaVersion === 2) {
    const roles = new Map();
    for (const image of manifest.images) {
      if (!['acceptance', 'development'].includes(image.role)) throw new Error('Missing evaluation role');
      if (roles.has(image.groupId) && roles.get(image.groupId) !== image.role) throw new Error('Group crosses evaluation roles: ' + image.groupId);
      roles.set(image.groupId, image.role);
    }
  } else if (role !== null) throw new Error('Historical corpus has no role partition');
  let samples = manifest.images
    .filter(image => (!tier || image.tier === tier) && (!role || image.role === role))
    .map(image => ({ file: image.file, groupId: image.groupId, packId: image.packId, tier: image.tier, preset: image.preset || 'large',
      ...(image.role ? { role: image.role } : {}),
      ...(image.geometry ? { geometry: image.geometry } : {}),
      ...(image.sha256 ? { sha256: image.sha256 } : {}),
      ...(image.error || image.sourceError ? { sourceError: image.error || image.sourceError } : {}) }));
  if (stride > 1) samples = samples.filter((_, index) => index % stride === 0);
  return limit > 0 ? samples.slice(0, limit) : samples;
}

function loadManifestGroups(manifestPath = path.join(CORPUS_DIR, 'manifest.json')) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')).groups || {};
}

function groupCandidates(observableGroups, groupId) {
  const row = observableGroups && observableGroups[groupId];
  return row && Array.isArray(row.members) ? new Set([groupId, ...row.members]) : new Set([groupId]);
}

function measureGeometry(expected, observation) {
  if (!expected) return null;
  if (!observation || !observation.widgetRect || !Array.isArray(observation.slots)) {
    return { passed: false, maxErrorPx: null, reason: 'missing geometry' };
  }
  if (observation.width !== expected.width || observation.height !== expected.height) {
    return { passed: false, maxErrorPx: null, reason: 'image dimensions differ' };
  }
  let maxErrorPx = 0;
  const compareRect = (actual, truth) => {
    if (!actual || !truth) return false;
    for (const key of ['x', 'y', 'w', 'h']) {
      if (!Number.isFinite(actual[key]) || !Number.isFinite(truth[key])) return false;
      maxErrorPx = Math.max(maxErrorPx, Math.abs(actual[key] - truth[key]));
    }
    return true;
  };
  if (!compareRect(observation.widgetRect, expected.widgetRect)) {
    return { passed: false, maxErrorPx: null, reason: 'invalid widget rectangle' };
  }
  for (const [index, truth] of expected.slotRects.entries()) {
    const slot = observation.slots.find(row => row.index === index);
    if (!compareRect(slot?.native?.rect, truth)) {
      return { passed: false, maxErrorPx: null, reason: 'missing slot rectangle ' + index };
    }
  }
  return { passed: maxErrorPx <= 1, maxErrorPx, tolerancePx: 1 };
}

function computeMetrics(samples, ranksFor, observableGroups) {
  let top1 = 0, recall = 0, coarseRecall = 0, memberPresent = 0, failures = 0;
  let stageCount = 0, geometryTotal = 0, geometryPassed = 0;
  const rows = [], failureStages = { geometry: 0, retrieval: 0, refinement: 0, execution: 0 };
  for (const sample of samples) {
    const prediction = ranksFor(sample);
    const component = Array.isArray(prediction);
    const ranked = component ? prediction : (prediction && prediction.results || []);
    const candidates = !component && prediction && prediction.candidateGroupIds;
    const expected = groupCandidates(observableGroups, sample.groupId);
    const identity = row => typeof row === 'string' ? row : (row.groupId || row.name);
    const rankedGroups = [...new Set(ranked.map(identity))];
    const coarseGroups = [...new Set((prediction?.stage1Results || []).map(identity))];
    const firstHit = rankedGroups.findIndex(id => expected.has(id));
    const coarseHit = coarseGroups.findIndex(id => expected.has(id));
    const isTop1 = firstHit === 0;
    const recalled = Array.isArray(candidates) && candidates.some(id => expected.has(id));
    const present = !!sample.packId && ranked.some(row => typeof row === 'object' &&
      (row.name === sample.packId || (row.members || []).includes(sample.packId)));
    const error = prediction && prediction.error || (!prediction ? 'missing prediction' : null);
    if (isTop1) top1++;
    if (firstHit >= 0) recall++;
    if (recalled) coarseRecall++;
    if (present) memberPresent++;
    if (error) failures++;
    if (Array.isArray(candidates)) stageCount++;
    const geometry = sample.geometry
      ? (prediction?.geometry || measureGeometry(sample.geometry, prediction?.observation)) : null;
    if (geometry) { geometryTotal++; if (geometry.passed) geometryPassed++; }
    const failureStage = error ? 'execution' : geometry && !geometry.passed ? 'geometry'
      : !isTop1 && Array.isArray(candidates) ? (recalled ? 'refinement' : 'retrieval') : null;
    if (failureStage) failureStages[failureStage]++;
    const timings = Object.fromEntries(['coarseMs', 'refineMs', 'totalMs'].filter(key =>
      Number.isFinite(prediction?.metrics?.[key])).map(key => [key, prediction.metrics[key]]));
    rows.push({ file: sample.file, packId: sample.packId, groupId: sample.groupId, top1: isTop1,
      predictedGroupId: rankedGroups[0] || null, coarseRank: coarseHit >= 0 ? coarseHit + 1 : 0, failureStage, timings,
      recalled: firstHit >= 0, coarseRecalled: Array.isArray(candidates) ? recalled : null,
      candidateCount: Array.isArray(candidates) ? candidates.length : null,
      memberPresent: present, error, rank: firstHit >= 0 ? firstHit + 1 : 0, geometry });
  }
  const rate = count => samples.length ? count / samples.length : 0;
  return { total: samples.length, top1, recall, top1Rate: rate(top1), recallRate: rate(recall),
    coarseRecall: stageCount === samples.length ? coarseRecall : null,
    coarseRecallRate: stageCount === samples.length ? rate(coarseRecall) : null,
    memberPresent, failures, failureStages, geometryTotal, geometryPassed,
    geometryRate: geometryTotal ? geometryPassed / geometryTotal : null, rows };
}

function createNodeEngine({ matcher = 'legacy' } = {}) {
  const { createCanvas, ImageData } = require('@napi-rs/canvas');
  const { createSbiEngine } = require('../assets/js/sbi-engine.js');
  return createSbiEngine({
    matcher,
    createCanvas: () => createCanvas(1, 1),
    ImageDataCtor: ImageData,
    decodeReference: async bytes => {
      const { data, info } = await require('sharp')(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { width: info.width, height: info.height, pixels: new Uint8ClampedArray(data) };
    },
    fetchImpl: async url => {
      const file = path.join(ROOT, String(url).replace(/^\//, '').replace(/\?.*$/, ''));
      return { ok: fs.existsSync(file), status: fs.existsSync(file) ? 200 : 404,
        json: async () => JSON.parse(fs.readFileSync(file, 'utf8')),
        arrayBuffer: async () => fs.readFileSync(file) };
    },
  });
}

async function loadCorpusInto(engine) {
  await engine.ensureFingerprints();
  if (!engine.store || !engine.store._meta) throw new Error('fingerprint metadata was not loaded');
  await engine.ensurePixelBucketsForPacks(Object.keys(engine.store.packs || {}));
  return engine.store._meta;
}

async function readRgba(file) {
  const sharp = require('sharp');
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
}

function maskHist(pix, bins = HISTORY_BINS) {
  const hist = new Float32Array(bins * bins * bins);
  let n = 0;
  for (let i = 0; i < pix.length; i += 4) {
    if (pix[i + 3] < 64) continue;
    const r = Math.min(bins - 1, pix[i] * bins >> 8);
    const g = Math.min(bins - 1, pix[i + 1] * bins >> 8);
    const b = Math.min(bins - 1, pix[i + 2] * bins >> 8);
    hist[(r * bins + g) * bins + b]++;
    n++;
  }
  if (n) for (let i = 0; i < hist.length; i++) hist[i] /= n;
  return hist;
}

function coverage(pix) {
  let n = 0;
  for (let i = 3; i < pix.length; i += 4) if (pix[i] >= 64) n++;
  return n / (pix.length / 4);
}

const OBSERVATION_SCHEMA = 1;
const ARRAY_TYPES = { Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array,
  Int8Array, Int16Array, Int32Array, Float32Array, Float64Array };

function encodeObservationValue(value) {
  if (value === undefined) return { $sbi: 'undefined' };
  if (typeof value === 'number' && !Number.isFinite(value)) return { $sbi: 'number', value: String(value) };
  if (ArrayBuffer.isView(value)) {
    const type = value.constructor.name;
    if (!ARRAY_TYPES[type]) throw new Error('Unsupported observation array: ' + type);
    return { $sbi: type, value: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') };
  }
  if (Array.isArray(value)) return value.map(encodeObservationValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeObservationValue(item)]));
  }
  return value;
}

function decodeObservationValue(value) {
  if (Array.isArray(value)) return value.map(decodeObservationValue);
  if (!value || typeof value !== 'object') return value;
  if (value.$sbi === 'undefined') return undefined;
  if (value.$sbi === 'number') return Number(value.value);
  if (value.$sbi) {
    const Type = ARRAY_TYPES[value.$sbi];
    if (!Type || typeof value.value !== 'string') throw new Error('Invalid observation array');
    const bytes = Uint8Array.from(Buffer.from(value.value, 'base64'));
    if (bytes.byteLength % Type.BYTES_PER_ELEMENT) throw new Error('Invalid observation array length');
    return new Type(bytes.buffer);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeObservationValue(item)]));
}

function serializeObservation(observation) {
  return { schemaVersion: OBSERVATION_SCHEMA, observation: encodeObservationValue(observation) };
}

function deserializeObservation(record) {
  if (!record || record.schemaVersion !== OBSERVATION_SCHEMA) throw new Error('Incompatible observation schema');
  return decodeObservationValue(record.observation);
}

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function digest(value) { return createHash('sha256').update(value).digest('hex'); }

function cacheHeader({ samples, provenance }) {
  return { kind: 'sbi-observations', schema: OBSERVATION_SCHEMA, count: samples.length,
    manifest: digest(stableJson(samples)), provenance: digest(stableJson(provenance)) };
}

async function closeCacheInput(lines, input) {
  lines.close();
  if (input.closed) return;
  const closed = new Promise(resolve => input.once('close', resolve));
  input.destroy();
  await closed;
}

async function inspectCache(file, options, partial = false) {
  const expected = cacheHeader(options);
  const hash = createHash('sha256');
  let count = 0, header = false, complete = false, validBytes = 0;
  const input = fs.createReadStream(file);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch {
        if (partial) break;
        throw new Error('Invalid observation cache JSON');
      }
      if (!header) {
        if (row.kind !== expected.kind || row.schema !== expected.schema) throw new Error('Incompatible cache schema');
        if (row.manifest !== expected.manifest || row.count !== expected.count) throw new Error('Cache manifest mismatch');
        if (row.provenance !== expected.provenance) throw new Error('Cache provenance mismatch');
        header = true;
      } else if (complete) {
        throw new Error('Unexpected data after cache footer');
      } else if (row.kind === 'complete') {
        if (count !== expected.count || row.count !== count || row.sha256 !== hash.digest('hex')) throw new Error('Incomplete or corrupt cache');
        complete = true;
      } else {
        const observation = deserializeObservation(row);
        if (count >= options.samples.length || observation.file !== options.samples[count].file) throw new Error('Cache sample order mismatch');
        hash.update(line + '\n');
        count++;
      }
      validBytes += Buffer.byteLength(line + '\n');
    }
  } finally { await closeCacheInput(lines, input); }
  if (!header || (!complete && !partial)) throw new Error('Incomplete observation cache');
  return { count, complete, validBytes, hash };
}

async function* readObservationCache(file, options) {
  await inspectCache(file, options);
  const input = fs.createReadStream(file);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    let header = true;
    for await (const line of lines) {
      const row = JSON.parse(line);
      if (header) { header = false; continue; }
      if (row.kind === 'complete') break;
      yield deserializeObservation(row);
    }
  } finally { await closeCacheInput(lines, input); }
}

async function writeObservationCache(file, observations, options) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const pending = file + '.partial';
  let state = { count: 0, hash: createHash('sha256') };
  if (fs.existsSync(pending)) {
    state = await inspectCache(pending, options, true);
    if (state.complete) {
      fs.renameSync(pending, file);
      return { cacheFile: file, count: state.count, resumed: state.count };
    }
    const size = fs.statSync(pending).size;
    if (state.validBytes === size + 1) fs.appendFileSync(pending, '\n');
    else fs.truncateSync(pending, state.validBytes);
  } else {
    fs.writeFileSync(pending, JSON.stringify(cacheHeader(options)) + '\n', { flag: 'wx' });
  }
  const resumed = state.count;
  const fromFactory = typeof observations === 'function';
  const source = fromFactory ? observations(resumed) : observations;
  const handle = await fs.promises.open(pending, 'a');
  let index = fromFactory ? resumed : 0;
  try {
    for await (const observation of source) {
      if (index++ < resumed) continue;
      if (state.count >= options.samples.length || observation.file !== options.samples[state.count].file) throw new Error('Cache sample order mismatch');
      const line = JSON.stringify(serializeObservation(observation)) + '\n';
      await handle.writeFile(line);
      state.hash.update(line);
      state.count++;
    }
    if (state.count !== options.samples.length) throw new Error('Incomplete observation cache');
    await handle.writeFile(JSON.stringify({ kind: 'complete', count: state.count, sha256: state.hash.digest('hex') }) + '\n');
    await handle.sync();
  } finally { await handle.close(); }
  fs.renameSync(pending, file);
  return { cacheFile: file, count: state.count, resumed };
}

// Slot features must survive JSON so the score phase can replay the shipped
// matcher without decoding screenshots again. Typed arrays become plain arrays
// and are revived by deserializeFeatures.
function serializeFeatures(features) {
  if (!features) return null;
  return {
    dhash: features.dhash ? Array.from(features.dhash) : null,
    hist: features.hist ? Array.from(features.hist) : null,
    moments: features.moments ? Array.from(features.moments) : null,
    edge: features.edge,
    sig: features.sig ? { ...features.sig } : null,
    pix: features.pix ? Array.from(features.pix) : null,
  };
}

function serializeHashless(features) {
  return {
    hist: features.hist ? Array.from(features.hist) : null,
    moments: features.moments ? Array.from(features.moments) : null,
    edge: features.edge,
  };
}

function deserializeFeatures(features) {
  if (!features) return null;
  return {
    dhash: features.dhash ? Uint8Array.from(features.dhash) : null,
    hist: features.hist ? Float64Array.from(features.hist) : null,
    moments: features.moments,
    edge: features.edge,
    sig: features.sig,
    pix: features.pix ? Uint8Array.from(features.pix) : null,
  };
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function evaluationContext(options = {}) {
  const manifestPath = options.manifestPath || path.join(CORPUS_DIR, 'manifest.json');
  const corpusDir = path.dirname(manifestPath);
  const samples = loadSamples({ ...options, manifestPath });
  const matcher = options.matcher || 'legacy';
  if (!['legacy', 'aligned'].includes(matcher)) throw new Error('Unknown evaluation matcher: ' + matcher);
  const hashes = {};
  const files = [__filename, path.join(ROOT, 'assets/js/sbi-engine.js'), path.join(ROOT, 'assets/js/sbi.js'),
    path.join(ROOT, 'package-lock.json'), manifestPath,
    ...fs.readdirSync(FINGERPRINT_DIR).filter(n => n.endsWith('.json')).sort().map(n => path.join(FINGERPRINT_DIR, n))];
  if (matcher === 'aligned') {
    const alignedDir = path.join(FINGERPRINT_DIR, 'aligned');
    const indexFile = path.join(alignedDir, 'index.json');
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    files.push(indexFile);
    for (const texture of index.textures) {
      if (!/^textures\/[a-f0-9]{64}\.png$/.test(texture.file)) throw new Error('Invalid aligned reference path');
      const file = path.join(alignedDir, texture.file);
      if (await hashFile(file) !== texture.sha256) throw new Error('Native reference hash mismatch: ' + texture.file);
    }
  }
  for (const file of files) hashes[path.relative(ROOT, file).replace(/\\/g, '/')] = await hashFile(file);
  const imageHashes = [];
  for (const sample of samples) {
    const file = path.join(corpusDir, sample.file);
    imageHashes.push([sample.file, fs.existsSync(file) ? await hashFile(file) : 'missing']);
  }
  const provenance = { matcher, files: hashes, images: digest(stableJson(imageHashes)), node: process.version,
    canvas: require('@napi-rs/canvas/package.json').version, sharp: require('sharp/package.json').version };
  const key = digest(stableJson({ samples, provenance })).slice(0, 24);
  return { samples, provenance, corpusDir, matcher,
    cacheFile: path.join(options.cacheDir || CACHE_DIR, `observations-v${OBSERVATION_SCHEMA}-${key}.ndjson`) };
}

async function captureObservation(engine, file, sample = {}) {
  if (sample.sourceError) throw new Error(sample.sourceError);
  const source = await fs.promises.readFile(file);
  if (sample.sha256 && digest(source) !== sample.sha256) throw new Error('Corpus image hash mismatch: ' + sample.file);
  const { data, width, height } = await readRgba(source);
  const { createCanvas, ImageData } = require('@napi-rs/canvas');
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(data, width, height), 0, 0);
  return { ...sample, width, height, ...engine.extractHotbarSlots(ctx, width, height, sample.preset || 'large') };
}

async function extract(options = {}) {
  const context = options.context || await evaluationContext(options);
  const { samples, corpusDir, cacheFile } = context;
  const engine = createNodeEngine({ matcher: context.matcher });
  await engine.prepareSearch();
  const started = Date.now();
  const source = async function* (offset) {
    for (let i = offset; i < samples.length; i++) {
      const sample = samples[i];
      let observation;
      try { observation = await captureObservation(engine, path.join(corpusDir, sample.file), sample); }
      catch (error) { observation = { ...sample, slots: [], error: error.message }; }
      yield observation;
      if (options.onProgress) options.onProgress(i + 1, samples.length);
    }
  };
  const receipt = await writeObservationCache(cacheFile, source, context);
  return { ...receipt, elapsedMs: Date.now() - started, provenance: context.provenance };
}

async function* loadCache(options = {}) {
  const context = options.context || await evaluationContext(options);
  yield* readObservationCache(context.cacheFile, context);
}

function intersection(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] < b[i] ? a[i] : b[i];
  return sum;
}

// Pack-side palette references, built once from the generated pixel buckets.
async function buildPackPalettes() {
  const engine = createNodeEngine();
  await loadCorpusInto(engine);
  const packs = [];
  for (const [packId, surfaces] of Object.entries(engine.store.packs)) {
    const perType = {};
    for (const type of TYPES) {
      const surface = surfaces[type];
      if (!surface || typeof surface.pix !== 'string') continue;
      const bytes = engine.base64ToBytes(surface.pix);
      perType[type] = maskHist(bytes);
    }
    if (Object.keys(perType).length) packs.push({ packId, perType });
  }
  return packs;
}

// Rank groups with the shipped scorer, so the bench measures the real pipeline
// rather than a reimplementation of it.
function rankPalette(observation, packs, observableGroups) {
  const engine = _sharedEngine;
  const slots = observation.slots;
  // The bench reports the scorer the site uses, so it reads the same `scores` map
  // that matchPacks orders by (palette with pixel rerank on the shortlist).
  const { scores } = engine.scorePaletteCandidates(slots);
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(entry => entry[0]);
}

function formatReport(metrics, label) {
  const pct = value => (value * 100).toFixed(1) + '%';
  return [
    `SBI bench${label ? ' — ' + label : ''}`,
    `  images          ${metrics.total}`,
    `  group top-1     ${metrics.top1} (${pct(metrics.top1Rate)})`,
    `  final presence  ${metrics.recall} (${pct(metrics.recallRate)})`,
    metrics.coarseRecall == null ? null : `  coarse recall   ${metrics.coarseRecall} (${pct(metrics.coarseRecallRate)})`,
    `  member present  ${metrics.memberPresent}`,
    `  failures        ${metrics.failures}`,
    metrics.geometryTotal ? `  geometry        ${metrics.geometryPassed}/${metrics.geometryTotal} (${pct(metrics.geometryRate)})` : null,
    metrics.elapsedMs === undefined ? null : `  scoring         ${(metrics.elapsedMs / 1000).toFixed(1)}s`,
  ].filter(Boolean).join('\n');
}

// Replay the shipped matcher against cached observations. Slot features are
// revived from JSON and handed to matchPacks, so this measures exactly what the
// browser would score — no screenshot decoding, no DOM.
async function scoreCurrent(options = {}) {
  const context = options.context || await evaluationContext(options);
  const engine = createNodeEngine({ matcher: context.matcher });
  await engine.prepareSearch();
  const started = Date.now(), predictions = new Map(), samples = [];
  let index = 0;
  for await (const observation of loadCache({ context })) {
    const groupId = engine.store._packToGroup[observation.packId];
    samples.push({ ...context.samples[index], groupId: groupId || observation.groupId });
    let prediction;
    try {
      if (observation.error) throw new Error(observation.error);
      if (!groupId) throw new Error('Expected pack missing from reference metadata: ' + observation.packId);
      prediction = await engine.searchObservation(observation);
      prediction = { results: prediction.results, candidateGroupIds: prediction.candidateGroupIds,
        stage1Results: prediction.stage1Results, metrics: prediction.metrics,
        geometry: measureGeometry(observation.geometry, observation),
        error: observation.slots.length ? null : 'no detected slots' };
    } catch (error) { prediction = { results: [], candidateGroupIds: [], error: error.message }; }
    predictions.set(observation.file, prediction);
    index++;
    if (options.onProgress) options.onProgress(index, context.samples.length);
  }
  const metrics = computeMetrics(samples, sample => predictions.get(sample.file), engine.store._meta.groups);
  return { ...metrics, elapsedMs: Date.now() - started, provenance: context.provenance,
    mode: context.matcher === 'aligned' ? 'aligned-candidate' : 'legacy-production', role: options.role || 'all' };
}

async function evaluate(options = {}) {
  const context = await evaluationContext(options);
  let reusable = false;
  if (fs.existsSync(context.cacheFile)) {
    await inspectCache(context.cacheFile, context);
    reusable = true;
  }
  if (!reusable) await extract({ ...options, context });
  return options.mode === 'palette' ? scorePalette({ ...options, context }) : scoreCurrent({ ...options, context });
}

function deserializeHashless(features) {
  return {
    hist: features.hist ? Float64Array.from(features.hist) : null,
    moments: features.moments,
    edge: features.edge,
  };
}

let _sharedEngine = null;
async function getLoadedEngine() {
  if (_sharedEngine) return _sharedEngine;
  const engine = createNodeEngine();
  await loadCorpusInto(engine);
  _sharedEngine = engine;
  return engine;
}

async function scorePalette(options = {}) {
  const context = options.context || await evaluationContext(options);
  const engine = await getLoadedEngine();
  const started = Date.now(), ranked = new Map(), samples = [];
  for await (const observation of loadCache({ context })) {
    samples.push({ file: observation.file, packId: observation.packId,
      groupId: engine.store._packToGroup[observation.packId] || observation.groupId });
    ranked.set(observation.file, observation.error ? [] : rankPalette(observation));
  }
  return { ...computeMetrics(samples, sample => ranked.get(sample.file), engine.store._meta.groups),
    elapsedMs: Date.now() - started, mode: 'palette-component', provenance: context.provenance };
}

module.exports = {
  CORPUS_DIR, CACHE_DIR, FINGERPRINT_DIR, TYPES,
  loadSamples, loadManifestGroups, groupCandidates, computeMetrics, measureGeometry,
  createNodeEngine, loadCorpusInto, readRgba, maskHist, coverage,
  extract, loadCache, buildPackPalettes, rankPalette, scorePalette, scoreCurrent,
  serializeFeatures, deserializeFeatures, serializeObservation, deserializeObservation,
  writeObservationCache, readObservationCache, evaluationContext, captureObservation, evaluate, formatReport,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const phase = argv[0] || 'score';
  const option = name => {
    const index = argv.indexOf('--' + name);
    return index >= 0 ? argv[index + 1] : null;
  };
  const tier = option('tier') || 'light';
  const limit = Number(option('limit') || 0);
  const stride = Number(option('stride') || 1);

  const run = async () => {
    if (!['score', 'current', 'extract', 'palette'].includes(phase)) throw new Error('Unknown evaluation phase: ' + phase);
    if (!Number.isInteger(limit) || limit < 0 || !Number.isInteger(stride) || stride < 1) throw new Error('Invalid limit/stride');
    const options = { tier, limit, stride, matcher: option('matcher') || 'legacy', role: option('role') || null,
      mode: phase === 'palette' ? 'palette' : 'production',
      ...(option('manifest') ? { manifestPath: path.resolve(option('manifest')) } : {}),
      onProgress: (done, total) => { if (done % 50 === 0 || done === total) process.stderr.write(`  ${done}/${total}\n`); } };
    if (phase === 'extract') {
      const receipt = await extract(options);
      process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
      return;
    }
    const metrics = await evaluate(options);
    const report = option('report');
    if (report) { fs.mkdirSync(path.dirname(report), { recursive: true }); fs.writeFileSync(report, JSON.stringify(metrics, null, 2)); }
    process.stdout.write(formatReport(metrics, metrics.mode) + '\n');
  };
  run().catch(error => {
    process.stderr.write((error && error.stack ? error.stack : String(error)) + '\n');
    process.exitCode = 1;
  });
}
