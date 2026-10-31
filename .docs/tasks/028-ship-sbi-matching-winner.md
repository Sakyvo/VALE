Status: open
Executor: pi

## Parent
`.docs/tasks/022-sbi-matching-rewrite.md`

## What to build
把 bake-off 胜出路线集成进浏览器生产路径:匹配核心模块以胜出路线替换 v23 打分;类型标签退 UI 展示;删除 CLIP 遗留(transformers.min.js、sbi-worker、旧 embeddings 数据与 ENABLE_CLIP 开关);同步 SBI_FINGERPRINT_VERSION 与 HTML cache buster;重跑 test_sbi.py 与评测台终审。

## Acceptance criteria
- [ ] `python test_sbi.py` 组级 9/9
- [ ] 评测台 synthetic light 组级 top-1 ≥ 80%
- [ ] CLIP 遗留代码/数据/开关全部移除,`npm test` 全绿
- [ ] 首查下载量 ≤8MB 实测记录(含懒加载模型)
- [ ] `.docs/SBI_SEARCH.md` 流程章节与实现一致

## Blocked by
- `025-classic-fingerprint-bakeoff.md`
- `027-embedding-retrieval-bakeoff.md`
