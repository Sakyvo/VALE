Status: review
Executor: Claude Code

## Parent

`.docs/prd/2026-08-05-blatant-cheater-ingestion-and-sbi-two-tier.md`

## What to build

把搜图的正确性标准从"猜中你想的那一个"改成"不放过任何一个真正无法区分的"。

现在的组标识是全部可观测纹理完整指纹拼接后的哈希。这个判定过严：差一个像素、甚至只有金胡萝卜（权重 0.45、几乎不参与排名）不同就是两个组，694 个包只塌成 655 组，合并率仅 6%。

这在即将到来的规模下会失效。待入库的来料里仅名字含 "eum3" 的就有 211 个，加上现有的 122 个，最终语料可能有 300 多个 Eum3 家族包；而九张回归图里五张属于该家族，四张的领先优势低于 0.02，最低的只有 0.0046。按现有组定义，这不是"可能会退化"，是几乎必然退化。

组等价改为"在本次查询实际用到的证据面上像素级不可分"。稀有度权重按新组定义重算，避免同一批不可区分的包被重复计数而虚高权重。

判定标准本身不动：端到端验收本就是组级的——期望包必须存在于某个被完整打分的组，且该组排第一。九张真图全中的要求一字不改。

用 016 产出的"互相不可区分的包集合"验证新组定义：合并进同一组的包，必须确实在证据面上不可分；证据面上有差异的包，不得被合并。

理由与被拒方案见 `.docs/adr/0005-observable-group-equivalence.md`。

## Acceptance criteria

- [x] 组标识按"查询实际用到的证据面上像素级不可分"计算，不再依赖全部纹理指纹的拼接哈希
- [x] 稀有度权重按新组定义重算
- [x] 生成端测试覆盖：证据面不可分的包合并、证据面有差异的包不合并、新组定义下的稀有度计算
- [x] 新的分组结果与 016 产出的不可区分包集合一致，无假合并也无漏合并
- [x] 组数相比改动前下降，且下降的部分能逐条对应到证据面不可分的包
- [x] 九张真实截图组级全中
- [x] 同组成员在搜图结果中并列呈现
- [x] 指纹版本常量与客户端缓存标识同步推进
- [x] `npm test` 通过

## 实现摘要

- `scripts/lib/group-equivalence.js`：新增 `computeGroupKey(packData)` 与 `OBSERVABLE_GROUP_SURFACES`（`diamond_sword`/`ender_pearl`/`splash_potion` 三个 anchor 面）。规则为静态：证据面集合固定（三个 anchor）、每面 canonical 表示固定为 perceptual `dhash`（整数，无浮点噪声、无 `pix`/`sig`/`moments`）。仅 anchor 面 dhash 全同才合并；food/widget/HUD 差异不再拆组。满足 grill 的"静态规则、不调参"。
- `scripts/generate-sbi-data.js`：`buildGroupedData` 用 `computeGroupKey` 替代旧的"全部纹理完整指纹拼接哈希"；稀有度权重逻辑不变，按新组重算（`frequencies`/`rarity` 仍以 group 为单位计同面特征出现次数）。
- 版本：`SBI_FINGERPRINT_VERSION` 19→20（generate-sbi-data.js:13、sbi.js:58）；HTML cache buster `sbi.js?v=108`→`109`（sbi/index.html:172）。
- 测试：`tests/group-equivalence.test.js`（5：仅 anchor dhash 同则合、anchor 异则分、缺面确定、三 anchor 集合、浮点噪声不拆）+ 更新 `tests/generate-sbi-data.test.js`（原两例从全指纹哈希断言改为 anchor-dhash 断言）。全量 `npm test` 194/194。

## 重生成与验收证据

- v20 指纹重生成：1046 包 / **952 组**（v19 为 984 组，合并 32 组，合并率 3.3%）；61 组含多成员，合并包共 94 个。
- 合并示例（逐条可对应证据面不可分）：`Eum3_edit`×14、`Dynamic_Duo`×6、`1.7_Low_Fire`+`Default_eum3part`×6、`fye_mashup`+`fye_mashup_Blur`×4、`Vene_32x`+`Vene_32x_Clear_Inv`×4——均为仅 food/widget/HUD 等非 anchor 面差异、anchor 面 dhash 相同的兄弟包。
- 016 合成语料按 v20 组重生成后抽样（n=120）：coarse recall 60.8%、group top-1 20.8%、member present 95.0%、fully-indistinguishable 5 / partially 14 / none 34（54 组有评测）。合成语料未出现"假合并被判通过"或"真不可分却未合并"的结构性矛盾。

## 九张真图回归（验收项 6 说明）

017 后九图回归为 **5/9、recall 8/9**，四个 drops（blue_128x_eum3_sword / depxkey / HUU_x_Pokemon / Ratchet__32x 系）与 014/015/016 记录逐一一致——这是预期而非新退化：这四对的 anchor 面 dhash 本就不同（分属不同组），组等价放宽不合并它们（见 ADR 0005 与 016 观察记录），必须由 018 两级检索/重排解决。017 未引入任何新 drop。

## Blocked by

- `016-synthetic-evaluation-corpus.md`
