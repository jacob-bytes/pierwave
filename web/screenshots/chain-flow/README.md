# 链路详情复用模板画布 / Chain detail reuses the template canvas

**中文**：本目录验收「完整链路」复用模板拓扑画布，并覆盖组选路策略与
当前通路。脚本用静态构建 + Playwright API mock，不依赖主控 / 数据库；
十条链路 fixture 覆盖多成员、单卡、长链、最后一跳不可测、最后一跳缺数据、
折叠、failover / lowest_latency / round_robin 与旧主控缺字段回退。

**English**: Acceptance shots for the "Full chain" section reusing the shared
template topology canvas, including per-group routing strategy and the current
path. The script serves a static build and mocks the API with Playwright, so no
master or database is needed. Ten chain fixtures cover multi-member,
single-card, long, unmeasurable last hop, missing last hop, folding,
failover / lowest_latency / round_robin and the old-controller fallback.

## 复现 / Reproduce

```bash
cd web && npm run build
cd ..
node web/scripts/shots-chain-flow.mjs
```

模板画布静止帧的改动前 / 改动后对比。`before-*` 截图来自改动前的构建
（临时快照，不随仓库提交）；`after-*` 来自当前构建：

```bash
TEMPLATE_ONLY=1 SHOT_PREFIX=before- DIST_DIR=web/.dist-before \
  node web/scripts/shots-chain-flow.mjs
TEMPLATE_ONLY=1 SHOT_PREFIX=after- COMPARE_TEMPLATE=1 \
  node web/scripts/shots-chain-flow.mjs
```

## 当前通路截图 / Current-path shots

截图使用 **static build + API mock**（`web/scripts/shots-chain-flow.mjs`），
fixture 字段与真实接口逐字段一致，便于在没有主控时复现。真实接口另外用
`data/preview.db` 的临时副本启动主控验证（不改真实预览库账号）：

```bash
sqlite3 data/preview.db ".backup '/tmp/pw-active-preview.db'"
PIERWAVE_ADMIN_PASSWORD=devpass PIERWAVE_ADDR=127.0.0.1:8796 \
  PIERWAVE_DB='sqlite:///tmp/pw-active-preview.db?mode=rwc' \
  ./target/debug/pierwave-master
```

后端返回的 `管理员 · 主备三跳`（failover，当前=东京-03，东京-02 离线）与
`管理员 · 最低延迟双跳`（lowest_latency，当前=东京-01）字段与本目录
fixture 对齐；截图本身仍走 mock，避免依赖登录态与预览库。

Shots use a **static build + mocked API**. The fixtures mirror the real
response field by field. The real endpoint was separately checked against a
temporary copy of `data/preview.db` (never the real preview account): 781 is
failover with 东京-03 active and 东京-02 offline, and 782 is lowest_latency
with 东京-01 active.

| 文件 / File | 场景 / Scenario |
|---|---|
| `active-failover-{width}-{theme}.png` | failover：东京-03「当前」、东京-02 离线红点、列头 `故障转移·2选1` |
| `active-lowest-{width}-{theme}.png` | lowest_latency：东京-01「当前」、另两台「候选」、列头 `最低延迟·3选1` |
| `active-round-robin-{width}-{theme}.png` | round_robin：无首选 / 候选，列头 `2 台分担` |
| `active-legacy-{width}-{theme}.png` | 旧主控缺 `strategy` / `active_server_id`：回退首选 / 候选与台数 |

## 读数 / Readings

- `failover`：默认高亮 **香港-01 → 东京-03 → 新加坡-01 → 链目标**；
  东京-03 `data-chain-tag="active"`（「当前」），东京-02 为候选且离线红点。
- `lowest`：默认高亮 **香港-01 → 东京-01 → 链目标**；列头
  `最低延迟·3选1`，东京-01 是「当前」，其余两台「候选」。
- `round-robin`：多成员中继列 `active / preferred / candidate` 均为 **0**，
  列头 `2 台分担`；单成员列仍显示 `1 台`，入口 / 目标不显示策略。
- `legacy`：没有 active；多成员中继列回退 **1 首选 + 1 候选**，列头保持
  `2 台`。
- 所有场景：`documentElement.scrollWidth - innerWidth = 0`（无横向溢出）；
  390 为 compact 画布（1 倍 + 画布内横向滚动），1440 为 full。
- `multi`：适应窗口 **95%**，**4** 个可见药丸、**4** 条 hot 连线、
  **2** 首选 + **2** 候选；列头 = 组名 + 台数；`≈` 只出现在多成员段。
- `single`：**100%**，全部卡片 / 连线点亮，没有首选 / 候选标签。
- `long`：缩放下限 **90%**，右侧提示「右侧还有 2 列」，点击后画布平移。
- `folded`：入口 6 台 → **4 + 1** 张卡，列头 `4 / 6 台`；展开后 `6 台`
  并出现「恢复默认」。
- 药丸 CSS 盒宽：链路 **56px** / 模板 **44px**。
- 点亮连线带 **1s** march（`animationDuration: 1s`），链路画布无 pulse；
  `prefers-reduced-motion: reduce` 下 `animationName: none`。
- 不可测 / 缺数据段：虚线 + `—` + tooltip 说明；`target` / `unknown` 不画点。
- 模板画布静止帧：`COMPARE_TEMPLATE=1` 时与改动前逐像素对比，折叠 / 展开 ×
  深浅四组应为 **0px** 差异（写入 `report-template-*.json`）。
- 英文：`Current` / `Balanced across 2` 由 `report.json` 的 `assertions.en` 记录。
- `report.json` 记录全部读数与 `errors`（当前为空）。
