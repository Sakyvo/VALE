const fs = require('fs');
const path = require('path');
const { LOCAL_ASSET_BASE, buildAssetUrl, resolveAssetBase } = require('./lib/asset-remote');

const PAGE_SIZE = 50;

const MC_COLORS = {
  '0': '#000000', '1': '#0000AA', '2': '#00AA00', '3': '#00AAAA',
  '4': '#AA0000', '5': '#AA00AA', '6': '#FFAA00', '7': '#AAAAAA',
  '8': '#555555', '9': '#5555FF', 'a': '#55FF55', 'b': '#55FFFF',
  'c': '#FF5555', 'd': '#FF55FF', 'e': '#FFFF55', 'f': '#FFFFFF'
};

function cleanMinecraftText(text) {
  if (!text) return '';
  let r = text.replace(/^(?:§[0-9a-fk-or])*[!#]+\s*/gi, '');
  if (text.includes('§')) r = r.replace(/_([0-9a-fk-or])/gi, '§$1');
  return r.replace(/§[0-9a-fk-or]/gi, '').replace(/[§]/g, '').replace(/^[^0-9a-zA-Z\u4e00-\u9fff$]+/, '').trim();
}

function toColoredHtml(text) {
  if (!text) return '';
  let cleaned = text.replace(/^(?:§[0-9a-fk-or])*[!#]+\s*/gi, '');
  if (text.includes('§')) cleaned = cleaned.replace(/_([0-9a-fk-or])/gi, '§$1');
  cleaned = cleaned.replace(/^[^0-9a-zA-Z\u4e00-\u9fff§$]+/, '').trim();
  let result = '', color = null;
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === '§' && i + 1 < cleaned.length) {
      const code = cleaned[i + 1].toLowerCase();
      if (MC_COLORS[code]) color = MC_COLORS[code];
      i++;
    } else {
      result += color ? `<span style="color:${color}">${cleaned[i]}</span>` : cleaned[i];
    }
  }
  return result;
}

function formatSize(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)}MB` : `${(bytes / 1024).toFixed(0)}KB`;
}

function getFileSize(filePath, registryEntry) {
  if (registryEntry && registryEntry.size) return formatSize(registryEntry.size);
  try {
    return formatSize(fs.statSync(filePath).size);
  } catch { return 'Unknown'; }
}

function main() {
  const extractedPath = 'data/extracted.json';
  if (!fs.existsSync(extractedPath)) {
    console.log('No extracted.json found. Run extract-textures.js first.');
    return;
  }

  let extracted = JSON.parse(fs.readFileSync(extractedPath, 'utf-8'));
  const today = new Date().toISOString().split('T')[0];

  // Load existing per-pack JSON to preserve first-seen uploadDate across rebuilds.
  // GitHub auto-build runs on every push; without this every rebuild would reset
  // uploadDate to the current date.
  function readExistingUploadDate(packId) {
    try {
      const existing = JSON.parse(fs.readFileSync(`data/packs/${packId}.json`, 'utf-8'));
      if (existing && typeof existing.uploadDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(existing.uploadDate)) {
        return existing.uploadDate;
      }
    } catch {}
    return null;
  }

  // Load pack registry for download URLs
  const registryPath = 'data/pack-registry.json';
  const registry = fs.existsSync(registryPath) ? JSON.parse(fs.readFileSync(registryPath, 'utf-8')) : null;
  const assetBasePath = 'data/asset-base.json';
  const assetBaseConfig = fs.existsSync(assetBasePath) ? JSON.parse(fs.readFileSync(assetBasePath, 'utf-8')) : null;

  // Load lists
  const listsPath = 'l/lists.json';
  const lists = fs.existsSync(listsPath) ? JSON.parse(fs.readFileSync(listsPath, 'utf-8')) : [];
  const packToLists = {};
  lists.forEach(list => {
    list.packs.forEach(packName => {
      if (!packToLists[packName]) packToLists[packName] = [];
      packToLists[packName].push(list.name);
    });
  });

  // Deduplicate packIds - skip duplicates
  const usedIds = new Set();
  extracted = extracted.filter(e => {
    if (usedIds.has(e.packId)) return false;
    usedIds.add(e.packId);
    return true;
  });

  // Generate pack details
  const packs = extracted.map(e => {
    const zipName = `${e.originalName}.zip`;
    const encodedName = encodeURIComponent(e.originalName);
    let githubUrl, mirrorUrl;
    if (registry && registry[zipName]) {
      const repo = registry[zipName].repo;
      githubUrl = `https://raw.githubusercontent.com/Sakyvo/${repo}/main/resourcepacks/${encodedName}.zip`;
      mirrorUrl = `https://ghfast.top/https://raw.githubusercontent.com/Sakyvo/${repo}/main/resourcepacks/${encodedName}.zip`;
    } else {
      githubUrl = `https://raw.githubusercontent.com/Sakyvo/VALE/main/resourcepacks/${encodedName}.zip`;
      mirrorUrl = `https://ghfast.top/https://raw.githubusercontent.com/Sakyvo/VALE/main/resourcepacks/${encodedName}.zip`;
    }
    const assetBase = resolveAssetBase(assetBaseConfig, e.packId);
    return {
      id: e.originalName,
      name: e.packId,
      displayName: cleanMinecraftText(e.originalName) || e.packId,
      coloredName: toColoredHtml(e.originalName),
      description: e.description || '',
      cover: buildAssetUrl(assetBase, e.packId, 'cover.png'),
      packPng: buildAssetUrl(assetBase, e.packId, 'pack.png'),
      icon: fs.existsSync(path.join(e.outputDir, 'icon.png')) ? buildAssetUrl(assetBase, e.packId, 'icon.png') : null,
      ...(assetBase !== LOCAL_ASSET_BASE ? { assetBase } : {}),
      file: `resourcepacks/${e.originalName}.zip`,
      fileSize: getFileSize(path.join('resourcepacks', `${e.originalName}.zip`), registry && registry[zipName]),
      uploadDate: readExistingUploadDate(e.packId) || today,
      lists: packToLists[e.packId] || [],
      textures: e.extracted,
      downloads: {
        github: githubUrl,
        mirror: mirrorUrl
      }
    };
  });

  // Sort by displayName for A-Z
  packs.sort((a, b) => a.displayName.localeCompare(b.displayName, 'en'));

  // Write individual pack JSON
  fs.mkdirSync('data/packs', { recursive: true });
  packs.forEach(p => {
    fs.writeFileSync(`data/packs/${p.name}.json`, JSON.stringify(p, null, 2));
  });

  // Generate index.json (lightweight). Issue 019: drop fields the homepage card
  // renderer and search do not consume (id/description) so the index does not
  // balloon with pack count. Search/grid use name/displayName/coloredName/lists/cover/packPng.
  const indexItems = packs.map(p => ({
    name: p.name,
    displayName: p.displayName,
    coloredName: p.coloredName,
    lists: p.lists,
    cover: p.cover,
    packPng: p.packPng,
    ...(p.assetBase ? { assetBase: p.assetBase } : {})
  }));

  const index = {
    total: packs.length,
    pageSize: PAGE_SIZE,
    pages: Math.ceil(packs.length / PAGE_SIZE),
    items: indexItems
  };
  fs.writeFileSync('data/index.json', JSON.stringify(index, null, 2));

  // Issue 019: stamp a build-version cache key (content hash of the index) into
  // pack-loader.js so Cloudflare can cache index.json / page data instead of being
  // busted by a per-request timestamp.
  const crypto = require('crypto');
  const indexHash = crypto.createHash('sha256').update(JSON.stringify(index)).digest('hex').slice(0, 8);
  const loaderPath = path.join(__dirname, '..', 'assets', 'js', 'pack-loader.js');
  let loaderSrc = fs.readFileSync(loaderPath, 'utf8');
  const before = loaderSrc;
  loaderSrc = loaderSrc.replace(/(const VALE_INDEX_VERSION = )[^;]+;/, `$1'${indexHash}';`);
  if (loaderSrc !== before) fs.writeFileSync(loaderPath, loaderSrc);

  // Likewise stamp lists.json content hash into list.js so list page data is cacheable.
  const listsJsonPath = path.join(__dirname, '..', 'l', 'lists.json');
  if (fs.existsSync(listsJsonPath)) {
    const listsHash = crypto.createHash('sha256').update(fs.readFileSync(listsJsonPath)).digest('hex').slice(0, 8);
    const listJsPath = path.join(__dirname, '..', 'assets', 'js', 'list.js');
    let listSrc = fs.readFileSync(listJsPath, 'utf8');
    const beforeList = listSrc;
    listSrc = listSrc.replace(/(const VALE_LISTS_VERSION = )[^;]+;/, `$1'${listsHash}';`);
    if (listSrc !== beforeList) fs.writeFileSync(listJsPath, listSrc);
  }

  // Generate paginated data
  fs.mkdirSync('data/pages', { recursive: true });
  for (let i = 0; i < index.pages; i++) {
    const pageItems = packs.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE);
    fs.writeFileSync(`data/pages/page-${i + 1}.json`, JSON.stringify({ page: i + 1, items: pageItems }, null, 2));
  }

  console.log(`Generated index with ${packs.length} packs, ${index.pages} pages.`);
}

main();
