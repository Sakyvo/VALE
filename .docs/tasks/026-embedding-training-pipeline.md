Status: open
Executor: pi

## Parent
`.docs/tasks/022-sbi-matching-rewrite.md`

## What to build
bake-off 候选 B 的训练侧:Python/torch 自监督对比训练管线,入 `scripts/`。训练数据 = thumbnails 全量 item 纹理;增强管线镜像截图像素级退化(JPEG 压缩、缩放、亮度/对比度抖动,参数与 `scripts/lib/synthetic-corpus.js` 的 perturbation 一致);架构为小 CNN(MobileNet 级以下);产出 ONNX int8 模型(≤3MB)提交仓库。

## Acceptance criteria
- [ ] 单命令可复现训练(seed 固定,损失曲线留档)
- [ ] 模型导出 ONNX int8 ≤3MB 并入库
- [ ] 嵌入输出 128d,与 027 的生成端维度对齐
- [ ] CI 零训练依赖(仅本地手动跑)

## Blocked by

- `035-sbi-aligned-route-decision.md`

## Conditional activation and status correction

Reopened, not an instruction to train now. The current ADR-0006 requires proven crop/preprocessing correctness, remaining-failure analysis and approval of a bounded retraining proposal before this route is active. Task 035 owns that decision. If approved, remove this decision dependency before scheduling retraining and linking downstream evidence; do not create a cycle back into 035.

The prior session produced an experimental 128d fp32 ONNX export with a separate weight file (reported about 28KB plus 624KB); this is not proof of an int8 model, reproducibility or a committed production artifact. The original quantization, data-split, model-size and quality criteria remain unverified. Do not label the pipeline complete merely because export succeeded.

If the aligned classical route passes all gates, record this task as superseded/not selected rather than checking its unperformed criteria. Retire obsolete experiment implementation through 035 while retaining conclusions and reproduction provenance. The old model is not a valid fallback.
