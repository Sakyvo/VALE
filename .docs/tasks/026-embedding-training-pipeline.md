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

## Current repository state (recorded by 035, not an activation)

The experiment is half-materialised and asymmetric on purpose; see [the 035 report](../reports/sbi-035-aligned-route-decision.md).

| Path | Git state | Role |
| --- | --- | --- |
| `scripts/ml/train_embed.py` | tracked | reproducible training command |
| `scripts/ml/render_hotbar.py` | tracked | reproducible training-pair renderer |
| `scripts/lib/sbi-embedding.js` | tracked | inference helper (`require('onnxruntime-node')`) |
| `assets/models/sbi-embed.onnx` + `.data` | untracked | derived weights, 28,431 + 624,128 bytes |

`scripts/lib/sbi-embedding.js` hard-codes `MODEL_PATH = path.join(ROOT, 'assets', 'models', 'sbi-embed.onnx')`, which is absent at HEAD. Verified there are **no live callers**: nothing under `src/`, `scripts/` or `tests/` imports it, and `node --test "tests/*.test.js"` never loads it. It is dead code relative to both the shipping path and the suite, and must never be offered as a working fallback.

The weights stay out of git as derived output regenerable via `scripts/ml/train_embed.py --out assets/models/sbi-embed.onnx`. Do not check this card's criteria on the strength of that earlier export: int8, ≤3MB, seed-reproducible loss history, 128d/027 alignment and CI-zero-training remain unverified.
