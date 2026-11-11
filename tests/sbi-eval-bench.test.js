'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const bench = require('../scripts/sbi-eval-bench.js');

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'test_img', 'synthetic', 'manifest.json');

test('cached observations preserve all ranking evidence and native geometry', () => {
  const { createCanvas, ImageData } = require('@napi-rs/canvas');
  const engine = bench.createNodeEngine();
  const canvas = createCanvas(24, 24);
  const ctx = canvas.getContext('2d');
  const pixels = new Uint8ClampedArray(24 * 24 * 4);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 17) % 256;
  ctx.putImageData(new ImageData(pixels, 24, 24), 0, 0);
  const slot = engine.extractSlotFeatures(ctx, 0, 0, 24, 24, 24, 0);
  const observation = {
    file: 'fixture.png', groupId: 'g1', packId: 'pack-one',
    slots: [{ ...slot, native: { width: 24, height: 24, pixels },
      refineVariants: [slot.features], mask: new Uint8Array([1, 0, 1]) }],
    widgetRect: { x: 0, y: 0, w: 24, h: 24 },
    searchInfo: { unit: 1.5, mode: 'fixture' },
    widgetFeatures: { ...slot.features, colors: new Float32Array([0.2, 0.7]) },
    hudFeatures: {
      hearts: [slot.features], hunger: [slot.features], armor: [slot.features],
      heartBoxes: [{ x: 2, y: 3, w: 9, h: 9 }], hungerBoxes: [], armorBoxes: [],
    },
  };
  const replay = bench.deserializeObservation(JSON.parse(JSON.stringify(bench.serializeObservation(observation))));
  assert.deepStrictEqual(replay, observation);
  replay.slots[0].features.pix[0] ^= 255;
  assert.notEqual(replay.slots[0].features.pix[0], observation.slots[0].features.pix[0]);
});

test('observation cache publishes only complete matching-provenance runs and resumes interruptions', async t => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'observations.ndjson');
  const samples = [{ file: 'a.png' }, { file: 'b.png' }];
  const provenance = { engine: 'engine-one', corpus: 'corpus-one' };
  const rows = samples.map(sample => ({ ...sample, slots: [], hudFeatures: { hearts: [] } }));
  async function* interrupted() { yield rows[0]; throw new Error('decode interrupted'); }
  await assert.rejects(bench.writeObservationCache(file, interrupted(), { samples, provenance }), /decode interrupted/);
  assert.equal(fs.existsSync(file), false, 'a partial run must not replace the accepted cache');
  const receipt = await bench.writeObservationCache(file, rows, { samples, provenance });
  assert.equal(receipt.resumed, 1);
  const loaded = [];
  for await (const row of bench.readObservationCache(file, { samples, provenance })) loaded.push(row);
  assert.deepStrictEqual(loaded, rows);
  await assert.rejects(async () => {
    for await (const row of bench.readObservationCache(file, { samples, provenance: { ...provenance, engine: 'new' } })) void row;
  }, /provenance/);
  await assert.rejects(async () => {
    for await (const row of bench.readObservationCache(file, { samples: [...samples, { file: 'c.png' }], provenance })) void row;
  }, /manifest/);
  fs.appendFileSync(file, 'truncated');
  await assert.rejects(async () => {
    for await (const row of bench.readObservationCache(file, { samples, provenance })) void row;
  }, /cache/i);
});

test('cache resume repairs a complete JSON row whose terminating newline was interrupted', async t => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-cache-eof-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'observations.ndjson');
  const rows = [{ file: 'a.png', slots: [] }, { file: 'b.png', slots: [] }];
  const options = { samples: rows.map(({ file }) => ({ file })), provenance: { engine: 'one' } };
  async function* interrupted() { yield rows[0]; throw new Error('stop'); }
  await assert.rejects(bench.writeObservationCache(file, interrupted(), options), /stop/);
  const partial = file + '.partial';
  fs.truncateSync(partial, fs.statSync(partial).size - 1);
  await bench.writeObservationCache(file, rows, options);
  const replay = [];
  for await (const row of bench.readObservationCache(file, options)) replay.push(row);
  assert.deepStrictEqual(replay, rows);
});

test('cache iteration releases its file handles before completion, rejection or early cancellation', async t => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-cache-close-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }));
  const file = path.join(dir, 'observations.ndjson');
  const rows = [{ file: 'a.png' }, { file: 'b.png' }];
  const options = { samples: rows, provenance: { engine: 'one' } };
  await bench.writeObservationCache(file, rows, options);
  const streams = [], open = fs.createReadStream;
  t.mock.method(fs, 'createReadStream', (...args) => {
    const stream = open(...args);
    streams.push(stream);
    return stream;
  });
  for await (const row of bench.readObservationCache(file, options)) void row;
  assert.ok(streams.every(stream => stream.closed), 'normal completion must release every handle');
  streams.length = 0;
  for await (const row of bench.readObservationCache(file, options)) { void row; break; }
  assert.ok(streams.every(stream => stream.closed), 'early cancellation must release every handle');
  streams.length = 0;
  await assert.rejects(async () => {
    for await (const row of bench.readObservationCache(file, { ...options, provenance: { engine: 'two' } })) void row;
  }, /provenance/);
  assert.ok(streams.every(stream => stream.closed), 'failed validation must release every handle');
});

test('capture rejects stale image content and declared source failures before extracting pixels', async t => {
  const os = require('node:os'), crypto = require('node:crypto'), sharp = require('sharp');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-image-integrity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'input.png');
  const png = await sharp({ create: { width: 320, height: 180, channels: 4, background: '#202020' } }).png().toBuffer();
  fs.writeFileSync(file, png);
  const engine = bench.createNodeEngine();
  await assert.rejects(bench.captureObservation(engine, file, { sha256: 'stale' }), /image hash/i);
  await assert.rejects(bench.captureObservation(engine, file, { sourceError: 'missing source font' }), /missing source font/);
  const observation = await bench.captureObservation(engine, file, { sha256: crypto.createHash('sha256').update(png).digest('hex') });
  assert.equal(observation.width, 320);
  assert.equal(observation.height, 180);
});

test('the bench reads every labelled image from the synthetic manifest', () => {
  const samples = bench.loadSamples({ manifestPath: MANIFEST, tier: 'light' });
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const lightCount = manifest.images.filter(i => i.tier === 'light').length;

  assert.equal(samples.length, lightCount);
  for (const sample of samples) {
    assert.ok(sample.file && fs.existsSync(path.join(ROOT, 'test_img', 'synthetic', sample.file)));
    assert.ok(sample.groupId, 'each sample must carry its expected group');
  }
});

test('versioned acceptance selection preserves geometry and failed cases without leaking development variants', t => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbi-roles-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifestPath = path.join(dir, 'manifest.json');
  const images = [
    { file: 'a.png', groupId: 'g1', packId: 'one', role: 'acceptance', tier: 'light', geometry: { width: 1920, height: 1080 }, sha256: 'image-one' },
    { file: 'b.png', groupId: 'g1', packId: 'one', role: 'acceptance', tier: 'light', error: 'missing texture' },
    { file: 'c.png', groupId: 'g2', packId: 'two', role: 'development', tier: 'light' },
  ];
  fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 2, images }));
  const selected = bench.loadSamples({ manifestPath, role: 'acceptance' });
  assert.equal(selected.length, 2);
  assert.deepStrictEqual(selected[0].geometry, images[0].geometry);
  assert.equal(selected[1].sourceError, 'missing texture');
  assert.equal(selected[0].sha256, 'image-one');
  assert.equal(bench.loadSamples({ manifestPath, role: 'development' }).length, 1);
  assert.throws(() => bench.loadSamples({ manifestPath, role: 'unknown' }), /role/i);
  images[2].groupId = 'g1';
  fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 2, images }));
  assert.throws(() => bench.loadSamples({ manifestPath, role: 'acceptance' }), /group.*role/i);
});

test('evaluation separates known crop errors from ranking successes and counts missing observations', () => {
  const geometry = { width: 1920, height: 1080, widgetRect: { x: 687, y: 1014, w: 546, h: 66 },
    slotRects: [{ x: 696, y: 1023, w: 48, h: 48 }, { x: 1176, y: 1023, w: 48, h: 48 }] };
  const samples = ['correct', 'shifted', 'missing'].map(file => ({ file, groupId: 'g1', geometry }));
  const observation = { width: 1920, height: 1080, widgetRect: geometry.widgetRect,
    slots: [{ index: 0, native: { rect: geometry.slotRects[0] } }, { index: 1, native: { rect: geometry.slotRects[1] } }] };
  const shifted = { ...observation, slots: [observation.slots[0], { index: 1, native: { rect: { ...geometry.slotRects[1], x: 1182 } } }] };
  const predictions = {
    correct: { results: [{ groupId: 'g1' }], candidateGroupIds: ['g1'], observation },
    shifted: { results: [{ groupId: 'g1' }], candidateGroupIds: ['g1'], observation: shifted },
    missing: { results: [], candidateGroupIds: [], error: 'image unavailable' },
  };
  const metrics = bench.computeMetrics(samples, sample => predictions[sample.file]);
  assert.equal(metrics.top1, 2, 'crop accuracy is not inferred from rank');
  assert.equal(metrics.geometryTotal, 3);
  assert.equal(metrics.geometryPassed, 1);
  assert.equal(metrics.geometryRate, 1 / 3);
  assert.equal(metrics.rows[1].geometry.maxErrorPx, 6);
  assert.equal(metrics.rows[2].geometry.passed, false);
  assert.equal(bench.computeMetrics([{ file: 'legacy' }], () => []).geometryTotal, 0);
});

test('diagnostics report the earliest observed failure and separate coarse from final group rank', () => {
  const samples = ['hit', 'crop', 'recall', 'refine', 'error'].map(file => ({
    file, groupId: 'truth', geometry: { width: 640, height: 360 },
  }));
  const goodGeometry = { passed: true, maxErrorPx: 0, tolerancePx: 1 };
  const predictions = {
    hit: { results: [{ groupId: 'truth', name: 'member' }], candidateGroupIds: ['truth'],
      geometry: goodGeometry, stage1Results: [{ groupId: 'truth' }], metrics: { coarseMs: 2, refineMs: 5, totalMs: 8 } },
    crop: { results: [{ groupId: 'truth' }], candidateGroupIds: ['truth'],
      geometry: { passed: false, maxErrorPx: 6 }, metrics: { totalMs: 9 } },
    recall: { results: [{ groupId: 'other' }], candidateGroupIds: ['other'], geometry: goodGeometry },
    refine: { results: [{ groupId: 'other', name: 'one' }, { groupId: 'other', name: 'two' }, { groupId: 'truth' }],
      stage1Results: [{ groupId: 'truth' }, { groupId: 'other' }], candidateGroupIds: ['truth', 'other'], geometry: goodGeometry },
    error: { results: [], candidateGroupIds: [], error: 'reference unavailable' },
  };
  const report = bench.computeMetrics(samples, sample => predictions[sample.file]);
  assert.deepStrictEqual(report.rows.map(row => row.failureStage), [null, 'geometry', 'retrieval', 'refinement', 'execution']);
  assert.deepStrictEqual(report.failureStages, { geometry: 1, retrieval: 1, refinement: 1, execution: 1 });
  assert.equal(report.rows[3].rank, 2, 'rank counts groups, not expanded member rows');
  assert.equal(report.rows[3].coarseRank, 1);
  assert.equal(report.rows[0].timings.refineMs, 5);
  assert.equal(report.rows[1].timings.refineMs, undefined, 'an unmeasured duration is not zero');
  assert.equal(report.rows[2].predictedGroupId, 'other');
});

test('stage metrics distinguish candidate recall, final rank and expected member presence', () => {
  const samples = [
    { file: 'a', groupId: 'g1', packId: 'one' },
    { file: 'b', groupId: 'g2', packId: 'two' },
    { file: 'c', groupId: 'g3', packId: 'three' },
    { file: 'd', groupId: 'g4', packId: 'four' },
  ];
  const predictions = {
    a: { candidateGroupIds: ['g1', 'g2'], results: [{ groupId: 'g1', name: 'one' }] },
    b: { candidateGroupIds: ['g2'], results: [{ groupId: 'g9', name: 'nine' }] },
    c: { candidateGroupIds: ['g8'], results: [{ groupId: 'g3', name: 'not-three' }] },
    d: { error: 'extraction failed', candidateGroupIds: [], results: [] },
  };
  const metrics = bench.computeMetrics(samples, sample => predictions[sample.file]);
  assert.equal(metrics.total, 4);
  assert.equal(metrics.top1, 2);
  assert.equal(metrics.coarseRecall, 2);
  assert.equal(metrics.memberPresent, 1);
  assert.equal(metrics.failures, 1);
  assert.deepStrictEqual(metrics.rows.map(row => row.candidateCount), [2, 1, 1, 0]);
  assert.equal(metrics.coarseRecallRate, 0.5);
});

test('metrics report group-level top-1 and final-ranking presence for component experiments', () => {
  const samples = [
    { file: 'a', groupId: 'g1' },
    { file: 'b', groupId: 'g2' },
    { file: 'c', groupId: 'g3' },
    { file: 'd', groupId: 'g4' },
  ];
  const ranked = {
    a: ['g1', 'g9'],            // top-1 hit, recalled
    b: ['g9', 'g2'],            // recalled but not top-1
    c: ['g9', 'g8'],            // never recalled
    d: ['g4'],                  // top-1 hit
  };

  const metrics = bench.computeMetrics(samples, sample => ranked[sample.file]);

  assert.equal(metrics.total, 4);
  assert.equal(metrics.top1, 2);
  assert.equal(metrics.recall, 3);
  assert.equal(metrics.top1Rate, 0.5);
  assert.equal(metrics.recallRate, 0.75);
});

test('metrics honour observable groups so equivalent members still count as a hit', () => {
  const samples = [{ file: 'a', groupId: 'g1' }];
  const metrics = bench.computeMetrics(samples, () => ['g7'], { g1: { members: ['g1', 'g7'] } });
  assert.equal(metrics.top1, 1);
});
