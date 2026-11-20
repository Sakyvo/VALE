// Minecraft potion compositing: a tinted liquid mask painted under a bottle sprite.
//
// The liquid mask is `potion_overlay.png`, a greyscale shape that Minecraft multiplies
// by the potion's colour, so the shading survives the tint. The bottle sprite is drawn
// on top: `potion_bottle_drinkable.png` for drinkable potions and
// `potion_bottle_splash.png` for splash potions.

const sharp = require('sharp');
const { getFirstFrameBuffer } = require('../thumbnail-preview-utils');

const POTION_COLORS = {
  instant_health: [248, 36, 35],
  fire_resistance: [228, 154, 58],
  speed: [124, 175, 198],
};

const POTION_BOTTLES = {
  drinkable: 'assets/minecraft/textures/items/potion_bottle_drinkable.png',
  splash: 'assets/minecraft/textures/items/potion_bottle_splash.png',
};

const POTION_OVERLAY = 'assets/minecraft/textures/items/potion_overlay.png';

// The potion products the site publishes: file name, bottle shape, colour.
const POTION_PRODUCTS = [
  { file: 'splash_potion_of_healing.png', bottle: 'splash', color: 'instant_health' },
  { file: 'potion_speed.png', bottle: 'drinkable', color: 'speed' },
  { file: 'potion_fire_resistance.png', bottle: 'drinkable', color: 'fire_resistance' },
];

// Multiplies the mask by the colour and keeps the mask's own alpha, so a shaded mask
// stays shaded.
async function tintLiquid(overlay, color) {
  const { data, info } = await sharp(overlay).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      continue;
    }
    data[i] = Math.round((data[i] * color[0]) / 255);
    data[i + 1] = Math.round((data[i + 1] * color[1]) / 255);
    data[i + 2] = Math.round((data[i + 2] * color[2]) / 255);
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

async function compositePotion({ bottle, overlay, color }) {
  const frames = await Promise.all([bottle, overlay].map(getFirstFrameBuffer));
  const metas = await Promise.all(frames.map(frame => sharp(frame).metadata()));
  const size = Math.max(...metas.flatMap(m => [m.width, m.height]));
  const [bottleBuffer, overlayBuffer] = await Promise.all(frames.map(frame =>
    sharp(frame).resize(size, size, { kernel: 'nearest' }).png().toBuffer()));

  const liquid = await tintLiquid(overlayBuffer, color ?? POTION_COLORS.instant_health);
  const meta = await sharp(liquid).metadata();

  return sharp({
    create: { width: meta.width, height: meta.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      { input: liquid, blend: 'over' },
      { input: bottleBuffer, blend: 'over' },
    ])
    .png()
    .toBuffer();
}

module.exports = {
  POTION_BOTTLES,
  POTION_COLORS,
  POTION_OVERLAY,
  POTION_PRODUCTS,
  compositePotion,
  tintLiquid,
};