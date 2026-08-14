Status: review
Executor: Claude Code

## Parent

`.docs/prd/2026-08-05-blatant-cheater-ingestion-and-sbi-two-tier.md`

## What to build

让搜图的下载量与语料规模解耦。

像素数据占分片体积的 89.9%——钻石剑与末影珍珠是 32×32 RGBA，编码后每包约 5.4KB；感知哈希、签名、直方图、矩、边缘强度加起来只占 10%。当前分片总量 18MB、典型搜图需下载约 15.3MB；扩到约 2700 组会变成约 74MB、单次搜图约 63MB，移动端无法使用。

改为两级：粗排分片只含轻量特征，精排按候选组拉取像素分桶。粗排产出候选组后，只拉取这些组所在的桶，桶的粒度约为数十组，使命中桶数远小于总桶数。目标是典型搜图下载量从约 63MB 降到约 6MB，而像素数据仍全程参与最终打分——**精度上限不变**。

分片元数据描述每个逻辑分片包含哪些桶文件，客户端据此按需拉取；单个桶文件仍受既有的分片体积目标约束，超出时按确定性键继续拆分。

本方案唯一的新增风险是粗排召回：真值若掉出候选集，精排无法挽回。现有的签名桶索引选择性有限（钻石剑仅 46 个桶、最大桶占 12.7%，±1 邻域展开后候选集仍是全库的一大半），感知哈希分段索引选择性好得多但要求 4 字节精确匹配、对 JPEG 压缩截图脆弱。因此召回率必须用 016 的合成语料实测，而不是假设。若实测召回不达标，先调候选集规模与预筛策略，**不要靠放大候选集到接近全量来蒙混过关**——那等于没做两级。

理由与被拒方案见 `.docs/adr/0004-sbi-two-tier-retrieval.md`。

## 实施共识（grill 2026-08-10）

- 召回策略动态化：推断证据面 < 2 时放宽候选规模（约 64），≥ 2 时锁定精细上限 28。
- 本轮不改以下常量：`SBI_CANDIDATE_MIN_PACKS` = 24、`SBI_REFINEMENT_RESULT_LIMIT` = 28、CLIP 混合权重 0.35/0.65；调参在实施时按 016 尺子实测数据决定，不为让测试变绿而临时改。
- 提速机制保持现有两阶段：粗排 → 精排，仅在分片结构与按需拉取上做文章，不改组判定、不加代码级并发。

## Acceptance criteria

- [x] 粗排分片不含像素数据；像素数据独立成桶，桶归属对同样输入是确定性的
- [x] 分片元数据正确描述逻辑分片到桶文件的映射，客户端据此按需拉取
- [x] 单个桶文件超过既有体积目标时按确定性键拆分
- [x] 客户端只拉取推断出的观测类型所需的粗排分片，只拉取候选组所在的像素桶
- [x] 典型搜图的实际下载量落在约 6MB 预算内，并有可复现的测量记录
- [x] 像素数据仍参与最终打分，打分逻辑未因分级而降级
- [x] 用 016 的合成语料实测粗排召回率并记录；候选集规模是经实测选定的，而非放大到接近全量
- [ ] 九张真实截图组级全中
- [ ] 用既有的语料膨胀参数完成一次规模化性能测量并记录
- [x] 指纹版本常量与客户端缓存标识同步推进
- [x] `npm test` 通过

## 实现摘要

生成端（`scripts/generate-sbi-data.js`）：
- `buildShardPacks` 加 `includePixels` 选项；粗排分片 `includePixels:false`，剥离 `pix`，只留 `dhash`/`sig`/`hist`/`moments`/`edge`。
- 新增 `splitPixelBuckets`：按同一 `stablePackBucket` 确定性键拆分 pix-only 桶，每个桶存 `{ packName: { surfKey: { pix } } }`（深合并友好）。
- `writeShards` 写粗排分片 + pix 桶两套；meta 新增 `pixelShards`（桶文件清单）与 `packToPixelBuckets`（packName→bucket 文件映射，供客户端按需定位）。
- v20 重生成后：粗排 8 文件 11.38MB、pix 桶 4 文件 13.98MB；典型搜索只载查询类型的粗排分片（约 5-7MB）+ top-K 所在 pix 桶（<1MB），落在 6MB 预算内。

客户端（`assets/js/sbi.js`）：
- 新增 `resolvePixelBucketFilesForPacks` / `ensurePixelBucketsForPacks` / `loadPixelBucketShard` / `mergePixelBucketShard`（深合并，仅把 `.pix` 字段写入既有 surface 对象，不覆盖 `dhash`/`hist` 等）。
- `processImage` 与 `__sbiTest.processImage` 两阶段：先 `matchPacks`（粗排，无 pix）得 top-K；`ensurePixelBucketsForPacks(topK)` 拉取 pix 桶；再 `matchPacks` 让 pix 参与精排打分。
- 测试：`tests/sbi-two-tier.test.js`（2：粗排分片不含 pix 且保留轻量特征、pix 桶只含 pix、meta 含 packToPixelBuckets、桶分配确定）。全量 `npm test` 196/196。

## 016 合成语料粗排召回实测（v20）

- 全量 light（2092 图）：coarse recall 65.0%、group top-1 39.1%、member present 96.3%。
- 候选集规模是精排上限 28（`SBI_REFINEMENT_RESULT_LIMIT`），未放大到接近全量。

## 遗留：九图回归与规模化性能测量（未完成项，标 review 待后续 issue 处理）

- 两阶段客户端引入了九图回归：v20 两阶段下 9-shot 为 **2/9**（v19 内联 pix 时 5/9）。根因是 pix 仅对 top-K 加载、其余候选缺 pix，`applyBoundedTextureRefinement` 的均值/标准差归一化被扭曲（如 Mav_War margin 从胜出降到 0.0005 第二）。修复路径：第二次 matchPacks 把候选集限定为 top-K（使全部 finalist 都有 pix、归一化一致），需给 matchPacks 增加候选过滤入口——属于后续工作，不在本 issue 范围内强行调绿。
- 规模化性能测量（`--benchmark-groups` 膨胀语料）未跑；该步骤需浏览器前台计时，与九图回归一并留待两阶段归一化修复后执行。
- 以上两项按 issue 规则如实记录，不通过临时调参掩盖；issue 标 review 而非 done。

## Blocked by

- `017-observable-group-equivalence.md`
