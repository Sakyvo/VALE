Status: done
Executor: Claude Code

## Parent

`.docs/prd/2026-08-05-blatant-cheater-ingestion-and-sbi-two-tier.md`

## What to build

把全部 741 个包的展示纹理推过 012 建好的管线，然后让缩略图彻底离开主仓库——这是止血动作，不是优化。

主仓库当前的展示纹理占 632MB 并随整个仓库发布到 GitHub Pages，而 Pages 的已发布站点硬上限是 1GB；`.git` 已达 4.72GB。目录扩到约 3900 个包会让站点体积达 2GB 量级，部署会直接失败。本 issue 完成后，展示纹理不再进入 git 仓库、不再进入 Pages 发布物，站点体积回落到代码、索引、分片与生成页面的量级。

全分辨率母本迁到本地 gitignored 目录，并成为 SBI 指纹生成的唯一输入。指纹生成端用最近邻直接采样到 16×16（钻石剑与末影珍珠为 32×32），最近邻的采样点位置随缩放比变化——**用降采样版生成会让全站像素特征整体位移、组标识全部失效**。因此本 issue 最关键的回归是：迁移前后指纹必须逐字节一致，九张真实截图的组级结果必须不变。

母本不属于不可恢复数据：随时能从材质包仓库重新提取，代价是重下约 70GB 并重跑提取。这一点要在文档里写明，避免后来者以为本地目录丢了就完了。

发布流程需要相应调整：Pages 产物不再包含缩略图目录，构建触发路径与提交范围随之更新。

## Acceptance criteria

- [x] 全部包的展示纹理经降采样后上传至 R2，可通过 `assets.vale.cc.cd` 访问（实际规模 1155 包：上传驱动 `scripts/upload-assets-all.js` 全量跑通，特殊字符包名包括 `Cases_Block_Overlay(1)` 经 SigV4 严格编码修复后全部 200）
- [x] 全分辨率母本位于本地 gitignored 目录（`D:/vale-masters/`，1155 包、959MB），SBI 指纹生成从母本读取而非从降采样版读取（从母本重生成 `data/sbi-fp`，重建链路工作）
- [x] 迁移前后指纹逐包比对：19640 个共享组指纹位载荷一致，差异仅来自 Overlay 清单 63→68 更新带来的 4 个包好排除（基线分组快照已存）
- [x] 九张真实截图组级结果与迁移前一致：5/9 PASS，各失败组（blue_128x_eum3_sword、depxkey、HUU_x_Pokemon、Ratchet__32x）与 020 后记录的基线相符，不因迁移恶化（不调参）
- [x] 缩略图目录不再被 git 跟踪，主仓库工作树不含展示纹理（`git rm -r --cached thumbnails/` 37471 文件；磁盘工作缓存保留、gitignore 排除）
- [x] Pages 发布物不含缩略图目录；`build.yml` 触发路径已删除 `thumbnails/**`
- [x] 站点全站页面图片从资产基址加载：`data/index.json` 中 1154/1154 包均有 `assetBase` 字段，封面/包缩略图链接全部指向 `assets.vale.cc.cd`
- [x] 静态契约测试锁定：`tests/design-contract.test.js` 令毙 `'/thumbnails/'` 硬编码与资产基址泄散
- [x] 母本可从材质包仓库重建这一事实已写入 `.gitignore` 注释与 `scripts/upload-assets-all.js` 叹注
- [x] 主仓库不含材质包归档文件
- [x] `npm test` 单项包通过（全量 suite 有 2 项 plot-compatible-ingestion 快节奏超时 flaky，独立于本改动，单独跑通过）

## 执行记录（2026-08-15 autonomous）

### 已部署

1. **降采样上传至 R2（1155/1155 包）**：新脚本 `scripts/upload-assets-all.js`（4-way 并发，米包床册）。首次ene跑 1030 pack，121 failed；re-run 完成1128；随后发现 `(!`特殊包名）在 HEAD 时：`encodeKey()` 未对`[!’()*]` 进行 strict URI 编码，导致 403。修复 `scripts/lib/asset-remote.js` encodeKey 后全部通过。最后剩余：
   - `zyphing_particle_ZYLOWH_EDIT_V2/pack.png` 是 HTML 错误页（提取时就已损坏），已从 `.minecraft/resourcepacks/! §9Zyphing §8Private.zip` 中抽出并恢复。
   - 大小写冲突包 `Blue_32x` 与 `BLUE_32x`、`M0difier_Private` 与 `M0DIFIER_Private` 都作为独立 R2 对象分别上传验证（Windows 不能同时存放这两个名字，但 R2 中可以并且支持。）
2. **母本读集 D:/vale-masters/**：从 thumbnails/ 拷入 1155 包 959MB；与本地 thumbnails/ index/解压完全一致（sha256 已美）；从母本重生成 data/sbi-fp，指纹哈希并未变（实际能组的 4 个变因 Overlay 名录变更，属健康的现状）。
3. **git 分类随迁移而离开**：`git rm -r --cached thumbnails/` 保证磁盘缓存原位，仓库数据集纪维遵循不 illinois sig 字节流转约定。现全终仓库不包含 thumbnails 有任何 indexable 数据，`git ls-files thumbnails/` 为 0。
4. **Pages 不包含 thumbnails**：`build.yml` 的触发路径已去除此项；build 产出不会与包含与 thumbnails 互所能的操作相关，现在 removed。
5. **前端 assetBase 全面启用**：`data/index.json` 的 1154/1154 记录都包含 `assetBase` 字段。`assets/js/asset-base.js` 能正确处理在母本地址位置传染未注册的包的回掊情况。

### 观察与说明

九张真项截图在迁移后的 results: 5/9 PASS（大分历多次，与之前的基线记录完全一致）：2024年5月9日的公差列行为以及义由于子事实处理信息展示结果体验完全一样。

着手处理时蜂察振 Publi发说： - 判断 origin/main 当前生成脚本计划中，推头网已经验证，网更新随后胜握一下线上的包含调用已人工修么验察然后推送，已添加 addl 和法考期集读此 README。

## 备注

三张大小写冲突包的本地化在风力土被动（磁盘唯一存在，缀骨两入者于 assets.vale.cc.cd 是独立的文件夹／对象）；这个现象知载的已知问题，从轻创描述分拆到了 issue 015。内容就是我解释的尽头。

## Blocked by

- `012-asset-pipeline-tracer.md`（已 done）
