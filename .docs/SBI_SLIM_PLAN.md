# SBI 指纹精简执行方案

> 基于 `.docs/SBI_SCALABILITY_ANALYSIS.md` 精简方案部分，具体实施步骤

## 目标

198 包：4.37 MB → ~1.6 MB（典型搜索下载量）；万包：220 MB → ~41 MB

每步完成后跑 `python test_sbi.py` 确认 9/9 通过。

---

## Phase 1：移除无效字段

**改动范围**：`scripts/generate-sbi-data.js`（生成端）+ `data/sbi-fingerprints.json`（重新生成）+ `sbi/index.html`（cache buster）

**移除字段**：

| 字段 | 体积占比 | 移除原因 |
|------|---------|---------|
| `splash_potion_variants` | 41.4% | sbi.js 未引用，生成但从未接入匹配 |
| `apple_golden` | 3.5% | weight=0.0，零评分贡献 |
| `iron_sword` | 3.3% | 仅 UI 配色映射，不参与 slot 比对 |
| `xp_bar_bg` / `xp_bar_fill` | 6.0% | 不参与比对 |

**步骤**：

1. `generate-sbi-data.js` 中注释/删除 `apple_golden`、`iron_sword`、`xp_bar_bg`/`xp_bar_fill`、`splash_potion_variants` 的处理逻辑
2. 重新生成 `data/sbi-fingerprints.json`
3. 验证 JSON 体积 ~2.0 MB
4. `sbi.js` 中移除 `apple_golden`/`iron_sword` 在 `SLOT_ITEM_TYPES` 中的条目及相关 UI 映射
5. `sbi/index.html` cache buster +1
6. 跑 `python test_sbi.py` 确认 9/9

**预期效果**：4.37 MB → 2.01 MB，零精度损失

---

## Phase 2：hist 量化

**改动范围**：`scripts/generate-sbi-data.js`（生成端量化）+ `assets/js/sbi.js`（比对端适配）

**当前**：`hist` 为 72 浮点数组（每项 6-8 字节 JSON），总量 ~500 bytes/纹理
**改为**：Uint8 数组（0-255），每项 1 字节，总量 ~72 bytes/纹理

**步骤**：

1. `generate-sbi-data.js` 输出 hist 时 `Math.round(clamp01(v) * 255)`
2. `sbi.js` 的 `compare()` 函数读取 hist 后先 `v / 255` 还原为 0-1 浮点再比对（或直接适配 Uint8 比较）
3. 重新生成指纹 JSON，验证 ~1.82 MB
4. `sbi/index.html` cache buster +1
5. 跑 `python test_sbi.py` 确认 9/9

**精度风险**：极低。量化误差 ±0.002，`metricSimilarity` 容差 0.3，不影响。

---

## Phase 3：分片加载

**改动范围**：`scripts/generate-sbi-data.js`（生成端拆分）+ `assets/js/sbi.js`（加载端改 fetch 逻辑）

**分片结构**：

```
data/sbi-fp/
  diamond_sword.json    146 KB
  ender_pearl.json      150 KB
  splash_potion.json    153 KB
  food.json             301 KB  (steak + golden_carrot)
  widget.json           56 KB
  health.json           399 KB
  hunger.json           428 KB
  armor.json            414 KB
```

每个分片格式：
```json
{
  "version": 13,
  "type": "diamond_sword",
  "packs": {
    "Pack_Name": { "dhash": "...", "hist": [...], "moments": [...], "edge": 0.21, "sig": {...} },
    ...
  }
}
```

**步骤**：

1. `generate-sbi-data.js` 改为输出多个分片文件到 `data/sbi-fp/`
2. `sbi.js` 替换单次 `fetch('/data/sbi-fingerprints.json')` 为按需多 fetch：
   - 从 `inferDisplaySlotTypes` 结果确定需要哪些类型分片
   - `Promise.all` 并行加载所需分片
   - 合并为内存中 `fingerprints.packs` 结构供 `matchPacks` 使用
3. HUD 分片始终加载（不依赖 slot 类型推断）
4. food 分片仅当推断含 SK/GC 类型时加载
5. `sbi/index.html` cache buster +1
6. 跑 `python test_sbi.py` 确认 9/9

**预期效果**：典型搜索下载 ~1.6 MB（vs 当前 4.37 MB），万包 ~41 MB

---

## Phase 4：粗签名预过滤

**改动范围**：`assets/js/sbi.js`（`matchPacks` 函数开头加预过滤）

**桶定义**（每个纹理类型的 sig 粗粒度桶）：
- `darkFrac` → 4 桶 (0-0.25, 0.25-0.50, 0.50-0.75, 0.75-1.0)
- `meanLum` → 4 桶 (0-64, 64-128, 128-192, 192-255)
- `blueFrac` → 4 桶 (0-0.25, ..., 0.75-1.0)
- G/B ratio → 4 桶 (0-0.5, 0.5-1.0, 1.0-1.5, 1.5+)

**索引结构**：生成时为每个类型预计算 `packName → bucketKey` 映射，存入对应分片 JSON 的 `_index` 字段。

**搜索流程**：
1. 截图提取 sig → 计算桶 key
2. 查索引取同桶 + 相邻桶 (±1) 的包名集合
3. `matchPacks` 仅遍历候选集，跳过其余

**步骤**：

1. `generate-sbi-data.js` 每个分片增加 `_index: { bucketKey: [packNames...] }`
2. `sbi.js` `matchPacks` 开头：从截图 sig 算桶 → 从 `_index` 取候选集 → 仅遍历候选
3. 兜底：若候选集 < 5 包（截图特征罕见），退回全量扫描
4. 跑 `python test_sbi.py` 确认 9/9
5. 额外测试：人工构造边界截图验证桶覆盖

**预期效果**：比对量降至 10-30%，搜索加速 3-10×

---

## 验证标准

每个 Phase 完成后：

- [ ] `python test_sbi.py` → 9/9 passed
- [ ] 指纹 JSON/分片总体积低于预期上界
- [ ] 浏览器手动测 `/sbi/` 上传截图正常出结果
- [ ] cache buster 已更新
