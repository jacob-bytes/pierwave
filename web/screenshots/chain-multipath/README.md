# 多路径时延卡验收截图 / Multi-path latency acceptance shots

**中文**：用独立 Vite 页面渲染真实的 `ChainLatencyDetail`（真实组件 +
`normalizeChainHealth`），不依赖主控或数据库。覆盖整体时延卡的多路径说明、
逐段标题的策略与台数、悬停图例 / 线条的成员明细，以及多成员组掉一台时的
「降级」徽章（不是「阻断」）；每张图在 1440 / 390、亮 / 暗两套下各截一次。

**English**: Renders the real `ChainLatencyDetail` component with
`normalizeChainHealth` through a standalone Vite page, so no controller or
database is required. It covers the multi-path note on the overall latency
card, per-segment strategy titles, the member breakdown on legend / line
hover, and the `degraded` badge when one member of a multi-member hop is
offline (not `blocked`), at 1440 / 390 in both themes.

## 运行 / Run

```bash
cd web
./node_modules/.bin/vite --port 5199 --strictPort

# 另开一个终端 / another terminal
BASE=http://localhost:5199 node web/screenshots/chain-multipath/shots.mjs
```

环境变量 / Env: `BASE` / `PLAYWRIGHT_MODULE` / `CHROME_PATH` / `HEADED`。

## 覆盖 / Coverage

| fixture | 场景 / Scenario |
|---|---|
| `failover` | 主备 3 台、东京-01 离线、东京-02 当前 → 「降级 · 东京-01 离线」+「第 2 段 · 主备 · 3 选 1」/ failover with one offline member |
| `roundRobin` | 轮询 3 台、没有当前成员 → 「第 2 段 · 轮询 · 3 台分担」/ round robin |
| `single` | 单成员链 → 没有多路径说明，段标题保持「第 1 段 / 第 2 段」/ single-member chain |
| `missingMembers` | 节点有策略、段没有 `members[]` → 标题仍在，明细降级消失 / missing segment members |
| `many` | 10 台成员 → 「第 2 段 · 主备 · 10 选 1」+ 明细 8 行 + `+2`，当前成员排第一 / 8 rows + `+N` |

## 断言 / Assertions（`report.json`）

- 整体时延卡：`多路径 · 按各跳中位数叠加` 只在多成员跳的链出现，`title`
  写明「不是单条连接的 RTT」；单成员链没有这句话；
- 段标题挂在段的**源组**（契约 `segments[].members` 同源）：`第 2 段 · 主备 · 3 选 1` /
  `第 2 段 · 轮询 · 3 台分担`；入口段与单成员段保持 `第 N 段`；
- 悬停图例：成员明细卡显示成员名 / 状态点 / P50 / 丢包，`active` 成员标
  「当前」并排第一；10 台时 8 行 + `+2`；契约缺 `members[]` 时没有任何明细；
- 悬停线条：tooltip 追加同一张明细表（`data-segment-tooltip` 内只有 1 张），
  缺契约时 tooltip 与旧版一致；首屏不出现成员曲线 / 明细；
- 徽章：多成员组掉一台是 `degraded`（「降级 · 东京-01 离线」），整跳没有
  在线成员才是 `blocked`；
- 英文 pass 断言 `Multi-path · summed per-hop medians` / `Degraded · 东京-01 offline` /
  `Segment 1 · Active/standby · 1 of 3` / `Current`。

关键图 / Key shots：`{fixture}-{theme}-{width}.png`（整页）、
`*-members.png`（图例悬停视口）、`*-tooltip.png`（线条悬停的逐段卡）。
