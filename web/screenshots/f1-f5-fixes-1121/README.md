# F1–F5 web 修复实测 / F1–F5 web fixes — before & after

本轮只改 `web/`。截图用 Playwright（Chrome for Testing，headless）在
**1440×900 / 390×844、deviceScaleFactor = 1** 下拍摄；几何数据由
`getBoundingClientRect()` / `getComputedStyle()` 读取。数据来自
`data/preview.db` 的临时副本（admin：2 服务器 / 6 节点 / 4 套餐 / 6 用户 /
3 条链；用户：kenji，50 GB 套餐、重置日 1 日）。

This pass touches `web/` only. Screenshots were taken with Playwright
(Chrome for Testing, headless) at **1440×900 / 390×844, deviceScaleFactor = 1**;
geometry comes from `getBoundingClientRect()` / `getComputedStyle()`. Data came
from a temporary copy of `data/preview.db` (admin: 2 servers / 6 nodes /
4 packages / 6 users / 3 chains; user: kenji, 50 GB package, reset day 1).

目录 / Layout：

- `before/` — 改前截图与 `metrics.json`
- `after/` — 改后截图、`metrics.json`、`measurements-f2-f4.json`、`contrast.json`
- `contract/` — 新详情接口的回落 / 20 秒轮询验证（接口按契约 mock）

---

## F1 · 390 顶栏 / 390 header

**中文**：当前 HEAD 的 `<sm` 布局已经满足「品牌 + 进入后台 + 主题一行」：
390 下「更新于」文字收进 `sr-only`，只留状态圆点；品牌与三项动作都不溢出，不产生
横向滚动。本次没有改布局，只把圆点的 `title` 补成
`更新于 HH:MM:SS · 每 20 秒自动刷新`，让手机宽度下看不到文字时仍能通过
title 取得数据时间（此前 title 只有「每 20 秒自动刷新」）。

**English**: At HEAD the `<sm` layout already keeps brand + admin + theme on one
row: at 390 the “updated at” text is `sr-only` and only the status dot remains;
the brand truncates and nothing overflows. This pass did not change the layout;
it only changed the dot’s `title` to `Updated HH:MM:SS · refreshes every 20s`,
so the timestamp is still reachable when the text is hidden (previously the
title only carried the refresh hint).

| 指标 / Metric | 390 | 1440 |
|---|---|---|
| header 高度 / height | 65.0 px | 65.0 px |
| 页面横向溢出 / horizontal overflow | 0（390 = 390） | 0（1440 = 1440） |
| 「更新于」可见文字 / visible label | 6×6 圆点 / dot only | 99.2×16 px 文本 / text |
| 进入后台 / Admin | 100×40 @ x=226–326 | 100×32 @ x=1252–1352 |
| 主题 / Theme | 40×40 @ x=334–374 | 32×32 @ x=1364–1396 |
| 同一行 / same row | 是 / yes | 是 / yes |
| 圆点 title (390) | `更新于 18:34:16 · 每 20 秒自动刷新` | 同左 / same |

截图 / Screenshots：
[390 改前](before/f1-header-390-light.png) ·
[390 改后](after/f1-header-390-light.png) ·
[390 暗色](after/f1-header-390-dark.png) ·
[1440 改后](after/f1-header-1440-light.png) ·
[1440 暗色](after/f1-header-1440-dark.png)

---

## F2 · 概览多序列配色 / overview multi-series palette

**中文**：协议趋势图改为 **primary 的四档明度 + 四种线型**，最多 4 条序列
（含 `other`）。四档颜色只引用 CSS 变量 `--series-1…4`，没有新色相；
图例同时显示颜色与线型，390 下四个图例不移除、不截断，仍在一行内。

- 改前：同一条 primary，靠 `opacity = 1 / 0.72 / 0.5 / 0.34` + 线型区分；
  第 3、4 条在深色卡片上的实际对比度约 **2.36 / 1.71:1**，低于 3:1。
- 改后：四档明度对应的 token 对比度 **5.99 / 7.41 / 9.25 / 11.48:1**；
  1× 截图里图例线段的实际像素最低 **3.85:1**（暗色），亮色最低 **3.10:1**。
- 线型依次为：实线 / `6 3` 虚线 / `2 3` 点线 / `8 3 2 3` 点划线。

**English**: The protocol chart now uses **four lightness steps of `primary` +
four dash patterns**, capped at 4 lines including `other`. The steps are CSS
variables (`--series-1…4`), so no new hue is introduced. The legend shows both
colour and dash pattern; at 390 all four items stay visible, untruncated, on one
row.

- Before: one primary with `opacity = 1 / 0.72 / 0.5 / 0.34` plus dash. The 3rd
  and 4th lines measured roughly **2.36 / 1.71:1** on the dark card, below 3:1.
- After: token contrast **5.99 / 7.41 / 9.25 / 11.48:1**; the lowest rendered
  legend-mark pixel is **3.85:1** in dark and **3.10:1** in light at 1×.
- Dashes: solid / `6 3` / `2 3` / `8 3 2 3`.

| 项目 / Item | 1440 | 390 |
|---|---|---|
| 序列数 / series | 4 | 4 |
| 图表宽度 / chart width | 1120 px | 310 px |
| 图例项 / legend items | 4，全部未截断 / 4, none truncated | 4，同一行 / 4, one row |
| 图例字号 / legend font | 12 px | 12 px |
| 横向溢出 / horizontal overflow | 0 | 0 |

截图 / Screenshots：
[1440 亮色改前](before/f2-protocol-1440-light.png) →
[改后](after/f2-protocol-1440-light.png)；
[1440 暗色改前](before/f2-protocol-1440-dark.png) →
[改后](after/f2-protocol-1440-dark.png)；
[390 亮色改后](after/f2-protocol-390-light.png) ·
[390 暗色改后](after/f2-protocol-390-dark.png)。
原始数据见 [measurements-f2-f4.json](after/measurements-f2-f4.json) 与
[contrast.json](after/contrast.json)。

---

## F3 · 390 详情曲线刻度 / detail curve ticks

**中文**：`<sm` 时间刻度从 5 个减为 3 个（首 / 中 / 现在），1440 仍保留
5 个；y 轴本来就只有 100 / 50 / 0，未动。plot、24 个小时桶、hover 与键盘
行为完全不变（键盘 ←/→ 仍能移动读数，tooltip 仍通过 `aria-describedby`
关联）。

**English**: Below `sm` the time axis drops from 5 labels to 3 (start / middle /
now); 1440 still shows 5. The y-axis was already 100 / 50 / 0 and is unchanged.
The plot, the 24 hourly buckets, hover and keyboard behaviour are untouched
(←/→ still moves the reading; the tooltip is still tied via `aria-describedby`).

| 项目 / Item | 1440 | 390 |
|---|---|---|
| y 轴 / y ticks | 100 / 50 / 0 | 100 / 50 / 0 |
| 时间刻度（前）/ time labels before | 5 | 5 |
| 时间刻度（后）/ after | 5 | **3**（首 / 中 / 现在） |
| 隐藏的刻度 / hidden labels | — | `01:00`, `13:00`（w=0） |
| plot 宽度 / plot width | 344 px | 290 px |
| 键盘读数 / keyboard | ✔ tooltip `17:00–18:00 · 无采样` | ✔ |
| 鼠标读数 / hover | ✔ tooltip `01:00–02:00 · 100% · 正常` | ✔ |

截图 / Screenshots：
[390 改前](before/f3-detail-390-light.png) →
[改后](after/f3-detail-390-light.png)；
[390 暗色改后](after/f3-detail-390-dark.png)；
[1440 改后（未变）](after/f3-detail-1440-light.png)。

---

## F4 · 用户端环形卡右侧 / user ring card right side

**中文**：右侧补上「已用 / 总额度」与「重置日」，三列都有两项内容，不再出现
一整块留白。字段没有 `reset_at`（也没有顶层 `package_quota_bytes`），实际使用：

- 已用 = `usage.used_bytes`
- 总额度 = `package.traffic_limit`（与 `package_quota_bytes` 同口径）
- 重置日 = `summary.packages[]` 里按「套餐名 + 到期时间」匹配主套餐实例的
  `reset_day`；`null` 显示「不自动重置」，匹配不到（旧后端 / 字段缺失）时
  整项隐藏，避免把「不知道」说成「不重置」。

**English**: The right side now includes “Used / quota” and “Reset day”, giving
all three columns two items each and removing the empty third. There is no
`reset_at` (and no top-level `package_quota_bytes`) in `/me/summary`, so the
fields used are:

- used = `usage.used_bytes`
- quota = `package.traffic_limit` (same basis as `package_quota_bytes`)
- reset day = `reset_day` from the matching `summary.packages[]` instance
  (matched by package name + expiry). `null` renders “No auto reset”; an
  unmatched instance (old backend / missing field) hides the item rather than
  turning “unknown” into “no reset”.

| 项目 / Item | 改前 / Before | 改后 / After |
|---|---|---|
| 右侧指标 / right-side metrics | 到期 + 今日 + 日均 / 3 blocks | 到期 + 已用总额度 + 今日 + 重置日 + 日均 / 5 blocks |
| 1440 卡片 / card | 1152×176 | 1152×176 |
| 三列宽度 / columns | 298.66 × 3 | 298.66 × 3 |
| 第 2/3 列内容 / col 2–3 content | 每列只有 1 项 / 1 item each | 每列 2 项，内容高 100.8 px / 2 items, 100.8 px |
| 390 堆叠 / 390 stack | 342×? | 342×561.3，无横向溢出 |
| 空列 / empty column | 右侧 1/3 只有一项 / one item in last third | 无 / none |

截图 / Screenshots：
[1440 亮色改前](before/f4-me-1440-light.png) →
[改后](after/f4-me-1440-light.png)；
[1440 暗色改后](after/f4-me-1440-dark.png)；
[390 亮色改后](after/f4-me-390-light.png)；
[390 暗色改后](after/f4-me-390-dark.png)。

---

## F5 · 设置页保存条 / settings save bar

**中文**：选择**保存条吸底**，而不是卡片标题吸顶。理由：设置页在同一个滚动
容器里叠了多张卡，多个 sticky 标题会互相顶替、在 390 下还会占掉本已紧张的
高度；保存条只有一个，直接解决「改一个字段要滚到底才能提交」的实际问题。
没有折叠、隐藏或移动任何配置项。

**English**: The **sticky bottom save bar** was chosen over sticky card titles.
Multiple sticky titles would compete inside the same scroll container and eat
scarce height at 390; there is only one save bar, and it directly fixes the
real problem (scroll to the bottom to submit one field). No setting is folded,
hidden or moved.

| 保存按钮 / Save button | 改前 / Before | 改后 / After |
|---|---|---|
| 1440 页顶 / top | top 1547.9，视口外 / off-screen | top 832，可见 / visible |
| 1440 45% 滚动 / mid | 可见 / visible | top 832，可见 / visible |
| 390 页顶 / top | top 2107.8，视口外 / off-screen | top 768，可见 / visible |
| 390 45% 滚动 / mid | top 1155.8，视口外 / off-screen | top 768，可见 / visible |
| 滚动到底 / bottom | — | top 818.9（1440）/ 754.8（390），仍在流内 / in flow |
| 配置项增减 / config items | 0 | 0 |

截图 / Screenshots：
[1440 页顶改前](before/f5-settings-top-1440-light.png) →
[改后](after/f5-settings-top-1440-light.png)；
[390 页顶改前](before/f5-settings-top-390-light.png) →
[改后](after/f5-settings-top-390-light.png)；
[390 滚动中](after/f5-settings-mid-390-dark.png) ·
[390 底部](after/f5-settings-bottom-390-light.png) ·
[1440 暗色](after/f5-settings-top-1440-dark.png)。

---

## 新详情接口 / new detail endpoint

**中文**：详情页现在同时请求 `GET /api/v1/public/status`（页头、404 判定、
列表兜底）与 `GET /api/v1/public/status/:id`（`server` + 顶层
`series_24h`）。详情成功时优先用详情数据；404 / 接口未就绪时用列表里的
同 id 行，列表也没有 `series_24h` 时速率迷你趋势与延迟趋势整项隐藏，不报错。
详情查询 20 秒轮询，404 后停止空转。

**English**: The detail page now requests both `GET /api/v1/public/status`
(header, 404 state, list fallback) and `GET /api/v1/public/status/:id`
(`server` + top-level `series_24h`). On success the detail payload wins; on
404 / endpoint-not-ready it falls back to the same row from the list. If the
list no longer carries `series_24h`, the rate sparkline and latency trend are
hidden rather than erroring. The detail query polls every 20 s and stops after
a 404.

| 场景 / Case | 结果 / Result |
|---|---|
| 详情 200 + 顶层 `series_24h`，列表已无 `series_24h` | rate trend 1，latency trend 1，无错误 / no errors |
| 详情 200 但 `series_24h: null` | rate trend 0，页面正常 / page fine，无错误 |
| 详情 404，列表正常 | rate trend 0，列表 KPI / 曲线正常，无页面错误 / no page error |
| 详情 200（1440） | 四张卡正常，横向溢出 0 / no horizontal overflow |
| 20 秒轮询 / polling | 21 s 内 2 次请求，间隔 20014 ms / 2 requests, 20014 ms apart |

> 说明：本机运行的 master 二进制早于另一条 lane 的 `crates/master` 改动，
> 因此 contract 截图用 Playwright 按契约 mock 了详情接口；列表数据仍来自
> 真实 preview 库。真实前端代码使用的是同一个 URL / 字段。
>
> Note: the running master binary predates the other lane’s `crates/master`
> changes, so the contract screenshots mock the detail endpoint in Playwright
> using the exact contract; list data is real preview data. The shipped frontend
> uses the same URL and fields.

截图 / Screenshots：
[详情 404 回落 / fallback](contract/list-fallback-detail-404-390-light.png) ·
[详情 200 / top-level series](contract/detail-top-level-series-390-light.png) ·
[详情 1440](contract/detail-top-level-series-1440-light.png) ·
[series = null](contract/detail-series-null-390-dark.png)。
原始数据见 [contract/metrics.json](contract/metrics.json)。

---

## 验证 / Verification

```bash
# web 单测 / unit tests
make web-test
# ℹ tests 822 · pass 822 · fail 0（基线 817，本次 +5 / baseline 817, +5）

# 类型检查 / type-check
cd web && ./node_modules/.bin/tsc -b --noEmit   # no output

# 生产构建 / production build
make web-build                                   # ✓ built
```

`oxlint src`：0 errors，24 个既有 warning（与本轮无关）。
`oxlint src`: 0 errors, 24 pre-existing warnings (unrelated to this pass).

工作区里另有另一条 lane 对 `crates/{domain,master}` 与 `docs/PUBLIC-STATUS.md`
的改动；本 lane **没有触碰**这些文件，也没有 commit。
The working tree also contains another lane’s changes under
`crates/{domain,master}` and `docs/PUBLIC-STATUS.md`; this lane did **not** touch
them and did **not** commit.
