Status: open
Executor: pi

## Parent
`.docs/tasks/022-sbi-matching-rewrite.md`

## What to build
bake-off 候选 A:在评测台上实现并调优"经典强化"路线——pix 进入粗排/候选集构造、类型硬规则退出匹配层(全 slot×全类型计分)、权重重校。允许为提升指标修改一切经典特征与打分逻辑,但改动必须落在 023 拆出的匹配核心模块内,且不引入任何神经网络推理。目标:synthetic light 组级 top-1 ≥ 80% 且九图 9/9。

## Acceptance criteria
- [ ] 候选 A 在评测台上的最终数字(含主要中间迭代记录)落在任务卡
- [ ] 若达成(≥80% + 9/9):按 ADR-0006 本路线即为终局,028 只集成经典变体
- [ ] 若未达成:差距数字记录在案,作为上模型的依据
- [ ] 九图回归同步实测(评测台外另跑 `python test_sbi.py`,数字记录在案)

## Blocked by
- `024-offline-sbi-eval-bench.md`
