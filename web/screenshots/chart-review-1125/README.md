# 概览图表 review 修复截图 / Overview chart review screenshots

这组截图只覆盖本轮前端 review 里属于图表 lane 的修复，用 Playwright 拦截
`/api/v1/**` 起 dist 静态页，不连主控、不写库。

This directory covers only the chart-lane fixes from the frontend review. It
serves `web/dist` and mocks `/api/v1/**` in Playwright, so it needs no controller
and no database.

## 怎么跑 / How to run

```bash
cd web
npm run build
node screenshots/chart-review-1125/shots.mjs
```

产物：36 张 PNG + `report.json`（刻度文本、网格线属性、tooltip 计算样式、
图例计数、390 横向溢出）。**全部断言通过才会打印 `assertions: all passed`。**

Output: 36 PNGs plus `report.json` (tick labels, grid attributes, tooltip
computed styles, legend counts, 390px overflow). The script prints
`assertions: all passed` only when every check succeeds.

## 实测结果 / Measured results

| 图表 / Chart | x 轴 / x ticks | y 轴 / y ticks | 网格 / Grid |
|---|---|---|---|
| 在线率趋势 Uptime trend | `11/19 … 11/25`，7 个日刻度不重复 / 7 unique daily ticks | `0/25/50/75/100%` | 横向点线 5 条，竖向 0 条 / 5 horizontal dotted, 0 vertical |
| 当前资源（负载）Current resources (load) | `11/19 … 11/25` | **`0/5/10/15/20/25%`**（yMax=25 跟随数据） | 横向 6，竖向 0 / 6 horizontal, 0 vertical |
| 流量趋势 Traffic | `11/16 … 11/22` | **`0 / 20 GB / 40 GB / 60 GB`**（不是 46.6 GB） | 横向 2，竖向 0 / 2 horizontal, 0 vertical |
| 协议趋势 Protocol | `11/16 … 11/22` | **`0 / 10 GB / 20 GB / 30 GB / 40 GB`**（不是 93.1 GB） | 横向 5，竖向 0 / 5 horizontal, 0 vertical |
| 链路时延趋势 Chain trend | `00:00 … 21:45`（末位是真实样本 / last real sample） | `0/15/30/45/60ms` | 横向 5 + 竖向 7（保留）/ 5 horizontal + 7 vertical (kept) |

- 网格线统一为 `stroke=var(--border)`、`stroke-opacity=0.6`、`stroke-dasharray=2 4`；
  `report.json` 对每张图的每条 gridline 都做了断言。链路迷你图（自绘 SVG）的
  竖向时间线也用同一组常量，`vector-effect: non-scaling-stroke` 保证点线在
  任意缩放下一致。
- 7 个 tooltip（在线率 / 资源 / 流量 / 协议 / 链路趋势 / 逐段 / 迷你图）实测
  内边距 `12px`、正文 `12px`、`font-variant-numeric: tabular-nums`、
  `bg-popover` 背景、`rounded-md` 圆角、`shadow-lg/40` 阴影；
  截图见 `tooltip-*.png`，数值见 `report.json.tooltips`。
- 图例折叠：9 条链时主行 4 项 + `5 条暂无样本 ⌄`（`aria-expanded=false`）；
  点开后 `aria-expanded=true`、列出来全部 5 条（`report.json.legends`）。
- 1440 / 390 × 亮 / 暗 全部 `scrollWidth == innerWidth`，无横向溢出。

English summary: grid lines are one shared dotted horizontal style
(`var(--border)` at 0.6 opacity, `2 4` dash); vertical grid lines remain only on
the chain-latency trend (plus the self-drawn chain sparkline timeline). All seven
tooltips share one shell (12px padding, 12px body, 11px secondary, tabular
numerals). The chain legend folds 5 of 9 sample-less chains behind a weak
`5 条暂无样本` toggle, expanded 5/5. No horizontal overflow at 1440 or 390 in
either theme.

## 文件 / Files

- `shots.mjs`：数据 fixture + API mock + 截图 + 断言 / fixtures, mocks, shots, assertions.
- `report.json`：最近一次实测 / latest measurements.
- `uptime-*` / `resource-load-*` / `traffic-*` / `protocol-*` / `chain-trend-*`：
  1440/390 × dark/light 静态截图 / static shots.
- `tooltip-*`：7 类 tooltip 特写（1440/390 dark）/ tooltip close-ups.
- `chain-legend-expanded-*`：折叠展开后（1440/390 dark）/ expanded legend.

## 备注 / Notes

- 逐段图与整体迷你图在链路详情弹窗里，截图通过深链接
  `?view=chain&chain=chain-hk-tokyo` 打开弹窗后抓取。
- 图表 lane 之外的成本页 tooltip 没有迁移（另一条 lane 负责），
  `ChartTooltipShell` 已导出，可直接复用。
- 场景数据是 fixture（6 台服务器 / 9 条链 / 7 天流量），不依赖真实后端。
