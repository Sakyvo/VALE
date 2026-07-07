# VALE - Resource Pack Storage Architecture

## 仓库结构

- **主站** `Sakyvo/Sakyvo.github.io` — 仅存放网站前后端代码、缩略图、数据索引
- **材质包库** `Sakyvo/packs-001` ~ `packs-NNN` — 存放 .zip 材质包文件

## 材质包仓库规则

- 每个仓库存储上限 **5GB**
- 材质包按**修改日期升序**依次填充仓库
- 仓库满时，根目录创建 `!  FULL  !` 标记文件
- 新包上传到**第一个没有 FULL 标记**的仓库
- 所有仓库用完时，自动创建新仓库（编号递增）
- `K:\Projects\website\.vale-pack-upload` 只能作为上传过程中的临时克隆/中转目录，不得长期保留材质包或 `packs-NNN` 本地副本
- 材质包 `.zip` 只应长期存在于对应的远端 GitHub 仓库 `Sakyvo/packs-NNN`；本地上传完成并推送后应清理临时克隆/缓存
- 远端现有 `packs-NNN` 容量不足时，在 GitHub 远端新建下一个编号仓库继续上传，不要用本地目录扩容或长期存储

## Git 工作流

- **默认规则**：每次任务执行前 `git pull`，完成后 `git push`
- **特例**：用户可明示跳过 pull 或 push，该要求仅对下一次任务生效

## 禁止事项

- 主仓库下**不得**出现任何材质包 `.zip` 文件
- 主仓库下**不得**存在 `resourcepacks/` 目录
- 不得把 `K:\Projects\website\.vale-pack-upload` 当作本地材质包仓库；若发现其中有上传后残留的材质包，应确认远端已推送后清理
- 若发现上述文件/目录，应提醒用户清理而非提交

## 前端交互规则

- **风格统一**：新增或修改任何页面/组件时，必须沿用站内既有视觉语言（CSS 变量配色、2px 边框、字体、间距、顶栏高度、按钮样式等）；同类元素跨页面保持一致，不得引入孤立的新风格。
- 主页类页面（Explore 主页、List 首页、List 详情页等）打开 pack 详情时必须使用新标签页：pack 链接加 `target="_blank"` 和 `rel="noopener noreferrer"`。
- 主页类搜索框不得在输入过程中立即重渲染大结果集；应在用户点击搜索按钮或按 Enter 后提交查询并显示结果。
- 若主页类搜索框内容被完全清空，应自动重置已提交查询并恢复全部显示。

## 以图搜图 (SBI)

SBI (Search by Image) 允许用户上传 Minecraft PvP 截图，通过指纹比对识别所使用的材质包。

### 搜索流程

1. 用户上传截图 → `extractHotbarSlots` 提取 hotbar slot 特征
2. `inferDisplaySlotTypes` 推断每个 slot 的物品类型（DS/EP/HL/SK 等）
3. `matchPacks` 遍历指纹库，加权比对每个 slot 与每个包的对应纹理
4. 按 mix 权重合并 slot/hud/widget 分项得分，输出排名

### 指纹系统

指纹由 `scripts/generate-sbi-data.js` 从 `thumbnails/` 生成，输出到 `data/sbi-fp/` 分片目录。

每个纹理指纹包含：`dhash`（感知哈希）、`hist`（直方图）、`moments`（RGB 矩）、`edge`（边缘强度）、`sig`（签名：覆盖率/亮度/颜色分布/形状）。

### 评分权重

```
Type:  DS=8.0  EP=8.2  HL=4.8  SK/GC=0.45
HUD:   HP=6.4  Hun=5.4  Arm=5.2
Mix:   slot=0.44  hud=0.36  widget=0.20
```

DS 和 EP 是区分度最高的类型（权重 8.0+），HL 次之；SK/GC 权重极低。

### 指纹分片

指纹按类型拆分为独立 JSON 文件，搜索时按需加载：
- `diamond_sword.json`、`ender_pearl.json`、`splash_potion.json` — 高权重，必加载
- `food.json`（steak+golden_carrot）— 低权重，按需
- `widget.json`、`health.json`、`hunger.json`、`armor.json` — HUD/Widget

### 版本控制

- `SBI_FINGERPRINT_VERSION`：指纹版本号，变更时客户端自动刷新缓存
- 指纹文件变更后**必须** bump 版本号 + `sbi/index.html` cache buster

### 回归测试

- `python test_sbi.py`：headless Edge + CDP，9 张测试图，验证 #1 命中
- 修改 `sbi.js` 或指纹数据后**必须**跑测试确认无回归

## 关键文件

| 文件 | 用途 |
|------|------|
| `data/pack-registry.json` | 每个包所在仓库的映射表 |
| `scripts/extract-textures.js` | 提取材质缩略图 |
| `scripts/generate-index.js` | 生成索引（自动读取 registry 生成下载链接） |
| `scripts/generate-sbi-data.js` | 生成 SBI 指纹数据 |
| `assets/js/sbi.js` | SBI 客户端搜索逻辑 |

## pack-registry.json 格式

```json
{
  "包名.zip": {
    "repo": "packs-001",
    "repoNum": 1,
    "size": 12345678
  }
}
```

## 下载链接生成规则

`generate-index.js` 根据 `pack-registry.json` 自动生成：
- GitHub: `https://raw.githubusercontent.com/Sakyvo/{repo}/main/resourcepacks/{name}.zip`
- Mirror: `https://ghfast.top/https://raw.githubusercontent.com/Sakyvo/{repo}/main/resourcepacks/{name}.zip`

若 registry 中无记录，回退到主站路径。

## 注意事项

- 上传脚本会自动更新 `pack-registry.json`
- 每次添加新包后必须重新运行 `generate-index.js` 更新下载链接
- 本地**不需要**保留 packs-NNN 仓库文件夹；上传脚本可按需临时克隆到 `.vale-pack-upload`，但完成远端 push 后应删除这些临时克隆
- `fileSize` 从 `pack-registry.json` 的 `size` 字段读取（字节）
- Windows 文件名大小写不敏感，注意 git 大小写冲突
- 包名中的特殊字符（§、!、#）在 URL 中需要 encodeURIComponent
