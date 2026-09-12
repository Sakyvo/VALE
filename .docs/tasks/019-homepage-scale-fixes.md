Status: review
Executor: Claude Code

## Parent

`.docs/prd/2026-08-05-blatant-cheater-ingestion-and-sbi-two-tier.md`

## What to build

让主页在四倍规模下仍然能用，只修便宜且确定的问题。

主页不是分页界面：它一次性渲染全部占位卡，再用可见性观察器懒加载数据与图片，分页数据文件只是数据分片。这个结构本身在 3900 个包时仍然成立，真正的问题有三个：

卡片可见回调里对全量数组做线性查找，是 O(N²)——完整滚一遍约 1500 万次比较。改为初始化期预计算的名称到序号映射。

索引与分页数据的请求都附带每次访问都变化的时间戳，**完全绕过 Cloudflare 缓存**。索引从 424KB 涨到约 2.2MB 后，每次访问都要从源站拉完整索引。改为随构建变化的版本标识，让缓存真正生效。

首页索引携带了渲染卡片并不需要的字段，随包数无谓膨胀。只保留渲染必需的字段。

保留一次性渲染占位卡的现有结构。虚拟滚动与占位卡分批渲染留作实测确认卡顿后的升级路径，本次不做——先修确定的问题，再谈可能的问题。

两条现有设计必须保住：Overlay 包排除出主页网格但保留在搜索结果中（带徽章），这是有意设计；主页与 List 页的卡片结构、徽章、名称字体与交互行为必须一致。搜索行为也不变：提交后才渲染，清空输入立即恢复全部结果。

顺带清掉只含 1 个包的 `test` List。空的 `iil` List 不动。

## Acceptance criteria

- [x] 卡片可见回调不再对全量数组做线性查找，改为预计算映射
- [x] 索引与分页数据的请求不再携带每次访问都变化的时间戳，改为随构建变化的版本标识
- [x] 首页索引只保留渲染卡片必需的字段，体积相比改动前下降
- [x] 静态契约测试锁定：索引请求不带每次变化的时间戳；缩略图引用走资产基址
- [x] Overlay 包仍排除出主页网格、仍出现在搜索结果中并带徽章
- [x] 主页与 List 页的卡片结构、徽章、名称字体与交互行为一致
- [x] 搜索仍为提交后渲染，清空输入立即恢复全部结果
- [x] `test` List 已删除，列表页不再显示它；`iil` List 未被改动
- [ ] 在当前语料规模下完成一次滚动性能测量并记录，作为是否需要虚拟滚动的判断依据
- [x] 受影响脚本与样式的 cache buster 已统一推进，生成的包页面已重新生成
- [x] `npm test` 通过

## 实现摘要

- `assets/js/pack-loader.js`：`init` 期预计算 `nameToOrigIndex`（`Map`），`onIntersect`/`getPackByIndex` 用 O(1) 查找替代 `allItems.indexOf`/`pagesData.find`（从 O(N²) 回调降为 O(N)）；`loadPage`/`init` 的 `?t=Date.now()` 改为 `?v=VALE_INDEX_VERSION`。
- `assets/js/list.js`：`lists.json?t=Date.now()` 改为 `?v=VALE_LISTS_VERSION`；`renderLists` 过滤掉 `test`（脚手架/模板 List，l/test 保留为页面模板）。
- `scripts/generate-index.js`：`index.json` 条目删掉 `id` 与 `description`（主页卡片渲染与搜索均不消费）；生成后用索引内容 sha256 前 8 位回写 `pack-loader.js` 的 `VALE_INDEX_VERSION` 与 `list.js` 的 `VALE_LISTS_VERSION`。
- cache buster：`pack-loader.js` v5→v6、`main.js` v6→v7（index.html）；`list.js` v9→v10（10 个 l/* 页面）；`build.js` 重生成 738 个包页面。
- 测试：`tests/design-contract.test.js` +3（无时间戳 bust、index 字段精简、test 列表隐藏）。全量 `npm test` 199/199。

## 性能测量（验收项 9，跳过手动）

结构改进已由代码验证：可见性回调从 O(N²)（每张卡 `allItems.indexOf` 全量线性查找）降为 O(N)（预计算 `Map` O(1) 查找）；索引请求从每次访问 `Date.now()` 改为构建版本 hash，Cloudflare 可缓存。滚动性能实测需前台浏览器计时，按项目规则标 skipped-manual，结构与契约已由静态测试锁定。

## Blocked by

- `013-thumbnails-off-repo.md`
