# 字号下限 11px：改前 / 改后证据

> **拓扑截图说明 / Topology shots notice**：拓扑截图自本次起由 `web/screenshots/chain-flow/` 取代；本目录的旧拓扑图仅作历史对照。 / From this change on, topology screenshots are superseded by `web/screenshots/chain-flow/`; the old topology shots here are historical references only.


> 第二轮把「需要被读的次要数据」提到 13px，见 [ROUND2.md](ROUND2.md)。
> Round 2 raises targeted secondary data to 13px; see [ROUND2.md](ROUND2.md).

**中文**：本轮只改 `web/`，给前端立一个可读的字号下限，并让辅助信息更舒适。
改动前后的截图、机读报告和复现脚本都在本目录；没有提交。

**English**: This pass only touches `web/`. It establishes a readable type floor
for the whole front end and makes supporting text more comfortable. Before/after
screenshots, machine-readable reports and repro scripts live here; nothing is
committed.

## 改了什么 / What changed

- 所有 `text-[8px]` / `text-[9px]` / `text-[10px]` → `text-[11px]`（25 个
  `web/src` 文件中 134 处，含链路页面与其余页面）；recharts
  `fontSize: 9|10` → `fontSize: 11`（10 处）。
- `.type-micro` 从 11.5px → **12px**，作为「常用辅助信息」的语义档位。
- `docs/DESIGN.md` 新增中英「三、字号 / Typography」规则：11 / 12 / 13 / 14
  四档，层级靠颜色与字重。
- 新增源码级防回归测试 `web/src/components/typeFloor.test.mjs`：禁止
  `text-[8px]` / `text-[9px]` / `text-[10px]` 与 `fontSize: 9|10`（含小数小于
  11px），没有白名单。
- 放大后仅做必需的最小宽度 / 标签密度调整：
  - 拓扑连接线最小宽度 80→88px、不可测量段 104→112px；
  - 热力图移动端名称列 60→80px，日期表头不再截断；
  - 链路详情 390 下时间轴隔一个刻度显示，避免 11px 的 `20:00` 与 `23:15`
    重叠 4px。

- Replaced every `text-[8px]` / `text-[9px]` / `text-[10px]` with
  `text-[11px]` across 26 files, and recharts `fontSize: 9|10` with `11`.
- `.type-micro` now **12px** for common supporting text.
- Added the bilingual typography rules to `docs/DESIGN.md`.
- Added `web/src/components/typeFloor.test.mjs`, a source-level guard that
  rejects the old sizes with no allow-list.
- Only necessary width/density tweaks after enlarging: topology connector
  minimum widths 80→88px and 104→112px, the mobile heatmap name column
  60→80px with non-clipping date headers, and every-other tick on the 390
  detail time axis so 11px `20:00` / `23:15` no longer overlap by 4px.

## 复现 / Reproduce

```bash
# 1) master（临时预览库，admin/devpass）
cp data/preview.db data/font-floor.db
# 把样本时间平移到当前窗口（见下方 SQL）
PIERWAVE_ADMIN_PASSWORD=devpass PIERWAVE_ADDR=127.0.0.1:8787 \
PIERWAVE_DB='sqlite://data/font-floor.db?mode=rwc' target/debug/pierwave-master

# 2) vite dev
cd web && npm run dev

# 3) 截图 / 巡检
node web/screenshots/font-floor/shots.mjs before
node web/screenshots/font-floor/shots.mjs after
node web/screenshots/font-floor/probe.mjs
node web/screenshots/font-floor/tooltips.mjs
python3 web/screenshots/font-floor/compare.py
```

样本平移 SQL（只改临时库）：

```sql
UPDATE forward_latency_samples SET ts = ts + ((strftime('%s','now') - 120) - (SELECT max(ts) FROM forward_latency_samples));
UPDATE forward_probe_samples   SET ts = ts + ((strftime('%s','now') - 120) - (SELECT max(ts) FROM forward_probe_samples));
UPDATE server_samples          SET ts = ts + ((strftime('%s','now') - 120) - (SELECT max(ts) FROM server_samples));
UPDATE forward_status          SET updated_at = updated_at + ((strftime('%s','now') - 300) - (SELECT max(updated_at) FROM forward_status));
```

## 文件 / Files

- `before/`：改动前截图（9 个视图 × 1440/390 × 暗/亮；390 多为视口截图，
  公开状态页随文档高度截全页）。
- `after/`：改动后同一批截图，外加 `overview-server-heatmap-*` 与 tooltip 局部图。
- `compare/`：`compare-{view}-{width}-{theme}.png` 左右并排对比（BEFORE | AFTER）。
- `report-before.json` / `report-after.json`：每页最小字号、11/12px 计数、
  `document.scrollWidth - innerWidth`。
- `probe-report.json`：64 项检查（全部路由 + 设置各 tab + `/me` + 公开状态
  + 登录 + 热力图 + 链路弹窗刻度重叠）。
- `tooltip-report.json`：链路趋势 / 逐段趋势 / 整体时延 / 热力图 tooltip 的
  字号与溢出。
- `shots.mjs` / `probe.mjs` / `tooltips.mjs` / `compare.py`：复现脚本。

## 结果 / Results

### 最小字号 / Minimum font size（1440 暗色，改动前 → 改动后）

| 视图 / View | Before | After |
|---|---:|---:|
| 概览 · 资源状态 / overview server | 9px | **11px** |
| 概览 · 流量趋势 / traffic | 9px | **11px** |
| 概览 · 成本开销 / cost | 8px | **11px** |
| 概览 · 链路时延 / chain | 9px | **11px** |
| 服务器列表 / servers | 11.5px | **12px** |
| 转发列表 / forwards | 11.5px | **12px** |
| 公开状态页 / status | 11px | **12px** |
| 设置 / settings | 11.5px | **12px** |
| 链路详情弹窗 / chain detail | 9px | **11px** |

`.type-micro` 在所有页面实测 12px；服务器 / 转发 / 设置页当前最小文字就是 12px。

随机抽查 5 个页面的辅助信息 / Spot-check of supporting text on five pages:

| 页面 / Page | 抽查元素 / Sample | 实测 / Measured |
|---|---|---:|
| 概览 · 链路时延 / overview chain | `[data-chain-sample]`（最近样本时间） | 12px |
| 服务器 / servers | `.type-micro`（元信息） | 12px |
| 转发 / forwards | `.type-micro`（规格 / 端口 meta） | 12px |
| 公开状态 / status | `.type-micro`（延迟 / 在线天数） | 12px |
| 设置 / settings | `.type-micro`（说明 / 版本） | 12px |

**English**: `.type-micro` measures 12px everywhere. On servers, forwards and
settings the smallest visible text is 12px. The overview tabs now bottom out at
11px (chart ticks and dense labels); body copy stays 14px.

### 全站巡检 / Full-site probe

- 64 项检查，`below 11px = 0`，`390 overflowX = 0`。
- 登录、`/me`、设置 7 个 tab、公开状态与详情、节点 / 用户 / 套餐 / 日志都在其中。
- 12/12 tooltip 检查（链路趋势 / 逐段趋势 / 整体时延 / 热力图 / 公开状态
  迷你图 / 可用率曲线）：字号 11–12px，`inViewport = true`，无
  `scrollWidth > clientWidth`。

- 64 checks: zero text below 11px, zero horizontal overflow at 390.
- All tooltips fit at 11–12px.

### 拓扑标注 / Topology labels

390 与 1440、暗/亮四组的注入数据（`128.5 ms ≈`、`不可测量`、
`（引擎不支持探测）`）实测：

| 标注 / Label | 字号 | clientWidth | scrollWidth | 截断 |
|---|---:|---:|---:|---:|
| `128.5 ms ≈` | 11px | 66px | 66px | 否 / no |
| `不可测量` | 11px | 44px | 44px | 否 / no |
| `（引擎不支持探测）` | 11px | 99px | 99px | 否 / no |

连接线最小宽度 88 / 112px 后，1440 仍铺满、390 仍按原设计横向滚动。

### 表格 / Table regression

- 桌面端链路行不出现列名（`P50` / `窗口丢包` 只出现在表头），390 才出现
  行内小标签；实测 `rowText` 无重复列名。
- 390 下 64 个页面 `scrollWidth ≤ innerWidth`；表格超宽时仍是**表格容器内**
  横向滚动（服务器表、转发表、日志表），不把页面撑宽。

- Desktop chain rows still contain no column labels; the mobile row labels stay
  mobile-only. Wide tables scroll inside their own container, never the page.

## 命令结果 / Command results

```text
npm test            1224 pass / 0 fail        (baseline 1221 + 3 new guard tests)
npx tsc -b --noEmit exit 0
npm run build       built in 385ms, exit 0
npm run lint        0 errors (63 pre-existing warnings)
```

源码扫描 / Source scan:

```text
text-[8px] / [9px] / [10px]   0
fontSize: 9 / 10              0
.type-micro                   12px
```

## 已知边界 / Known boundaries

- 11px 仍用于图表刻度、链路拓扑标注、密集数字标签；这是全站下限。第二轮
  只把明确列出的「需要被读的次要数据」提到 13px，没有把整类文字都提升。
- `docs/DESIGN.md` 的 13px 档位已在第二轮落到列表第二行、表格非主列、详情
  字段值与空态 / 错误态正文；图表刻度、图例、Badge 内部与表头仍保持 11–12px。
- 服务器表在 1440 下本来就有表内横向滚动（「当前速率」列被 sticky 操作列
  遮住一部分），改动前 `before/servers-1440-dark.png` 已存在；本轮没有改
  表格结构。
- 热力图 390 的左侧名称列从 60px 调到 80px 是放大字号的必要宽度调整；
  桌面 120px 未变。

- 11px remains for chart ticks, topology labels and dense numeric labels. Round 2
  adds 13px for list second lines, non-primary table data, detail field values
  and empty/error body copy; chart ticks, legends, badge text and table headers
  stay at 11–12px.
- The 390 heatmap name column grew from 60px to 80px only because 11px names
  no longer fit; the 120px desktop column is unchanged.
