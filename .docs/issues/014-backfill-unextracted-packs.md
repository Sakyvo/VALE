Status: open
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

## Blocked by

- `013-thumbnails-off-repo.md`
