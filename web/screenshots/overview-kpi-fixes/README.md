# 概览 KPI / 子页 / 热力图 / 流量榜截图

> 本轮前端 review 第 5 / 8 / 9 / 11 条的复现截图与断言。
> Screenshots and assertions for review items 5 / 8 / 9 / 11.

## 复现 / Reproduce

```bash
cd web
npm run build
node screenshots/overview-kpi-fixes/shots.mjs
```

脚本会启动一个只读 `web/dist` 的静态服务，并在 Playwright 里 mock `/api/v1/**`；
不需要主控、数据库或种子数据。Playwright 复用仓库 `.npm-cache/_npx` 里的缓存，
不新增依赖。结果写入 `report.json`，出现断言失败时脚本退出码为 1。

The script serves `web/dist` and mocks `/api/v1/**` inside Playwright. No
controller, database or seed data is needed; it reuses the Playwright copy in the
repo's `.npm-cache/_npx`, so no project dependency is added. Assertions live in
`report.json`; the script exits non-zero on failure.

## 截图 / Shots

| 文件 / File | 内容 / Contents |
|---|---|
| `kpi-bars-{dark,light}-{1440,390}.png` | 四个 KPI 条并排对照（高度一致）/ four KPI bars side by side |
| `kpi-bar-{server,cost,chain,templates}-{theme}-{width}.png` | 单个 KPI 条近景 / individual KPI bar |
| `kpi-{server,cost,chain,templates}-{theme}-{width}.png` | 整页上下文 / full-page context |
| `subtabs-{theme}-{width}.png` | 主 tab + 筛选 + 下划线子页 / main tabs, filter and underline sub-tabs |
| `heatmap-collapsed-{1440,390}.png` | 6 台全程离线折叠成一行 / six fully-offline rows collapsed |
| `heatmap-expanded-{1440,390}.png` | 点击聚合行后逐行展开 / expanded rows |
| `heatmap-tooltip-1440.png` | 聚合行 hover 显示这 N 台名称 / names tooltip |
| `traffic-leaderboard-{1440,390}.png` | 流量榜「负载」标注 / load label in the traffic leaderboard |

## 断言 / Assertions

- **KPI 栅格**：四组 KPI 都走 `ChainKpiGrid` / `ChainKpiCell`；`grid-template-columns`
  在 1440 为 4 列、390 为 2 列；数字 28px、副行 13px、标签 12px。
- **KPI 高度**：1440 暗/亮均为 `[136, 136, 136, 136]`；390 暗/亮均为
  `[329, 329, 329, 329]`（三个指标的视图首格 `col-span-2`，与四格视图同高）。
- **成本页 390**：总开销占满第一行，本年度 / 未来 12 个月在第二行；金额换行时
  由统一的最小高度兜住，不把某个 tab 撑高。
- **子页**：12px；选中 `color: var(--primary)` + `::after` 2px `var(--primary)`，
  未选中 `var(--muted-foreground)`，无实心胶囊背景；位置仍在筛选器右侧。
- **热力图**：10 台中 5 台整段离线 + 1 台无采样 → 折叠后 4 个服务器行 + 1 个
  聚合行，聚合行文案「6 台全程离线」、tooltip 列出 6 个名字；聚合行没有
  `data-heatmap-cell`，折叠的 6 台不进入键盘遍历；展开后恢复 10 行、10×168 个格子。
- **流量榜**：1440 与 390 的服务器行都含「负载」字样（390 仍为「负载 0.42」）。

All numeric results are in `report.json` (`errors: []` means every assertion passed).
