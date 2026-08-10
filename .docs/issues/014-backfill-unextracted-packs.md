Status: review
Executor: Claude Code

## Parent

`.docs/prd/2026-08-05-blatant-cheater-ingestion-and-sbi-two-tier.md`

## What to build

让 378 个隐形包重新出现在站点上。

它们已经上传到远端、已经在 List 里、审计记录显示分类正常且无阻塞项，但提取从未跑到它们头上——断点在 `packs-004`（37 个已公开、174 个未提取），`packs-005` 的 204 个全部未提取。结果是 registry 有 1118 条而公开可见只有 738 个，三分之一的目录是隐形的。用户搜 "fye" 返回 0 条就是这个缺陷的直接体现：七个 Fyes 包全部不可见。其中 366 个视觉内容独一无二，不是重复。

补提取要复用现有替换流程里的远端下载路径，**不给提取脚本新增一条平行的远端能力**。378 个里 373 个的归档仍在本地材质包目录，只有 5 个需要从远端拉取（约 70MB），因此优先用本地归档、本地缺失时才走远端。

补提取完成后重新生成索引、页面、展示资产与指纹。此时 SBI 语料从 655 组增至约 1000 组，是整个方案的第一个真实规模压力点——九张真实截图在这个规模下是否还能全中，直接决定后续 SBI 工作要做多狠。若出现掉名，如实记录是哪张、被谁挤掉、差多少，不要为了让测试变绿而临时调参。

同时需要一个可持续的防复发手段：让"已上传但未提取"这个状态可被查出来，而不是等用户搜不到才发现。

## Acceptance criteria

- [x] 378 个包全部完成提取并进入公开索引，公开包数从 738 增至 1110（378 减去 6 个因 sanitize 合并的重复 packId；审计显示 uploaded-not-extracted 已归零）
- [x] 主页搜索 "fye" 返回 9 个 Fyes 系列结果（含 Fyes Default edit [FPS BOOST](3)、Private Fyes Default、fye mashup Blur 等）
- [x] 本地已有归档的包不触发远端读取；仅本地缺失的 5 个从对应材质包仓库拉取（实测 5 个全部走远端下载：!      §bCases §3Block §8Overlay、! Pax 10 Rose、SoupSkidz Map 7 Pack (1)、Fyes Default edit [FPS BOOST] (3)、§b!    fye §1mashup Blur）
- [x] 补提取走既有远端下载路径（`github-pack-remote.downloadArchive`，transport=curl），提取脚本未新增平行的远端能力
- [ ] 这 378 个包的展示资产已经降采样并上传至 R2，母本已落入本地母本目录 —— **skipped-manual**，依赖 013/R2 环境（见 issue 012 人工验收）
- [x] 索引、页面、指纹已重新生成（index 1110；SBI 语料 655→980 组，version 18→19）
- [x] 九张真实截图组级全中；若有掉名，已如实记录掉名图、胜出包与分差，且未通过临时调参掩盖 —— **见下方「SBI 回归掉名记录」**
- [x] 存在一种可重复执行的检查，能列出 registry 中已上传但缺失提取数据的条目（`node scripts/audit-extraction-coverage.js` + 测试）
- [x] 临时中转目录在成功与失败路径上均被清理（backfill 脚本 finally 清理 manifest 与远端暂存目录；实测无残留）
- [x] `npm test` 通过（180/180）

## SBI 回归掉名记录（version 19，语料 655→980 组）

结果 5/9 全中，4 张掉名。**所有胜出包均为本次 014 新增入库的包**，属 PRD 预警的语料扩大必然退化，未做任何调参。修复路径是后续 issue 017（组等价放宽）与 018（两级检索），不在本 issue 范围内。

| 掉名图 | 期望 | 胜出包（014 新增） | 分差 margin | 期望排位 | 备注 |
| --- | --- | --- | --- | --- | --- |
| Large - Blue 128x.png | Blue_128x | blue_128x_eum3_sword | 0.0229 | #4 | 组内近亲 |
| Large - Eum3 Blue Revamp.jpeg | Eum3_Blue_Revamp | depxkey | 0.0752 | #5 | Eum3 家族 |
| Large - Eum3Blue Revamp (2).jpeg | Eum3Blue_Revamp | HUU_x_Pokemon | 0.1430 | 未入候选 | **recalled=False，粗排召回风险实证** |
| Small - Eum3 Blue Revamp.jpeg | Eum3_Blue_Revamp | Ratchet__32x | 0.0000 | #4 | 完全并列 |

候选召回 8/9（Large - Eum3Blue Revamp (2).jpeg 真值掉出候选集），与 PRD "粗排召回是本方案唯一新增风险" 的判断一致。

## 已知问题：大小写碰撞 packId（Blue_32x/BLUE_32x 等）

014 补提取使 registry 中大小写仅异的 packId 对同时进入 extracted 与站点生成，暴露 Windows 本地（core.ignorecase=true）无法同时保存两个大小写目录的固有限制：

- Blue_32x（packs-004，43.6MB）与 BLUE_32x（packs-005，15.6MB）是两个独立包，index 中均有条目（index total 1114 含两者）；Linux CI 正确生成 data/packs/BLUE_32x.json 与 p/BLUE_32x/ 页面
- 但 thumbnails/ 只有一个物理目录（Blue_32x），提取时两个包的展示资产互相覆盖；线上 thumbnails/BLUE_32x 缺失（其 cover 引用为 404），Blue_32x 目录内容可能来自 BLUE_32x 的提取
- 同类碰撞还有 M0difier_Private/M0DIFIER_Private

**此问题不影响 014 验收项**（提取入 index、可搜索、SBI 指纹均完成），但影响这两个大小写碰撞包的展示资产正确性。修复路径是 013（thumbnails 移出仓库、远端收纳可保留大小写差异）；在 R2 迁移时以远端对象名区分两包，并用 `git mv` 或远端操作在 Linux 上整理。本地 Windows 工作树会因此残留无法消除的 `M data/packs/*` 大小写差异，属物理限制，勿尝试提交修复。

## 人工验收步骤（R2 环境就绪后）

R2 环境（bucket + assets.vale.cc.cd + 凭据，见 issue 012 人工验收）就绪后，对 1114 个公开包的展示资产统一做降采样上传：

```
# 逐个 packId 上传并在 data/asset-base.json 登记
node scripts/upload-assets.js '<pack_id>'
# 每批后重生成
node scripts/generate-index.js && node scripts/build.js
npm run sbi:data
python test_sbi.py
```

确认本地母本目录含全部 1114 个包的全分辨率纹理（迁移后 `thumbnails/` 仅存降采样展示副本）。

## Blocked by

- `013-thumbnails-off-repo.md`
