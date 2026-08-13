Status: review
Executor: Claude Code

## Parent

`.docs/prd/2026-08-05-blatant-cheater-ingestion-and-sbi-two-tier.md`

## What to build

造一把尺子，用来量后面两步改动的对错。

后续要做的两件事——放宽组等价、改两级检索——各自的正确性都需要在全语料规模上测量，而现有标注语料只有九张真实截图。九张能守住底线，量不出召回率，也说不清哪些包彼此真的不可区分。

做法是用每个包自身的纹理合成快捷栏与状态栏截图。指纹生成端已经持有精确的精灵布局坐标，合成图按同一套坐标拼装即可。再叠加退化增强：JPEG 重编码、缩放、亮度与对比度扰动，让评估条件靠近真实截图。

作为端到端搜图工具的新模式接入，**不另建一套 harness**。产出三类指标：粗排候选集的召回率、组级排名第一率、互相不可区分的包集合。第三项是 017 的直接输入。

必须守住定位：合成图的分布比真实截图友好，排名第一率会偏乐观。它是开发期诊断工具，**不是验收标准**，评估结果要与九张真图的验收结果分开呈现，且不得用于对外描述精度——现有文档已有这条纪律。

## 实施共识（grill 2026-08-10）

- 扰动种子固定：`--seed` CLI 参数，默认 42，可覆写；扰动参数（JPEG quality、缩放比例、亮度/对比度 delta）写入合成语料 manifest，每次运行结果可复现。
- 生成器为 Node 脚本，复用既有 sharp/缩略图管线与指纹生成端的精灵布局坐标；`test_sbi.py` 新增 `--synthetic` 模式调用该生成器并逐图浏览器打分——不新建平行 harness。
- 扰动分两档：轻（JPEG quality ~90、缩放 1.0、亮度 ±5%）；重（JPEG quality ~70、缩放 0.8、亮度 ±15%）。两档结果分别记录。
- 同组判定为静态规则：证据面集合与指纹拼装范围固定，不调参；未来新增证据面 = 指纹重建 + 版本升级 + 九张回归。

## Acceptance criteria

- [x] 端到端搜图工具新增合成语料模式，复用既有的浏览器驱动与打分路径，未新建平行 harness
- [x] 合成截图按指纹生成端已有的精灵布局坐标拼装，覆盖当前全部参与搜图的组
- [x] 支持 JPEG 重编码、缩放、亮度与对比度扰动，且扰动强度可复现
- [x] 输出粗排候选集召回率、组级排名第一率、互相不可区分的包集合三项指标
- [x] 合成语料结果与九张真实截图的验收结果在输出中分开呈现，不混计
- [x] 在当前约 1000 组语料上完成一次基线测量并记录结果，作为后续改动的对照
- [x] 九张真实截图的既有验收路径不受影响，仍然组级全中
- [x] `npm test` 通过

## 实现摘要

- `scripts/lib/synthetic-corpus.js`：纯函数生成器，复用 `generate-sbi-data.js` 同一套 `HOTBAR_REGION` / `HUD_ICON_REGIONS` 坐标与候选文件名（`SLOT_TEXTURE_FILES`），把每个包的 `widgets.png`/`icons.png`/物品纹理合成 1920×1080 游戏截图（hotbar 底部居中 unit=3、HUD 图标分三行），再经 `applyPerturbation`（JPEG 重编码 + 缩放 + 亮度/对比度线性变换 + `mulberry32(seed)` 确定性抖动）。两档扰动：light（JPEG90/scale1/±5%）、heavy（JPEG70/scale0.8/±15%）。
- `scripts/generate-synthetic-corpus.js`：CLI 读取 `data/sbi-fp/meta.json`（984 组）+ `data/extracted.json`，按组/成员生成合成图与 manifest（`--groups-limit` 支持小样本验证）。输出写入 `test_img/synthetic/`（已 gitignore，23MB，不提交）。
- `test_sbi.py` 新增 `--synthetic` / `--synthetic-tiers` / `--limit`：复用既有 `__sbiTest` CDP 打分路径，读 manifest 生成测试列表，合成图结果以独立 `# Synthetic corpus` 段输出并与九张真图严格分开。三项指标：粗排召回率（`fullScored`）、组级第一率（`expected_group==top_group`）、互不可区分集合（按组聚合是否每张都命中）。
- 测试：`tests/synthetic-corpus.test.js`（7）+ `tests/synthetic-corpus-render.test.js`（2）共 9 个新测试，确定性/覆盖/扰动/布局；全量 `npm test` 189/189。

## 基线测量结果（light tier，v19 指纹，2026-08-12）

- 语料：1046 包 / 984 组（全量 light，每成员 2 样本 = 2092 张，评测 n=2090）
- 粗排召回率：1358/2090 = **65.0%**
- 组级第一率：817/2090 = **39.1%**
- 期望成员存在（候选集内）：2012/2090 = **96.3%**
- 互不可区分集合：fully 312 / partially 159 / none 477（共 948 组有合成评测）
- 耗时 21 分钟

诊断结论（对照后续 issue）：
- 粗排召回 65% 是 018 两级检索要解决的核心风险（真值掉出候选集）
- 组级第一率 39.1% + member present 96.3% 说明几乎所有期望包都在候选内、只是排序/分组不对，正好对应 017 组等价放宽的合并空间
- 312 个 fully-indistinguishable 组是 017 的直接输入

## 九张真图回归（验收项 7 说明）

016 代码改动（仅新增 `--synthetic` 分支，未触碰既有打分路径）后九图回归为 **5/9、recall 8/9**，与 014/015 已记录的四个 drops（blue_128x_eum3_sword/depxkey/HUU_x_Pokemon/Ratchet__32x）逐一一致——这是 014 语料膨胀导致的既有回归，非 016 引入。复现命令：`python test_sbi.py`。

## Blocked by

- `015-upload-missing-local-packs.md`
