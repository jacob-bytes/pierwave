# 链路列表标准表格 / Standard chain table

**中文**：本目录是「链路时延」列表从上一版三段式改回**标准表格**的验收截图与
机读几何报告。目标是去掉贯穿地址的装饰连接线、行内重复的 `P50` / `窗口丢包`
标签、被拉伸的地址和过大的 P50 字号；信息仍然完整。

**English**: Acceptance screenshots and a machine-readable geometry report for
the chain-latency list, reworked from the previous three-block layout into a
**standard table**. It removes the decorative connector line through the address,
the repeated per-row `P50` / `Window loss` labels, the stretched address, and the
oversized P50. All information is preserved.

数据来自真实主控（`data/chain-rows-v2.db`，复制自 `data/preview.db`，并把时延 /
探测样本平移到当前窗口），没有注入 mock。4 跳链、慢链、地址、路由、样本时间、
P50、窗口丢包都来自真实接口。

Data comes from a real controller (`data/chain-rows-v2.db`, copied from
`data/preview.db` with latency/probe samples shifted into the current window); no
mock payload is injected.

## 文件 / Files

- `rows-{1440,390}-{dark,light}.png`：本版「链路」卡片截图。
- `compare-{1440,390}-{dark,light}.png`：上一版 / 本版并排对比。
- `before/rows-*.png`：上一版三段式截图，供对比留档。
- `report.json`：每张截图的列宽、行高、字号、地址宽度、列间距、表头唯一性、
  行内标签、连接线元素、路由和横向溢出断言。

## 布局 / Layout

```
表头： 链路            起点 → 终点                  跳数   P50     窗口丢包   状态
行1：  港日中转链 [变慢] 203.0.113.11:21001 → 198.51.100.23:21004   4   93 ms   3.2%   健康  ›
行2：  香港-01 → 东京-01 → … → 大阪-01 · 最近样本 12 分钟前
```

- 表头只出现一次；行内不再重复 `P50` / `窗口丢包` / `跳数` 标签。
- 列宽：链路 22% / 起点·终点 44% / 跳数 64px / P50 88px / 丢包 96px /
  状态 96px / chevron 24px，列间距 12px。
- 地址最大宽度 520px，只有一个 muted 的 `→`，没有连接线、没有大箭头。
- 数值列右对齐 + `tabular-nums`；P50 17px、跳数 13px、丢包 14px。
- 第二行 12px muted：真实路由 + 样本时间；4 跳及以上用 `…` 省略中间节点。
- 390：单列堆叠（名称 → 地址 → 路由/样本 → 指标），表头隐藏，行内小标签为
  「跳数 / 时延 / 丢包」，长地址 truncate，无横向溢出。

## 实测几何 / Measured geometry

| 视口 | 行高 | 链路 | 地址 | 跳数 | P50 | 丢包 | 状态 | chevron | 地址宽 | 列距 | 溢出 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1440 dark/light | 64px | 223px | 447px | 64px | 88px | 96px | 96px | 24px | 447px | 12px | 0px |
| 390 dark/light | 133px | 300px | 300px | 单列 | 单列 | 单列 | 单列 | 单列 | 300px | — | 0px |

字号：跳数 13 / 地址 13 / 路由 12 / 样本时间 12 / P50 17 / 丢包 14。

## 审计 / Audit

这一页为填满而加的装饰已去掉：

- 地址之间的连接线 + 大箭头（上一版）；
- 每行重复的 `P50` / `窗口丢包` 标签；
- P50 下方的第二行 delta（不在本页要求的信息清单里，详情弹窗仍保留）；
- 20px P50（降到 17px）；
- 状态胶囊的边框/底色（回到「圆点 + 文本」）。

保留的边框、分隔线都是表格结构本身（卡片头、表头底线），没有为撑满行宽而加
的元素。信息清单保持完整：名称 / 状态 / 跳数 / 地址 / 路由 / 样本时间 / P50 /
丢包。

## 重新生成 / Regenerate

```bash
# repo root：复制预览库并把样本平移到当前窗口
cp data/preview.db data/chain-rows-v2.db
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

- 表头唯一；桌面可见、390 隐藏；
- 行内 `innerText` 不含 `P50` / `窗口丢包`，连接线元素数量为 0；
- 列宽 22% / 44% / 64 / 88 / 96 / 96 / 24，行高 64px，地址 447px ≤520px；
- 跳数 13 / 地址 13 / 路由 12 / 样本 12 / P50 17 / 丢包 14；
- 4 跳路由为 `香港-01 → 东京-01 → … → 大阪-01`，不出现被省略的「新加坡-01」；
- 慢链显示「变慢」徽章；
- 390 四段纵向堆叠，`scrollWidth - innerWidth = 0`；
- 四种组合都没有页面错误。

## 未做 / Out of scope

- 不改 `crates/`；真实接口已经返回 `entry` / `exit` / `loss_samples`。
- 未提交 commit（按项目约定由主控合流后统一处理）。
