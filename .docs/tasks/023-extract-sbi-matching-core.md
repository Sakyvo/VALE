Status: open
Executor: pi

## Parent

`.docs/tasks/022-sbi-matching-rewrite.md`

## What to build

把 `assets/js/sbi.js` 中的匹配核心(特征计算纯函数、比较器、类型推断、matchPacks 打分管线、指纹分片装载)拆成浏览器与 Node 双端可 require 的独立模块。`sbi.js` 保留 UI/渲染/cropbox/历史,改为消费该模块。本任务是纯行为保持重构,不做任何打分逻辑变更——拆分前后浏览器侧行为必须逐位一致。

## Acceptance criteria

- [x] 匹配核心模块可从 Node 直接 require,DOM/canvas 依赖注入为 seam
- [ ] `node --check` and applicable project tests verified; unrelated baseline failures recorded separately, not called green
- [ ] Behavior-preserving split verified against its exact pre-split version: identical per-case top-1 and scores, not merely the same aggregate 2/9
- [x] `sbi.js` 中不再残留匹配核心实现(仅引用)

## Blocked by

- `030-sbi-observation-parity.md`

## Evidence

- `assets/js/sbi-engine.js` (3,416 lines, 119 functions) holds the matching core; `assets/js/sbi.js` keeps UI/render/cropbox/history and consumes the engine at the top.
- Engine seams are injected: `createCanvas`, `ImageDataCtor`, `fetchImpl`; `assets/js/sbi.js` passes the browser implementations.
- Historical parity evidence reported 2/9, candidate recall 4/9 and the same top-1 names as the pre-split baseline. This does not by itself prove score-by-score or bitwise parity; subsequent worktree ranking edits must not be mistaken for the original split.
- `npm test` 205/207 pass — the two `plot-compatible-ingestion` failures also fail on the untouched tree.
- New Node-side test `tests/sbi-engine.test.js` loads the engine without a DOM, fingerprints a texture, renders a synthetic hotbar from real pack thumbnails, and gets the source pack as rank 1.

## Status correction

Reopened during the approved batch-029 documentation pass: the checked all-green/score-parity claims exceeded the recorded evidence. The completed extraction work is retained; 030 owns evidence reconciliation, with no duplicate refactor or dependency back to this card. Historic line/function counts above are not a current implementation inventory. Do not mark done until the remaining criteria are verified.

Task 030 has recorded the original split's bitwise score-parity claim as **unproven** in [its baseline report](../reports/sbi-030-observation-baseline.md). Its current browser/direct/cache parity checks prove the tested snapshot behaves consistently across execution paths; they do not prove equivalence to the unsplit revision. This criterion remains unchecked rather than substituting aggregate accuracy or a later ranking snapshot.
