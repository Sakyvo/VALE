Status: open
Executor: pi

## Parent
`.docs/tasks/022-sbi-matching-rewrite.md`

## What to build
bake-off 候选 A:在评测台上实现并调优"经典强化"路线——pix 进入粗排/候选集构造、类型硬规则退出匹配层(全 slot×全类型计分)、权重重校。Use the existing engine and the approved alignment-first contract rather than unrestricted parameter tuning; batch 029 owns geometry, source-preserving preprocessing and the verified classical comparison. No neural inference is introduced by this classical route.目标:synthetic light 组级 top-1 ≥ 80% 且九图 9/9。

## Acceptance criteria
- [ ] 候选 A 在评测台上的最终数字(含主要中间迭代记录)落在任务卡
- [ ] 若达成(≥80% + 9/9):按 ADR-0006 本路线即为终局,028 只集成经典变体
- [ ] If the classical route misses the gates, record per-stage failure evidence; a missed threshold alone does not authorize a model under the revised ADR-0006.
- [ ] 九图回归同步实测(评测台外另跑 `python test_sbi.py`,数字记录在案)

## Blocked by
- `035-sbi-aligned-route-decision.md`

## Status correction and experimental evidence

Reopened: experiment activity was incorrectly treated as completion. Task 035 owns the aligned comparison record and can resolve this card without a duplicate tuning queue.

The session reported standalone palette top-1 1621/2092 (77.5%), with small-sample trials up to 82.9% on 398 usable rows. The later real-shot browser run reported 3/9, versus the initial 2/9. These are historical measurements with different paths and inputs; neither the sample nor the component score proves the full delivery gate. Capture hashes and rerun on the same complete corpus after 030 verifies replay fidelity.

Do not claim the spatial-size fix removed all sword/pearl evidence from coarse scoring, that the median always denotes empty slots, or that low ranks prove incorrect source textures. Isolated ablations and source/geometry checks must establish those effects before conclusions are accepted.
