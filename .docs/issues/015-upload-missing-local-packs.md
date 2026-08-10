Status: review
Executor: Claude Code

## Parent

`.docs/prd/2026-08-05-blatant-cheater-ingestion-and-sbi-two-tier.md`

## What to build

把 37 个从未上传的本地包按正常入库流程补传，顺带把入库路径在小规模下演练一遍。

本地材质包目录有 1102 个归档，其中 105 个文件名不在 registry；对色号与符号做归一化比对后，37 个是真的从未上传，其余是同一个包的不同命名形式。用户举的 `Fyes Default edit [FPS BOOST].zip` 属于这 37 个，而 `Private Fyes Default.zip` 属于 014 处理的隐形包——两类问题外观相同、成因完全不同。

这 37 个包走完整入库流程：先规范化，只有规范化产物可以上传；高版本材质与 Overlay 沿用现有识别规则自动处理；视觉内容重复的在仓库分配与远端写入之前被拦下。它们属于站点自有收藏，进入自有收藏 List。

这一步同时是 020 那次 50 包试跑之前的一次真实但低风险的入库演练：如果规范化、仓库分配、重复判定或 List 归属有任何缺陷，在 37 个包的代价下暴露，而不是在 2201 个包的时候。

## Acceptance criteria

- [x] 实际上传新入库 4 个（Cayden_Remastered、Airbus_Yokabi_Edit、Yokabi_OG、Nice_lil_Yokabi_64x_EDIT，全部进 packs-006 与 Sakyvo List）；其余 17 个本地文件被分类为 高版本/重复/冲突 而拦截——见「真实分类 vs issue 37 估算」
- [x] 被识别为高版本材质的包未上传、未进入任何 List，并留有审计记录（3 个：Doly_128x、qCh1ll_ Private、meezoid，记录于 data/internal/pack-normalization-audit.json）
- [x] 本次 4 个新包均非 Overlay；Overlay 识别规则沿用既有 detect-overlay（46 个 Overlay 包无新增变化）
- [x] 视觉内容与已有包完全相同的，在仓库分配与远端写入之前被拦下（Fyes Default edit [FPS BOOST].zip 与 Johkeh Default(2).zip 匹配已有包，dry-run 即上报 blocked_content_duplicate，未触发任何远端写入）
- [x] 成功入库的 4 个包进入 Sakyvo List（1052→1056），并出现在主页与公开索引中（index 1114）
- [ ] 展示资产已降采样并上传至 R2，母本已落入本地母本目录 —— **skipped-manual**，依赖 013/R2 环境（见 issue 012 人工验收）
- [x] 索引、页面、指纹已重新生成（index 1114；SBI 语料 984 组，version 19）
- [x] 九张真实截图组级全中；若有掉名，已如实记录且未通过临时调参掩盖 —— **见 issue 014 的 SBI 回归掉名记录**（015 新增 4 包后回归结果与此完全相同：5/9 通过，4 张同名图掉名，胜出包均为 014 新增）
- [x] 主仓库不含材质包归档文件，临时中转目录已清理（.vale-pack-upload 在成功路径上由脚本清理，实测无残留）
- [x] `npm test` 通过

## 真实分类 vs issue 37 估算

issue 写时用「归一化文件名」估算 37 个从未上传；实际走 upload-folder.js 的 packId+内容指纹判定后，21 个本地文件（19 唯一 packId）相对 registry 全新，进入 dry-run 后分类如下：

| 分类 | 数量 | 文件 |
| --- | --- | --- |
| upload_new（已上传） | 4 | ! §6Cayden Remastered、Airbus Yokabi Edit、Yokabi OG、§4Nice §flil §4Yokabi §f[64x] §4EDIT |
| high_version（跳过） | 3 | ! §9§lDoly 128x、! §b§l§oqCh1ll_ Private、meezoid |
| blocked_content_duplicate（与已有包视觉相同，拦截） | 2 | Fyes Default edit [FPS BOOST]、! Johkeh Default(2) |
| blocked_pack_id_content_conflict（同名异版，硬拦截需人工决策） | 5 | ! §3Tory eum3 Revamp、!#Fire、Eum3 Edit、private default edit、Yokabi Edit |
| skip_existing_pack_id_exact_content（内容已存在，跳过） | 5 | #PvPmen、#§bPvPmen§3 Revamp、Faith red 128、§3StimpyHCF §f§lEDIT、pax10 |
| skip_source_duplicate（stage 内重复文件） | 2 | ! Yokabi Edit（=Yokabi Edit）、§9Nice §f…EDIT（=§4Nice 版） |

说明：用户举的 `Fyes Default edit [FPS BOOST].zip` 内容与远端已有的 `Fyes Default edit [FPS BOOST] (3).zip` **视觉完全相同**，被 blocked_content_duplicate 拦截、未上传——即 014 已用 (3) 名义把它上线，015 正确识别为重复而非重新入库。5 个 pack_id_content_conflict 是同名（同 packId）但视觉内容不同的包，属于硬 blocker（脚本对 content_ 开头 blocker 无条件拒绝 execute），需要人工决策保留哪个版本——移交用户。

## 人工验收步骤（R2 环境就绪后）

R2 环境（bucket + assets.vale.cc.cd + 凭据，见 issue 012 人工验收）就绪后，对 1114 个公开包的展示资产统一做降采样上传：

```
# 逐个 packId 上传（当前 1114 个已上传但未迁移资产），并在 data/asset-base.json 登记
node scripts/upload-assets.js '<pack_id>'
# 每批后重生成
node scripts/generate-index.js && node scripts/build.js
npm run sbi:data
python test_sbi.py
```

回填 015 新增的 4 个包（Cayden_Remastered、Airbus_Yokabi_Edit、Yokabi_OG、Nice_lil_Yokabi_64x_EDIT）时同样执行，并确认本地母本目录含它们的全分辨率纹理。

## 遗留：5 个同名异版冲突（需人工决策）

| 本地文件 | packId | registry 已有 |
| --- | --- | --- |
| !     §3Tory eum3 Revamp.zip | Tory_EUM3_Revamp | ! §2 Tory EUM3 Revamp.zip @ packs-002 |
| !#Fire.zip | fire | fire.zip @ packs-002 |
| Eum3 Edit.zip | Eum3_edit | ! Eum3 edit.zip @ packs-002 |
| private default edit.zip | Private_Default_EDIT | §3Private Default §fEDIT.zip @ packs-002 |
| Yokabi Edit.zip | yokabi_edit | yokabi edit.zip @ packs-001 |

5 个都是「同名（同 packId）但视觉内容不同」，流程按硬 blocker 拒绝 execute。决策：保留 registry 现有版本（丢弃本地），或保留本地并替换远端——由人工在下次入库会话中决定。

## Blocked by

- `014-backfill-unextracted-packs.md`
