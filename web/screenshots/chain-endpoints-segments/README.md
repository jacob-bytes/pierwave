# 链路列表端点列 / 逐段多序列折线 / Endpoints and per-hop multi-series chart

**中文**：本目录是「链路时延」列表新增「起点 / 终点」「跳数」两列，以及详情
「逐段」改为**一张多序列折线图**的验收截图与机读报告。数据来自真实主控
（`data/preview-chain-latency.db` 的副本），浏览器侧只对
`GET /api/v1/overview/chain-health` 注入**新契约字段**（`entry` / `exit` /
`segments[].loss_pct` / `segments[].series`），因为后端 lane 尚未合并这些字段。
链、节点、时延曲线、诊断、拓扑仍全部来自真实接口。

**English**: Acceptance screenshots and a machine-readable report for the two
new list columns (**entry / exit**, **hops**) and for the detail view's
per-hop section, now rendered as **one multi-series line chart**. Data comes
from a real controller (a copy of `data/preview-chain-latency.db`); only the
new contract fields (`entry` / `exit` / `segments[].loss_pct` /
`segments[].series`) are injected in the browser because the backend lane has
not merged them yet. Chains, nodes, latency curves, diagnosis and topology are
real.

## 文件 / Files

- `list-{1440,390}-{dark,light}.png`：完整列表页（KPI + 趋势 + 链路列表）。
- `rows-{1440,390}-{dark,light}.png`：只截链路列表卡片，便于看列宽与 390 两行。
- `detail-segments-{1440,390}-{dark,light}.png`：逐段区域——一张多序列折线 +
  图例 + 图表下方每段一行的贡献占比。
- `detail-tooltip-*.png`：tooltip 在同一时刻按段序列出时延 + 该时刻丢包，并标注
  最高 / 最低段。
- `detail-tooltip-null-*.png`：某段逐桶丢包为 null → 该段显示 `—`，不借用窗口值。
- `detail-empty-*.png`：所有段都没有历史数据 → 图例灰显「无历史数据」+ 图表空态。
- `list-no-contract-1440-dark.png`：旧主控完全不返回 `entry` / `exit` 时整列 `—`，
  title 说明「主控未返回该端信息」。
- `report.json`：上述断言的机读结果（列头、390 行布局、图例状态、tooltip 内容、
  图表高度、溢出量等）。

## 关键决定 / Key decisions

### 1. 起点 / 终点列 / Entry and exit column

第一行 `起点 address → 终点 address`（等宽、`ip:port`），第二行服务器名。
`address` 为 null 时显示 `—`，`title` 区分两种降级原因：

- 整段缺失（旧主控）：`起点：主控未返回该端信息`；
- 只有地址缺失：`起点：没有可展示的地址（ip:port 缺失或端口无效）`。

```
entry/exit 缺失 → 整列 —
address 为 null → 该侧 —
```

不拿链配置的组信息兜底：契约没上线时，猜一个「看起来像起点」的地址比显示
`—` 更危险。

### 2. 跳数单独成列 / Hops is its own column

从链名旁移到独立列，避免链名与跳数挤在一起。390 下第一行是
「链名 + 状态 + 跳数」，第二行是「起点 → 终点 + P50 + 窗口丢包」。

### 3. 逐段 = 一张多序列图 / One chart for all hops

每条段一条线（第 1 段 / 第 2 段 / …），x = 时间（24h / 7d 跟随时窗），y = 时延 ms。
颜色只用 **primary 明度阶梯 + 线型**，不引入新色相；图例可点击隐藏/显示单段。
无数据段不出线，图例灰显「无历史数据」。

**tooltip 不画第二条线 / no second axis.** 丢包只进 tooltip：ms 与 % 量纲不同，
双轴会让读者把两条线的交叉点误读成因果关系。tooltip 按段序同时给出该时刻时延
与 `segments[].series[i].loss_pct`；null → `—`，不回落到窗口丢包。

图表下方保留每段一行的贡献占比条（段当前 P50、窗口丢包、贡献 %），不再每段
一张卡片。

### 4. 390 布局 / 390 layout

图表高度约 240px；图例 `flex-wrap` 换行；贡献条每段一行，地址/路由在窄屏隐藏，
只留段号、P50、窗口丢包与占比条。`report.json` 记录了
`document.scrollWidth - innerWidth <= 1` 的实测值。

## 重新生成 / Regenerate

```bash
# repo root：复制预览链时延库并把样本时间平移到当前窗口
sqlite3 data/preview-chain-latency.db ".backup data/chain-hops-shots.db"
DELTA=$(( $(date +%s) - $(sqlite3 data/chain-hops-shots.db "select max(ts) from forward_latency_samples;") + 300 ))
sqlite3 data/chain-hops-shots.db "update forward_latency_samples set ts = ts + $DELTA;"
PIERWAVE_ADMIN_PASSWORD=devpass PIERWAVE_ADDR=127.0.0.1:8787 \
  PIERWAVE_DB='sqlite://data/chain-hops-shots.db?mode=rwc' ./target/debug/pierwave-master

# 另一个终端：前端 dev server（代理 /api 到 8787）
cd web && npm run dev

# 第三个终端
node web/screenshots/chain-endpoints-segments/shots.mjs
```

Playwright 从仓库 `.npm-cache/_npx/.../playwright` 取，不新增项目依赖；
需要本机 Chrome（脚本默认 `/Applications/Google Chrome.app`，可用
`CHROME_PATH` 覆盖）。

## 断言 / Assertions

`report.json` 共 41 项，全部通过：

- 桌面列头含「起点 / 终点」「跳数」「窗口丢包」；每行地址与服务器名都用 `→`；
- 390 每行两行布局（`meta.top > main.top`），无横向溢出；
- 详情 `table` 数量 = 0；逐段只有一张图、两条数据线、三行贡献条；
- 图例点击后线条数 2 → 1，再点恢复；
- tooltip 两行按段序、每行同时含 `ms` 与「该时刻丢包」百分比，最高段标注一次；
- null 逐桶丢包 tooltip 显示 `—`；
- 无数据段不画线，图例灰显「无历史数据」；
- 旧主控缺 `entry` / `exit` 时整列 `— → —`。

## 未做 / Out of scope

- 不改 `crates/`：契约就绪后前端自动从真实接口读取；缺失时按上述规则降级。
- 未提交 commit（按项目约定由主控合流后统一处理）。
