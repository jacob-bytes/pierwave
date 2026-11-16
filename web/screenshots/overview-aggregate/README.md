# Overview aggregate cards / 概览聚合卡片

截图与实测数据：趋势 / 分布 / 榜单三组标签合并后，1440×900 整页高度从
1744px（1.94 屏）降到 1381px（1.53 屏，与改前同口径取 `<main>` 内容高度）。

Screenshots and measurements for the merged overview cards. On a 1440×900
viewport the page height drops from 1744px (1.94 screens) to 1381px
(1.53 screens, measured on the `<main>` scroll container, same as before).

## 文件 / Files

| 文件 / File | 内容 / Contents |
|---|---|
| `overview-default-{light,dark}-{1440,390}.png` | 默认：总流量 / 协议 / 服务器 |
| `overview-trend-protocol-{light,dark}-{1440,390}.png` | 趋势 → 协议 |
| `overview-dist-package-{light,dark}-{1440,390}.png` | 分布 → 套餐 |
| `overview-board-node-{light,dark}-{1440,390}.png` | 榜单 → 节点 |
| `overview-board-user-{light,dark}-{1440,390}.png` | 榜单 → 用户 |
| `before-{light,dark}-{1440,390}.png` | 改前旧版式（同一份基线数据） |
| `same-data-{light,dark}-{1440,390}.png` | 改后、同一份基线数据（用于高度对比） |
| `report.json` | 每个状态的实测高度、溢出、请求与断言结果 |
| `shots.mjs` | 可复现的种子数据 + 截图 + 断言脚本 |

所有截图语言为简体中文；`shots.mjs` 使用 `pierwave.locale=zh-CN`。
Screenshots are captured in Simplified Chinese (`shots.mjs` pins
`pierwave.locale=zh-CN`).

## 高度 / Height

| 数据集 / Dataset | 改前 / Before | 改后 / After |
|---|---|---|
| 基线数据（与 1744px 相同）/ baseline | 1744px = 1.94 屏 / screens | 1255px = 1.39 屏（含顶栏 1311px = 1.46） |
| 截图数据（5 条链 + 7 天流量）/ screenshot data | — | 1381px = 1.53 屏（含顶栏 1437px = 1.60） |
| 榜单 → 节点 / user | — | 1408px = 1.56 屏 |

“屏”按 1440×900 的 900px 计算；高度取 `<main>.scrollHeight`，与改前 1744px 同口径。
Screens are `height / 900`; heights are measured on `<main>.scrollHeight`, the
same basis as the previous 1744px.

## 可复现 / Reproduce

```bash
# 1. fresh DB 启动 master（会创建 admin/devpass）
PIERWAVE_ADDR=127.0.0.1:8787 \
PIERWAVE_DB='sqlite:///tmp/pw-overview/db.sqlite?mode=rwc' \
PIERWAVE_ADMIN_PASSWORD=devpass ./target/debug/pierwave-master

# 2. 另一个终端起 vite dev
cd web && npm run dev

# 3. 造数据、截图、跑断言
BASE=http://127.0.0.1:5173 DB_PATH=/tmp/pw-overview/db.sqlite \
  node web/screenshots/overview-aggregate/shots.mjs
```

脚本会通过 API 造 2 台服务器 / 80 个节点 / 5 个用户 / 4 个套餐 / 5 条链，
并直接写 7 天用户流量与今日节点流量。重复运行前请重建 DB。
The script seeds 2 servers, 80 nodes, 5 users, 4 packages, 5 chains, and writes
seven days of user traffic plus today's node traffic. Recreate the DB before
running it again.

## 标签 / Tabs

- 趋势：`总流量`（默认） / `协议`；两套数据分别来自 `stats/traffic` 与
  `overview?days=7`，首屏均已加载，切换不产生新请求。
- 分布：`协议`（默认） / `套餐`；同一份 `overview` 聚合结果。
- 榜单：`服务器`（默认） / `节点` / `用户`；同一份 `overview` 聚合结果。
- 键盘：三组标签都是 Radix Tabs，`←` / `→` 在标签间移动并同步切换面板；
  `aria-controls` 指向真实存在的 `role=tabpanel`。
- 390px：标签条 `overflow-x: auto`；卡片单列，页面与主内容区均无横向溢出。

- Trend: `Traffic` (default) / `Protocol`; both queries load on first paint,
  switching does not refetch.
- Breakdown: `Protocol` (default) / `Package`, same `overview` payload.
- Leaderboard: `Servers` (default) / `Nodes` / `Users`, same payload.
- Keyboard: Radix tabs; `←` / `→` moves and switches, and every
  `aria-controls` resolves to a real `role=tabpanel`.
- 390px: tabs scroll horizontally; single-column cards with no horizontal
  overflow.

## 信息完整性 / Information retained

| 原卡片 / Original | 现在位置 / Now |
|---|---|
| 近 7 天流量趋势（图例、累计线、总量徽标、错误重试） | 趋势卡 → 总流量 |
| 协议趋势（图例、线型、空态） | 趋势卡 → 协议 |
| 协议分布（节点数、流量、占比条、unknown） | 分布卡 → 协议 |
| 套餐用量分布（用户数、流量、占比条） | 分布卡 → 套餐 |
| 链路健康（状态、跳数、入口、/chains 跳转） | 原位常驻（2/3 宽） |
| 告警（全部条目、批量续期/停用、断流记录、清理、弹窗） | 原位常驻（1/3 宽，不折叠） |
| 服务器 Top 5（名称、趋势线、在线点、负载、流量、/servers） | 榜单卡 → 服务器 |
| 节点 Top 5（名称、协议 · 服务器、流量） | 榜单卡 → 节点（新增 /nodes 跳转） |
| 用户 Top 5（名称、流量、/users） | 榜单卡 → 用户 |
| Top 5 空态文案（服务器 / 节点 / 用户） | 各标签独立空态，文案不变 |

## 断言 / Assertions

`shots.mjs` 在真实浏览器里断言（全部通过）：

- 三组默认标签、第一项激活、标签条 `overflow-x: auto`；
- 三组 `←` / `→` 键切换并回到原项；
- 切换标签前后数据请求次数均为 3（`stats/overview`、`overview?days=7`、
  `stats/traffic?days=7`）；
- 服务器 / 节点 / 用户行分别跳转 `/servers`、`/nodes`、`/users`；
- 拦截接口返回空数据时，七个标签分别出现对应空态文案；
- 20 张截图（5 状态 × 亮/暗 × 1440/390）均无横向溢出、无浏览器报错；
- 1440×900 五种状态全部 ≤ 1450px（默认 1381px，榜单节点/用户 1408px）。
