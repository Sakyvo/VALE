Status: open
Executor: pi

## Parent

`.docs/tasks/022-sbi-matching-rewrite.md`

## What to build

把 `assets/js/sbi.js` 中的匹配核心(特征计算纯函数、比较器、类型推断、matchPacks 打分管线、指纹分片装载)拆成浏览器与 Node 双端可 require 的独立模块。`sbi.js` 保留 UI/渲染/cropbox/历史,改为消费该模块。本任务是纯行为保持重构,不做任何打分逻辑变更——拆分前后浏览器侧行为必须逐位一致。

## Acceptance criteria

- [ ] 匹配核心模块可从 Node 直接 require,DOM/canvas 依赖注入为 seam
- [ ] `node --check` 通过;`npm test` 全绿
- [ ] `python test_sbi.py` 结果与拆分前完全一致(仍为 2/9,每个 case 的 top-1 与分数不漂移)
- [ ] `sbi.js` 中不再残留匹配核心实现(仅引用)

## Blocked by

None - can start immediately
