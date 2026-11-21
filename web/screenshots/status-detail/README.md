# 服务器详情 `/status/:id` · 四张卡 / Four-card dashboard

所有者决策：**不新增后端字段**，只用现有 `GET /api/v1/public/status`；
详情页收成 4 张卡，每张回答一个问题。只改 `web/`。

## 四张卡 / Four cards

| # | 卡片 | 内容 |
|---|---|---|
| ① | 状态与趋势 | 名称/国旗/分组/状态 pill/在线时长 → 延迟、24h 可用率、当前速率 → **24h 曲线合并在本卡内** |
| ② | 可用性明细 | 中断次数、累计中断、采样覆盖、最低/最高时段、24h vs 7d + 差值；桌面额外补最长连续正常、前 2 个中断时段（都由 `buckets_24h` 推导） |
| ③ | 运行环境 | 内存/硬盘环、负载、发行版+版本、虚拟化、架构、**Xray 状态** |
| ④ | 费用与流量 | 到期/价格（有值才显示，过期 warning）+ 按月/年估算的剩余进度；累计流量 `net_rx_bytes` / `net_tx_bytes` +「自开机以来」+ 平均每小时上下行 |

桌面 2×2：① 左上、② 右上、③ 左下、④ 右下；左栏 420px，右栏其余。
`items-stretch` 让同一行卡片等高；① 的曲线 `flex-1` 吸收多余高度。
桌面用现有数据补了 ② 的最长连续正常/中断时段、④ 的到期进度/平均每小时，
避免 stretch 后卡片内部出现大块空白；390 单列不 stretch，因此这些可选行
在移动端隐藏，页面保持 1473px（≤1500）。

## 怎么跑 / How to run

```bash
cd web
NPM_CONFIG_CACHE=/Users/jlthzy/Documents/mmrust/.npm-cache npm run build
npx vite preview --port 4173 --strictPort
# 另一个终端 / another shell
BASE_URL=http://localhost:4173 node screenshots/status-detail/shots.mjs
```

产物：7 态 × 1440/390 × 亮/暗（28）+ 英文 healthy + 加载骨架 + **Xray 未运行**
= 31 张 matrix 结果；再加 hover / 列表入口 / error-last-success 3 张，共 **34 张**
+ `report.json`。

## 对齐实测 / Alignment

1440（健康态，`report.json`）：

- 内容宽 **1352px**；①③ 宽 **420px**，②④ 宽 **916px**；
- 第一行：①/② top = **137px**，bottom = **609.34px**；
- 第二行：③/④ top = **625.34px**，bottom = **954.91px**；
- 四张卡之间 gap = **16px**；
- 页脚 `y=970.91`，与第二行底边间距 **16px**；
- 页面高 **1003px**，页底剩余 **16.09px**（≤24）。

390：页面高 **1473px**（healthy/incident/offline），nodata 1355px；单列宽
**358px**，无横向滚动；页脚/页底均 16px。

每张卡「最后一个内容块到卡片内边距底部」的空白（padding 20/16 之外）：

| 卡片 | 1440 | 390 |
|---|---|---|
| ① 状态与趋势 | 0px（曲线填满） | 0px |
| ② 可用性明细 | 0px（列表 justify-between） | 0px |
| ③ 运行环境 | 0px（Xray 行贴底） | 0px |
| ④ 费用与流量 | 0px（两个 section 贴底） | 0px |

`report.json` 的 `innerBlank` 字段保存了这组实测值。

## 可用性明细的推导规则 / Derived availability details

全部来自 `buckets_24h`（24 个逐小时桶），没有新接口：

- **中断次数**：连续 `online_ratio === 0` 的小时算一段；`null` 不是 0，会打断连续段。
- **累计中断**：`0` 桶数 × 1 小时；注明「按小时采样，实际可能更短」。
- **采样覆盖度**：非 null 桶数 / 24。
- **最低 / 最高时段**：只比较有采样的小时；并列取更早的一段；显示区间 + 百分比。
- **24h vs 7 天**：两个数字并排 + 差值（百分点）。
- **最长连续正常**：连续 `online_ratio >= 0.99` 的小时数；桌面补在明细里。
- **中断时段**：把连续 0% 段转成 `HH:00–HH:00`，只列前 2 个；桌面补在明细里。
- **无采样**：`sampled === 0` 时中断次数、累计中断、覆盖度、最低/最高、
  最长连续正常、中断时段、24h/7d 差值全部显示 `—`，绝不显示“0 次中断”。

规则实现：`web/src/lib/publicStatus.ts` 的 `summarizeAvailability()`，
单测在 `web/src/lib/publicStatus.test.mjs`。

### Fixture 与期望值 / Fixture and expected values

`fixtures.mjs` 的目标 `srv-hk`：

| 状态 | 桶 | 期望 |
|---|---|---|
| healthy | 24 个 `1` | 中断 0 次 / 0 小时；覆盖 24/24；最低=最高 00:00–01:00 100%；24h/7d 100% · 差值 0.0 pp |
| incident | null `[2,3,18]`；0% `[8,9,15]`；91% `[14]` | 21/24 采样；**中断 2 次**（8–9 一段 + 15 一段）；**累计 3 小时**；覆盖 **21/24**；最低 08:00–09:00 0%；最高 00:00–01:00 100%；最长连续正常 **5 小时**；中断时段 **08:00–10:00 · 15:00–16:00**；24h 86% / 7d 98.7%，差值 **−12.7 pp** |
| nodata | 24 个 null | 明细全 `—`，卡片头「无采样」；不出现 `0 次` |
| xray | 同 healthy，`xray_running=false` | pill 异常 + 运行环境「Xray 未运行」 |

④ 的进度条：`paid_until` 剩余 27 天 / 月周期 30 天，显示 `27 / 30 天` 和
「按月估算」；平均每小时 = `net_rx_bytes` / `net_tx_bytes` ÷ `uptime_secs`，
显示 `↓ 3.75 GB/h · ↑ 562 MB/h`。两者都只使用现有字段，且只在桌面宽度
（卡片被 stretch）显示。

无采样时 `outageCount` / `outageHours` / `coverageRatio` 在 helper 里返回 `null`，
不是 0；这是 UI 显示 `—` 的源头。

## 24h 曲线 / 24h curve

- 0–100% 纵轴 + 时间横轴；step line + area。
- null = 整列斜线 hatch，不连线、不填充，绝不画成 100%。
- 0% 落基线（`y=96`），保持可见；相邻采样才连线，缺口两侧没有 transition。
- 分段色 ≥99 primary / 95–99 warning / <95 destructive；健康态只有 primary + 淡 area。
- 合并进 ① 后曲线高度自适应，不再单独占一张卡。
- crosshair + tooltip：鼠标、键盘 ←/→ + Escape、触摸点按；24 条 `sr-only` 逐小时文本。
- 7 天数字已移到 ②，不再在曲线页脚重复。

## 截图矩阵 / Screenshots

- `healthy` / `incident` / `offline` / `nodata` / `notfound` / `error` / `disabled`
  × 1440/390 × dark/light；
- `healthy-dark-1440-en.png`；
- `loading-dark-1440.png`（四卡骨架）；
- **`xray-off-dark-1440.png`**（额外要求，显示「Xray 未运行」）；
- `incident-hover-dark-1440.png`、`list-entry-dark-1440.png`、`error-last-success-dark-1440.png`。

旧的 `normal-*` 已由 `healthy-*` / `incident-*` 替换。

## 文案 / Copy

- 「平均延迟」→ **延迟 / Latency**。
- 404 → **该节点不存在或已下线 / This node does not exist or is offline**。
- 三个时间信号：顶栏「更新于」、pill「在线 14 天 3 小时」、页脚「最后上报」。
- Xray：运行中 / **未运行** / 状态未知；未运行时 status pill 为「异常」。
- 无费用数据时 ④ 只显示流量，不保留空的费用块。

---

## English summary

The detail page is now exactly four cards, built only from the existing public
status payload. ① status & trend (header, three numbers, 24h curve merged in),
② availability details (all derived from `buckets_24h`), ③ runtime (rings, load,
OS/virtualization/architecture, Xray), ④ billing & traffic. Desktop uses a 2×2
grid with a 420px left column and 916px right column, 16px gaps and stretch
alignment: card tops/bottoms in each row match exactly. The page is 1003px tall
at 1440 (1473px at 390), with 16px between the grid and footer and 16px at the
page bottom.

Outages are consecutive `online_ratio === 0` hours; null breaks a run and is
never treated as 0. Total outage is zero-hour count × 1h (noted as hourly
sampling), coverage is non-null buckets / 24, lowest/highest use sampled hours,
and 24h vs 7d includes the percentage-point difference. With zero samples all
derived values render `—`, never "0 outages". The incident fixture (nulls
2/3/18; zeros 8/9/15) therefore yields 2 outages, 3 hours, 21/24 coverage,
lowest 08:00–09:00 0%, highest 00:00–01:00 100%, and −12.7 pp versus 7d.

Xray `false` is called out explicitly as “Xray not running” in the runtime card,
in addition to the abnormal status pill.
