Status: open
Executor: Claude Code

## Parent

`.docs/prd/2026-08-05-blatant-cheater-ingestion-and-sbi-two-tier.md`

## What to build

用 50 个包把投稿入库的完整链路跑通一遍，在放量之前把管线缺陷暴露在可承受的代价下。

来源是一位投稿者分两批传来的两个文件夹，共 2666 个唯一文件名，其中 2201 个不在 registry、合计 53.2GB。两批仅 88 个同名（79 个字节相同），不是包含关系——它们只是传输批次，按数量多少命名，因此**合并为单个 `Blatant Cheater` List**，不按批次拆分。

这批包属于投稿者，**不进入自有收藏 List**；但它们出现在主页网格——主页归属与是否自有无关。

本 issue 只取 50 个包，走完整链路：规范化 → 上传 → 提取 → 降采样 → 资产上传 → 索引与页面生成 → 指纹重生成 → 回归。所有包上传前一律先过规范化，只有规范化产物可以上传。高版本材质、Overlay、视觉重复三类识别沿用现有实现，不因这批投稿调整规则。

选 50 个时应刻意覆盖会踩坑的形态：名字含色号、井号、空格的；疑似 Overlay 的；疑似与现有包视觉重复的。目的是让管线在这一批就遇到真实的边界情况，而不是等到第 2000 个包才第一次遇到。

## Acceptance criteria

- [ ] `Blatant Cheater` List 已创建，两个来源文件夹的包合并进同一个 List，未按传输批次拆分
- [ ] 入库的包进入 `Blatant Cheater` List，未进入自有收藏 List
- [ ] 入库的包出现在主页网格与公开索引中
- [ ] 50 个包全部经规范化后上传，规范化产物之外的形态未被写入远端
- [ ] 选取的 50 个包覆盖含色号、井号、空格的名称，且其资产 URL 与下载链接均可访问
- [ ] 被识别为高版本材质的未上传、未进入 List，留有审计记录
- [ ] 被识别为 Overlay 的进入 List，但不出现在主页网格与搜图结果中
- [ ] 视觉内容与已有包完全相同的，在仓库分配与远端写入之前被拦下
- [ ] 展示资产已降采样并上传至 R2，母本已落入本地母本目录
- [ ] 索引、页面、指纹已重新生成
- [ ] 九张真实截图组级全中
- [ ] 主仓库不含材质包归档文件，临时中转目录在成功与失败路径上均已清理
- [ ] 链路中暴露的每个缺陷都已修复或明确记录，作为放量的前置判断依据
- [ ] `npm test` 通过

## Blocked by

- `018-sbi-two-tier-retrieval.md`
- `019-homepage-scale-fixes.md`

## 试点分类进展（2026-08-14）

来源 `D:\Blatant Cheater` 两个文件夹合并为单一暂存目录（50 个覆盖色号/井号/空格/高版本的边界形态包），`upload-folder.js --dry-run` 分类结果：

- **upload_new**: 40（进入 Blatant Cheater List）
- **blocked_pack_id_content_conflict**: 5（同名异版，hard blocker，需人工 retain 决策）：
  - `! §3Azure.zip` (33.7MB)
  - `Kahzuk overlay gray.zip` (25.8MB)
  - `§3Tory Eum3 §l[REVAMP].zip` (20.7MB)
  - `§5Purple 128x.zip` (38.3MB)
  - `§9Advisers Block§f Overlay.zip` (8.2MB)
- **blocked_content_duplicate**: 1（`! not complete - 0zi.zip` 11.6MB，需 retain=existing）
- **skip_existing_pack_id_exact_content**: 4（已注册）

规范化：50/50 normal（无 high_version / illegal）。

执行状态：分类完成、暂存目录就绪（`/tmp/vale-020-pilot`），但 40 个 upload_new 的实际执行（upload-folder --execute + backfill 提取 + index/build + SBI 重生成 + 九图回归）需要 30+ 分钟连续处理；后续 issue 021 全量入库（~2201 包）需 8-12 小时串行上传——两者均超出单次会话自主范围。R2 相关验收项（展示资产上传至 R2、母本目录）受 012/013 人工验收阻塞。

按 grill 共识，020 单批 50 包 roll 完即止、不调参；6 个 blocker 的 retain 决策沿用 015 的同名异版处理模式（记录为 alias，retainedFile 指向既有远端文件）。

## 执行结果（2026-08-14）

- 40 个 upload_new 已上传至 packs-006（registry 1122→1162），`Blatant Cheater` List 创建并含 45 个成员（40 upload_new + 4 skip_existing + 1 duplicate retain=existing，后者记录 aye.zip 别名）。两个来源文件夹合并为单一 List，未按批次拆分。
- 6 个 hard blocker 处理：5 个 same-packId-different-content 从暂存目录剔除（记录为需人工 retain 决策，沿用 015 模式）；1 个 content_duplicate（`not complete - 0zi.zip` 视觉同 aye.zip@packs-003）写 duplicate-resolutions retain=existing 清除。
- 提取：backfill-missing-extract 远端拉取并提取 40 个包（extracted 1114→1154，missing 0）。
- 索引/页面：generate-index（1154 packs/24 pages）+ build.js 重生成包页面。
- SBI 重生成：v20，1085 packs / 991 组（+40 新包，部分按 anchor-dhash 合并）。
- 展示资产 R2 上传与母本目录：受 012/013 人工验收（R2 环境）阻塞，标 skipped-manual。
- 九图回归：因全量 pix 预加载在 1085 包语料下变慢，单轮超时未取到稳定数；018 已记录全量预加载方案（5/9 基线），此处的两阶段开销是下载量预算优化的待解项。
- detect-overlay：扫描某新包时 vips out-of-memory（16MB），已记录为管线缺陷；Overlay 列表已部分更新到 64。
- `npm test`：单元/设计测试（46）单独全绿；完整套件在大语料下出现归档重试与迁移测试的负载超时（flaky，单独运行全绿）。
- 主仓库无 .zip/resourcepacks/，`.vale-pack-upload` 成功后清理。

链路缺陷记录：(1) ensureRepo 对已存在仓库调用 gh repo create 失败（"Name already exists"），需改为先 gh repo view 探测；(2) git clone over proxy 不稳定（EOF），gh repo clone 可绕过；(3) detect-overlay vips OOM on 某 020 新包——三者为放量前置判断依据。
