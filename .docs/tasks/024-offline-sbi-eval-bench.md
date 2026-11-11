Status: open
Executor: pi

## Parent
`.docs/tasks/022-sbi-matching-rewrite.md`

## What to build
离线评测台:Node 加载 `test_img/synthetic/` 语料(manifest.json truth)与 `data/sbi-fp/` 指纹,跑完整"提取→推断→打分→排序"管线,输出 coarse recall@K、group top-1、member present 三项指标。提取层在 Node 侧需要像素解码 seam(sharp 或等价),打分管线必须复用 023 拆出的匹配核心模块,保证量尺与线上同源。产出 v23 基线数字。

## Acceptance criteria
- [ ] 单命令(如 `npm run sbi:eval`)跑完 2092 张 light 语料并打印三项指标
- [ ] 全程不开浏览器
- [ ] 指标口径与 task 018 可比:coarse recall = 真值组进入候选集比例,group top-1 = 排序第一为真值组
- [ ] Record a source/version-pinned full baseline and explain differences from the older v20 report in 016/018; do not require the new result to match 65.0%/39.1%/96.3%, and reconcile 2090 evaluated versus 2092 generated.

## Blocked by
- `030-sbi-observation-parity.md`

## Status correction and ownership

Reopened: none of this card's acceptance items had been verified on the card despite `Status: done`. Task 030 owns the remaining bench/parity work, including 023's split evidence, so this card does not schedule a second implementation.

Those reopening defects were addressed by 030: observation serialization preserves nested HUD and slot evidence, candidate recall uses explicit pre-refinement IDs, and normal/test/offline ranking share one execution path. The source-pinned result and limitations are in [the 030 baseline report](../reports/sbi-030-observation-baseline.md). The full historical run completed at 1584/2092 top-1, 1999/2092 coarse recall@48 and 1982/2092 member presence; eight excluded-pack cases remain failures. This card remains open until 030's remaining verification audit closes. The two unidentified historical omissions (2090 versus 2092) and original split score parity are not retroactively claimed as resolved facts.

Historical session reports include 17.5% top-1 on 40 browser synthetic queries, 20.3% on a 300-row replay and 77.5% for a standalone palette mode on 2092 rows. They have different paths/scopes and are not the verified full baseline required here.
