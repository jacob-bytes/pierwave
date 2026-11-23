# 链路列表两行式改版 / Two-line chain list rows

**中文**：本目录是「链路时延」列表行改版的验收截图与机读几何报告。目标是去掉
旧 6 等宽列留下的两处空白，并把跳数从独立列移到第二行左侧、放大到 13px。
数据来自真实主控（`data/chain-rows-v2.db`，复制自 `data/preview.db`，并把时延 /
探测样本平移到当前窗口），没有注入 mock。

**English**: Acceptance screenshots and a machine-readable geometry report for the
chain-latency row redesign. The goal is to remove the gaps left by the old
six-column layout and move the hop count into the second line at 13px. Data comes
from a real controller (`data/chain-rows-v2.db`, copied from `data/preview.db`
with latency/probe samples shifted into the current window); no mock payload is
injected.

## 文件 / Files

- `rows-{1440,390}-{dark,light}.png`：只截「链路」卡片，便于看两行布局、块宽和
  390 堆叠。
- `report.json`：每张截图对应的字号、行高、块宽、块间距、横向溢出与路由断言。

## 布局 / Layout

```
第一行：链路名 [变慢]                     起点 ip:port ───→ 终点 ip:port       P50 91.5 ms  窗口丢包 3.2%  健康 >
第二行：4 跳 · 最近样本 11 分钟前         香港-01 → 东京-01 → … → 大阪-01
```

- 网格：`minmax(180px,1.2fr) | minmax(320px,2fr) | 16rem`，三段之间只有 12px。
- 跳数：13px、muted，与「最近样本」同字号；不再有独立「跳数」列。
- 地址：等宽 13px；服务器路由 12px muted；4 跳及以上用 `…` 省略中间节点，
  节点名全部来自真实逐段数据，不补假中转。
- 右侧指标：P50 20px、窗口丢包 14px、状态徽章 + chevron，固定 16rem。
- 390：单列堆叠为「名称行 → 地址行 → 指标行」，长地址 / 路由用 truncate，
  `report.json` 中 `scrollOverflow = 0`。
- 桌面地址行用一条极淡的连接线吃掉地址与指标之间的空段；390 隐藏该线。

## 实测几何 / Measured geometry

| 视口 | 行高 | 左块 | 中块 | 右块 | 地址→指标 | 溢出 |
|---|---:|---:|---:|---:|---:|---:|
| 1440 dark/light | 72px | 311px | 519px | 256px | 12px | 0px |
| 390 dark/light | 167px | 300px | 300px | 300px | 纵向堆叠 | 0px |

字号：跳数 13 / 最近样本 13 / 地址 13 / 服务器路由 12 / P50 20 / 丢包 14。

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

`report.json` 共 16 项，全部通过：

- 三张链卡分别覆盖 4 跳 / 3 跳 / 2 跳；4 跳路由为
  `香港-01 → 东京-01 → … → 大阪-01`，不出现被省略的「新加坡-01」；
- 慢链显示「变慢」徽章；
- 跳数、最近样本、地址、路由、P50、丢包字号与上表一致；
- 桌面块间距与地址→指标间距均 12px，没有 >40px 的空白；
- 390 三块纵向堆叠，`document.scrollWidth - innerWidth = 0`；
- 四种组合都没有页面错误。

## 未做 / Out of scope

- 不改 `crates/`；真实接口已经返回 `entry` / `exit` / `loss_samples`。
- 未提交 commit（按项目约定由主控合流后统一处理）。
