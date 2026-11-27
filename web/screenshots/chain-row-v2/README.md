# 链路表格与拓扑图调整 / Chain table and topology polish

> **拓扑截图说明 / Topology shots notice**：拓扑截图自本次起由 `web/screenshots/chain-flow/` 取代；本目录的旧拓扑图仅作历史对照。 / From this change on, topology screenshots are superseded by `web/screenshots/chain-flow/`; the old topology shots here are historical references only.


**中文**：本目录是「链路时延」列表与详情拓扑图最新一版的验收截图和机读几何
报告。本版做了四处调整：

1. 表格所有列统一左对齐，数值列保留 `tabular-nums`；
2. 跳数与状态值提升到与 P50 相同的 **15px / font-medium**；
3. 每行底部加 `border-border/60` 分隔线，最后一行没有；
4. 详情拓扑图铺满卡片宽度，连接线垂直居中，线上标该段时延、线下标该段丢包；
   目标段用虚线并标「无历史数据」。

**English**: Acceptance screenshots and a machine-readable geometry report for
the latest chain-latency table and detail topology. Four changes:

1. every column is left-aligned, numeric columns keep `tabular-nums`;
2. the hop and status values now match P50 at **15px / font-medium**;
3. each row gets a `border-border/60` bottom separator, the last row does not;
4. the detail topology fills the card, the connector is vertically centred, with
   segment latency above and loss below; the target hop is dashed and labelled
   "No history".

数据来自真实主控（`data/chain-rows-v2.db`，复制自 `data/preview.db`，并把时延 /
探测样本平移到当前窗口），没有注入 mock。

Data comes from a real controller (`data/chain-rows-v2.db`, copied from
`data/preview.db` with latency/probe samples shifted into the current window); no
mock payload is injected.

## 文件 / Files

- `rows-{1440,390}-{dark,light}.png`：表格卡片截图。
- `topology-{1440,390}-{dark,light}.png`：拓扑卡片截图。
- `topology-390-{dark,light}-end.png`：390 横向滚动到末端，展示目标段虚线。
- `compare-{1440,390}-{dark,light}.png`：上一版 / 本版并排对比。
- `before/rows-*.png`：上一版表格截图，供对比留档。
- `report.json`：列宽、行高、字号、对齐、分隔线、拓扑右侧空白、连接线中心
  偏移、上下标注、目标段虚线等断言。

## 表格 / Table

```
链路          起点 → 终点                          路由                        跳数  P50    窗口丢包  状态
港日中转链 [变慢] 203.0.113.11:21001 → 198.51.100.23:21004  香港-01 → 东京-01 → … → 大阪-01   4   93 ms   3.2%   健康  ›
最近样本 16 分钟前
```

- 全部列左对齐；数值列仍 `tabular-nums`。
- 跳数 15px、状态 15px、P50 15px，同为 `font-medium`；丢包 14px。
- 每行底部 `border-b border-border/60`，最后一行 `border-b-0`；表头下边框不动。
- 列宽：链路 20% / 地址 32% / 路由 22% / 跳数 64 / P50 80 / 丢包 88 / 状态 88 /
  chevron 24，列距 12px。
- 样本时间在链路名下的小字；路由独立成列，超长截断并给完整 `title`。
- 390 单列：链路（含样本）→ 地址 → 路由 → 跳数/时延/丢包，表头隐藏。

### 表格实测 / Measured table geometry

| 视口 | 行高 | 分隔线 | 链路 | 地址 | 路由 | 跳数 | P50 | 丢包 | 状态 | chevron | 地址宽 | 溢出 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1440 dark/light | 70px | 2（3 行） | 184px | 295px | 203px | 64px | 80px | 88px | 88px | 24px | 295px | 0px |
| 390 dark/light | 174px | 2（3 行） | 300px | 300px | 300px | 单列 | 单列 | 单列 | 单列 | 单列 | 300px | 0px |

字号：跳数 15 / 状态 15 / 地址 12 / 路由 12 / 样本 12 / P50 15 / 丢包 14。
所有列 `text-align: left`。

## 拓扑 / Topology

- 节点按可用宽度均分（1440 实测每块 106px），连接线自然伸展，右侧空白 4px。
- 连接线在节点方块垂直中心：实测 4 段偏移均为 **0px**（要求 ±2px）。
- 线上标该段时延，线下标该段丢包；目标段线上「无历史数据」、线下「—」，线为虚线。
- 节点高度 48px（原约 30px），容纳上下两行信息；保持原有边框/圆角样式。
- 390 节点过多时横向滚动（实测 `scrollWidth - clientWidth = 442px`），节点
  不压缩、不截断文字。

### 拓扑实测 / Measured topology geometry

| 视口 | 右侧空白 | 节点宽 | 节点高 | 连接线中心偏移 | 横向溢出 |
|---|---:|---:|---:|---:|---:|
| 1440 dark/light | 4px | 106px ×5 | 48px | 0px ×4 | 0px |
| 390 dark/light | 滚动 | 96px ×5 | 48px | 0px ×4 | 442px（预期可滚动） |

## 审计 / Audit

- 表格不再有任何 `text-align: right` 或 `justify-end`；
- 行内不重复 `P50` / `窗口丢包` 标签，标签只在表头出现一次；
- 分隔线只存在于行底部，最后一行没有，表头下边框独立；
- 拓扑没有为填满而加的装饰：连接线是数据线，上方时延、下方丢包都是有效信息；
- 保留的卡片边框、表头底线、告警条都是结构或状态信息。

## 重新生成 / Regenerate

```bash
sqlite3 data/preview.db ".backup 'data/chain-rows-v2.db'"
NOW=$(date +%s)
MAX=$(sqlite3 data/chain-rows-v2.db "select max(ts) from forward_latency_samples;")
DELTA=$((NOW - 120 - MAX))
sqlite3 data/chain-rows-v2.db \
  "update forward_latency_samples set ts = ts + $DELTA;
   update forward_probe_samples set ts = ts + $DELTA;"

# 终端 1
PIERWAVE_ADMIN_PASSWORD=devpass PIERWAVE_ADDR=127.0.0.1:8787 \
  PIERWAVE_DB='sqlite://data/chain-rows-v2.db?mode=rwc' ./target/debug/pierwave-master

# 终端 2
cd web && npm run dev

# 终端 3
node web/screenshots/chain-row-v2/shots.mjs
```

Playwright 从仓库 `.npm-cache/_npx/.../playwright` 取，不新增项目依赖；需要本机
Chrome（默认 `/Applications/Google Chrome.app`，可用 `CHROME_PATH` 覆盖）。

## 断言 / Assertions

`report.json` 共 28 项，全部通过：

- 表格 8 列全部 `text-align: left`；跳数/状态/P50 均为 15px；
- 行高 70px；3 行中分隔线数量 2，最后一行 0；
- 地址 ≤520px、列距 ≤40px、无横向溢出；
- 表头唯一且含「路由」，行内不含 `P50` / `窗口丢包`；
- 拓扑右侧空白 4px ≤8px；4 条连接线中心偏移 0px；
- 每条边上下都有时延/丢包；目标段 `dashed`、「无历史数据」、「—」；
- 390 拓扑可横向滚动且节点文字不压缩；
- 四种组合都没有页面错误。

## 未做 / Out of scope

- 不改 `crates/`；真实接口已经返回 `entry` / `exit` / `loss_samples`。
- 未提交 commit（按项目约定由主控合流后统一处理）。
