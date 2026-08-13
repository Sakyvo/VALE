'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { PNG } = require('pngjs');

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
async function renderSyntheticShot({ slots = [], status = {}, widgetTex = null, iconsTex = null, outputW = 1920, outputH = 1080, unit = 3 }) {
  const hotbarW = Math.round(HOTBAR_REGION.w * unit); // 546
  const hotbarH = Math.round(HOTBAR_REGION.h * unit); // 66
  const hbX = Math.round((outputW - hotbarW) / 2);       // 687
  const hbY = outputH - hotbarH;                        // 1014 (bottomOffset 0)

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

  // Item slots inside the hotbar strip (CROPBOX_SLOT_LEFT=1, STEP=20, slots vertically centered).
  const slotPx = 18 * unit;   // 54
  const slotStep = 20 * unit; // 60
  const slotLeftX = 1 * unit; // 3
  const slotY = hbY + Math.round((hotbarH - slotPx) / 2);
  let slotIdx = 0;
  const slotComposites = [];
  for (const slot of slots.slice(0, 9)) {
    if (!slot || !slot.file) continue;
    const item = await sharp(slot.file).resize(slotPx, slotPx, { kernel: 'nearest' }).png().toBuffer();
    slotComposites.push({ input: item, left: hbX + slotLeftX + slotIdx * slotStep, top: slotY });
    slotIdx++;
  }

  // HUD icons from icons.png: armor row above hotbar, health (left) + hunger (right) above armor.
  const hudComposites = [];
  if (iconsTex) {
    const iconPx = 9 * unit; // 27
    const armorY = hbY - iconPx - 4;
    const statY = armorY - iconPx - 4;
    for (let i = 0; i < 10; i++) {
      const armor = await scaleExtract(iconsTex, HUD_ICON_REGIONS.armor_full, iconPx);
      hudComposites.push({ input: armor, left: hbX + i * iconPx, top: armorY });
    }
    for (let i = 0; i < 10; i++) {
      const health = await scaleExtract(iconsTex, HUD_ICON_REGIONS.health_full, iconPx);
      hudComposites.push({ input: health, left: hbX + i * iconPx, top: statY });
    }
    const hungerX = hbX + hotbarW - 10 * iconPx;
    for (let i = 0; i < 10; i++) {
      const hunger = await scaleExtract(iconsTex, HUD_ICON_REGIONS.hunger_full, iconPx);
      hudComposites.push({ input: hunger, left: hungerX + i * iconPx, top: statY });
    }
  }

  return sharp(bg).composite([...composites, ...slotComposites, ...hudComposites]).png().toBuffer();
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
  mulberry32,
  renderHotbar,
  renderSyntheticShot,
  sha256Buffer,
};
