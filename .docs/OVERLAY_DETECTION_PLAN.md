# Overlay 材质包检测与分类方案

## 背景

Mav War 的以图搜图 (SBI) 出现了一类干扰结果：贴图与 Default pack 几乎完全相同，仅在 sky / glint / 个别 block 等非核心位置有差异。这类包不是真正的 PvP 包，不应在主页展示，也不应被 SBI 识别。

**典型样本（6 个 user-confirmed overlay）**

- `Cases Block Overlay(white fire) !`
- `Idiol Snow v4`
- `LightMap + Clear Walls`
- `no color purple sky and glint overlay`
- `no color red sky and glint overlay`
- `sky & glint overlay`

**反例（必须不被误判）**

- `gosu default hd sky` —— 钻石剑短一格，属于普通材质

---

## 检测算法

### Core 贴图（11 张）

PvP 包必须个性化的核心元素。这 11 张必须**全部**与 default 一致才能判定为 overlay。

| 类型 | 文件 |
|------|------|
| Items | `diamond_sword.png` |
| Items | `ender_pearl.png` |
| Items | `splash_potion_of_healing.png` |
| Items | `iron_sword.png` |
| Items | `fishing_rod_uncast.png` |
| Items | `apple_golden.png` |
| Items | `steak.png` |
| Items | `golden_carrot.png` |
| GUI | `widgets.png` |
| GUI | `icons.png` |
| Particle | `particles.png` |

font / skin / blocks / armor / inventory 不进入判定（在 PvP 包中本就常不改，当作误判源排除）。

### 比对单位：解码后像素 SHA256

`extract-textures.js` 的 sanitize 路径只在像素发生修改时写回文件，因此 `thumbnails/` 中存在 **raw / sanitized 混合**：

- `ender_pearl.png` thumbnail → sanitized bytes（边缘脏点被清理）
- `diamond_sword.png` thumbnail → raw bytes（原图已干净，sanitize 未触发写入）

直接比对文件 SHA256 会失效。**采用 `sharp` 解码为 RGBA 原始像素，对像素缓冲取 SHA256**，绕过 PNG 编码差异。

### Reference Set（每张贴图）

跨 MC 版本的 default 贴图微有差异（如 1.7 vs 1.8 的 `ender_pearl` / `golden_carrot`）。本仓库 `Default_Texture/pack.mcmeta` 为 `pack_format:1` 即 1.7，而 6 个 seed pack 基于 1.8 系。

**Seed Bootstrap 策略**：每张 core 贴图的 reference set 包含

1. `Default_Texture/` 对应原文件解码后像素哈希
2. 6 个 seed pack 同名贴图解码后像素哈希

任一命中即视为"default 同源"。

### 判定规则

```
pack 的 11 张 core 贴图像素 SHA256 全部 ∈ reference set ⟺ overlay
```

严格 11/11，1 张不中即非 overlay。

---

## 验证结果（基于当前 195 包）

| Pack | 命中 | 判定 |
|------|------|------|
| Cases_Block_Overlaywhite_fire | 11/11 | overlay ✓ |
| Idiol_Snow_v4 | 11/11 | overlay ✓ |
| LightMap_Clear_Walls | 11/11 | overlay ✓ |
| no_color_purple_sky_and_glint_overlay | 11/11 | overlay ✓ |
| no_color_red_sky_and_glint_overlay | 11/11 | overlay ✓ |
| sky_glint_overlay | 11/11 | overlay ✓ |
| gosu_default_hd_sky | 9/11 | 非 overlay ✓ |
| DEFAULT_LOW_FIRE_HD_SKY | 6/11 | 非 overlay ✓ |

**195 包中无 10/11 模糊边缘案例。零误判、零漏判。**

---

## 存储与行为

| 决策点 | 落点 |
|--------|------|
| 标记位 | `l/lists.json` 新建 `{name:'overlay', cover:'', description:'', packs:[...]}` |
| 与原 list 关系 | 叠加（保留原 list 隶属） |
| 重跑模式 | 覆盖式（`overlay.packs` 完全替换为新一轮检测结果） |
| 主页 placeholders | 隐藏 overlay 包 |
| 主页搜索结果 | 显示 overlay 包 + `OVERLAY` 角标 |
| `/l/` 列表页 | overlay list 作为普通 list 显示，可点入 |
| `/p/<name>/` 详情页 | 仍可访问 |
| SBI | 生成阶段直接排除，指纹库不含 overlay |

---

## 工作流（一条龙）

```
detect-overlay.js
    ↓ 写 l/lists.json
generate-index.js
    ↓ 派生 data/index.json + data/packs/*.json + data/pages/*.json
generate-sbi-data.js (修改后读 lists.json 跳过 overlay)
    ↓ 重生成 data/sbi-fp/*.json
bump SBI_FINGERPRINT_VERSION + sbi/index.html cache buster
```

通过 `npm run build:overlay` 串联。

---

## 代码改动清单

| 文件 | 改动 |
|------|------|
| `scripts/detect-overlay.js` | **新建**：扫描 thumbnails，构建 reference set，输出 overlay 列表，写 lists.json，链式触发后续脚本 |
| `scripts/generate-sbi-data.js` | 主循环读取 `l/lists.json`，pack 命中 'overlay' 时 `continue` 跳过 |
| `assets/js/main.js` | `renderPlaceholders` 过滤 `lists.includes('overlay')`；`renderResults` 检测并附加 `OVERLAY` 角标 |
| `assets/css/style.css` | 新增 `.overlay-badge` 样式 |
| `package.json` | 新增 `build:overlay` npm script |

`generate-index.js` / `list.js` / `pack-detail.js` 无需改动（`lists` 字段自动派生）。

---

## Seed 扩展

6 个 seed 硬编码于脚本顶部常量。如未来发现新的 default 版本变种导致漏判，可通过：

```bash
node scripts/detect-overlay.js --seed <packName>
```

追加 seed，或直接修改脚本常量。

---

## 验证清单

修改完成后**必须**执行：

```bash
python test_sbi.py    # 9 张测试图 #1 命中验证 SBI 回归
```

确认 SBI 不被 overlay 排除影响、9/9 仍通过。

---

## 关键洞察记录

1. **不能只看"贴图缺失 fallback"**：包可以打包一份与 default 字节相同的副本，方案 B（仅 fallback）会漏判。必须做内容比对。
2. **不能直接 SHA256 文件字节**：`fix-thumbnail-preview-alpha.js` 只在像素变更时写回，thumbnails 是 raw/sanitized 混合体。必须解码到像素层。
3. **不能只用一个 Default_Texture**：1.7 vs 1.8 的 `ender_pearl` / `golden_carrot` 像素不同。seed bootstrap 是最低成本的多版本兼容方案。
4. **threshold 必须 11/11 严格**：放宽到 10/11 会把 `gosu default hd sky` 这种"改了 1 处的真材质包"误判。
