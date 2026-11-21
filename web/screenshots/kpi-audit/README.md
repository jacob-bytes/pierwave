# KPI 极值审计 / KPI extreme-value audit

公开状态页 hero 三个 KPI（平均延迟、24h 可用率、当前总速率）的极值、挤压、
字号 / 基线 / 对比度、tooltip 与键盘可达性审计。**只读审计**：不修改 `web/src`、
不启动后端、不写库；所有数据由 Playwright 拦截 `GET /api/v1/public/status` 注入。

## 运行 / Run

```bash
# 1) 构建并起预览（仓库约定：Web 构建用 make）
make web-build
(cd web && npx vite preview --port 4173 --strictPort)

# 2) 全量矩阵（33 fixture × 1440/390 × 亮/暗 × 中/英）
node web/screenshots/kpi-audit/audit.mjs

# 3) 容器挤压（1280/1100/1024/768，9 个代表 fixture）
KPI_MODE=squeeze KPI_OUT=squeeze node web/screenshots/kpi-audit/audit.mjs

# 4) A/B 时序 / 量级场景（见下）
KPI_FILTER=temporal-spike-rate,temporal-spike-latency,temporal-spike-uptime,dual-gap-rx-high,dual-gap-tx-high \
  KPI_OUT=temporal node web/screenshots/kpi-audit/audit.mjs

# 5) 0.001 B/s、1024^4-1、双向 1024 GB/s 等边界
KPI_FILTER=rate-1024-both KPI_OUT=extra node web/screenshots/kpi-audit/audit.mjs
KPI_FILTER=latency-null,uptime-null,rate-both-missing,rate-rx-missing KPI_OUT=nulls \
  node web/screenshots/kpi-audit/audit.mjs
KPI_FILTER=series-all-null,series-partial-null,series-5-points,series-40-points,series-negative,buckets-5,buckets-40,buckets-null \
  KPI_OUT=series node web/screenshots/kpi-audit/audit.mjs

# 6) 曲线像素行分析（A/B 截图，2× DPR）
python3 web/screenshots/kpi-audit/pixel-rows.py
```

Playwright 从仓库内 `.npm-cache/_npx/*/node_modules/playwright` 加载；浏览器用本机
Google Chrome。可用 `BASE_URL` / `PLAYWRIGHT_MODULE` / `CHROME_PATH` 覆盖。

## 目录 / Layout

| 文件 | 内容 |
|---|---|
| `fixtures.mjs` | 全部 fixture（33 + A/B + 边界），形状与公开 API 一致 |
| `audit.mjs` | 主脚本：拦截、测量、截图、tooltip / 键盘探针 |
| `pixel-rows.py` | 把 `chart-*.png` 按 stroke 像素颜色逐行统计，输出曲线像素行 |
| `report.json` | 主矩阵原始测量（264 jobs） |
| `squeeze.json` | 1280/1100/1024/768 挤压测量（144 jobs） |
| `temporal.json` | A/B 时序 / 量级场景（40 jobs） |
| `extra.json` | 双向 1024 GB/s 边界（8 jobs） |
| `nulls.json` | null 态补测（32 jobs，含 latency null 修正） |
| `series.json` | series / buckets 异常补测（64 jobs，含曲线几何） |
| `pixel-rows.json` | A/B 两张图的像素行 / 线宽 / 贴底数据 |
| `report.md` | 审计结论（阻断级、一致性、极值、规则、Top 3） |
| `shots/` | 297 张截图；`temporal-spike-*`、`dual-gap-*`、`chart-*` 是 A/B 证据 |

## A/B 场景

* `temporal-spike-rate`：`rx = [2 MB/s ×11, 2000 MB/s]`，`tx = null`（避免上行线盖住小值）；
* `temporal-spike-latency`：`[28 ms ×11, 9000 ms]`；
* `temporal-spike-uptime`：24 个小时桶 `[1.0 ×23, 0.0]`，`uptime_24h = 23/24`；
* `dual-gap-rx-high`：`rx = 2000 MB/s, tx = 2 MB/s`（1000 倍差）；
* `dual-gap-tx-high`：反过来。

曲线几何从 SVG path 的 viewBox 坐标换算到 CSS px；像素行从 2× DPR 的
`chart-*.png` 按实际 stroke 颜色统计。两者都记录在 `temporal.json` 与
`pixel-rows.json`，可互证。

## 约束

* 截图与测量脚本只放在本目录；`web/src` 无改动；
* 未 commit、未打 tag、未发版；
* 数据由 fixture 注入，不代表任何真实节点。
