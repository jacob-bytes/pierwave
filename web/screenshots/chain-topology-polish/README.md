# 链路拓扑与整体时延图验收 / Chain topology and overall axis

> **拓扑截图说明 / Topology shots notice**：拓扑截图自本次起由 `web/screenshots/chain-flow/` 取代；本目录的旧拓扑图仅作历史对照。 / From this change on, topology screenshots are superseded by `web/screenshots/chain-flow/`; the old topology shots here are historical references only.


**中文**：本目录是「链路时延」详情页这一版的验收截图与机读报告。改动集中在
`web/`：

1. 拓扑节点加 `SOURCE` / `HOP n` / `TARGET` 小标签与状态点：在线为 2s 呼吸
   绿点，非 online 为静止红点，目标节点无点且虚线框；
2. 节点宽 112px、高 56px，仍按可用宽度铺满卡片；连接线保持垂直居中，
   线上时延、线下丢包不变；
3. 最后一跳现在按正常段展示真实时延；只有 `missing_hops` / 无样本时才显示
   「无历史数据」；
4. 整体时延图的时间轴改为 5–7 个刻度（24h 每 4h、7d 每 1d），带极淡竖向
   gridline；右端是最后一个真实样本的时间，滞后超过 5 分钟时补一行「现在」；
5. 整体图图例只用 `--primary`：P50 实线、P10–P90 与异常窗口分别用
   primary/15、primary/30；异常窗口色块也是 primary；
6. 逐段与整体趋势 tooltip 的「该时刻丢包」统一为「丢包」，`hoverLossHint`
   同步去掉「该时刻」；
7. 拓扑上的时延 / 丢包改为紧贴连接线：上方 2.5px、下方 2.5px，水平居中
   （偏差 0px）；段内左右留白减小、连接段宽度略增到 80px，总宽仍铺满卡片；
8. 诊断条改为主题蓝：`bg-primary/10`、`border-primary/30`、`text-foreground`，
   不再使用 warning 色。

**English**: Acceptance screenshots and a machine-readable report for the
chain-latency detail page. All changes are under `web/`:

1. topology nodes now carry `SOURCE` / `HOP n` / `TARGET` labels and a status
   dot — a 2s breathing green dot when online, a still red dot for any other
   known status, and no dot plus a dashed border for the target;
2. nodes are 112×56px and still fill the card; the connector stays vertically
   centred, with latency above and loss below;
3. the final hop now renders its real latency and only falls back to "No
   history" when `missing_hops` / samples are actually absent;
4. the overall chart axis has 5–7 ticks (4h on 24h, 1d on 7d) with faint
   vertical gridlines; the right edge is the last real sample, with a "Now"
   reference only when the sample lags by more than five minutes;
5. the overall legend uses `--primary` only: P50, P10–P90 and the anomaly
   window reuse primary at different opacities;
6. per-hop and overall tooltips now say "Loss" instead of "Loss at that time";
7. topology latency/loss labels now hug the connector (2.5px above/below) and are
   horizontally centred (0px offset); segment padding shrinks and the connector
   grows to 80px while the row still fills the card;
8. the diagnosis bar is primary blue (`bg-primary/10`, `border-primary/30`,
   `text-foreground`) with no warning colour.

## 数据说明 / Data note

数据来自真实主控（`data/preview.db` 的副本，时延 / 探测样本平移到当前窗口）。
另一条 lane 正在改后端，`chains[].nodes` 与「最后一跳有数据」尚未进入本机
二进制；`shots.mjs` 在浏览器层把 `nodes` / `role` / `status` 与最后一段补成
`docs/CHAIN-HEALTH.md` 的契约。最后一段的 P50 与序列由真实链级序列按比例
派生，只用于展示该契约形状，不代表真实末跳读数；其余曲线、窗口丢包、
`entry` / `exit`、链列表都来自真实接口。

Data comes from a real controller (a copy of `data/preview.db` with latency and
probe samples shifted into the current window). The backend lane is still
landing `chains[].nodes` and the final-hop fix, so `shots.mjs` only patches those
contract fields in the browser (per `docs/CHAIN-HEALTH.md`). The final hop's P50
and series are derived from the real chain-level series solely to exercise that
contract shape; every other series, window loss, `entry` / `exit` and the chain
list stay real.

## 文件 / Files

- `topology-{1440,390}-{dark,light}.png`：正常拓扑（全绿点 + 目标虚线）。
- `topology-{1440,390}-{dark,light}-end.png`：390 横向滚到末端，展示目标虚线。
- `topology-fault-{1440,390}-{dark,light}.png`：HOP 2 故障红点与其它绿点同屏。
- `topology-reduced-motion-1440-dark.png`：`prefers-reduced-motion` 下绿点静止。
- `diagnosis-{1440,390}-{dark,light}.png`：诊断条主题蓝。
- `overall-{24h,7d}-{1440,390}-{dark,light}.png`：整体时延图与时间轴。
- `trend-{24h,7d}-{1440,390}-{dark,light}.png`：列表页多链趋势的同一套刻度。
- `tooltip-trend-*` / `tooltip-segment-*`：两种 tooltip 的「丢包」文案。
- `report.json`：121 项断言（标签、状态点颜色 / 动画、目标虚线、末跳数据、
  标注与线的间距 / 水平居中、1440 拓扑铺满卡片、诊断条 primary token、
  刻度数量与间隔、末位样本时间、gridline、图例单色、tooltip 文案、
  390 横向滚动、reduced-motion）。

## 实测 / Measured

| 项目 | 结果 |
|---|---|
| 节点标签 | `SOURCE / HOP 1 / HOP 2 / HOP 3 / TARGET` |
| 节点尺寸 | 112 × 56 px；1440 下 5 节点铺满卡片，右侧空白 0 |
| 状态点 | online `--success` + `status-breathe`；offline `--destructive` + `animation: none` |
| 目标节点 | `border-style: dashed`，无状态点 |
| 末跳 | 边 `seq = hops`、`missing = false`，线上有 ms、线下有 % |
| 标注 / 线 | 时延下沿距线 2.5px、丢包上沿距线 2.5px；水平居中偏差 0px（4 段均） |
| 连接段 | 80px 宽；节点 112px 宽；1440 下右侧空白 0px、无溢出 |
| 诊断条 | 背景 `primary/10`、边框 `primary/30`、文字 `foreground`，class 无 warning |
| 24h 刻度 | 5–7 个；等距刻度间隔 14400s，末位为真实样本 `HH:mm` |
| 7d 刻度 | 5–7 个；等距刻度间隔 86400s，末位为 `MM/DD HH:00` |
| gridline | 与刻度数量一一对应，`stroke: var(--border)` |
| 图例 | 3 个色块全部为 `bg-primary*`，无 warning / destructive |
| tooltip | 含「丢包」，不含「该时刻」 |

`report.json` 的 121 项全部通过。Light / dark 两套主题分别读取
`--success`、`--destructive`、`--primary` 的实际计算值再比对，不是写死颜色。

## 重新生成 / Regenerate

```bash
# 1) 复制真实预览库并平移样本到当前窗口
sqlite3 data/preview.db ".backup 'data/chain-topology-polish.db'"
NOW=$(date +%s)
MAXL=$(sqlite3 data/chain-topology-polish.db "select max(ts) from forward_latency_samples;")
MAXP=$(sqlite3 data/chain-topology-polish.db "select max(ts) from forward_probe_samples;")
sqlite3 data/chain-topology-polish.db \
  "update forward_latency_samples set ts = ts + $((NOW - 120 - MAXL));
   update forward_probe_samples  set ts = ts + $((NOW - 120 - MAXP));"

# 2) 起主控（后台）与前端
PIERWAVE_ADMIN_PASSWORD=devpass PIERWAVE_ADDR=127.0.0.1:8787 \
  PIERWAVE_DB='sqlite://data/chain-topology-polish.db?mode=rwc' \
  ./target/debug/pierwave-master
cd web && npm run dev

# 3) 生成截图与断言
node web/screenshots/chain-topology-polish/shots.mjs
```

如果预览库里的 admin 密码不是 `devpass`，先用本地 `argon2id` 重算
`users.password_hash`，或设置 `ADMIN_PASSWORD` 指向已有密码。
Playwright 从仓库 `.npm-cache/_npx/.../playwright` 取，不新增项目依赖；
需要本机 Chrome（默认 `/Applications/Google Chrome.app`，可用
`CHROME_PATH` 覆盖）。
