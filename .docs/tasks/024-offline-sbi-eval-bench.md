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
- [ ] v23 基线数字记录在案(预期与 018 的 65.0%/39.1%/96.3% 量级吻合;若显著不符,先查量尺偏差再继续)

## Blocked by
- `023-extract-sbi-matching-core.md`
