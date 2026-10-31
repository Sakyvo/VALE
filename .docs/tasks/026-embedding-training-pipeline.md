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

None - can start immediately
