# KPI 审计修复回归 / KPI audit fixes regression

对应 `../kpi-audit/report.md` 的 F1–F6。数据直接复用 `../kpi-audit/fixtures.mjs`，
Playwright 拦截 `GET /api/v1/public/status`，不启动后端、不写库。

## 怎么跑 / How to run

```bash
cd web
NPM_CONFIG_CACHE=/Users/jlthzy/Documents/mmrust/.npm-cache npm run build
npx vite preview --port 4173 --strictPort
# 另一个终端 / another shell
BASE_URL=http://localhost:4173 node screenshots/kpi-fixes/shots.mjs
```

产物：31 张截图（6 个审计 fixture × 1440/390 × 亮/暗 = 24 张 hero 卡片，外加
键盘、单/双方向缺失、`rate-tiny`、`rate-1024-both`，以及 1 张 `uptime-9999`
整页证据）+ `report.json`。

## fixture 与断言 / Fixtures and assertions

| fixture | 断言 |
|---|---|
| `temporal-spike-rate` | 2 MB/s 的非零小值被抬到 y=21（0 基线 y=23），桌面可见高度 2px、390 下 1.67px；2000 MB/s 仍贴顶 |
| `dual-gap-rx-high` | 两条线共用 0..max：高线 y=1、低线 y=21；低线不再和 0 同像素 |
| `uptime-9999` | 可用率显示 `99.99%`（不是 `100%`），`%` 是 12px 单位；卡片 24h 可用率也显示 `99.99%`（整页截图见 `uptime-9999-full-dark-1440.png`） |
| `series-all-null` | 延迟/速率图空态；空态文案 11px、不透明 muted；暗色对比度 7.08、亮色 5.51 |
| `buckets-null` | 数字显示 `—`、图显示空态，不再出现「100% + 数据收集中」 |
| `rate-1024`（fixture `rate-boundary-1024`） | 大数字显示 `1 TB/s`，不再显示 `1024 GB/s` |
| `rate-tiny`（补测） | 大数字 `<1 B/s`；tooltip 保留 `0.001 B/s` / `0.4 B/s` |
| `rate-1024-both`（补测） | 两边都到边界也仍用 20/30px，不缩字号 |
| `rate-rx-missing` / `rate-both-missing` | 单方向缺、两方向都缺的 `—` 都是同一个 20/30px |

## 实测 / Measured

- 数值：**30px / line-height 30px（1440）**、**20px / 20px（390）**；速率不再 16px。
- 单位：`ms` / `%` / `MB/s` / `GB/s` / `TB/s` 全部 **12px**、muted；`%` 已从数字 span 拆出。
- 基线：1440 下三列数字 text bottom 全部 **153px**；三张图的 bottom 全部 **187px**。
- 高度：hero 仍 **171px（1440）/ 368.75px（390）**，未因字号变大而撑高（速率在 1440 仍一行）。
- 小值地板：`y=21` vs 0 的 `y=23`，桌面 **2px**、390 **1.67px**；0 仍贴底。
- 空态：11px，暗色对比度 **7.08**、亮色 **5.51**（均 ≥4.5）。
- 键盘：从页面起点按 **3 次 Tab** 进入迷你图；`tabIndex=0`、左右键移动采样点、
  Escape 关闭；`aria-describedby` 指向 tooltip，tooltip `aria-live="polite"`；
  焦点环实测 2px `oklch(0.74 0.16 264.6)`（即 `--focus-ring`）。

## F6 的选择 / Why `buckets-null` shows `—`

`buckets-null` 里后端仍带 `uptime_24h = 1`，但 24 个小时桶全空。数字和折线
本来就是同一份桶的两个视图；保留「100% + 数据收集中」会自相矛盾。因此**数字
也显示 `—`**，图和数字一起进入未知态。没有隐藏图，因为「数据收集中」本身
就是有用的空态信息。

## 范围 / Scope

可用率精度统一走 `availabilityPercentText`：hero KPI、迷你图 tooltip、
`ServerCard`（24h + 7d）与 `ServerTable` 都显示 `99.99%`；进度条宽度与
`aria-valuenow` 仍用整数百分比（0.01% 的差在 1px 条上不可见）。速率格式化
函数在 `lib/netRate.ts`，`availabilityPercentText` 在 `lib/publicStatus.ts`。
