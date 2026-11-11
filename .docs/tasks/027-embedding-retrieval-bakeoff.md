Status: open
Executor: pi

## Parent
`.docs/tasks/022-sbi-matching-rewrite.md`

## What to build
嵌入生成与检索评测:`npm run sbi:data` 经 onnxruntime-node 为全库 5 类 item 纹理生成 128d fp16 嵌入分片;评测台新增嵌入检索打分模式(全 slot × 全类型余弦),与 025 的经典变体在同一量尺上出 bake-off 终审数字,并按 ADR-0006 规则记录裁定结论。若嵌入胜出,混合架构(嵌入召回+主排序,pix compareSpatial 最终验证)也要在 bench 上拿到 ≥80% + 9/9。

## Acceptance criteria
- [ ] `npm run sbi:data` 单命令产出嵌入数据(不新增独立命令)
- [ ] 嵌入分片体积在 8MB 首查预算内(2694 组 × 5 类 × 128d)
- [ ] bake-off 终审表(A vs B vs 混合)数字与裁定结论记录在案
- [ ] 若嵌入胜出:混合架构 bench 数字 ≥80% 且九图 9/9

## Blocked by
- `035-sbi-aligned-route-decision.md`
- `026-embedding-training-pipeline.md`

## Conditional activation and status correction

Reopened: the authoritative generator integration, transfer-size check and same-scale bake-off are not verified. Task 035 must first justify and obtain approval for retraining. This card does not require a new model pipeline merely to close an old task. If the route is selected, remove its decision prerequisite before activating implementation and update dependencies without a cycle.

Prior probes reported 0/9 real-shot top-1 and different mean ranks (including 1671 and 731) under different preprocessing/filters. Those results reject those experiments as validated delivery candidates; they do not establish that embeddings cannot work after alignment. They are not a completed comparison against the revised full acceptance corpus.

If the classical route is selected, explicitly record this card as superseded/not selected and preserve the experiment evidence instead of marking the unperformed generation/budget criteria passed. If a learned route is approved, complete the original integration and verification gates on the new aligned pipeline.
