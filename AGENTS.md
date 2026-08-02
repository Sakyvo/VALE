# VALE

## 项目定位

VALE 是面向 Minecraft 1.7/1.8 PvP 玩家的静态材质包浏览、下载与以图搜图网站，部署于 `vale.cc.cd`。
主仓库 `Sakyvo/VALE` 只保存站点代码、索引和缩略图；材质包归档保存在远端 `Sakyvo/packs-NNN`。
SBI 是项目核心能力，必须同时维持准确率、响应速度和静态托管兼容性。

## 技术栈与结构

- 技术栈：HTML、CSS、原生 JavaScript、CommonJS Node.js、Python、GitHub Actions/Pages。
- `assets/`：共享样式、浏览器逻辑和字体。
- `scripts/`：上传、提取、索引、页面和 SBI 数据生成工具。
- `data/`、`thumbnails/`：目录数据、指纹分片和提取资源。
- `p/`、`l/`：生成的 pack 与 List 路由页面。
- `tests/`、`test_sbi.py`：Node 测试和 SBI Edge 回归。
- `.docs/`：开发契约、研究记录、issues 和历史归档。

## 常用命令

- Node 测试：`npm test`
- JavaScript 语法检查：`node --check <changed-file.js>`
- 生成公开索引：`npm run index`
- 生成路由页面：`node scripts/build.js`
- 生成 SBI 指纹：`npm run sbi:data`
- SBI 回归：`python test_sbi.py`
- 完整内容指纹扫描：`npm run packs:scan-content -- --concurrency 6`

## 常驻法则

- 每次任务开始先执行 `git pull`，完成并验证后执行 `git push`；用户明示跳过时仅对当次任务生效。
- 领取“下一个 issue”时先按 `Executor` 过滤当前工具，再从匹配项中选择编号最小的 open、无阻塞 issue；Codex 不执行 `Executor: Claude Code` 的任务，Claude Code 反之。
- 主仓库不得出现材质包 `.zip` 或 `resourcepacks/`；提交前检查 tracked/staged 文件。
- 材质包只长期保存在远端 `Sakyvo/packs-NNN`；`.vale-pack-upload` 仅作临时中转并必须在成功或失败后清理。
- 远端仓库达到 5GB 时写入 `!  FULL  !`，然后使用或创建下一个编号仓库。
- 修改 registry、List 或生成器后，运行权威生成命令并检查生成差异；不要批量手改生成页面或 JSON。
- 新增或修改页面时沿用共享 CSS 变量、边框、字体、间距、顶栏和控件样式。
- 主页与 List 页面必须保持一致：同一 pack 在两处的卡片结构、徽章、名称字体和交互行为必须相同；修改任一处时同步另一处。
- 主页类 pack 链接使用新标签页及 `noopener noreferrer`；搜索只在提交后渲染，清空输入时立即恢复全部结果。
- 修改 SBI 匹配器或指纹数据时同步版本常量和 HTML cache buster，并运行 `python test_sbi.py`。
- 站点经 Cloudflare 缓存（静态资源 4 小时）：修改 `style.css` 或共享 JS 后，必须统一 bump 全站 HTML 引用的 `?v=` 版本号（含重新生成 `p/*`），否则线上长时间不生效。
- 不得根据扫描结果直接删除或替换远端包；必须执行完整内容判定、人工保留决策和两阶段清理。
- pack/List 名新增非拉丁字符后，运行 `python scripts/subset-font.py` 更新字体子集（同时生成名称像素字体与 HarmonyOS Sans UI 字体）。

## 按需读取索引

- 修改远端仓库分配、registry 或下载链接时，读 `.docs/PACK_STORAGE.md`。
- 扫描、上传、判重或替换材质包时，读 `.docs/PACK_INGESTION.md` 和 `.docs/PACK_CONTENT_IDENTITY.md`。
- 修改页面、浏览器交互、状态、样式或生成流程时，读 `.docs/frontend/index.md`。
- 修改 SBI 算法、权重、分片或版本时，读 `.docs/SBI_SEARCH.md`。
- 维护 Overlay/Conquest 分类时，读 `.docs/OVERLAY_DETECTION_PLAN.md`。
- 查阅旧 Trellis 工作记录时，读 `.docs/archive/trellis-tasks/INDEX.md`。

## 优先级声明

1. 用户当前明确指令。
2. 更近目录的 `AGENTS.md`。
3. 本文件。
4. 本文件路由到的 `.docs/*.md`。
