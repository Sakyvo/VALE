```markdown
# Minecraft 1.7/1.8 材质包分享网站 - 设计文档

> 仓库地址: https://github.com/Sakyvo/VALE  
> 部署地址: https://vale.cc.cd

---

## 一、项目概述

### 1.1 项目简介

一个基于 GitHub Pages 的 Minecraft 1.7/1.8 材质包分享网站，支持自动提取材质生成封面、瀑布流展示、3D 盔甲预览、搜索功能和用户提交审核。

### 1.2 规模预估

| 阶段 | 材质包数量 |
|------|-----------|
| 初期 | 100-300 |
| 中期 | 2000+ |
| 后期 | 10000+ |

### 1.3 技术栈

| 层级 | 技术选型 |
|------|----------|
| 前端 | HTML5 + CSS3 + Vanilla JS |
| 构建 | Node.js + GitHub Actions |
| 部署 | GitHub Pages |
| 3D渲染 | Three.js |
| 图片处理 | Sharp |
| ZIP解析 | AdmZip |

---

## 二、系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                    GitHub Pages (静态托管)                   │
├─────────────────────────────────────────────────────────────┤
│  前端: HTML + CSS + Vanilla JS                              │
│  构建: GitHub Actions (自动提取材质、生成索引)                │
│  数据: JSON 索引文件 + 静态资源                              │
└─────────────────────────────────────────────────────────────┘

工作流:
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ 上传 ZIP │───▶│ Actions  │───▶│ 提取材质 │───▶│ 生成索引 │
│ + Meta   │    │ 触发构建 │    │ 生成封面 │    │ 部署页面 │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
```

---

## 三、目录结构

```
VALE/
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   └── pack-submission.yml       # 材质包提交模板
│   └── workflows/
│       ├── build.yml                 # 主构建流程
│       └── process-submission.yml    # 用户提交审核处理
├── packs/                            # 材质包 ZIP 源文件
│   ├── faithful-32x.zip
│   └── default-edit.zip
├── pack-meta/                        # 材质包元数据 JSON
│   ├── faithful-32x.json
│   └── default-edit.json
├── scripts/
│   ├── extract-textures.js           # 材质提取脚本
│   └── generate-index.js             # 索引生成脚本
├── src/
│   ├── index.html                    # 首页
│   ├── pack.html                     # 详情页模板
│   ├── submit.html                   # 用户提交页
│   ├── admin.html                    # 管理后台
│   ├── css/
│   │   └── style.css
│   └── js/
│       ├── main.js                   # 首页逻辑
│       ├── pack-loader.js            # 懒加载模块
│       ├── search.js                 # 搜索模块
│       ├── armor-viewer.js           # 3D盔甲渲染
│       └── admin.js                  # 管理后台逻辑
├── dist/                             # 构建输出 (自动生成，部署目录)
│   ├── index.html
│   ├── submit.html
│   ├── admin.html
│   ├── pack/
│   │   └── [pack-id]/
│   │       └── index.html            # 各材质包详情页
│   ├── assets/
│   │   ├── css/
│   │   ├── js/
│   │   └── images/
│   ├── thumbnails/
│   │   └── [pack-id]/
│   │       ├── cover.png             # 自动生成的封面
│   │       ├── diamond_sword.png
│   │       ├── ender_pearl.png
│   │       └── ...
│   └── data/
│       ├── index.json                # 轻量总索引
│       ├── pages/
│       │   ├── page-1.json
│       │   ├── page-2.json
│       │   └── ...
│       └── packs/
│           └── [pack-id].json        # 单包详细数据
├── package.json
├── design.md                         # 本文档
└── README.md
```

---

## 四、数据结构设计

### 4.1 材质包元数据 (`pack-meta/*.json`)

站长/协作者手动维护的元数据文件：

```json
{
  "id": "faithful-32x",
  "name": "Faithful 32x",
  "author": "Faithful Team",
  "version": "1.7/1.8",
  "resolution": "32x",
  "tags": ["32x", "原版风格", "PVP"],
  "description": "经典高清材质包，保持原版风格的同时提升清晰度",
  "uploadDate": "2024-01-15"
}
```

### 4.2 轻量总索引 (`dist/data/index.json`)

用于首页快速加载和搜索，约 100KB/1000条：

```json
{
  "total": 2500,
  "pageSize": 50,
  "pages": 50,
  "items": [
    {
      "id": "faithful-32x",
      "name": "Faithful 32x",
      "cover": "/thumbnails/faithful-32x/cover.png",
      "tags": ["32x", "原版风格", "PVP"],
      "resolution": "32x"
    }
  ]
}
```

### 4.3 分页数据 (`dist/data/pages/page-*.json`)

懒加载时按需请求，每页50条：

```json
{
  "page": 1,
  "items": [
    {
      "id": "faithful-32x",
      "name": "Faithful 32x",
      "author": "Faithful Team",
      "version": "1.7/1.8",
      "resolution": "32x",
      "description": "经典高清材质包...",
      "tags": ["32x", "原版风格", "PVP"],
      "cover": "/thumbnails/faithful-32x/cover.png",
      "file": "/packs/faithful-32x.zip",
      "fileSize": "12.5MB",
      "uploadDate": "2024-01-15",
      "textures": [
        "diamond_sword.png",
        "ender_pearl.png",
        "golden_carrot.png"
      ]
    }
  ]
}
```

### 4.4 单包详情 (`dist/data/packs/[id].json`)

详情页使用的完整数据：

```json
{
  "id": "!§bXenon §716x", #原文件名称
  "name": "Xenon_16x", #简化掉特殊字符后的名称, 空格改成_
  "author": "Notrodan",
  "resolution": "16x",
  "tags": ["16x", "OG"],
  "cover": "/Xenon_16x/pack.png",
  "file": "resourcepacks/!§bXenon §716x.zip",
  "fileSize": "12.5MB",
  "uploadDate": "2025-12-26", #上传的时间
  "textures": {
    "items": [
      "diamond_sword.png",
      "ender_pearl.png",
      "potion_bottle_splash.png",
      "golden_carrot.png",
      "steak.png",
      "bow_standby.png",
      "fishing_rod_uncast.png",
      "apple_golden.png",
      "iron_sword.png"
    ],
    "blocks": [
      "grass_side.png",
      "stone.png",
      "wool_colored_white.png"
    ],
    "armor": [
      "diamond_layer_1.png",
      "diamond_layer_2.png"
	],
    "gui": [
      "icons.png"
    ],
	"particle": [
      "particles.png"
  },
  "downloads": {
    "github": "https://raw.githubusercontent.com/Sakyvo/VALE/main/resourcepacks/Xenon_16x.zip",
    "mirror": "https://ghfast.top/https://raw.githubusercontent.com/Sakyvo/VALE/main/resourcepacks/Xenon_16x.zip"
  }
}
```

---

## 五、核心功能设计

### 5.1 材质自动提取

#### 提取目标材质

```javascript
const KEY_TEXTURES = {
  items: [
    'assets/minecraft/textures/items/diamond_sword.png',
    'assets/minecraft/textures/items/ender_pearl.png',
    'assets/minecraft/textures/items/golden_carrot.png',
    'assets/minecraft/textures/items/apple_golden.png',
    'assets/minecraft/textures/items/bow_standby.png',
    'assets/minecraft/textures/items/fishing_rod_uncast.png',
  ],
  blocks: [
    'assets/minecraft/textures/blocks/grass_side.png',
    'assets/minecraft/textures/blocks/stone.png',
    'assets/minecraft/textures/blocks/wool_colored_white.png',
  ],
  armor: [
    'assets/minecraft/textures/models/armor/diamond_layer_1.png',
    'assets/minecraft/textures/models/armor/diamond_layer_2.png',
  ]
};
```

#### 封面生成规则

| 属性 | 值 |
|------|-----|
| 尺寸 | 256x256 像素 |
| 布局 | 4x4 网格，每格 64x64 |
| 缩放算法 | Nearest Neighbor (保持像素风格) |
| 背景 | 透明 |
| 材质顺序 | diamond_sword → ender_pearl → golden_carrot → ... |

#### 提取脚本核心逻辑

```javascript
// scripts/extract-textures.js
const AdmZip = require('adm-zip');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

async function extractPack(zipPath, packId) {
  const zip = new AdmZip(zipPath);
  const outputDir = `dist/thumbnails/${packId}`;
  fs.mkdirSync(outputDir, { recursive: true });

  const extracted = [];

  for (const [category, paths] of Object.entries(KEY_TEXTURES)) {
    for (const texturePath of paths) {
      const entry = zip.getEntry(texturePath);
      if (entry) {
        const filename = path.basename(texturePath);
        const outputPath = `${outputDir}/${filename}`;
        fs.writeFileSync(outputPath, entry.getData());
        extracted.push({ category, filename });
      }
    }
  }

  await generateCover(packId, extracted);
  return extracted;
}

async function generateCover(packId, textures) {
  const itemTextures = textures
    .filter(t => t.category === 'items')
    .slice(0, 16);

  const composites = await Promise.all(
    itemTextures.map(async (t, i) => {
      const inputPath = `dist/thumbnails/${packId}/${t.filename}`;
      const resized = await sharp(inputPath)
        .resize(64, 64, { kernel: 'nearest' })
        .toBuffer();
      return {
        input: resized,
        left: (i % 4) * 64,
        top: Math.floor(i / 4) * 64,
      };
    })
  );

  await sharp({
    create: {
      width: 256,
      height: 256,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite(composites)
    .png()
    .toFile(`dist/thumbnails/${packId}/cover.png`);
}
```

---

### 5.2 瀑布流布局与懒加载

#### 响应式列数

| 屏幕宽度 | 列数 |
|----------|------|
| > 1400px | 5列 |
| > 1200px | 4列 |
| > 900px | 3列 |
| > 600px | 2列 |
| ≤ 600px | 1列 |

#### CSS 实现

```css
.pack-grid {
  column-count: 5;
  column-gap: 16px;
  padding: 16px;
}

.pack-card {
  break-inside: avoid;
  margin-bottom: 16px;
  background: #1a1a2e;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  transition: transform 0.2s, box-shadow 0.2s;
}

.pack-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
}

.pack-card img {
  width: 100%;
  image-rendering: pixelated;
}

.pack-card .info {
  padding: 12px;
}

.pack-card .name {
  font-size: 14px;
  font-weight: 600;
  color: #fff;
}

.pack-card .tags {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.pack-card .tag {
  font-size: 11px;
  padding: 2px 6px;
  background: #2d2d44;
  border-radius: 4px;
  color: #aaa;
}

@media (max-width: 1400px) { .pack-grid { column-count: 4; } }
@media (max-width: 1200px) { .pack-grid { column-count: 3; } }
@media (max-width: 900px)  { .pack-grid { column-count: 2; } }
@media (max-width: 600px)  { .pack-grid { column-count: 1; } }
```

#### 懒加载实现

```javascript
// src/js/pack-loader.js
class PackLoader {
  constructor() {
    this.index = null;
    this.loadedPages = new Set();
    this.pagesData = {};
    this.pageSize = 50;
    this.observer = new IntersectionObserver(
      entries => this.onIntersect(entries),
      { rootMargin: '200px' }
    );
  }

  async init() {
    this.index = await fetch('/data/index.json').then(r => r.json());
    this.renderPlaceholders();
    this.observeItems();
  }

  renderPlaceholders() {
    const grid = document.querySelector('.pack-grid');
    grid.innerHTML = this.index.items
      .map((item, i) => `
        <div class="pack-card" data-index="${i}" data-id="${item.id}" data-loaded="false">
          <div class="placeholder" style="aspect-ratio:1;background:#2d2d44"></div>
          <div class="info">
            <div class="name">${item.name}</div>
          </div>
        </div>
      `)
      .join('');
  }

  observeItems() {
    document.querySelectorAll('.pack-card[data-loaded="false"]')
      .forEach(el => this.observer.observe(el));
  }

  async onIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;

      const el = entry.target;
      const index = parseInt(el.dataset.index);
      const page = Math.floor(index / this.pageSize) + 1;

      if (!this.loadedPages.has(page)) {
        await this.loadPage(page);
      }

      const pack = this.getPackByIndex(index);
      if (pack) this.renderCard(el, pack);

      el.dataset.loaded = 'true';
      this.observer.unobserve(el);
    }
  }

  async loadPage(page) {
    const data = await fetch(`/data/pages/page-${page}.json`).then(r => r.json());
    this.pagesData[page] = data.items;
    this.loadedPages.add(page);
  }

  getPackByIndex(index) {
    const page = Math.floor(index / this.pageSize) + 1;
    const offset = index % this.pageSize;
    return this.pagesData[page]?.[offset];
  }

  renderCard(el, pack) {
    el.innerHTML = `
      <img src="${pack.cover}" alt="${pack.name}" loading="lazy">
      <div class="info">
        <div class="name">${pack.name}</div>
        <div class="tags">
          ${pack.tags.map(t => `<span class="tag">${t}</span>`).join('')}
        </div>
      </div>
    `;
    el.onclick = () => location.href = `/pack/${pack.id}/`;
  }
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  new PackLoader().init();
});
```

---

### 5.3 详情页

#### 页面结构

```html
<!-- dist/pack/[id]/index.html -->
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>材质包名称 - MC材质包分享</title>
  <link rel="stylesheet" href="/assets/css/style.css">
</head>
<body>
  <header>
    <a href="/" class="back">← 返回</a>
    <h1 class="pack-name"></h1>
  </header>

  <main class="pack-detail">
    <section class="pack-header">
      <img class="cover" src="" alt="">
      <div class="meta">
        <p class="author"></p>
        <p class="version"></p>
        <p class="size"></p>
        <p class="date"></p>
        <div class="tags"></div>
      </div>
    </section>

    <section class="description"></section>

    <section class="downloads">
      <h2>下载</h2>
      <a class="btn btn-primary download-github" href="">GitHub 下载</a>
      <a class="btn btn-secondary download-mirror" href="">镜像下载 (中国大陆)</a>
    </section>

    <section class="textures">
      <h2>材质预览</h2>
      <div class="texture-grid"></div>
    </section>

    <section class="armor-preview">
      <h2>3D 盔甲预览</h2>
      <div id="armor-viewer"></div>
    </section>
  </main>

  <script type="module" src="/assets/js/pack-detail.js"></script>
</body>
</html>
```

#### 下载按钮

```javascript
// 下载链接生成
function getDownloadLinks(packId) {
  const base = `https://raw.githubusercontent.com/Sakyvo/VALE/main/packs/${packId}.zip`;
  return {
    github: base,
    mirror: `https://ghfast.top/${base}`
  };
}
```

---

### 5.4 3D 盔甲渲染

#### 简化模型规格

| 部件 | 尺寸 (MC单位) | 位置 (MC单位) |
|------|---------------|---------------|
| 头部 | 8 × 8 × 8 | (0, 12, 0) |
| 躯干 | 8 × 12 × 4 | (0, 2, 0) |
| 左臂 | 4 × 12 × 4 | (-6, 2, 0) |
| 右臂 | 4 × 12 × 4 | (6, 2, 0) |
| 左腿 | 4 × 12 × 4 | (-2, -10, 0) |
| 右腿 | 4 × 12 × 4 | (2, -10, 0) |

#### Three.js 实现

```javascript
// src/js/armor-viewer.js
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';

class ArmorViewer {
  constructor(container, armorTexture1, armorTexture2) {
    this.container = container;
    this.init();
    this.loadArmor(armorTexture1, armorTexture2);
  }

  init() {
    // 场景
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a2e);

    // 相机
    this.camera = new THREE.PerspectiveCamera(45, 300 / 400, 0.1, 100);
    this.camera.position.set(0, 0.5, 3);

    // 渲染器
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(300, 400);
    this.container.appendChild(this.renderer.domElement);

    // 控制器
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableZoom = false;
    this.controls.enablePan = false;

    // 光照
    const ambient = new THREE.AmbientLight(0xffffff, 0.8);
    this.scene.add(ambient);

    this.animate();
  }

  loadArmor(texture1Path, texture2Path) {
    const loader = new THREE.TextureLoader();

    loader.load(texture1Path, (texture1) => {
      texture1.magFilter = THREE.NearestFilter;
      texture1.minFilter = THREE.NearestFilter;

      loader.load(texture2Path, (texture2) => {
        texture2.magFilter = THREE.NearestFilter;
        texture2.minFilter = THREE.NearestFilter;

        this.createModel(texture1, texture2);
      });
    });
  }

  createModel(texture1, texture2) {
    const scale = 1 / 8;

    // 材质
    const mat1 = new THREE.MeshBasicMaterial({ map: texture1, transparent: true });
    const mat2 = new THREE.MeshBasicMaterial({ map: texture2, transparent: true });

    // 头部 (使用 layer_1)
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(8 * scale, 8 * scale, 8 * scale),
      mat1
    );
    head.position.set(0, 12 * scale, 0);
    this.scene.add(head);

    // 躯干 (使用 layer_1)
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(8 * scale, 12 * scale, 4 * scale),
      mat1
    );
    body.position.set(0, 2 * scale, 0);
    this.scene.add(body);

    // 手臂 (使用 layer_1)
    const armGeo = new THREE.BoxGeometry(4 * scale, 12 * scale, 4 * scale);
    const armL = new THREE.Mesh(armGeo, mat1);
    armL.position.set(-6 * scale, 2 * scale, 0);
    this.scene.add(armL);

    const armR = new THREE.Mesh(armGeo, mat1);
    armR.position.set(6 * scale, 2 * scale, 0);
    this.scene.add(armR);

    // 腿部 (使用 layer_2)
    const legGeo = new THREE.BoxGeometry(4 * scale, 12 * scale, 4 * scale);
    const legL = new THREE.Mesh(legGeo, mat2);
    legL.position.set(-2 * scale, -10 * scale, 0);
    this.scene.add(legL);

    const legR = new THREE.Mesh(legGeo, mat2);
    legR.position.set(2 * scale, -10 * scale, 0);
    this.scene.add(legR);
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    this.scene.rotation.y += 0.005;
    this.renderer.render(this.scene, this.camera);
  }
}

export default ArmorViewer;
```

---

### 5.5 搜索功能

```javascript
// src/js/search.js
class PackSearch {
  constructor() {
    this.index = null;
    this.searchInput = document.querySelector('#search-input');
    this.resultsContainer = document.querySelector('.pack-grid');
    this.init();
  }

  async init() {
    this.index = await fetch('/data/index.json').then(r => r.json());
    this.searchInput.addEventListener('input', 
      this.debounce(() => this.search(), 300)
    );
  }

  search() {
    const query = this.searchInput.value.trim().toLowerCase();
    
    if (!query) {
      // 恢复默认显示
      new PackLoader().init();
      return;
    }

    const results = this.index.items.filter(pack =>
      pack.name.toLowerCase().includes(query) ||
      pack.tags.some(tag => tag.toLowerCase().includes(query))
    );

    this.renderResults(results);
  }

  renderResults(results) {
    this.resultsContainer.innerHTML = results
      .map(pack => `
        <div class="pack-card" onclick="location.href='/pack/${pack.id}/'">
          <img src="${pack.cover}" alt="${pack.name}">
          <div class="info">
            <div class="name">${pack.name}</div>
            <div class="tags">
              ${pack.tags.map(t => `<span class="tag">${t}</span>`).join('')}
            </div>
          </div>
        </div>
      `)
      .join('');
  }

  debounce(fn, delay) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }
}
```

---

## 六、管理后台

### 6.1 认证方式

- 使用 GitHub Personal Access Token
- Token 存储于 localStorage (仅本地浏览器)
- 所需权限: `repo` (读写仓库内容)

### 6.2 功能列表

| 功能 | 说明 |
|------|------|
| 查看列表 | 分页显示所有材质包 |
| 添加材质包 | 上传 ZIP + 填写元数据 |
| 编辑元数据 | 修改名称、标签、描述等 |
| 删除材质包 | 删除 ZIP 和元数据文件 |
| 触发构建 | 手动触发 GitHub Actions |
| 审核提交 | 查看待审核的用户提交 |

### 6.3 界面布局

```
┌─────────────────────────────────────────────────────────────┐
│  MC材质包管理后台                                  [登出]    │
├─────────────────────────────────────────────────────────────┤
│  [材质包列表] [待审核 (3)] [添加材质包] [设置]               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  搜索: [________________] [筛选: 全部 ▼]                    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ ☑ Faithful 32x                                      │   │
│  │   标签: 32x, PVP | 大小: 12.5MB | 日期: 2024-01-15  │   │
│  │   [编辑] [删除] [预览]                               │   │
│  ├─────────────────────────────────────────────────────┤   │
│  │ ☐ Default Edit                                      │   │
│  │   标签: 16x | 大小: 8.2MB | 日期: 2024-01-14        │   │
│  │   [编辑] [删除] [预览]                               │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  [批量删除] [批量编辑标签]              第 1/50 页 [<] [>]   │
└─────────────────────────────────────────────────────────────┘
```

### 6.4 GitHub API 操作

```javascript
// src/js/admin.js
class GitHubAdmin {
  constructor(token, repo = 'Sakyvo/VALE') {
    this.token = token;
    this.repo = repo;
    this.api = 'https://api.github.com';
  }

  async request(endpoint, options = {})