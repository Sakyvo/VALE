# SBI 的正确性以"可观测证据下不可分"为准，而非精确命中单个包

`buildGroupedData` 曾把全部可观测纹理的完整指纹（含 `pix` 与 `sig` 浮点）拼接后取 SHA256 作为 group ID。这个判定过严：差一个像素、甚至只有 `golden_carrot`（权重 0.45，几乎不参与排名）不同就是两个组，694 个包只塌成 655 组，合并率仅 6%。目录扩张后这会失效——单是待入库的来料就含 211 个 Eum3 变体，加上现有的 122 个，最终语料可能有 300+ 个 Eum3 家族包，而 `test_img/` 九张测试图里有五张属于该家族、四张的 margin 低于 0.02（最低 `Small - Eum3 Blue Revamp` 仅 0.0046）。因此 group 等价放宽为"**在本次查询实际用到的证据面上像素级不可分**"。

这不是降低标准。如果两个包在 DS / EP / HL / food / widget / HUD 这些证据面上完全一致，那么从一张截图上区分它们在信息论意义上就是不可能的，赌中某一个是运气而非能力；正确的产品行为是并列展示同组成员（`SBI_SEARCH.md` 已有 "exact observable groups are displayed together"）。相应地，验收标准是"期望包所在的组排第一"而非"#1 是期望包"——`test_sbi.py:425` 的判定 `expected_member_exists and recall_ok and expected_group == top_group` 本就是组级的，无需改动，九张真图 9/9 的要求也一字不改。

拒绝的替代方案：保持严格 group 而把验收放宽到 top-5 命中——用户要的是"这是哪个包"，给五个候选是产品体感的实质下降；保持严格 group 且坚持精确 #1，靠算法硬扛——在 300 个近乎同款的变体面前，这是把无法兑现的承诺写进验收线。
