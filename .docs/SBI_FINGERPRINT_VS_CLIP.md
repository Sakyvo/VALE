# SBI 匹配方案对比：指纹 vs CLIP 向量

本文档基于 `assets/js/sbi.js`、`scripts/generate-sbi-data.js`、`scripts/generate-sbi-embeddings.mjs`、`assets/js/sbi-worker.js` 以及 `test_img/` 9 张测试截图的实测结果。

---

## 1. 项目当前状态

`sbi.js:8` 中 `ENABLE_CLIP = false`。CLIP 路线代码、Web Worker、嵌入文件 (`data/sbi-clip-embeddings.bin`, `data/sbi-clip-index.json`) 都仍在仓库中，但运行时被关闭，**线上仅依赖指纹匹配**。

| 资产 | 大小 | 用途 |
|------|------|------|
| `data/sbi-fingerprints.json` | 2.7 MB | 指纹（dHash + hist + moments + sig） |
| `data/sbi-clip-embeddings.bin` | 400 KB | CLIP 向量（200 包 × 512 dim × 4 字节） |
| `data/sbi-clip-index.json` | 3.3 KB | CLIP 包名索引 |
| `assets/js/transformers.min.js` + WASM | ~5 MB | CLIP 推理依赖 |
| 远端 `Xenova/clip-vit-base-patch32` | ~86 MB | 首次访问下载 + 缓存 |

---

## 2. 指纹方案（当前线上）

### 数据生成 (`scripts/generate-sbi-data.js`)

每个 pack 的关键纹理（diamond_sword、ender_pearl、splash_potion、steak、golden_carrot、apple_golden、iron_sword、health/hunger/armor 三态、xp_bar、hotbar_widget）按 9×8 / 192bit 提取以下特征：

- **dHash**（24 bytes）：行方向梯度，按 R/G/B 三通道独立编码
- **hist**（72 bins）：48-bin RGB + 24-bin hue
- **moments**（6 floats）：R/G/B 通道均值 + 标准差
- **edge**（1 float）：边缘密度
- **sig**（~25 floats）：n、coverage、meanLum、meanR/G/B、redFrac、yellowFrac、blueFrac、darkFrac、edgeDarkFrac、centerX/Y、bbox、rowSlope、mirrorFrac …

### 运行时匹配 (`sbi.js`)

1. `extractHotbarSlots`：在截图里定位 hotbar、9 个 slot、HUD 三个区域
2. `inferDisplaySlotTypes`：为每个 slot 推断物品类型（DS/EP/HL/SK/GC/NN）
3. `matchPacks`：对每个 pack 计算
   - `slotComposite`：每个 slot 与该包对应类型的纹理相似度，加权平均
   - `hudComposite`：health/hunger/armor 三类与包指纹的相似度，加权平均
   - `widgetSim`：hotbar 的 widget 指纹相似度
   - 综合公式（当前权重）：
     `slot×0.44 + hud×0.36 + widget×0.20`
     再叠加 critical type 奖励、覆盖率奖励、shortfall 惩罚

### 优点

- **零依赖运行时**：纯 CPU/JS，无需下载模型，零冷启动
- **可解释、可调参**：每条权重都有语义，能针对具体失败用例定向修
- **数据小**：2.7 MB JSON，所有客户端首屏即可加载
- **空间局部性强**：每个 slot 单独比对，能给出"哪一格匹配/失配"的细颗粒诊断

### 缺点

- **依赖正确的 slot 类型推断**：`inferDisplaySlotTypes` 一旦把 EP 漏判为 NN，对应包的 EP 指纹完全不参与打分。Tory 测例就是如此。
- **对截图条件敏感**：模糊、JPEG 压缩、数字角标遮挡都会让 sig（meanRGB / 占比）漂移
- **辨识度上限有限**：对"几乎用 vanilla 纹理"的包难以区分，因为 dHash + 颜色直方图都接近
- **HUD 区域颜色容易被同色不同形干扰**：红心 vs 蓝心理论上 R/B 比值差 70 倍，但当前 `compareHudVariant` 内 dHash 占主导，单纯靠颜色权重撑不起足够的拉开度

---

## 3. CLIP 向量方案（已实现，未启用）

### 数据生成 (`scripts/generate-sbi-embeddings.mjs`)

对每个 pack：

1. 拼一张 224×224 复合图：
   - 上半 224×112：hotbar widget（widgets.png 中 0,0,182,22 拉伸）
   - 下半左 112×112：diamond_sword
   - 下半右 112×112：ender_pearl
2. 喂给 `Xenova/clip-vit-base-patch32` Vision encoder（q8 量化），取 `image_embeds`
3. L2 归一化后存为 `Float32Array(512)`

### 运行时匹配 (`sbi-worker.js` + `sbi.js`)

1. Web Worker 启动时拉取 CLIP 模型（86 MB，浏览器缓存）+ embeddings
2. 截图分析：把 hotbar+slot 0+slot 1 拼相同尺寸送入 Worker
3. Worker 计算 query 向量与每个 pack 向量的 cosine similarity，返回 Top-300
4. `handleClipResults` 把 CLIP 分数对当次查询做 min-max 归一化，作为 hash 分的乘子叠加：
   `score = hashScore × (CLIP_RERANK_BASE 0.35 + CLIP_RERANK_WEIGHT 0.65 × clipScore)`

CLIP 在当前架构里是 **rerank 信号**，不是独立打分线。

### 优点

- **语义级理解**：CLIP 学到了"剑形""球形""血条"这种抽象特征，对纹理风格变化（高分辨率重绘、配色调整）有更强容忍度
- **不依赖 slot 类型推断**：直接看整张拼图相似度，绕开 `inferDisplaySlotTypes` 误判风险
- **embedding 空间小**：包侧 400 KB，比指纹小 7 倍

### 缺点

- **首次加载昂贵**：86 MB 模型（即便有 hf-mirror 镜像）+ 5 MB transformers 库，移动网络体验差
- **冷启动慢**：第一次推理要几秒（onnx-wasm + q8）
- **不可解释**：失败时无法定位"是 widget 不像，还是 sword 不像"
- **拼图设计强烈影响结果**：当前只有 widget+sword+pearl，若 pack 的差异化集中在 HUD/potion 上则被忽略
- **两套数据要同步维护**：每加新包要跑 fingerprint 脚本 + embedding 脚本

---

## 4. 测试结果（test_img/ 9 张）

均使用 `python test_sbi.py` 在 Edge Headless + CDP 下跑，期望 Top1 = 文件名 ` - ` 后的包名。

### 当前线上指纹方案（`ENABLE_CLIP = false`，本次提交后权重）

| 截图 | Top1 | 期望 | 结果 |
|------|------|------|------|
| Large - Blue 128x | Blue_128x | Blue_128x | ✅ |
| Large - Eum3 Blue Revamp | Eum3_Blue_Revamp | Eum3_Blue_Revamp | ✅ |
| Large - Eum3Blue Revamp (2) | Eum3Blue_Revamp | Eum3Blue_Revamp | ✅ |
| Large - Eum3Blue Revamp | Eum3Blue_Revamp | Eum3Blue_Revamp | ✅ |
| Large - Mav War | Mav_War | Mav_War | ✅ |
| Large - OTB FPS | Yokabi_Pack | OTB_FPS | ❌（OTB_FPS 在 #20+，slot 仅 0.09） |
| Large - PvPMen | Pvpmen | Pvpmen | ✅ |
| Large - Tory Eum3 v1 [Revamp] | XethaFaith_3.0 | Tory_Eum3_v1_Revamp | ❌（#10+） |
| Small - Eum3 Blue Revamp | Eum3_Blue_Revamp | Eum3_Blue_Revamp | ✅ |

**通过率：7/9。** 两个失败用例的共同特点：

- 期望包的存储指纹与截图实际像素分布弱相关
  - OTB_FPS 截图里有蓝色心（与该包指纹一致），但 slot 1 是 OTB 自定义品牌图标（无对应指纹槽位），slot 整体得分被拉到 0.09
  - Tory 在 slot/HUD/widget 三项都略低于 XethaFaith/Throwback，纯权重扳不回来
- 单纯调权重无法同时修这两个又不影响其它已通过用例（实测 Blue_128x 和 OTB_FPS 互相牵制）

### CLIP 路线（需要打开 `ENABLE_CLIP = true` 后实测）

> **未在本次实验中跑**。原因：在线上关闭、模型首次拉取慢、embeddings 仅覆盖 widget+sword+pearl，对当前 9 个测例的关键差异（HUD 颜色、hotbar 末格食物 vs 药水）覆盖度低。

可预测的表现：

- Blue_128x、Eum3 Blue Revamp、Mav War 等"剑+珍珠+widget 都很有特色"的包：CLIP 更稳
- OTB FPS：拼图未包含 HUD 蓝心和品牌图标，**CLIP 也大概率拿不到 OTB_FPS 的辨识度**
- Tory：拼图里的剑/珍珠和 XethaFaith 风格相近，**CLIP 同样会被 XethaFaith 干扰**

---

## 5. 结论与建议

### 现阶段保留指纹为主

1. 两套测例失败的根因是**信号采集**问题（漏采 HUD、漏采末格食物纹理、漏采品牌图标），不是匹配算法本身。换 CLIP 不能直接解
2. 指纹方案的诊断面板（per-slot type、HP/Hu/Ar 分项）对调参/排错价值大，CLIP 的黑盒分数让定位失败用例更难

### CLIP 真要启用，先做这三件事

1. **扩展拼图**：把 HUD 三件套（heart_full、hunger_full、armor_full）和 potion/steak 都拼进 224×224，让模型看见更多差异面
2. **CLIP 作为 tie-breaker**：当指纹 Top1 与 Top2 分差 < 0.05 时再启用 CLIP rerank，避免每次查询都付 86 MB + 推理代价
3. **定期重跑 embedding**：thumbnails 更新就重跑 `generate-sbi-embeddings.mjs`，否则 CLIP 数据会比指纹更早失同步

### 想真正修 OTB / Tory 这两个 case

1. **指纹层面**：
   - 给 OTB_FPS、Tory 等包重新跑 `extract-textures.js` 确保 thumbnails 与 zip 内最新纹理一致
   - 增加 `inferDisplaySlotTypes` 对"品牌图标 / 数字角标遮挡"的鲁棒性
2. **数据层面**：在 `sbi-fingerprints.json` 里给"几乎纯 vanilla"的包打 `vanilla_like: true` 标志，匹配时降权
3. **算法层面**：HUD 比对引入"独特性"加权——某 pack 在某 HUD 类型上偏离全库均值越多、且匹配截图越好，给独家奖励

### 数据流向小结

```
resourcepacks/*.zip                                       (源材质)
  └── extract-textures.js ─→ thumbnails/{pack}/*.png      (缩略图)
        ├── generate-sbi-data.js  ─→ data/sbi-fingerprints.json    (指纹，运行时直接消费)
        └── generate-sbi-embeddings.mjs ─→ data/sbi-clip-*  (CLIP，目前未启用)
```

`generate-index.js` 读取 `data/extracted.json` + 现有 `data/packs/*.json` 的 `uploadDate` 写入新 JSON——本次提交后 uploadDate 不再被自动构建覆盖。
