const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const DETAIL_ITEM_TEXTURES = [
  'diamond_sword.png',
  'ender_pearl.png',
  'splash_potion_of_healing.png',
  'steak.png',
  'iron_sword.png',
  'fishing_rod_uncast.png',
  'apple_golden.png',
  'golden_carrot.png',
];

const PREVIEW_TEXTURE_FILES = new Set([
  ...DETAIL_ITEM_TEXTURES,
  'bow.png',
  'bow_standby.png',
  'potion_overlay.png',
  'potion_bottle_splash.png',
  'grass_side.png',
  'stone.png',
  'cobblestone.png',
  'wool_colored_white.png',
  'dirt.png',
  'planks_oak.png',
  'log_oak.png',
  'diamond_ore.png',
  'particle_magicCrit.png',
  'particle_crit.png',
  'buff_speed.png',
  'buff_fire_resistance.png',
  'potion_bottle_drinkable.png',
  'potion_speed.png',
  'potion_fire_resistance.png',
]);

const LOW_ALPHA_MAX = 16;
const NEUTRAL_DELTA_MAX = 12;
const DARK_RGB_MAX = 96;

function shouldSanitizePreviewTexture(filename) {
  return PREVIEW_TEXTURE_FILES.has(path.basename(filename));
}

function isLowAlphaNeutralDark(r, g, b, a) {
  if (a <= 0 || a > LOW_ALPHA_MAX) return false;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max <= DARK_RGB_MAX && max - min <= NEUTRAL_DELTA_MAX;
}

async function ensurePngBuffer(input) {
  return sharp(input).png().toBuffer();
}

async function getFirstFrameBuffer(input) {
  const buffer = Buffer.isBuffer(input) ? input : await fs.promises.readFile(input);
  const meta = await sharp(buffer).metadata();
  if (meta.height > meta.width && meta.height % meta.width === 0) {
    return sharp(buffer)
      .extract({ left: 0, top: 0, width: meta.width, height: meta.width })
      .png()
      .toBuffer();
  }
  return ensurePngBuffer(buffer);
}

async function sanitizePreviewPngBuffer(input) {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let changed = false;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];

    if (a === 0) {
      if (r || g || b) {
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
        changed = true;
      }
      continue;
    }

    if (!isLowAlphaNeutralDark(r, g, b, a)) continue;
    data[i] = 0;
    data[i + 1] = 0;
    data[i + 2] = 0;
    data[i + 3] = 0;
    changed = true;
  }

  return {
    changed,
    buffer: await sharp(data, {
      raw: { width: info.width, height: info.height, channels: info.channels },
    }).png().toBuffer(),
  };
}

async function sanitizeFirstFrameBuffer(input) {
  const firstFrame = await getFirstFrameBuffer(input);
  const { buffer } = await sanitizePreviewPngBuffer(firstFrame);
  return buffer;
}

async function sanitizeTextureFileInPlace(filePath) {
  const original = await fs.promises.readFile(filePath);
  const { buffer, changed } = await sanitizePreviewPngBuffer(original);
  if (changed) await fs.promises.writeFile(filePath, buffer);
  return changed;
}

// --- Cover: a Minecraft 1.8 HUD strip -------------------------------------
//
// The cover is what identifies a pack on the homepage, on List pages and in SBI
// results. It is composed here, from the pack's own masters, at 4x of the 182x49
// HUD so every sprite boundary stays on a whole pixel. Contract:
// ../../.docs/spec/pack-cover.md

const DEFAULT_TEXTURE_ROOT = path.join(__dirname, '..', 'Default_Texture', 'assets', 'minecraft', 'textures');

const COVER_SCALE = 4;
const HUD_WIDTH = 182;
const HUD_HEIGHT = 49;
const COVER_BACKGROUND = [0x87, 0xce, 0xeb, 0xff];

// Rows, in base units.
const ARMOR_ROW_Y = 0;
const STATUS_ROW_Y = 10;
const XP_BAR_Y = 20;
const HOTBAR_Y = 27;
const XP_FILL_WIDTH = 145;

// Text is always drawn at the vanilla 8-unit glyph size, whatever the pack's own
// ascii.png resolution is: an HD font would overflow a 9-unit HUD row.
const TEXT_SIZE = 8;
const DIGIT_ADVANCE = 6;
const EXP_LEVEL = '15';
const EXP_LEVEL_Y = 14;
const EXP_LEVEL_COLOR = [0x80, 0xff, 0x20];
const STACK_COUNT_COLOR = [0xff, 0xff, 0xff];

const HOTBAR_ITEMS = [
  { files: ['diamond_sword.png'] },
  { files: ['ender_pearl.png'], count: 16 },
  { files: ['potion_speed.png'] },
  { files: ['potion_fire_resistance.png'] },
  { files: ['splash_potion_of_healing.png'] },
  { files: ['bow.png', 'bow_standby.png'] },
  { files: ['steak.png', 'beef_cooked.png'], count: 64 },
  { files: ['golden_carrot.png', 'carrot_golden.png'], count: 64 },
  { files: ['apple_golden.png'], count: 64 },
];

// Decoding an 8192px atlas to raw RGBA needs hundreds of megabytes, and the cover
// only ever samples at 4x the 256-base grid. Capping the decode there is lossless for
// sprite geometry and keeps a bulk rebuild inside a normal memory budget.
const SPRITE_CAPS = {
  atlas: 256 * COVER_SCALE,      // icons.png, widgets.png
  font: 256,                     // ascii.png: one 16x16 cell grid, drawn 8 units tall
  item: 16 * COVER_SCALE,        // a 16-unit slot at 4x
};

async function readSprite(filePath, cap) {
  const buffer = Buffer.isBuffer(filePath) ? filePath : await fs.promises.readFile(filePath);
  const meta = await sharp(buffer).metadata();
  // Animated strips stack square frames vertically; a cover shows the first one.
  const frame = meta.height > meta.width && meta.height % meta.width === 0
    ? sharp(buffer).extract({ left: 0, top: 0, width: meta.width, height: meta.width })
    : sharp(buffer);
  const decoded = meta.width > cap ? frame.resize({ width: cap, kernel: 'nearest' }) : frame;
  const { data, info } = await decoded.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function loadSprite(outputDir, files, defaultDir, cap) {
  const candidates = [
    ...files.map(name => path.join(outputDir, name)),
    ...files.map(name => path.join(DEFAULT_TEXTURE_ROOT, defaultDir, name)),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return readSprite(candidate, cap);
  }
  // Old local masters have raw potion components but no drinkable products.
  // Compose in memory so the detail-page assets and SBI masters stay unchanged.
  const { POTION_PRODUCTS, POTION_BOTTLES, POTION_COLORS, POTION_OVERLAY, compositePotion } = require('./lib/potion-composite');
  const product = POTION_PRODUCTS.find(p => files.includes(p.file));
  if (product) {
    const component = async relative => {
      const local = path.join(outputDir, path.basename(relative));
      return fs.promises.readFile(fs.existsSync(local) ? local : path.join(DEFAULT_TEXTURE_ROOT, 'items', path.basename(relative)));
    };
    const buffer = await compositePotion({
      bottle: await component(POTION_BOTTLES[product.bottle]),
      overlay: await component(POTION_OVERLAY),
      color: POTION_COLORS[product.color],
    });
    return readSprite(buffer, cap);
  }
  return null;
}

// Nearest-neighbour blit in output pixels, painted over whatever is already there.
function blit(target, source, sx, sy, sw, sh, dx, dy, dw, dh, tint) {
  const stepX = sw / dw;
  const stepY = sh / dh;
  for (let y = 0; y < dh; y++) {
    const targetY = dy + y;
    if (targetY < 0 || targetY >= target.height) continue;
    const sourceY = sy + Math.floor(y * stepY);
    for (let x = 0; x < dw; x++) {
      const targetX = dx + x;
      if (targetX < 0 || targetX >= target.width) continue;
      const si = (sourceY * source.width + sx + Math.floor(x * stepX)) * 4;
      const alpha = source.data[si + 3];
      if (alpha === 0) continue;
      const di = (targetY * target.width + targetX) * 4;
      const r = tint ? (source.data[si] * tint[0]) / 255 : source.data[si];
      const g = tint ? (source.data[si + 1] * tint[1]) / 255 : source.data[si + 1];
      const b = tint ? (source.data[si + 2] * tint[2]) / 255 : source.data[si + 2];
      if (alpha === 255) {
        target.data[di] = r;
        target.data[di + 1] = g;
        target.data[di + 2] = b;
        target.data[di + 3] = 255;
        continue;
      }
      const sourceAlpha = alpha / 255;
      const targetAlpha = target.data[di + 3] / 255;
      const outAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
      target.data[di] = Math.round((r * sourceAlpha + target.data[di] * targetAlpha * (1 - sourceAlpha)) / outAlpha);
      target.data[di + 1] = Math.round((g * sourceAlpha + target.data[di + 1] * targetAlpha * (1 - sourceAlpha)) / outAlpha);
      target.data[di + 2] = Math.round((b * sourceAlpha + target.data[di + 2] * targetAlpha * (1 - sourceAlpha)) / outAlpha);
      target.data[di + 3] = Math.round(outAlpha * 255);
    }
  }
}

// Sprite rectangles are addressed in the vanilla 256-base atlas coordinates.
function drawSprite(target, atlas, u, v, w, h, x, y) {
  const atlasScale = atlas.width / 256;
  blit(
    target, atlas,
    Math.round(u * atlasScale), Math.round(v * atlasScale),
    Math.round(w * atlasScale), Math.round(h * atlasScale),
    x * COVER_SCALE, y * COVER_SCALE, w * COVER_SCALE, h * COVER_SCALE,
  );
}

function drawItem(target, sprite, x, y) {
  blit(target, sprite, 0, 0, sprite.width, sprite.height, x * COVER_SCALE, y * COVER_SCALE, 16 * COVER_SCALE, 16 * COVER_SCALE);
}

function drawGlyph(target, font, glyphX, glyphY, cell, x, y, color) {
  blit(target, font, glyphX, glyphY, cell, cell, x * COVER_SCALE, y * COVER_SCALE, TEXT_SIZE * COVER_SCALE, TEXT_SIZE * COVER_SCALE, color);
}

function textWidth(text) {
  return text.length * DIGIT_ADVANCE;
}

function drawText(target, font, text, x, y, color) {
  const cell = font.width / 16;
  const shadow = [Math.floor(color[0] / 4), Math.floor(color[1] / 4), Math.floor(color[2] / 4)];
  let cursor = x;
  for (const character of text) {
    const code = character.charCodeAt(0);
    const glyphX = (code % 16) * cell;
    const glyphY = Math.floor(code / 16) * cell;
    drawGlyph(target, font, glyphX, glyphY, cell, cursor + 1, y + 1, shadow);
    drawGlyph(target, font, glyphX, glyphY, cell, cursor, y, color);
    cursor += DIGIT_ADVANCE;
  }
}

async function generateCoverFromOutputDir(outputDir, outputFile = 'cover.png') {
  const [icons, widgets, font] = await Promise.all([
    loadSprite(outputDir, ['icons.png'], 'gui', SPRITE_CAPS.atlas),
    loadSprite(outputDir, ['widgets.png'], 'gui', SPRITE_CAPS.atlas),
    loadSprite(outputDir, ['ascii.png'], 'font', SPRITE_CAPS.font),
  ]);
  const items = await Promise.all(
    HOTBAR_ITEMS.map(item => loadSprite(outputDir, item.files, 'items', SPRITE_CAPS.item)),
  );

  const target = {
    data: Buffer.alloc(HUD_WIDTH * COVER_SCALE * HUD_HEIGHT * COVER_SCALE * 4),
    width: HUD_WIDTH * COVER_SCALE,
    height: HUD_HEIGHT * COVER_SCALE,
  };
  for (let i = 0; i < target.data.length; i += 4) {
    target.data[i] = COVER_BACKGROUND[0];
    target.data[i + 1] = COVER_BACKGROUND[1];
    target.data[i + 2] = COVER_BACKGROUND[2];
    target.data[i + 3] = COVER_BACKGROUND[3];
  }

  if (icons) {
    for (let i = 0; i < 10; i++) {
      drawSprite(target, icons, 16, 9, 9, 9, 1 + i * 8, ARMOR_ROW_Y);
      drawSprite(target, icons, 34, 9, 9, 9, 1 + i * 8, ARMOR_ROW_Y);
      drawSprite(target, icons, 16, 0, 9, 9, 1 + i * 8, STATUS_ROW_Y);
      drawSprite(target, icons, 52, 0, 9, 9, 1 + i * 8, STATUS_ROW_Y);
      drawSprite(target, icons, 16, 27, 9, 9, HUD_WIDTH - 10 - i * 8, STATUS_ROW_Y);
      drawSprite(target, icons, 52, 27, 9, 9, HUD_WIDTH - 10 - i * 8, STATUS_ROW_Y);
    }
    drawSprite(target, icons, 0, 64, HUD_WIDTH, 5, 0, XP_BAR_Y);
    drawSprite(target, icons, 0, 69, XP_FILL_WIDTH, 5, 0, XP_BAR_Y);
  }

  if (font) {
    drawText(target, font, EXP_LEVEL, Math.round((HUD_WIDTH - textWidth(EXP_LEVEL)) / 2), EXP_LEVEL_Y, EXP_LEVEL_COLOR);
  }

  if (widgets) {
    drawSprite(target, widgets, 0, 0, HUD_WIDTH, 22, 0, HOTBAR_Y);
    drawSprite(target, widgets, 0, 22, 24, 24, -1, HOTBAR_Y - 1);
  }

  for (let i = 0; i < HOTBAR_ITEMS.length; i++) {
    const sprite = items[i];
    if (!sprite) continue;
    const itemX = 1 + i * 20 + 2;
    const itemY = HOTBAR_Y + 1 + 2;
    drawItem(target, sprite, itemX, itemY);
    if (HOTBAR_ITEMS[i].count && font) {
      const label = String(HOTBAR_ITEMS[i].count);
      drawText(target, font, label, itemX + 17 - textWidth(label), itemY + 9, STACK_COUNT_COLOR);
    }
  }

  const coverBuffer = await sharp(target.data, {
    raw: { width: target.width, height: target.height, channels: 4 },
  }).png().toBuffer();
  await fs.promises.writeFile(path.join(outputDir, outputFile), coverBuffer);
  return coverBuffer;
}

module.exports = {
  DETAIL_ITEM_TEXTURES,
  PREVIEW_TEXTURE_FILES,
  HOTBAR_ITEMS,
  COVER_SCALE,
  COVER_BACKGROUND,
  shouldSanitizePreviewTexture,
  getFirstFrameBuffer,
  sanitizePreviewPngBuffer,
  sanitizeFirstFrameBuffer,
  sanitizeTextureFileInPlace,
  generateCoverFromOutputDir,
};
