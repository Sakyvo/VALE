'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { PNG } = require('pngjs');
const { renderMcText } = require('../extract-textures');
const { sanitizeFirstFrameBuffer } = require('../thumbnail-preview-utils');
const { stableStringify } = require('./pack-content-fingerprint');
const { retryWindowsFileOperation } = require('./pack-content-index');

const DEFAULT_SEED = 42;
const INDISTINGUISHABLE_EPSILON = 1e-4;

const PERTURBATION_TIERS = {
  light: { jpegQuality: 90, scale: 1.0, brightnessDelta: 0.05, contrastDelta: 0.05 },
  heavy: { jpegQuality: 70, scale: 0.8, brightnessDelta: 0.15, contrastDelta: 0.15 },
};

// Evidence surface texture file candidates, mirroring generate-sbi-data.js TEXTURES.
// Each surface may resolve to one of several filenames depending on pack.
const SLOT_TEXTURE_FILES = {
  diamond_sword: ['diamond_sword.png'],
  ender_pearl: ['ender_pearl.png'],
  splash_potion: ['splash_potion_of_healing.png', 'potion_bottle_splash.png'],
  steak: ['steak.png'],
  golden_carrot: ['golden_carrot.png'],
  widgets: ['widgets.png'],
  icons: ['icons.png'],
};

function resolveTexture(thumbDir, candidates) {
  for (const f of candidates) {
    const p = path.join(thumbDir, f);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Hotbar widget strip in vanilla widgets.png (256x256 base texture).
const HOTBAR_REGION = { x: 0, y: 0, w: 182, h: 22 };
// HUD sprite regions inside icons.png (256-base). Same coordinates as generate-sbi-data.js.
const HUD_ICON_REGIONS = {
  health_empty:  { x: 16, y: 0,  w: 9, h: 9 },
  health_half:   { x: 61, y: 0,  w: 9, h: 9 },
  health_full:   { x: 52, y: 0,  w: 9, h: 9 },
  hunger_empty:  { x: 16, y: 27, w: 9, h: 9 },
  hunger_half:   { x: 61, y: 27, w: 9, h: 9 },
  hunger_full:   { x: 52, y: 27, w: 9, h: 9 },
  armor_empty:   { x: 16, y: 9,  w: 9, h: 9 },
  armor_half:    { x: 25, y: 9,  w: 9, h: 9 },
  armor_full:    { x: 34, y: 9,  w: 9, h: 9 },
};

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function scaleExtract(texBuf, region, outSize) {
  const meta = await sharp(texBuf).metadata();
  const scale = meta.width / 256;
  const left = Math.max(0, Math.round(region.x * scale));
  const top = Math.max(0, Math.round(region.y * scale));
  const width = Math.max(1, Math.round(region.w * scale));
  const height = Math.max(1, Math.round(region.h * scale));
  return sharp(texBuf)
    .extract({ left, top, width, height })
    .resize(outSize, outSize, { kernel: 'nearest' })
    .png().toBuffer();
}

async function renderHotbar({ widgetPng, itemPngs, outputSize = 360 }) {
  const widget = await sharp(widgetPng).ensureAlpha().toBuffer();
  const widgetMeta = await sharp(widget).metadata();
  const baseW = widgetMeta.width;
  const baseH = widgetMeta.height;
  const scaleFactor = outputSize / baseW;
  const scaledW = outputSize;
  const scaledH = Math.max(1, Math.round(baseH * scaleFactor));

  const bg = await sharp(widget).resize(scaledW, scaledH, { kernel: 'nearest' }).png().toBuffer();

  const composites = [];
  const slotCount = 9;
  const slotW = Math.round(baseW / slotCount);
  for (let i = 0; i < Math.min(itemPngs.length, slotCount); i++) {
    const item = await sharp(itemPngs[i]).resize(slotW, slotW, { kernel: 'nearest' }).png().toBuffer();
    composites.push({ input: item, left: i * slotW, top: 0 });
  }

  return sharp(bg).composite(composites).png().toBuffer();
}

/**
 * Render a full synthetic hotbar+HUD screenshot from pack textures,
 * laid out to match the SBI cropbox (9-slot hotbar strip + HUD icon rows).
 * All regions are taken from the same source coordinates used by generate-sbi-data.js.
 */
async function renderSyntheticShot({ slots = [], status = {}, widgetTex = null, iconsTex = null, outputW = 1920, outputH = 1080, unit = 3, bottomOffset = 0, layoutVersion = 1, fontTex = null }) {
  const hotbarW = Math.round(HOTBAR_REGION.w * unit); // 546
  const hotbarH = Math.round(HOTBAR_REGION.h * unit); // 66
  const hbX = Math.round((outputW - hotbarW) / 2);       // 687
  const hbY = outputH - hotbarH - Math.round(bottomOffset); // 1014 (bottomOffset 0)

  // Dark game-like background
  const bg = await sharp({
    create: { width: outputW, height: outputH, channels: 3, background: { r: 18, g: 16, b: 22 } },
  }).png().toBuffer();

  const composites = [];

  // Hotbar widget strip from the pack's widgets.png (HOTBAR region 182x22), scaled by unit.
  if (widgetTex) {
    const wm = await sharp(widgetTex).metadata();
    const sc = wm.width / 256;
    const strip = await sharp(widgetTex)
      .extract({
        left: Math.max(0, Math.round(HOTBAR_REGION.x * sc)),
        top: Math.max(0, Math.round(HOTBAR_REGION.y * sc)),
        width: Math.max(1, Math.round(HOTBAR_REGION.w * sc)),
        height: Math.max(1, Math.round(HOTBAR_REGION.h * sc)),
      })
      .resize(hotbarW, hotbarH, { kernel: 'nearest' })
      .png().toBuffer();
    composites.push({ input: strip, left: hbX, top: hbY });
  }

  if (layoutVersion >= 2) {
    // Issue 031: items occupy their 16x16 logical cell inside each 20-unit slot, so
    // empty slots keep their position and overlays can be drawn where the game does.
    const itemPx = 16 * unit;
    const itemY = hbY + 3 * unit;
    for (let index = 0; index < Math.min(slots.length, 9); index++) {
      const slot = slots[index];
      if (!slot || !slot.file) continue;
      const item = await sharp(slot.file).resize(itemPx, itemPx, { kernel: 'nearest' }).png().toBuffer();
      const itemX = hbX + (3 + index * 20) * unit;
      composites.push({ input: item, left: Math.round(itemX), top: Math.round(itemY) });
      if (typeof slot.durability === 'number') {
        const bar = await barOverlay(itemPx, slot.durability);
        const barHeight = Math.max(1, Math.round(itemPx * 2 / 16));
        composites.push({ input: bar, left: Math.round(itemX), top: Math.round(itemY + itemPx - barHeight) });
      }
      if (Number.isInteger(slot.count) && slot.count > 1) {
        const badge = await countOverlay(itemPx, slot.count, fontTex);
        const badgeMeta = await sharp(badge).metadata();
        composites.push({ input: badge, left: Math.round(itemX + itemPx - badgeMeta.width),
          top: Math.round(itemY + itemPx - badgeMeta.height) });
      }
    }
  } else {
    // Legacy layout (kept for the historical corpus): 18-unit items packed from slot 0.
    const slotPx = 18 * unit;   // 54
    const slotStep = 20 * unit; // 60
    const slotLeftX = 1 * unit; // 3
    const slotY = hbY + Math.round((hotbarH - slotPx) / 2);
    let slotIdx = 0;
    for (const slot of slots.slice(0, 9)) {
      if (!slot || !slot.file) continue;
      const item = await sharp(slot.file).resize(slotPx, slotPx, { kernel: 'nearest' }).png().toBuffer();
      composites.push({ input: item, left: hbX + slotLeftX + slotIdx * slotStep, top: slotY });
      slotIdx++;
    }
  }

  // Keep the historical HUD layout untouched; v2 uses 8-unit icon spacing.
  const hudComposites = [];
  if (iconsTex) {
    const iconPx = 9 * unit; // 27
    const step = layoutVersion >= 2 ? 8 * unit : iconPx;
    const armorY = layoutVersion >= 2 ? hbY - 27 * unit : hbY - iconPx - 4;
    const statY = layoutVersion >= 2 ? hbY - 17 * unit : armorY - iconPx - 4;
    for (let i = 0; i < 10; i++) {
      const armor = await scaleExtract(iconsTex, HUD_ICON_REGIONS.armor_full, iconPx);
      hudComposites.push({ input: armor, left: hbX + i * step, top: armorY });
    }
    for (let i = 0; i < 10; i++) {
      const health = await scaleExtract(iconsTex, HUD_ICON_REGIONS.health_full, iconPx);
      hudComposites.push({ input: health, left: hbX + i * step, top: statY });
    }
    const hungerX = layoutVersion >= 2 ? hbX + hotbarW - iconPx : hbX + hotbarW - 10 * iconPx;
    for (let i = 0; i < 10; i++) {
      const hunger = await scaleExtract(iconsTex, HUD_ICON_REGIONS.hunger_full, iconPx);
      hudComposites.push({ input: hunger, left: hungerX + (layoutVersion >= 2 ? -i : i) * step, top: statY });
    }
  }

  return sharp(bg).composite([...composites, ...hudComposites]).png().toBuffer();
}

// Durability bar: the game draws it across the bottom two logical pixels of the item cell.
async function barOverlay(itemPx, fraction) {
  const height = Math.max(1, Math.round(itemPx * 2 / 16));
  const filled = Math.max(1, Math.round(itemPx * Math.max(0, Math.min(1, fraction))));
  const background = await sharp({ create: { width: itemPx, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 255 } } }).png().toBuffer();
  const bar = await sharp({ create: { width: filled, height, channels: 4, background: { r: 80, g: 220, b: 40, alpha: 255 } } }).png().toBuffer();
  return sharp(background).composite([{ input: bar, left: 0, top: 0 }]).png().toBuffer();
}

async function countOverlay(itemPx, count, fontTex) {
  if (!fontTex) throw new Error('Stack count requires a source font texture');
  const size = Math.max(2, Math.round(itemPx * 8 / 16));
  return renderMcText(fontTex, String(count), size, [245, 245, 245]);
}

async function applyPerturbation(inputBuf, params, seed) {
  const { jpegQuality, scale, brightnessDelta, contrastDelta } = params;
  const rng = mulberry32(seed);
  const brightnessJitter = 1 + (rng() - 0.5) * 2 * brightnessDelta;
  const contrastAlpha = 1 + (rng() - 0.5) * 2 * contrastDelta;

  const img = sharp(inputBuf);
  const meta = await img.metadata();
  const w = Math.max(1, Math.round(meta.width * (scale ?? 1)));
  const h = Math.max(1, Math.round(meta.height * (scale ?? 1)));

  // Brightness/contrast via linear transform: out = a * in + b
  const b = Math.round((brightnessJitter - 1) * 128);
  const linear = sharp(await img.resize(w, h, { kernel: 'nearest' }).png().toBuffer())
    .linear(contrastAlpha, b);

  return linear.jpeg({ quality: Math.round(jpegQuality) }).png().toBuffer();
}

async function buildSyntheticCorpus({
  corpusDir,
  seed = DEFAULT_SEED,
  groups = {},
  extracted = [],
  thumbsRoot = null,
  tiers = ['light', 'heavy'],
  samplesPerGroup = 2,
} = {}) {
  if (!corpusDir) throw new Error('corpusDir is required');

  const manifest = {
    schemaVersion: 1,
    seed,
    groups: {},
    perturbations: {},
    images: [],
  };
  for (const tier of Object.keys(PERTURBATION_TIERS)) {
    manifest.perturbations[tier] = { ...PERTURBATION_TIERS[tier] };
  }

  fs.mkdirSync(corpusDir, { recursive: true });

  const packIndex = new Map();
  for (const rec of extracted) packIndex.set(rec.packId, rec);

  for (const [groupId, group] of Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]))) {
    const members = (group.members || []).slice().sort((a, b) => a.localeCompare(b));
    manifest.groups[groupId] = { expected: members.length, representative: group.representative || members[0] || null };

    for (const tier of tiers) {
      for (let sampleIndex = 0; sampleIndex < samplesPerGroup; sampleIndex++) {
        for (const packId of members) {
          const thumbDir = path.join(thumbsRoot || 'thumbnails', packId);
          if (!fs.existsSync(thumbDir)) continue;

          const texturePaths = {};
          for (const [key, candidates] of Object.entries(SLOT_TEXTURE_FILES)) {
            const p = resolveTexture(thumbDir, candidates);
            if (p) texturePaths[key] = p;
          }
          if (!texturePaths.diamond_sword) continue;

          const slotTextures = {
            diamond_sword: 'diamond_sword',
            ender_pearl: 'ender_pearl',
            splash_potion: 'splash_potion',
            steak: 'steak',
            golden_carrot: 'golden_carrot',
          };
          const itemNames = Object.keys(slotTextures).filter(t => texturePaths[t]);
          if (itemNames.length === 0) continue;

          const slotDefs = itemNames.map(name => ({
            kind: name === 'splash_potion' ? 'HL' : (name === 'steak' || name === 'golden_carrot' ? 'food' : name.toUpperCase().slice(0, 2)),
            textureName: name,
          }));
          const defaultTexBuf = solidPlaceholder(16, 16, 128, 128, 128);
          const slotItems = slotDefs.map(s => ({
            type: s.kind,
            file: texturePaths[s.textureName] ? fs.readFileSync(texturePaths[s.textureName]) : defaultTexBuf,
          }));
          const hotbar = await renderSyntheticShot({
            slots: slotItems,
            widgetTex: texturePaths.widgets ? fs.readFileSync(texturePaths.widgets) : null,
            iconsTex: texturePaths.icons ? fs.readFileSync(texturePaths.icons) : null,
            unit: 3,
          });

          const params = PERTURBATION_TIERS[tier];
          const perturbed = await applyPerturbation(hotbar, params, seed + sampleIndex);
          const safeGroup = groupId.replace(/[^0-9a-z_-]/gi, '_');
          const file = `${safeGroup}/${tier}/${sampleIndex}-${packId}.png`;
          const dest = path.join(corpusDir, file);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, perturbed);

          manifest.images.push({
            file,
            packId,
            groupId,
            tier,
            sampleIndex,
            seed,
            perturbation: params,
            slotTypes: slotDefs.map(s => s.kind),
            slots: slotDefs,
          });
        }
      }
    }
  }

  const fingerprintSource = JSON.stringify({ version: manifest.schemaVersion, seed, perturbations: manifest.perturbations, groups: manifest.groups, images: manifest.images });
  manifest.hash = sha256Buffer(Buffer.from(fingerprintSource, 'utf8'));
  fs.writeFileSync(path.join(corpusDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { manifest };
}

const ALIGNED_PROFILES = [
  { name: 'sparse', slots: ['diamond_sword', 'ender_pearl', null, null, null, null, null, null, 'golden_carrot'],
    unit: 3, bottomOffset: 0, scale: 1, jpegQuality: 95, brightnessDelta: 0.02, contrastDelta: 0.02 },
  { name: 'full', slots: ['diamond_sword', 'ender_pearl', 'splash_potion', 'steak', 'golden_carrot', 'splash_potion', 'steak', 'ender_pearl', 'golden_carrot'],
    unit: 3, bottomOffset: 12, scale: 5 / 6, jpegQuality: 88, brightnessDelta: 0.04, contrastDelta: 0.04 },
  { name: 'repeated', slots: ['diamond_sword', 'ender_pearl', 'splash_potion', 'splash_potion', 'splash_potion', 'splash_potion', 'splash_potion', 'splash_potion', 'steak'],
    unit: 3, bottomOffset: 0, scale: 1, jpegQuality: 90, brightnessDelta: 0.05, contrastDelta: 0.05 },
];

async function planAlignedCorpus({ groups, thumbsRoot, seed = DEFAULT_SEED }) {
  const images = [], groupRecords = {};
  const sources = { ...SLOT_TEXTURE_FILES, font: ['ascii.png'] };
  for (const [groupId, group] of Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))) {
    const role = parseInt(sha256Buffer(Buffer.from(`${seed}:${groupId}`)).slice(0, 8), 16) % 5 === 0 ? 'development' : 'acceptance';
    const members = [...group.members].sort();
    groupRecords[groupId] = { ...group, members, role };
    for (const packId of members) {
      if (path.basename(packId) !== packId) throw new Error('Invalid pack path');
      const sourceFiles = {}, sourceHashes = {}, missing = [];
      for (const [key, candidates] of Object.entries(sources)) {
        const file = resolveTexture(path.join(thumbsRoot, packId), candidates);
        if (!file) { missing.push(key); continue; }
        sourceFiles[key] = path.basename(file);
        sourceHashes[key] = sha256Buffer(await fs.promises.readFile(file));
      }
      for (const [profileIndex, profile] of ALIGNED_PROFILES.entries()) {
        const unit = profile.unit, scale = profile.scale;
        const hbX = Math.round((1920 - 182 * unit) / 2), hbY = 1080 - 22 * unit - profile.bottomOffset;
        const mapRect = (x, y, w, h) => ({ x: x * scale, y: y * scale, w: w * scale, h: h * scale });
        const slots = profile.slots.map((type, index) => type ? { index, textureName: type,
          ...(index === 0 ? { durability: 0.55 } : { count: index % 2 ? 12 : 62 }) } : null);
        const id = sha256Buffer(Buffer.from(`${groupId}:${packId}:${profile.name}`));
        images.push({ file: `${role}/${id}.png`, groupId, packId, role, tier: 'light', profile: profile.name,
          seed: (seed + parseInt(id.slice(0, 8), 16)) >>> 0,
          preset: 'large', sourceFiles, sourceHashes,
          ...(missing.length ? { sourceError: 'Missing source textures: ' + missing.join(', ') } : {}),
          slots, perturbation: { ...profile, slots: undefined }, sampleIndex: profileIndex,
          geometry: { width: Math.round(1920 * scale), height: Math.round(1080 * scale), effectiveUnit: unit * scale,
            widgetRect: mapRect(hbX, hbY, 182 * unit, 22 * unit),
            slotRects: Array.from({ length: 9 }, (_, i) => mapRect(hbX + (3 + 20 * i) * unit, hbY + 3 * unit, 16 * unit, 16 * unit)) } });
      }
    }
  }
  const plan = { schemaVersion: 2, layoutVersion: 2, seed, groups: groupRecords, images,
    provenance: { rendererSha256: sha256Buffer(fs.readFileSync(__filename)),
      fontRendererSha256: sha256Buffer(fs.readFileSync(require.resolve('../extract-textures'))),
      frameReaderSha256: sha256Buffer(fs.readFileSync(require.resolve('../thumbnail-preview-utils'))),
      sharp: sharp.versions, groupSha256: sha256Buffer(Buffer.from(stableStringify(groups))) } };
  plan.hash = sha256Buffer(Buffer.from(stableStringify(plan)));
  return JSON.parse(JSON.stringify(plan));
}

async function renderAlignedCorpus(plan, { corpusDir, thumbsRoot, onProgress } = {}) {
  if (!corpusDir || !thumbsRoot) throw new Error('Aligned corpus requires output and source roots');
  const { hash, ...body } = plan;
  if (plan.schemaVersion !== 2 || hash !== sha256Buffer(Buffer.from(stableStringify(body)))) throw new Error('Invalid aligned corpus plan');
  if (plan.provenance.rendererSha256 !== sha256Buffer(fs.readFileSync(__filename)) ||
      plan.provenance.fontRendererSha256 !== sha256Buffer(fs.readFileSync(require.resolve('../extract-textures'))) ||
      plan.provenance.frameReaderSha256 !== sha256Buffer(fs.readFileSync(require.resolve('../thumbnail-preview-utils'))) ||
      stableStringify(plan.provenance.sharp) !== stableStringify(sharp.versions)) throw new Error('Aligned renderer provenance changed');
  // Validate frozen inputs before reusing any rendered rows, including resume hits.
  const verifiedSources = new Map();
  for (const sample of plan.images) {
    if (path.basename(sample.packId) !== sample.packId) throw new Error('Invalid source path');
    for (const [type, name] of Object.entries(sample.sourceFiles)) {
      if (path.basename(name) !== name) throw new Error('Invalid source path');
      const file = path.join(thumbsRoot, sample.packId, name);
      let hash = verifiedSources.get(file);
      if (!hash) {
        if (!fs.existsSync(file)) throw new Error('Source changed since plan: missing ' + file);
        hash = sha256Buffer(await fs.promises.readFile(file));
        verifiedSources.set(file, hash);
      }
      if (hash !== sample.sourceHashes[type]) throw new Error('Source changed since plan: ' + file);
    }
  }
  fs.mkdirSync(corpusDir, { recursive: true });
  const planFile = path.join(corpusDir, 'plan.json');
  if (fs.existsSync(planFile) && JSON.parse(fs.readFileSync(planFile, 'utf8')).hash !== hash) throw new Error('Refusing to overwrite another corpus plan');
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
  const manifest = { schemaVersion: 2, layoutVersion: 2, planHash: hash, seed: plan.seed,
    provenance: plan.provenance, groups: plan.groups, images: [] };
  const checkpoint = path.join(corpusDir, 'manifest.partial.json');
  const prior = fs.existsSync(checkpoint) ? JSON.parse(fs.readFileSync(checkpoint, 'utf8')) : null;
  if (prior && prior.planHash !== hash) throw new Error('Incompatible corpus checkpoint');
  const completed = new Map((prior?.images || []).map(row => [row.file, row]));
  for (const sample of plan.images) {
    const file = path.resolve(corpusDir, sample.file);
    if (!file.startsWith(path.resolve(corpusDir) + path.sep)) throw new Error('Invalid corpus image path');
    const previous = completed.get(sample.file);
    if (previous?.sha256 && fs.existsSync(file) && sha256Buffer(fs.readFileSync(file)) === previous.sha256) {
      manifest.images.push(previous);
    } else {
      let row;
      try {
        if (sample.sourceError) throw new Error(sample.sourceError);
        const buffers = {};
        for (const [type, name] of Object.entries(sample.sourceFiles)) {
          if (path.basename(name) !== name || path.basename(sample.packId) !== sample.packId) throw new Error('Invalid source path');
          const buffer = await fs.promises.readFile(path.join(thumbsRoot, sample.packId, name));
          if (sha256Buffer(buffer) !== sample.sourceHashes[type]) throw new Error('Source changed since plan: ' + type);
          buffers[type] = ['widgets', 'icons', 'font'].includes(type) ? buffer : await sanitizeFirstFrameBuffer(buffer);
        }
        const shot = await renderSyntheticShot({ layoutVersion: 2, unit: sample.perturbation.unit,
          bottomOffset: sample.perturbation.bottomOffset,
          slots: sample.slots.map(slot => slot ? { ...slot, file: buffers[slot.textureName] } : null),
          widgetTex: buffers.widgets, iconsTex: buffers.icons, fontTex: buffers.font });
        const png = await applyPerturbation(shot, sample.perturbation, sample.seed);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file, png);
        row = { ...sample, sha256: sha256Buffer(png) };
      } catch (error) { row = { ...sample, error: error.message }; }
      manifest.images.push(row);
    }
    if (manifest.images.length >= (prior?.images.length || 0) &&
        (manifest.images.length % 25 === 0 || manifest.images.length === plan.images.length)) {
      fs.writeFileSync(checkpoint + '.tmp', JSON.stringify(manifest));
      retryWindowsFileOperation(() => fs.renameSync(checkpoint + '.tmp', checkpoint));
      if (onProgress) onProgress(manifest.images.length, plan.images.length);
    }
  }
  manifest.hash = sha256Buffer(Buffer.from(stableStringify(manifest)));
  fs.writeFileSync(path.join(corpusDir, 'manifest.json.tmp'), JSON.stringify(manifest));
  retryWindowsFileOperation(() => fs.renameSync(path.join(corpusDir, 'manifest.json.tmp'), path.join(corpusDir, 'manifest.json')));
  return manifest;
}

function solidPlaceholder(w, h, r = 32, g = 32, b = 32) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

module.exports = {
  INDISTINGUISHABLE_EPSILON,
  DEFAULT_SEED,
  PERTURBATION_TIERS,
  SLOT_TEXTURE_FILES,
  applyPerturbation,
  buildSyntheticCorpus,
  planAlignedCorpus,
  renderAlignedCorpus,
  mulberry32,
  renderHotbar,
  renderSyntheticShot,
  sha256Buffer,
};
