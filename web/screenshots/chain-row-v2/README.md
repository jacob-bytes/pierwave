# 链路列表标准表格：独立路由列 / Standard chain table with a route column

**中文**：本目录是「链路时延」列表最新一版的验收截图与机读几何报告。本版在
上一版标准表格上再收两处：P50 从 17px 降到 **15px**；路由从第二行独立成
**「路由」列**，样本时间留在链路名下的小字。

**English**: Acceptance screenshots and a machine-readable geometry report for
the latest chain-latency list. On top of the previous standard table, this
version makes two changes: P50 drops from 17px to **15px**, and the route becomes
its own **Route** column; the sample time stays as small text under the chain
name.

数据来自真实主控（`data/chain-rows-v2.db`，复制自 `data/preview.db`，并把时延 /
探测样本平移到当前窗口），没有注入 mock。4 跳链、慢链、地址、路由、样本时间、
P50、窗口丢包都来自真实接口。

Data comes from a real controller (`data/chain-rows-v2.db`, copied from
`data/preview.db` with latency/probe samples shifted into the current window); no
mock payload is injected.

## 文件 / Files

- `rows-{1440,390}-{dark,light}.png`：本版「链路」卡片截图。
- `compare-{1440,390}-{dark,light}.png`：上一版 / 本版并排对比。
- `before/rows-*.png`：上一版标准表格截图，供对比留档。
- `report.json`：列宽、行高、字号、地址/路由宽度、列间距、表头唯一性、行内
  标签、连接线元素、路由和横向溢出断言。

## 布局 / Layout

```
表头： 链路          起点 → 终点                          路由                        跳数  P50    窗口丢包  状态
行1：  港日中转链 [变慢] 203.0.113.11:21001 → 198.51.100.23:21004  香港-01 → 东京-01 → … → 大阪-01   4   93 ms   3.2%   健康  ›
行2：  最近样本 18 分钟前
```

- 表头只出现一次，包含「路由」列；行内不重复 `P50` / `窗口丢包` / `跳数` 标签。
- 列宽：链路 20% / 地址 32% / 路由 22% / 跳数 64px / P50 80px / 丢包 88px /
  状态 88px / chevron 24px，列间距 12px。
- 地址 12px 等宽、最大宽度 520px；只有一个 muted `→`，没有连接线。
- 路由 12px muted，独立成列，超出截断，`title` 给完整序列。
- P50 15px、`tabular-nums`；跳数 13px、丢包 14px。
- 样本时间保留在链路名下的小字（12px muted），不再占第二行路由。
- 390：单列顺序「链路（含样本时间）→ 地址 → 路由 → 跳数/时延/丢包」，
  表头隐藏，行内小标签为「跳数 / 时延 / 丢包」，长文本 truncate，无横向溢出。

## 实测几何 / Measured geometry

| 视口 | 行高 | 链路 | 地址 | 路由 | 跳数 | P50 | 丢包 | 状态 | chevron | 地址宽 | 列距 | 溢出 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1440 dark/light | 70px | 184px | 295px | 203px | 64px | 80px | 88px | 88px | 24px | 295px | 12px | 0px |
| 390 dark/light | 173px | 300px | 300px | 300px | 单列 | 单列 | 单列 | 单列 | 单列 | 300px | — | 0px |

字号：跳数 13 / 地址 12 / 路由 12 / 样本时间 12 / P50 **15** / 丢包 14。

## 审计 / Audit

本页没有为填满而加的装饰：

- 地址间没有连接线 / 大箭头，只有一个 muted `→`；
- 行内没有重复的 `P50` / `窗口丢包` 标签；
- P50 15px，与丢包 14px 同一量级，不再突出；
- 状态为「圆点 + 文本」，没有额外胶囊边框；
- 保留的边框、分隔线都是表格结构本身（卡片头、表头底线），没有为撑满行宽
  而加的元素。信息完整：名称 / 状态 / 跳数 / 地址 / 路由 / 样本时间 / P50 /
  丢包。

## 重新生成 / Regenerate

```bash
# repo root：复制预览库并把样本平移到当前窗口
sqlite3 data/preview.db ".backup 'data/chain-rows-v2.db'"
NOW=$(date +%s)
MAX=$(sqlite3 data/chain-rows-v2.db "select max(ts) from forward_latency_samples;")
DELTA=$((NOW - 120 - MAX))
sqlite3 data/chain-rows-v2.db \
  "update forward_latency_samples set ts = ts + $DELTA;
   update forward_probe_samples set ts = ts + $DELTA;"

# 终端 1：真实主控
PIERWAVE_ADMIN_PASSWORD=devpass PIERWAVE_ADDR=127.0.0.1:8787 \
  PIERWAVE_DB='sqlite://data/chain-rows-v2.db?mode=rwc' ./target/debug/pierwave-master

# 终端 2：前端 dev server
cd web && npm run dev

# 终端 3：截图 + 断言
node web/screenshots/chain-row-v2/shots.mjs
```

Playwright 从仓库 `.npm-cache/_npx/.../playwright` 取，不新增项目依赖；需要本机
Chrome（默认 `/Applications/Google Chrome.app`，可用 `CHROME_PATH` 覆盖）。

## 断言 / Assertions

`report.json` 共 20 项，全部通过：

- 表头唯一，包含「路由」；桌面可见、390 隐藏；
- 行内 `innerText` 不含 `P50` / `窗口丢包`，连接线元素数量为 0；
- 8 列：20% / 32% / 22% / 64 / 80 / 88 / 88 / 24，行高 70px；
- P50 `font-size` = 15px；地址 12px、路由 12px、样本 12px；
- 地址 295px ≤520px；列间距 12px ≤40px；
- 4 跳路由为 `香港-01 → 东京-01 → … → 大阪-01`，不出现被省略的「新加坡-01」；
- 慢链显示「变慢」徽章；
- 390 四段纵向堆叠，`scrollWidth - innerWidth = 0`；
- 四种组合都没有页面错误。

## 未做 / Out of scope

- 不改 `crates/`；真实接口已经返回 `entry` / `exit` / `loss_samples`。
- 未提交 commit（按项目约定由主控合流后统一处理）。
