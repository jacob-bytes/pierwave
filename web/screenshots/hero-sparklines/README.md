# Hero 迷你图截图 / Hero sparkline screenshots

每次改 hero 的三张迷你图都重跑这个目录，不要只信单元测试：几何对不代表
布局、断线、空态和主题都对。

Re-run this directory whenever the hero charts change. Geometry tests passing
does not mean the layout, gaps, empty state and themes are right.

## 怎么跑 / How to run

```bash
cd web
NPM_CONFIG_CACHE=/Users/jlthzy/Documents/mmrust/.npm-cache npm run build
npx vite preview --port 4173 --strictPort
# 另开一个终端 / in another shell
BASE_URL=http://localhost:4173 node screenshots/hero-sparklines/shots.mjs
```

（`BASE_URL` 用 `localhost`；本机 `vite preview` 只监听 localhost。）

脚本用 Playwright 拦截 `GET /api/v1/public/status` 返回 `fixtures.mjs`，不启动后端、
不写库。产物是 24 张 PNG + `report.json`（布局实测、路径段数、tooltip 读数）。

## 五种数据形态 / Five data shapes

| 状态 | `series` | `buckets_24h` | 看到什么 / What it shows |
|---|---|---|---|
| `empty` | 缺失（旧后端 / 新部署） | 全 null | 三张图都是虚线基线 +「数据收集中」，**没有一条 0 平线** |
| `legacy` | 缺失（旧后端） | 完整 | 延迟 / 速率进空态，可用率图仍由桶现算 —— 回退路径 |
| `partial` | 有，含 null 缺口 | 完整，16–18 点全缺 | 三张图都抬笔断线，不跨 null 连线 |
| `full` | 完整 12 点 | 完整（10–11 点一次小事故） | 三张完整折线 |
| `zero` | 全部为 0（不是 null） | 全 0 | 三张图都画线；速率贴底，tooltip 读 `0 B/s` |

本轮同时删掉「24h 可用率」下方的水平进度条（折线已经表达同一段历史），
标签从「平均 24h 可用率」改为「24h 可用率」/「24h uptime」；数值仍是平均值。
另外两张图没有任何进度条类装饰。

`zero` 和 `empty` 放在一起就是「0 与 null 的区分证据」：

- `empty-*`：`lineCount = 0`、虚线基线存在、aria-label 是「数据收集中」；
- `zero-*`：`lineCount >= 1`，速率图所有 y = 47（viewBox 高 48，0 贴底），
  hover 读数是 `0 B/s`，KPI 也写 `0 B/s`；
- 两者在 `report.json` 里各自有完整数字，不靠肉眼。

## 布局实测 / Measured layout

同一份 8 台机器 fixture。上一版是 48 / 40px 的图；本轮按所有者反馈收到
24 / 20px，同时删掉可用率进度条、标签改为「24h 可用率」/「24h uptime」。

| | 上一版 1440 | 本轮 1440 | 上一版 390 | 本轮 390 |
|---|---|---|---|---|
| KPI 区宽 | 1046–1106 | **1046–1106**（视结论长度） | 326 | 326 |
| 单列宽 | 306–344 | **306–344**（三列差 ≤0.1px） | 326（整行） | 326（整行） |
| 迷你图高 | 48 | **24** | 40 | **20** |
| hero 高 | 213 | **171** | 383–405 | **347–369** |
| 横向溢出 | 无 | 无 | 无 | 无 |

参考：加迷你图之前 hero 是 155（1440）/ 227（390）；上一版 48px 的图把它撑到
213 / 405；本轮 24px 图 + 收紧间距 + 删除进度条后回到 171 / 369，1440 只比
「还没有图」时高 16px。768 / 1024 / 1280 也做过冒烟：无横向溢出，列宽分别是
213 / 199 / 284px。

## 文件 / Files

- `fixtures.mjs`：五种状态的数据，`buckets_24h` 与 `uptime_24h` 同源。
- `shots.mjs`：Playwright 截图 + 断言（溢出、列宽、断线段数、0 贴底、tooltip 不裁切）。
- `report.json`：最近一次的实测结果。
- `{state}-{theme}-{width}.png`：5 状态 × 亮/暗 × 1440/390（20 张）。
- `full-dark-1440-en.png` / `empty-dark-1440-en.png`：英文完整数据 / 空态。
- `full-dark-1440-hover.png` / `zero-dark-1440-hover.png`：tooltip 读数。

本目录不包含旧版 hero 的截图；`../status-hero/` 是 `b925ba2` 之前的验收产物，
其断言仍写着旧文案「在线率」，仅作历史参考。

---

## English summary

This directory is the visual regression bed for the three hero sparklines:
average latency, 24h uptime, and current total rate. The uptime KPI no longer
renders a progress bar (the line already carries the history), and its label no
longer says “average” — the number still is the average.

**Run it** after `npm run build` plus `npx vite preview --port 4173`, with
`BASE_URL=http://localhost:4173 node screenshots/hero-sparklines/shots.mjs`.
Playwright intercepts `GET /api/v1/public/status`; no backend is started.

**States.** `empty` (no `series`, no buckets) renders three dashed baselines
labelled “Collecting data”, never a flat zero line. `legacy` (old backend: no
`series`, buckets present) proves the fallback: latency and rate show the empty
state while uptime is still derived from `buckets_24h`. `partial` (null gaps in
`series` and three missing bucket hours) breaks every line at the gaps.
`full` draws all three lines. `zero` (all values are 0, not null) draws all
three lines and the rate chart sits flat on the baseline; its tooltip reads
`0 B/s`.

**Null vs 0 evidence.** `empty` charts have `lineCount = 0` and one dashed
baseline each; `zero` charts have `lineCount >= 1`, every rate y equals 47 in a
48-high viewBox, and hovering reads `0 B/s`. Both are recorded numerically in
`report.json`.

**Measured layout** (same 8-server fixture): charts are now 24 px tall on
desktop and 20 px below `md`, with 1 px lines and a fainter area gradient. The
hero is 171 px at 1440 (was 213) and 347–369 px at 390 (was 383–405); the KPI
columns stay 306–344 px wide at 1440 and full-width 326 px rows at 390, with no
horizontal overflow (also checked at 768 / 1024 / 1280). The 1440 hero is only
16 px taller than the pre-chart layout (155 px).

Old `../status-hero/` screenshots predate this layout and their assertions still
use the retired “online rate” label; they are kept as history, not as the
current baseline.
