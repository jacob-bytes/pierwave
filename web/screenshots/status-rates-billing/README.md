# 探针页 W1–W3：轮询、上下行速率、图标与三列账期 / Probe page W1–W3: polling, both directions, icons and three-column billing

三项都只改 `web/`。数据由 Playwright 拦截 `GET /api/v1/public/status` 注入，
不启动后端、不写数据库；截图里的节点名与金额都是 fixture。

All three changes are inside `web/` only. Playwright intercepts
`GET /api/v1/public/status` with fixtures, so these shots need no backend and
never touch the database.

```bash
# 1) 构建 & 静态预览 / build and preview the SPA
(cd web && npm run build && npx vite preview --port 4173 --strictPort)

# 2) 跑断言 + 截图（约 70 秒，轮询实测要真等两个 21 秒窗口）
BASE_URL=http://localhost:4173 node web/screenshots/status-rates-billing/shots.mjs
```

产物 / Output

| 文件 / File | 内容 / Contents |
|---|---|
| `hero-rates-{dark,light}-{1440,390}.png` | W1 总速率拆成 `↓` / `↑`，页头「更新于」 |
| `card-columns-{dark,light}-{1440,390}.png` | 整页：三列、图标、三种到期状态与三种周期 |
| `card-hk-{dark,light}-{1440,390}.png` | 单卡特写（香港，27 天后到期 / 月付） |
| `billing-missing-{dark,light}-{1440,390}.png` | 字段缺失降级：完整对照 + 5 张缺字段卡片 |
| `report.json` | 断言结果、几何（列宽 / 溢出）与轮询实测 |

## W1 每 20 秒轮询 / 20-second polling

- `lib/publicStatus.ts` 导出 `PUBLIC_STATUS_POLL_MS = 20_000`，`usePublicStatus`
  用它作为 `refetchInterval`，`staleTime` 15 秒（比轮询短）。
- `refetchIntervalInBackground: false`：`document.hidden` 时暂停轮询。
- `visibilitychange` 监听：页签重新可见时立即 `refetch()` 一次，不等下一个 20 秒。
  全局 `refetchOnWindowFocus` 是 `false`，所以这条监听是唯一保证，不依赖
  React Query 的默认 focus 行为。
- 页头「更新于 HH:MM:SS」仍取 `generated_at`，每次轮询自然更新。

实测（`report.json` 的 `polling`，Playwright 伪装页签可见性）：

| 实测 / Measurement | 结果 / Result |
|---|---|
| 首屏请求 / initial requests | 1 |
| 21 秒内请求 / requests in 21 s | 2（20 秒轮询生效） |
| 隐藏 21 秒内请求 / requests while hidden 21 s | 0 |
| 恢复可见到补拉 / visible → refetch | 55 ms |
| 同值轮询是否重挂载数值节点 / remount on identical poll | 否（标记仍在，不会每 20 秒闪） |
| 数值变化后 / after a real change | 重挂载一次，重播 150ms `value-settle` |

`Hero` 的「当前总速率」由 `onlineRateByDirection(servers)` 计算：只加在线机器，
上下行分别求和；某方向没有有效读数时该方向显示 `—`，两个方向都没有时整组显示
一个 `—`。数值变化通过 `key` 重挂载 + `.value-settle`（150ms 透明度
0.55→1）提示，同值不闪、不做数字滚动。

Hero's "Total rate" now sums each direction separately over online nodes
(`onlineRateByDirection`). A missing direction renders `—`; when no direction
has data the whole stat is a single `—`. A real value change remounts the value
node and replays the 150 ms opacity settle; identical values do not remount.

## W2 速率与累计前的图标 / Icons before rate and total

每一个值都带图标，图标说明「这是哪一类数字」：

- 当前速率：`↓` / `↑`（`ArrowDownIcon` / `ArrowUpIcon`）；
- 累计流量：`↓` 压在一条线上 / `↑` 压在一条线上（`ArrowDownToLineIcon` /
  `ArrowUpToLineIcon`）——和参考卡片一致，肉眼能区分「这一秒」与「自开机以来」；
- 到期：`CalendarClockIcon`；价格：`CoinsIcon`。

图标 `size-3` + `self-center`，与 `text-xs` 基线对齐，颜色统一
`text-muted-foreground`；不加边框、不加背景，行高不变（每格仍是 12px 文字行）。

## W3 三列：速率 / 累计流量 / 到期与价格 / Three columns

- `md` 以上：`grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.35fr)]`，第三列
  略宽（`JPY 1,280.00 / 月` 是最长内容）。速率列与累计列各两行（下 / 上），
  账期列两行（到期 / 价格），三列并排读下去。
- `<md`：两列 —— 速率、累计各占一列；账期组 `col-span-2` 换到第三行，
  390 下整组宽度等于卡片内容宽（实测 326px），不挤压前两列，页面
  `scrollWidth = clientWidth = 390`。

| 实测 1440 / Measurement | 值 / Value |
|---|---|
| 卡片内容宽 / card content | 294px |
| 速率列 / rate column | ~78px |
| 累计列 / total column | ~78px |
| 账期列 / billing column | ~106px |
| 流量区图标 / icons in traffic area | 6（2 速率 + 2 累计 + 2 账期） |

字段契约（后端另一条 lane 提供，旧后端可能整组缺失）：

```jsonc
{ "paid_until": "2026-12-17", "price_cents": 26800, "currency": "CNY", "billing_cycle": "monthly" }
```

`publicBilling()` 是唯一的显示判定点：四个字段**任一**缺失或非法（日期不合法、
价格负数、未知周期、空币种）就返回 `null`，第三组整组不渲染，不出现
`— / —` 占位。到期天数按 **UTC+8 业务日** 计算，与 `lib/time.ts` 的日账本同口径。

## 三种到期状态 / 三种周期 / Three expiry states and three cycles

| 节点 / Node | 数据 / Data | 渲染 / Rendered |
|---|---|---|
| 香港 / Hong Kong | `paid_until = 今天 + 27`，`26800 CNY monthly` | `27 天后到期`、`¥268.00 / 月` |
| 东京 / Tokyo | `paid_until = 今天 + 120`，`99900 CNY yearly` | `120 天后到期`、`¥999.00 / 年` |
| 新加坡 / Singapore | `paid_until = 今天`，`19900 USD once` | `今天到期`、`$199.00 / 一次性` |
| 洛杉矶 / Los Angeles | `paid_until = 今天 - 3`，`128000 JPY monthly` | `已过期`（warning 色）、`JPY 1,280.00 / 月` |

币种映射：`CNY → ¥`、`USD → $`、`EUR → €`，其它显示代码（`JPY 1,280.00`）。
周期映射：`monthly → 月 / mo`、`yearly → 年 / yr`、`once → 一次性 / one-time`。
「明天到期」单列一条文案，避免英文出现 `1 days left`。

## 字段缺失降级 / Missing-field fallback

`billing-missing-*.png` 是 6 张卡片：一张完整对照 + 缺 `paid_until`、缺
`price_cents`、缺 `currency`、缺 `billing_cycle`、`billing_cycle = null`。
后五张的账期组**整组不存在**（DOM 中没有该 `role="group"`，截图里第三列/第三行
直接消失），速率与累计列保持原样；断言同时检查卡片文本里没有 `— / —`。

## 测试 / Tests

`npm test`：689 pass（基线 673 + 新增 16 个用例）。

新增断言 / New assertions（`src/lib/publicStatus.test.mjs`）：

- `onlineRateByDirection`：只算在线机器、上下行分别求和、缺一个方向返回 `null`、
  0 是有效值、脏数据按方向跳过；`totalOnlineRate` 与两个方向之和一致。
- 轮询：`PUBLIC_STATUS_POLL_MS === 20_000` 且小于 stale 窗口；`queries.ts` 使用
  该常量、`refetchIntervalInBackground: false`、监听 `visibilitychange` 且只在
  `document.visibilityState === "visible"` 时补拉。
- Hero：使用 `onlineRateByDirection`、两个方向图标、`value-settle` 与
  `formatRatePairText`。
- 卡片：两种累计图标 + 两种速率图标、`CalendarClock` / `Coins`、md 三列模板、
  `col-span-2` 换行、调用 `publicBilling(server)`。
- `expiryDays`：27 / 0 / -1 / 42 天；UTC+8 跨午夜边界；非法日期（`2026-2-1`、
  `2026-02-30`、`not-a-date`、空串）返回 `null`；闰日有效。
- `expiryLabel`：已过期 / 今天 / 明天 / N 天四条分支。
- `formatPrice`：CNY / USD / EUR 符号、未知币种显示代码、千分位、0 元、缺失与
  非法值返回 `null`。
- `billingCycleKey`：三种周期（含大小写/空白）与未知值。
- `publicBilling`：四字段齐全返回完整数据；逐字段缺失、非法日期、非法周期、
  负价格都返回 `null`。
- i18n：中英周期与到期文案成对。

`npx tsc -b --noEmit`、`npm run build`、`npm test` 均通过。
