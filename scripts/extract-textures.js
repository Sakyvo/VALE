const AdmZip = require('adm-zip');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
  shouldSanitizePreviewTexture,
  sanitizePreviewPngBuffer,
  generateCoverFromOutputDir,
} = require('./thumbnail-preview-utils');
const { PACK_ID_OVERRIDES, sanitizeName } = require('./pack-utils');

// 粒子图集裁剪映射 (16x16 网格, index = x + y * 16)
const PARTICLE_TILES = {
  magicCrit: { index: 65, x: 1, y: 4 },  // 锋利/附魔暴击
  crit: { index: 66, x: 2, y: 4 },       // 普通暴击
};

// 药水Buff图标映射 (从 inventory.png 的 v=198 开始，横向排列，每个 18x18)
// 每行 8 个图标
const BUFF_ICONS = {
  speed: { row: 0, col: 0 },           // 速度 (蓝色脚印) - index 0
  fire_resistance: { row: 1, col: 7 }, // 抗火 (橙色火焰) - index 15
};

const KEY_TEXTURES = {
  items: [
    ['assets/minecraft/textures/items/diamond_sword.png'],
    ['assets/minecraft/textures/items/ender_pearl.png'],
    { composite: 'potion', bottle: 'assets/minecraft/textures/items/potion_bottle_splash.png', overlay: 'assets/minecraft/textures/items/potion_overlay.png', color: [248, 36, 35] },
    ['assets/minecraft/textures/items/steak.png', 'assets/minecraft/textures/items/beef_cooked.png'],
    ['assets/minecraft/textures/items/iron_sword.png'],
    ['assets/minecraft/textures/items/fishing_rod_uncast.png'],
    ['assets/minecraft/textures/items/apple_golden.png'],
    ['assets/minecraft/textures/items/golden_carrot.png', 'assets/minecraft/textures/items/carrot_golden.png'],
  ],
  blocks: [
    ['assets/minecraft/textures/blocks/grass_side.png'],
    ['assets/minecraft/textures/blocks/stone.png'],
    ['assets/minecraft/textures/blocks/cobblestone.png'],
    ['assets/minecraft/textures/blocks/wool_colored_white.png'],
    ['assets/minecraft/textures/blocks/dirt.png'],
    ['assets/minecraft/textures/blocks/planks_oak.png'],
    ['assets/minecraft/textures/blocks/log_oak.png'],
    ['assets/minecraft/textures/blocks/diamond_ore.png'],
  ],
  armor: [
    ['assets/minecraft/textures/models/armor/diamond_layer_1.png'],
    ['assets/minecraft/textures/models/armor/diamond_layer_2.png'],
  ],
  gui: [
    ['assets/minecraft/textures/gui/icons.png'],
    ['assets/minecraft/textures/gui/widgets.png'],
    ['assets/minecraft/textures/gui/container/inventory.png'],
  ],
  font: [['assets/minecraft/textures/font/ascii.png']],
  skin: [['assets/minecraft/textures/entity/steve.png']],
  particle: [['assets/minecraft/textures/particle/particles.png']],
};

// Extract first frame from animated texture (height > width vertical strip)
async function getFirstFrame(buffer) {
  const meta = await sharp(buffer).metadata();
  if (meta.height > meta.width && meta.height % meta.width === 0) {
    return sharp(buffer).extract({ left: 0, top: 0, width: meta.width, height: meta.width }).png().toBuffer();
  }
  return sharp(buffer).png().toBuffer();
}

function cleanMinecraftText(text) {
  if (!text) return '';
  let r = text.replace(/^(?:§[0-9a-fk-or])*[!#]+\s*/gi, '');
  if (text.includes('§')) r = r.replace(/_([0-9a-fk-or])/gi, '§$1');
  return r.replace(/§[0-9a-fk-or]/gi, '').replace(/[§]/g, '').trim();
}

function parseDescription(desc) {
  if (!desc) return '';
  if (typeof desc === 'string') return cleanMinecraftText(desc);
  if (Array.isArray(desc)) {
    return desc.map(d => typeof d === 'string' ? cleanMinecraftText(d) : (d.text ? cleanMinecraftText(d.text) : '')).join(' ');
  }
  if (desc.text) return cleanMinecraftText(desc.text);
  return '';
}

const JUNK_FILES = /(?:^|\/)(thumbs\.db|\.ds_store|desktop\.ini)$/i;

function isJunk(name) { return JUNK_FILES.test(name); }

function addZipEntryIfReadable(zip, entry, rel = entry.entryName) {
  try {
    zip.addFile(rel, entry.getData());
  } catch (err) {
    console.warn(`  Skipped unreadable zip entry: ${entry.entryName} (${err.message})`);
  }
}

function fixNestedArchive(zipPath) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const hasAssets = entries.some(e => e.entryName.startsWith('assets/'));
  let needsRebuild = false;

  // Case 1: nested archive (zip/rar inside zip, no top-level assets/)
  if (!hasAssets) {
    const innerArchive = entries.find(e =>
      !e.isDirectory && (e.entryName.endsWith('.zip') || e.entryName.endsWith('.rar'))
    );

    // Case 2: nested same-name folder containing assets/
    const nestedFolder = !innerArchive && entries.find(e => {
      const parts = e.entryName.split('/');
      return parts.length > 2 && parts[1] === 'assets';
    });

    if (innerArchive) {
      const innerBaseName = path.basename(innerArchive.entryName, path.extname(innerArchive.entryName));
      console.log(`  Nested archive detected: ${innerArchive.entryName}`);
      const tmpDir = path.join('tmp_nested_' + Date.now());
      fs.mkdirSync(tmpDir, { recursive: true });
      try {
        const innerPath = path.join(tmpDir, 'inner' + path.extname(innerArchive.entryName));
        fs.writeFileSync(innerPath, innerArchive.getData());
        const extractDir = path.join(tmpDir, 'extracted');
        fs.mkdirSync(extractDir, { recursive: true });
        if (innerPath.endsWith('.rar')) {
          execSync(`7z x "${innerPath}" -o"${extractDir}" -y`, { stdio: 'pipe' });
        } else {
          new AdmZip(innerPath).extractAllTo(extractDir, true);
        }
        const newZip = new AdmZip();
        function addClean(dir, zipDir) {
          for (const item of fs.readdirSync(dir)) {
            const full = path.join(dir, item);
            const rel = zipDir ? zipDir + '/' + item : item;
            if (isJunk(rel)) continue;
            if (fs.statSync(full).isDirectory()) {
              if (['assets'].includes(item) || zipDir) addClean(full, rel);
            } else {
              if (!zipDir && !['pack.mcmeta', 'pack.png'].includes(item)) continue;
              newZip.addFile(rel, fs.readFileSync(full));
            }
          }
        }
        addClean(extractDir, '');
        const newZipPath = path.join(path.dirname(zipPath), innerBaseName + '.zip');
        newZip.writeZip(newZipPath);
        if (newZipPath !== zipPath) fs.rmSync(zipPath, { force: true });
        console.log(`  Rebuilt as: ${path.basename(newZipPath)}`);
        return newZipPath;
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }

    if (nestedFolder) {
      const prefix = nestedFolder.entryName.split('/')[0] + '/';
      console.log(`  Nested folder detected: ${prefix}`);
      const newZip = new AdmZip();
      for (const e of entries) {
        if (e.isDirectory || !e.entryName.startsWith(prefix)) continue;
        const rel = e.entryName.slice(prefix.length);
        if (!rel || isJunk(rel)) continue;
        const top = rel.split('/')[0];
        if (rel.includes('/')) {
          if (top !== 'assets') continue;
        } else {
          if (!['pack.mcmeta', 'pack.png'].includes(rel.toLowerCase()) && top !== 'assets') continue;
        }
        addZipEntryIfReadable(newZip, e, rel);
      }
      newZip.writeZip(zipPath);
      console.log(`  Rebuilt from nested folder: ${path.basename(zipPath)}`);
      return zipPath;
    }

    return zipPath;
  }

  // Case 3: has assets/ at root but may contain junk files or non-pack files at root
  const hasJunk = entries.some(e => isJunk(e.entryName));
  const hasExtraRoot = entries.some(e => {
    if (e.isDirectory) return false;
    const parts = e.entryName.split('/');
    if (parts.length === 1) {
      return !['pack.mcmeta', 'pack.png'].includes(parts[0].toLowerCase());
    }
    return false;
  });

  if (hasJunk || hasExtraRoot) {
    const newZip = new AdmZip();
    for (const e of entries) {
      if (e.isDirectory) continue;
      if (isJunk(e.entryName)) continue;
      const parts = e.entryName.split('/');
      if (parts.length === 1 && !['pack.mcmeta', 'pack.png'].includes(parts[0].toLowerCase())) continue;
      if (parts.length > 1 && parts[0] !== 'assets') continue;
      addZipEntryIfReadable(newZip, e);
    }
    newZip.writeZip(zipPath);
    console.log(`  Cleaned junk from: ${path.basename(zipPath)}`);
  }

  return zipPath;
}

function convertRarToZip(rarPath) {
  const baseName = path.basename(rarPath, '.rar');
  const zipPath = path.join(path.dirname(rarPath), baseName + '.zip');
  if (fs.existsSync(zipPath)) return zipPath;

  const tmpDir = path.join('tmp_rar_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    execSync(`7z x "${rarPath}" -o"${tmpDir}" -y`, { stdio: 'pipe' });

    const newZip = new AdmZip();
    function addDir(dir, zipDir) {
      for (const item of fs.readdirSync(dir)) {
        const full = path.join(dir, item);
        const rel = zipDir ? zipDir + '/' + item : item;
        if (fs.statSync(full).isDirectory()) {
          addDir(full, rel);
        } else {
          newZip.addFile(rel, fs.readFileSync(full));
        }
      }
    }
    addDir(tmpDir, '');
    newZip.writeZip(zipPath);
    console.log(`  Converted rar to zip: ${baseName}.zip`);
    return zipPath;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function extractPack(zipPath) {
  const sourceOriginalName = path.basename(zipPath, path.extname(zipPath));
  zipPath = fixNestedArchive(zipPath);
  const originalName = sourceOriginalName;
  let packId = sanitizeName(originalName);
  const override = PACK_ID_OVERRIDES[packId];
  if (override && override.check(originalName)) {
    packId = override.id;
  }
  const zip = new AdmZip(zipPath);

  // Validate: must have pack.mcmeta
  if (!zip.getEntry('pack.mcmeta')) {
    console.log(`  Skipped: no pack.mcmeta`);
    return null;
  }

  const outputDir = path.join('thumbnails', packId);
  fs.mkdirSync(outputDir, { recursive: true });

  const extracted = { items: [], blocks: [], armor: [], gui: [], font: [], skin: [], particle: [] };
  let description = '';

  // Extract pack.png (use default if not found)
  const packPng = zip.getEntry('pack.png');
  if (packPng) {
    fs.writeFileSync(path.join(outputDir, 'pack.png'), packPng.getData());
  } else {
    fs.copyFileSync('Default_Texture/pack.png', path.join(outputDir, 'pack.png'));
  }

  // Extract pack.mcmeta
  const mcmeta = zip.getEntry('pack.mcmeta');
  if (mcmeta) {
    try {
      const data = JSON.parse(mcmeta.getData().toString('utf-8'));
      description = parseDescription(data.pack?.description);
    } catch (e) {}
  }

  // Extract icon.png (some packs have this)
  const iconPng = zip.getEntry('icon.png');
  if (iconPng) {
    fs.writeFileSync(path.join(outputDir, 'icon.png'), iconPng.getData());
  }

  for (const [category, pathsArray] of Object.entries(KEY_TEXTURES)) {
    for (const alternatives of pathsArray) {
      // Handle composite textures (like potions)
      if (alternatives.composite === 'potion') {
        const filename = 'splash_potion_of_healing.png';
        const bottleEntry = zip.getEntry(alternatives.bottle);
        const overlayEntry = zip.getEntry(alternatives.overlay);

        let bottleBuffer = bottleEntry ? bottleEntry.getData() : null;
        let overlayBuffer = overlayEntry ? overlayEntry.getData() : null;

        if (!bottleBuffer) {
          const defaultPath = path.join('Default_Texture', alternatives.bottle);
          if (fs.existsSync(defaultPath)) bottleBuffer = fs.readFileSync(defaultPath);
        }
        if (!overlayBuffer) {
          const defaultPath = path.join('Default_Texture', alternatives.overlay);
          if (fs.existsSync(defaultPath)) overlayBuffer = fs.readFileSync(defaultPath);
        }

        if (bottleBuffer && overlayBuffer) {
          const [r, g, b] = alternatives.color;

          // Extract first frame if animated
          bottleBuffer = await getFirstFrame(bottleBuffer);
          overlayBuffer = await getFirstFrame(overlayBuffer);

          // Normalize both textures to the same size
          const bottleMeta = await sharp(bottleBuffer).metadata();
          const overlayMeta0 = await sharp(overlayBuffer).metadata();
          const targetSize = Math.max(bottleMeta.width, bottleMeta.height, overlayMeta0.width, overlayMeta0.height);

          if (bottleMeta.width !== targetSize || bottleMeta.height !== targetSize) {
            bottleBuffer = await sharp(bottleBuffer).resize(targetSize, targetSize, { kernel: 'nearest' }).toBuffer();
          }
          if (overlayMeta0.width !== targetSize || overlayMeta0.height !== targetSize) {
            overlayBuffer = await sharp(overlayBuffer).resize(targetSize, targetSize, { kernel: 'nearest' }).toBuffer();
          }

          // 获取 overlay 的原始像素数据
          const overlayRaw = await sharp(overlayBuffer)
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

          const overlayPixels = overlayRaw.data;
          const { width, height } = overlayRaw.info;

          // Multiply 染色：颜色与灰度相乘，保留阴影细节
          for (let i = 0; i < overlayPixels.length; i += 4) {
            if (overlayPixels[i + 3] > 0) {
              overlayPixels[i] = Math.round(overlayPixels[i] * r / 255);
              overlayPixels[i + 1] = Math.round(overlayPixels[i + 1] * g / 255);
              overlayPixels[i + 2] = Math.round(overlayPixels[i + 2] * b / 255);
            }
          }

          // 创建染色后的 overlay
          const tintedOverlay = await sharp(overlayPixels, { raw: { width, height, channels: 4 } })
            .png()
            .toBuffer();

          // 正确的合成顺序：透明画布 + 染色液体 + 瓶子
          const overlayMeta = await sharp(tintedOverlay).metadata();
          const composited = await sharp({
            create: {
              width: overlayMeta.width,
              height: overlayMeta.height,
              channels: 4,
              background: { r: 0, g: 0, b: 0, alpha: 0 }
            }
          })
            .composite([
              { input: tintedOverlay, blend: 'over' },
              { input: bottleBuffer, blend: 'over' }
            ])
            .png()
            .toBuffer();

          const sanitizedPotion = await sanitizePreviewPngBuffer(composited);
          await fs.promises.writeFile(path.join(outputDir, filename), sanitizedPotion.buffer);

          // 同时保存原始 overlay 和 bottle 供前端动态渲染使用
          const sanitizedOverlay = await sanitizePreviewPngBuffer(overlayBuffer);
          const sanitizedBottle = await sanitizePreviewPngBuffer(bottleBuffer);
          fs.writeFileSync(path.join(outputDir, 'potion_overlay.png'), sanitizedOverlay.buffer);
          fs.writeFileSync(path.join(outputDir, 'potion_bottle_splash.png'), sanitizedBottle.buffer);

          extracted[category].push(filename);
        }
        continue;
      }

      let entry = null;
      const filename = path.basename(alternatives[0]);
      for (const alt of alternatives) {
        entry = zip.getEntry(alt);
        if (entry) break;
      }
      if (entry) {
        let outBuffer = entry.getData();
        if (shouldSanitizePreviewTexture(filename)) {
          outBuffer = (await sanitizePreviewPngBuffer(outBuffer)).buffer;
        }
        fs.writeFileSync(path.join(outputDir, filename), outBuffer);
        // Also extract .mcmeta if exists
        const mcmetaEntry = zip.getEntry(alternatives[0] + '.mcmeta');
        if (mcmetaEntry) {
          fs.writeFileSync(path.join(outputDir, filename + '.mcmeta'), mcmetaEntry.getData());
        }
      } else {
        // Fallback to Default_Texture
        for (const alt of alternatives) {
          const defaultPath = path.join('Default_Texture', alt);
          if (fs.existsSync(defaultPath)) {
            let outBuffer = fs.readFileSync(defaultPath);
            if (shouldSanitizePreviewTexture(filename)) {
              outBuffer = (await sanitizePreviewPngBuffer(outBuffer)).buffer;
            }
            fs.writeFileSync(path.join(outputDir, filename), outBuffer);
            break;
          }
        }
      }
      if (fs.existsSync(path.join(outputDir, filename))) {
        extracted[category].push(filename);
      }
    }
  }

  // 从 particles.png 裁剪出单个粒子贴图
  const particlesPath = path.join(outputDir, 'particles.png');
  if (fs.existsSync(particlesPath)) {
    await extractParticleTiles(particlesPath, outputDir);
  }

  // 生成带暗化背景的背包预览图
  const inventoryPath = path.join(outputDir, 'inventory.png');
  if (fs.existsSync(inventoryPath)) {
    await generateInventoryPreview(inventoryPath, outputDir);
    // 提取药水buff图标
    await extractBuffIcons(inventoryPath, outputDir);
  }

  await generateCover(packId, extracted, outputDir);

  return { packId, originalName, extracted, outputDir, description };
}

async function renderMcText(asciiPath, text, targetCellH) {
  const meta = await sharp(asciiPath).metadata();
  const srcCellW = Math.round(meta.width / 16);
  const srcCellH = Math.round(meta.height / 16);

  // 读取整个 ascii.png 的 raw 像素用于测量字符宽度
  const asciiRaw = await sharp(asciiPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const asciiPixels = asciiRaw.data;
  const imgW = asciiRaw.info.width;

  // 测量字符实际宽度：找最右非透明像素列
  function getCharWidth(charCode) {
    const col = charCode % 16;
    const row = Math.floor(charCode / 16);
    const ox = col * srcCellW;
    const oy = row * srcCellH;
    let maxCol = 0;
    for (let cy = 0; cy < srcCellH; cy++) {
      for (let cx = srcCellW - 1; cx >= 0; cx--) {
        const idx = ((oy + cy) * imgW + (ox + cx)) * 4;
        if (asciiPixels[idx + 3] > 0) {
          if (cx + 1 > maxCol) maxCol = cx + 1;
          break;
        }
      }
    }
    // 空格特殊处理：宽度 = cellW 的一半
    if (maxCol === 0) return Math.round(srcCellW / 2);
    return maxCol + 1; // +1 for spacing
  }

  const charInfos = [];
  let totalW = 0;
  for (const c of text) {
    const code = c.charCodeAt(0);
    const col = code % 16;
    const row = Math.floor(code / 16);
    const w = getCharWidth(code);
    charInfos.push({ code, col, row, w });
    totalW += w;
  }

  // 逐字符裁剪并紧凑拼接
  const composites = [];
  let curX = 0;
  for (const info of charInfos) {
    const buf = await sharp(asciiPath)
      .extract({ left: info.col * srcCellW, top: info.row * srcCellH, width: info.w, height: srcCellH })
      .toBuffer();
    composites.push({ input: buf, left: curX, top: 0 });
    curX += info.w;
  }

  let textBuf = await sharp({
    create: { width: totalW, height: srcCellH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  }).composite(composites).raw().toBuffer({ resolveWithObject: true });

  const pixels = textBuf.data;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] > 0) {
      pixels[i] = 64; pixels[i + 1] = 64; pixels[i + 2] = 64;
    }
  }

  const ratio = targetCellH / srcCellH;
  const finalW = Math.round(totalW * ratio);
  const finalH = targetCellH;
  return sharp(pixels, { raw: { width: totalW, height: srcCellH, channels: 4 } })
    .resize(finalW, finalH, { kernel: 'nearest' })
    .png()
    .toBuffer();
}

async function renderSkinFront(skinPath, targetHeight) {
  const skinMeta = await sharp(skinPath).metadata();
  const isOld = skinMeta.height === skinMeta.width / 2; // 64x32 format
  const skinScale = skinMeta.width / 64;
  const s = skinScale;

  const parts = {
    head:     { sx: 8*s,  sy: 8*s,  w: 8*s,  h: 8*s  },
    body:     { sx: 20*s, sy: 20*s, w: 8*s,  h: 12*s },
    rightArm: { sx: 44*s, sy: 20*s, w: 4*s,  h: 12*s },
    rightLeg: { sx: 4*s,  sy: 20*s, w: 4*s,  h: 12*s },
    leftArm:  isOld ? null : { sx: 36*s, sy: 52*s, w: 4*s, h: 12*s },
    leftLeg:  isOld ? null : { sx: 20*s, sy: 52*s, w: 4*s, h: 12*s },
  };

  const extractPart = (p) => sharp(skinPath)
    .extract({ left: p.sx, top: p.sy, width: p.w, height: p.h })
    .toBuffer();

  const mirrorPart = (p) => sharp(skinPath)
    .extract({ left: p.sx, top: p.sy, width: p.w, height: p.h })
    .flop()
    .toBuffer();

  const canvasW = 16 * s;
  const canvasH = 32 * s;

  const composites = [
    { input: await extractPart(parts.head), left: 4*s, top: 0 },
    { input: await extractPart(parts.body), left: 4*s, top: 8*s },
    { input: parts.leftArm ? await extractPart(parts.leftArm) : await mirrorPart(parts.rightArm), left: 0, top: 8*s },
    { input: await extractPart(parts.rightArm), left: 12*s, top: 8*s },
    { input: parts.leftLeg ? await extractPart(parts.leftLeg) : await mirrorPart(parts.rightLeg), left: 4*s, top: 20*s },
    { input: await extractPart(parts.rightLeg), left: 8*s, top: 20*s },
  ];

  const scaleRatio = targetHeight / canvasH;
  const finalW = Math.round(canvasW * scaleRatio);

  return sharp({
    create: { width: canvasW, height: canvasH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  })
    .composite(composites)
    .resize(finalW, targetHeight, { kernel: 'nearest' })
    .png()
    .toBuffer();
}

// 生成带暗化背景的背包预览图 inv.png
async function generateInventoryPreview(inventoryPath, outputDir) {
  try {
    const metadata = await sharp(inventoryPath).metadata();
    const { width } = metadata;
    const scale = width / 256;

    // 裁剪主背包区域 (0,0,176,166) - 256-base 坐标
    const cropW = Math.round(176 * scale);
    const cropH = Math.round(166 * scale);

    // 在 inventory 裁剪图上合成 Crafting 文字（在缩放之前）
    const invCropComposites = [];

    // "Crafting" 文字 - 位置 (256-base): 约 (86,16)
    const asciiPath = path.join(outputDir, 'ascii.png');
    if (fs.existsSync(asciiPath)) {
      const textBuf = await renderMcText(asciiPath, 'Crafting', Math.round(8 * scale));
      const textX = Math.round(86 * scale);
      const textY = Math.round(16 * scale);
      invCropComposites.push({ input: textBuf, left: textX, top: textY, blend: 'over' });
    }

    let inventoryCrop;
    if (invCropComposites.length > 0) {
      inventoryCrop = await sharp(inventoryPath)
        .extract({ left: 0, top: 0, width: cropW, height: cropH })
        .composite(invCropComposites)
        .toBuffer();
    } else {
      inventoryCrop = await sharp(inventoryPath)
        .extract({ left: 0, top: 0, width: cropW, height: cropH })
        .toBuffer();
    }

    // 创建方形画布 (512x512)
    const canvasSize = 512;
    const padding = 24;

    const availableSize = canvasSize - padding * 2;
    const invAspect = 176 / 166;
    let destW, destH;
    if (invAspect > 1) {
      destW = availableSize;
      destH = Math.round(availableSize / invAspect);
    } else {
      destH = availableSize;
      destW = Math.round(availableSize * invAspect);
    }

    const destX = Math.round((canvasSize - destW) / 2);
    const destY = Math.round((canvasSize - destH) / 2);

    const resizedInventory = await sharp(inventoryCrop)
      .resize(destW, destH, { kernel: 'nearest' })
      .toBuffer();

    const gradientSvg = `
      <svg width="${canvasSize}" height="${canvasSize}">
        <defs>
          <linearGradient id="darkGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" style="stop-color:rgb(16,16,16);stop-opacity:0.75"/>
            <stop offset="100%" style="stop-color:rgb(16,16,16);stop-opacity:0.82"/>
          </linearGradient>
        </defs>
        <rect width="${canvasSize}" height="${canvasSize}" fill="url(#darkGrad)"/>
      </svg>
    `;

    await sharp({
      create: {
        width: canvasSize,
        height: canvasSize,
        channels: 4,
        background: { r: 139, g: 139, b: 139, alpha: 255 }
      }
    })
      .composite([
        { input: Buffer.from(gradientSvg), blend: 'over' },
        { input: resizedInventory, left: destX, top: destY, blend: 'over' }
      ])
      .png()
      .toFile(path.join(outputDir, 'inv.png'));

  } catch (e) {
    console.error(`  Failed to generate inventory preview: ${e.message}`);
  }
}

// 从 particles.png 图集中裁剪指定粒子
async function extractParticleTiles(imagePath, outputDir) {
  try {
    const metadata = await sharp(imagePath).metadata();
    const { width, height } = metadata;

    // particles.png 是 16x16 网格
    const tileW = Math.floor(width / 16);
    const tileH = Math.floor(height / 16);

    for (const [name, tile] of Object.entries(PARTICLE_TILES)) {
      const sx = tile.x * tileW;
      const sy = tile.y * tileH;

      await sharp(imagePath)
        .extract({ left: sx, top: sy, width: tileW, height: tileH })
        .png()
        .toFile(path.join(outputDir, `particle_${name}.png`));
    }
  } catch (e) {
    console.error(`  Failed to extract particle tiles: ${e.message}`);
  }
}

// 从 inventory.png 图集中裁剪药水buff图标
// 图标位于 v=198 开始，横向排列，每个 18x18
async function extractBuffIcons(inventoryPath, outputDir) {
  try {
    const metadata = await sharp(inventoryPath).metadata();
    const { width } = metadata;
    const scale = width / 256;

    const iconSize = Math.round(18 * scale);
    const baseV = Math.round(198 * scale);

    for (const [name, icon] of Object.entries(BUFF_ICONS)) {
      const sx = icon.col * iconSize;
      const sy = baseV + icon.row * iconSize;

      await sharp(inventoryPath)
        .extract({ left: sx, top: sy, width: iconSize, height: iconSize })
        .png()
        .toFile(path.join(outputDir, `buff_${name}.png`));
    }
  } catch (e) {
    console.error(`  Failed to extract buff icons: ${e.message}`);
  }
}

async function generateCover(packId, textures, outputDir) {
  await generateCoverFromOutputDir(outputDir);
}

async function main() {
  const args = process.argv.slice(2);
  let packsDir = 'resourcepacks';
  let merge = false;
  let manifestPath = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input') packsDir = args[++i];
    else if (args[i] === '--merge') merge = true;
    else if (args[i] === '--manifest') manifestPath = args[++i];
  }
  if (!fs.existsSync(packsDir)) {
    console.log(`No input directory found: ${packsDir}`);
    return;
  }

  const files = fs.readdirSync(packsDir).filter(f => f.endsWith('.zip') || f.endsWith('.rar'));
  const existingResults = merge && fs.existsSync('data/extracted.json')
    ? JSON.parse(fs.readFileSync('data/extracted.json', 'utf-8'))
    : [];
  const results = [...existingResults];
  const usedIds = new Set(existingResults.map(r => r.packId));
  const allowedIds = manifestPath
    ? new Set(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')).extractPackIds || [])
    : null;

  for (const file of files) {
    console.log(`Processing: ${file}`);
    try {
      let zipPath = path.join(packsDir, file);
      if (file.endsWith('.rar')) {
        zipPath = convertRarToZip(zipPath);
      }
      // Pre-compute packId to check duplicates BEFORE extracting
      const originalName = path.basename(zipPath, '.zip');
      let packId = sanitizeName(originalName);
      const override = PACK_ID_OVERRIDES[packId];
      if (override && override.check(originalName)) {
        packId = override.id;
      }
      if (allowedIds && !allowedIds.has(packId)) {
        console.log(`  Skipped: ${packId} (not in manifest extract set)`);
        continue;
      }
      if (usedIds.has(packId)) {
        console.log(`  Skipped: ${packId} (duplicate of existing)`);
        continue;
      }
      const result = await extractPack(zipPath);
      if (!result) continue;
      usedIds.add(result.packId);
      results.push(result);
      console.log(`  Extracted: ${result.packId}`);
    } catch (err) {
      console.error(`  Error: ${err.message}`);
    }
  }

  fs.writeFileSync('data/extracted.json', JSON.stringify(results, null, 2));
  console.log(`Done. Processed ${results.length} packs.`);
}

main();
