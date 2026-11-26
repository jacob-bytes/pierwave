# 概览 KPI 入口与「更新于」验收 / Overview KPI entries and "Updated" header

**中文**：这个目录是概览顶部四张 KPI 卡变成入口、页头「刷新」改成
「更新于 HH:MM」的截图与断言产物。脚本用 Playwright 启动一个本地静态服务，
mock 掉概览需要的 API，不需要主控或数据库。

覆盖范围：

- 四卡异常 / 正常两态，1440 / 390，亮 / 暗；
- 异常数字的语义色（离线 / 阻断 destructive、降级 warning、0 值 muted），
  以及图标块无异常时中性、有异常时跟随语义色；
- 转发链卡与用户卡上的「全局」标；
- hover 的轻微背景 / ring 反馈，键盘 Enter 跳转；
- 四张卡的最终 URL：在线服务器（异常 → `/servers?only=abnormal`，
  正常 → `/?view=server`）、用户与套餐（`/users`）、转发链
  （阻断 → `?view=chain&section=chains&status=blocked`，降级 → `status=degraded`，
  都为 0 → 不带 status）、今日流量（`?view=traffic`）；
- 页头「更新于 HH:MM」：请求中 `aria-busy="true"`、不 `disabled`、
  焦点留在按钮上、连点只发一轮请求；
- 中英文案成对（`Updated HH:MM` / `Blocked … · degraded …`）。

**English**: This directory holds the screenshots and assertions for turning the
four overview KPI cards into links and replacing the page-header refresh button
with "Updated HH:MM". The script serves `web/dist` and mocks the overview APIs
with Playwright; no controller or database is needed.

Covers:

- abnormal / normal KPI rows at 1440 / 390 in both dark and light themes;
- semantic colours for anomaly counts (offline / blocked destructive,
  degraded warning, zero muted) and icon blocks that stay neutral without
  anomalies and follow the semantic colour when there is one;
- the "Global" tag on both the users and chains cards;
- subtle hover feedback and keyboard Enter navigation;
- final URLs for all four cards (abnormal online → `/servers?only=abnormal`,
  normal online → `/?view=server`; users → `/users`; chains blocked →
  `?view=chain&section=chains&status=blocked`, degraded → `status=degraded`,
  both 0 → no status; traffic → `?view=traffic`);
- "Updated HH:MM" with `aria-busy="true"`, never `disabled`, focus kept on the
  button and duplicate clicks collapsed into one request;
- paired Chinese / English copy (`Updated HH:MM` / `Blocked … · degraded …`).

## 运行 / Run

```bash
cd web
npm run build
node screenshots/overview-kpi-links/shots.mjs
```

结果写在 `report.json`；任何断言失败都会以非零退出码结束。
The results are written to `report.json`; any failed assertion exits non-zero.

## 产物 / Artifacts

| 文件 / File | 内容 / Content |
|---|---|
| `cards-{abnormal,normal}-{dark,light}-{1440,390}.png` | 四卡两态 / four cards in both states |
| `hover-…png` | 悬停反馈 / hover feedback |
| `header-…png` / `header-busy-…png` | 页头新形态 / new header, idle and busy |
| `page-top-…png` | 页头 + KPI + 下方视图 / header with cards and view |
| `click-{mode}-{0..3}-dark-1440.png` | 点击后的目标页 / landing page after click |
| `cards-en-…png` / `header-en-…png` | 英文文案 / English copy |
| `report.json` | href、颜色、aria-busy、请求数断言 / hrefs, colours, aria-busy, request counts |
