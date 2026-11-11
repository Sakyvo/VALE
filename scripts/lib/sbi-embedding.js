'use strict';

// Embedding side of SBI: a small CNN (see scripts/ml/train_embed.py) maps one
// 16x16 slot icon to a 128-d unit vector. Pack identity is then a nearest-
// neighbour problem over the corpus, which is what pixel/palette matching was
// failing to do on screenshots.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const MODEL_PATH = path.join(ROOT, 'assets', 'models', 'sbi-embed.onnx');
const EMBED_DIM = 128;
const ICON_SIZE = 16;
const PLATE = [32, 32, 32];
const ICON_FILL = 0.86;

const TYPES = ['diamond_sword', 'ender_pearl', 'splash_potion', 'steak', 'golden_carrot'];
const TYPE_FILES = {
  diamond_sword: ['diamond_sword.png'],
  ender_pearl: ['ender_pearl.png'],
  splash_potion: ['splash_potion_of_healing.png', 'potion_bottle_splash.png'],
  steak: ['steak.png'],
  golden_carrot: ['golden_carrot.png'],
};

let _session = null;

async function getSession() {
  if (_session) return _session;
  if (!fs.existsSync(MODEL_PATH)) throw new Error('missing embedding model at ' + MODEL_PATH);
  const ort = require('onnxruntime-node');
  _session = await ort.InferenceSession.create(MODEL_PATH);
  return _session;
}

// Pack textures keep transparent padding that the game does not draw, so crop to
// the opaque bounding box before scaling — otherwise the reference icon is a
// different size than the one on screen.
function contentBox(rgba, width, height, alphaMin = 48) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] < alphaMin) continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

function resizeNearest(rgba, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y + 0.5) * sh / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x + 0.5) * sw / dw));
      const s = (sy * sw + sx) * 4;
      const d = (y * dw + x) * 4;
      out[d] = rgba[s]; out[d + 1] = rgba[s + 1]; out[d + 2] = rgba[s + 2]; out[d + 3] = rgba[s + 3];
    }
  }
  return out;
}

// Build the 16x16 icon the game actually shows: item scaled into a slot plate.
function renderIcon(rgba, width, height, size = ICON_SIZE) {
  const box = contentBox(rgba, width, height);
  if (!box) return null;
  const itemPx = Math.max(2, Math.round(size * ICON_FILL));
  const cropped = new Uint8ClampedArray(box.width * box.height * 4);
  for (let y = 0; y < box.height; y++) {
    for (let x = 0; x < box.width; x++) {
      const s = ((box.y + y) * width + (box.x + x)) * 4;
      const d = (y * box.width + x) * 4;
      cropped[d] = rgba[s]; cropped[d + 1] = rgba[s + 1]; cropped[d + 2] = rgba[s + 2]; cropped[d + 3] = rgba[s + 3];
    }
  }
  const icon = resizeNearest(cropped, box.width, box.height, itemPx, itemPx);
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = PLATE[0]; out[i + 1] = PLATE[1]; out[i + 2] = PLATE[2]; out[i + 3] = 255;
  }
  const offset = Math.floor((size - itemPx) / 2);
  for (let y = 0; y < itemPx; y++) {
    for (let x = 0; x < itemPx; x++) {
      const s = (y * itemPx + x) * 4;
      const alpha = icon[s + 3] / 255;
      if (alpha <= 0) continue;
      const d = ((y + offset) * size + (x + offset)) * 4;
      out[d] = icon[s] * alpha + out[d] * (1 - alpha);
      out[d + 1] = icon[s + 1] * alpha + out[d + 1] * (1 - alpha);
      out[d + 2] = icon[s + 2] * alpha + out[d + 2] * (1 - alpha);
    }
  }
  return out;
}

// RGBA bytes (any size) -> normalised float tensor, channels-first, RGB + alpha.
function toTensor(rgba, width, height) {
  const size = width * height;
  const tensor = new Float32Array(4 * size);
  for (let i = 0; i < size; i++) {
    tensor[i] = rgba[i * 4] / 255;
    tensor[size + i] = rgba[i * 4 + 1] / 255;
    tensor[2 * size + i] = rgba[i * 4 + 2] / 255;
    tensor[3 * size + i] = rgba[i * 4 + 3] / 255;
  }
  return tensor;
}

async function embedBatch(icons, size = ICON_SIZE) {
  if (!icons.length) return [];
  const session = await getSession();
  const ort = require('onnxruntime-node');
  const flat = new Float32Array(icons.length * 4 * size * size);
  icons.forEach((icon, index) => {
    const t = icon.length === 4 * size * size ? toTensor(icon, size, size) : toTensor(icon, ICON_SIZE, ICON_SIZE);
    flat.set(t, index * 4 * size * size);
  });
  const feed = { slot: new ort.Tensor('float32', flat, [icons.length, 4, size, size]) };
  const out = await session.run(feed);
  const dims = out.embedding.dims;
  const data = out.embedding.data;
  const dim = dims[dims.length - 1];
  const result = [];
  for (let i = 0; i < icons.length; i++) {
    result.push(Array.from(data.slice(i * dim, (i + 1) * dim)));
  }
  return result;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

module.exports = { MODEL_PATH, EMBED_DIM, ICON_SIZE, TYPES, TYPE_FILES, renderIcon, contentBox, resizeNearest, toTensor, embedBatch, cosine, getSession };
