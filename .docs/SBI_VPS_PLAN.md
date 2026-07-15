# SBI VPS 扩展规划

> 未来选项：当包数 > 3,000 或客户端方案性能不足时启用

## 架构总览

```
用户浏览器                      VPS (SBI API)                    GitHub
┌──────────┐    POST /sbi/search    ┌──────────────┐    原始数据    ┌─────────────┐
│  截图上传  │ ──────────────────→  │  Node.js API  │ ←────────── │ packs-NNN   │
│  (FormData)│                      │  (Fastify)    │   生成时拉取  │ 材质包 zip  │
│            │ ←──────────────────  │              │              │             │
│  结果列表  │    JSON results      │  FAISS 索引   │              └─────────────┘
│  (~2KB)   │                      │  (内存/SSD)   │
└──────────┘                      └──────────────┘
                                     ↑
                              生成脚本定时跑
                              (generate-sbi-data.js)
```

- **VPS 只跑 SBI API**，网站其余部分仍部署 GitHub Pages
- **材质包 zip 文件仍在 GitHub**，VPS 不存储
- 指纹数据在 VPS 内存或 SQLite，生成脚本可定时从 GitHub 拉取新包更新

## 最低配置

| 项目 | 需求 | 说明 |
|------|------|------|
| CPU | 1 vCPU | 比对为单线程计算，无需多核 |
| RAM | 1 GB | 万包指纹 ~100MB + FAISS 索引 ~50MB + Node 基础 |
| SSD | 20 GB | 指纹 JSON + 索引 + 日志 |
| 带宽 | 1 TB/月 | 每次搜索上传 ~500KB 截图，返回 ~2KB 结果 |

### 推荐供应商

| 供应商 | 配置 | 月费 | 备注 |
|--------|------|------|------|
| Hetzner CX22 | 2 vCPU / 4GB / 40GB | €3.5 | 性价比最优 |
| RackNerd | 1 vCPU / 1GB / 25GB | $10/年 | 促销价，适合初期 |
| Vultr | 1 vCPU / 1GB / 25GB | $5 | 按小时计费，灵活 |

## API 设计

```
POST /sbi/search
Content-Type: multipart/form-data

字段:
  image: <截图文件>
  preset: "large" | "small" | "auto"

响应:
{
  "results": [
    { "rank": 1, "pack": "Tory_Eum3_v1_Revamp", "score": 0.96, ... },
    ...
  ],
  "slotTypes": ["DS", "EP", "HL", ...],
  "meta": { "preset": "large", "duration_ms": 47 }
}
```

## 算法路线

### 阶段 A：传统指纹 + 内存索引（快速上线）

- 将 `sbi.js` 的 `matchPacks` 逻辑移植到 Node.js
- 全量指纹加载到内存，搜索时 O(N) 遍历
- 万包预计 2-3s/次

### 阶段 B：嵌入向量 + FAISS（万包 < 50ms）

1. **嵌入生成**：将每个包的 DS/EP/HL/Widget/HUD 多维特征拼接为原始向量
   - DS: sig(21 维) + moments(6 维) + hist 摘要(8 维) = 35 维
   - EP: sig(21 维) + moments(6 维) = 27 维
   - Widget: 20 维
   - HUD: health(8) + hunger(8) + armor(8) = 24 维
   - 全包嵌入: ~110 维

2. **可选 PCA 降维**：110 → 64 维（损失 < 2% 方差）

3. **FAISS IVFFlat 索引**：
   - 训练：nlist = sqrt(N)，万包 ≈ 100 个 voronoi 单元
   - 搜索：nprobe = 10，查 10% 数据即可覆盖 top-50
   - 内存：万包 × 64 维 × 4 字节 = ~2.5 MB

4. **混合精排**：ANN 取 top-50 → 传统指纹逐包精排 → 最终排名

### 阶段 C（可选）：轻量 CNN 嵌入

- 用 MobileNetV3-Small 在 Minecraft 材质包数据上微调
- 输入 16×16 纹理，输出 64 维嵌入
- 精度提升主要来自：学到了非线性特征组合（如"深蓝底 + 圆形覆盖 = 末影珍珠"）
- 实现成本高，仅在阶段 B 精度不足时考虑

## 部署步骤

```bash
# 1. VPS 初始化
apt update && apt install -y nodejs npm
npm install -g pm2

# 2. 部署 SBI API
git clone <repo> /opt/sbi-api
cd /opt/sbi-api
npm install fastify multer faiss-node

# 3. 生成指纹索引
node scripts/generate-sbi-data.js     # 读取 thumbnails/
node scripts/build-faiss-index.js     # 构建 FAISS 索引（新增脚本）

# 4. 启动服务
pm2 start server.js --name sbi-api
pm2 save && pm2 startup

# 5. GitHub Pages 前端改造
# sbi.js 改为调用 VPS API 而非本地比对
# 指纹 JSON 不再需要下载到客户端
```

## 前端改造（启用 VPS 后）

- `sbi.js` 上传截图改为调用 `POST https://sbi-api.example.com/search`
- 移除客户端 `fetch('/data/sbi-fingerprints.json')` 和本地 `matchPacks` 调用
- 保留 `extractHotbarSlots` 用于预览/调试面板（可选）
- 进度条改为显示"搜索中..."而非"分析中..."

## 成本预估

| 阶段 | 月费 | 包数支持 | 搜索延迟 |
|------|------|---------|---------|
| A (传统+内存) | €3.5 | 5,000 | ~2s |
| B (嵌入+FAISS) | €3.5 | 50,000+ | <50ms |
| C (CNN嵌入) | €5-10 | 100,000+ | <30ms |

## 何时启用

- 包数 < 500：纯客户端（Phase 1-4 精简方案）
- 包数 500-3,000：客户端精简 + VPS 备选
- 包数 > 3,000：启用 VPS 方案
