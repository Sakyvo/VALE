Status: anchor
Executor: pi

## Problem

SBI 在 2694 组语料下崩溃:九图回归 2/9、合成语料组级 top-1 仅 39.1%(v23 实测)。主判别特征(dHash/hist/moments/sig)对 16×16 像素画辨识力耗尽,最强的 pix 逐像素比对只在 top-28 精排参与,粗排召回靠弱特征 + 过拟合的类型硬规则,继续调参已被证明互相牵制(调 A 坏 B)。本批次重写指纹+匹配层,让"命中第一个是对应材质包"重新成立。

## Decisions

- 验收口径:9-shot 9/9 + synthetic light 组级 top-1 ≥ 80%(等价组内成员不作验收)。
- 先建离线评测台(不开浏览器),经典强化与学习嵌入同尺度 bake-off;经典路线达标即停、不引入模型,否则落混合架构(嵌入做召回+主排序,pix compareSpatial 做最终验证与平局裁决)。详见 `.docs/adr/0006-sbi-matching-rewrite.md`。
- 类型推断退出匹配层,仅 UI 展示。
- 一期只嵌 item 5 类;HUD/widget 维持经典特征,数据说话再扩。
- 纯静态托管不破;首查下载 ≤8MB(含懒加载模型),修订 ADR-0004 的 6MB。
- 训练脚本(Python/torch)入 `scripts/`,`.onnx` 模型提交仓库,嵌入生成经 onnxruntime-node 并入 `npm run sbi:data` 单命令,CI 零训练依赖。
- 删除 CLIP 遗留(transformers.min.js / sbi-worker / 旧 embeddings / 开关),不并行维护。

## Out of scope

- heavy tier 进验收
- 重写提取层(extractHotbarSlots / HUD / widget 采集)
- VPS 服务端匹配
- 组等价语义(ADR-0005)变更

## Testing strategy

- 离线评测台是唯一量尺:合成语料上的 coarse recall / group top-1 / member present,Node 直跑不开浏览器。
- 真实截图回归 `python test_sbi.py` 保持组级 9/9 验收。
- `npm test` 不红;改匹配器/指纹时同步 SBI_FINGERPRINT_VERSION 与 HTML cache buster。
