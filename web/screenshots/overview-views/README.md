# 概览三视图设计探索 / Overview insight views

> 状态：**设计探索与数据映射**，不改产品代码。`web/src/`、`crates/`、数据库 schema 均未修改，也未 commit。
> Status: **design exploration and data mapping only**. No product code, schema, or commits were changed.

## 0. 结论 / TL;DR

- **标签顺序与默认**：`服务器状态 / 成本开销 / 链路时延`，默认 **服务器状态**。运维每天看的是“现在有没有问题”；成本是周期性查看；链路只在排障时看。默认标签应是数据最全、最不依赖配置的那个。
- **多币种**：全部折算成 **CNY**。汇率是管理员在设置里维护的**手动汇率**，不在前端硬编码；未知币种**不计入总额**，单独列一行并给去设置的入口。tooltip 保留原币金额。
- **7 天窗口**：`server_samples` / `forward_latency_samples` 都只保留 7 天，能做 24h、7d、7×24 小时热力图；**不能做年度趋势**。年度趋势需要新增日/小时汇总表，不能靠延长 5 分钟原始样本。
- **链路**：现有数据可以聚合出「逐跳」历史，但历史口径**不含最后一跳到链目标**；`total_latency_ms`（链列表当前值）包含目标段。原型把历史明确标成“跳间时延”，不冒充端到端。
- **一次性费用**：**不计入年化/未来 12 个月**，单独列出。理由：`once` 没有可比较的折旧周期，按剩余天数摊销会把一次性支出变成随时间变化的假月费。
- **preview 库现状**：`forward_latency_samples = 0`；`chain_group_members = 0`；`chain_hops = 0`。已在临时副本中造数验证聚合（不改 schema、不改 `data/preview.db`），见 §6。

- **Order/default**: `Server status / Cost / Chain latency`, default **Server status**. Daily operations ask “is anything wrong now”; cost is periodic; chain is troubleshooting-only.
- **Multi-currency**: convert everything to **CNY** with admin-maintained **manual FX rates** from settings. Unknown currencies are excluded from totals, shown separately, and link to settings. Tooltips keep the original amount.
- **7-day window**: both sample tables retain 7 days. 24h, 7d and a 7×24 hourly heatmap are possible; annual trends are **not**. Annual trends need a daily/hourly rollup, not longer 5-minute retention.
- **Chain**: history supports per-hop aggregation, but excludes the final hop → chain target. `total_latency_ms` (current chain list) includes it. The prototype labels history “inter-hop” and never pretends it is end-to-end.
- **One-time fees**: **excluded** from annualized / next-12-month figures and listed separately. `once` has no defensible depreciation period; amortizing over remaining days creates a fake monthly number that changes daily.
- **Preview DB snapshot**: `forward_latency_samples = 0`, `chain_group_members = 0`, `chain_hops = 0`. Aggregation was validated in a temp copy with seeded rows (§6). No schema or `data/preview.db` change.

## 1. 交付物 / Deliverables

| 文件 / File | 内容 / Contents |
|---|---|
| `server.html` | 服务器状态（默认）原型 / Server status prototype |
| `cost.html` | 成本开销原型（CNY 折算、未知币种、一次性）/ Cost prototype |
| `chain.html` | 链路时延原型（整体 + 逐段）/ Chain latency prototype |
| `server-{dark,light}-{1440,390}.png` | 服务器状态 × 4 / Server status × 4 |
| `cost-{dark,light}-{1440,390}.png` | 成本 × 4 / Cost × 4 |
| `chain-{dark,light}-{1440,390}.png` | 链路 × 4 / Chain × 4 |
| `prototype.css`, `prototype.js` | 无依赖的共享样式与图表/交互 / Shared CSS + JS, no dependencies |
| `shots.mjs` | 12 张截图的复现脚本 / Reproducible 12-shot script |
| `report.json` | 每次渲染的尺寸、溢出、标签、指标值 / Metrics per shot |

截图均为 **简体中文**；浅色 / 深色使用 `web/src/index.css` 的同一组 token。All screenshots are zh-CN; both themes reuse the app's token values.

## 2. 数据审计 / Data audit

### 2.1 方法与证据 / Method and evidence

1. 读迁移 `0018_server_samples`、`0020_latency`、`0023_chains`、`0026_chain_groups`、`0035_forward_target_probes`、`0036_latency_samples`、`0061_server_billing`、`0067_billing_cycle_count_unit`，以及 `repo::server_samples`、`repo::latency`、`routes/chains.rs`、`routes/servers.rs`。
2. 只读查询 `data/preview.db`（2026-11-22 11:55 快照）：10 台服务器；`server_samples` 6,876 行，范围 2026-11-15 12:00 → 2026-11-22 11:55；`forward_latency_samples = 0`；`chains = 3`，`chain_groups = 8`，`chain_group_members = 0`，`chain_hops = 0`。
3. 在临时副本 `/tmp/overview-views/chain-validation.db` 中补成员、造 24h × 5min 样本，验证聚合（§6）。**没有修改 `data/preview.db`、没有改 schema。**

- Read the migrations and repo/route code listed above.
- Read-only snapshot of `data/preview.db`: 10 servers; 6,876 `server_samples` rows (2026-11-15 12:00 → 2026-11-22 11:55); 0 `forward_latency_samples`; 3 chains, 8 groups, **0 group members**, 0 legacy `chain_hops`.
- Seeded a temp copy only for chain aggregation validation (§6). `data/preview.db` and schema untouched.

> **重要修正**：当前代码的链路拓扑在 `chain_groups` + `chain_group_members`，不在 `chain_hops`。
> `chain_hops` 是 0023 的旧线性模型；0026 已把旧 hops 搬进 groups，之后不再写入。preview 里它为 0 是预期。新代码不应再读 `chain_hops`。
>
> **Correction**: current topology lives in `chain_groups` + `chain_group_members`, not `chain_hops`. `chain_hops` is the legacy linear model (0023); 0026 migrated it to groups and stopped writing it. It is expected to be empty in preview. New code must not read `chain_hops`.

### 2.2 成本 / Cost

| 指标 / Metric | 来源 / Source | 状态 / Status | 备注 / Notes |
|---|---|---|---|
| 月均开销 / Monthly run-rate | `servers.price_cents`、`currency`、`billing_cycle_count`、`billing_cycle_unit` | **已有 / Existing** raw；**需新增 / Add** 聚合 | `monthly = price_cents / cycle_months`；`year` = count×12；`once` 单列；旧 `billing_cycle` 仅回退 |
| 年度总开销 / Annual total | 同上 / same | **需新增 / Add** 派生 | `monthly × 12`；这是**年化**，不是“本年已发生” |
| 未来 12 个月 / Next 12 months | 同上 + `servers.paid_until` | **需新增 / Add** 排期 | 从 `paid_until` 起按 cycle 排期，扣掉已预付覆盖的期数；无 `paid_until` 从今天起算；`once` 不计 |
| 开销大头 / Top N | 同上 / same | **需新增 / Add** 排序 | 当前配置下的折算月均；不是历史账单 |
| 币种构成 / Currency mix | 同上 + 汇率设置 / same + FX settings | **需新增 / Add** 汇率 | 原币金额 + 折算 CNY + 占比 |
| 汇率 / FX rate | 无 / none | **需新增 / Add** `fx_rates` | 手动维护；默认 USD 7.20、EUR 7.80、JPY 0.048 CNY/unit |
| 一次性费用 / One-time | `price_cents` + `billing_cycle_unit = once` + `paid_until` | **已有 / Existing** raw；**需新增 / Add** 处理 | 原型选择：**不计入年化/预测**，单独列出 |
| 未配置币种 / Unknown currency | `servers.currency` 任意 3 位大写 | **需新增 / Add** UI + 校验 | 不计入总额；单列“N 台使用未配置汇率的币种” |
| 实际历史支出 / Actual spend history | 无表 / no ledger | **不可得 / Not available** | 没有付款流水；所有“年度”数字都是当前配置的投影 |

**结论**：成本所需的**原始字段已经全部存在**，并且 `GET /api/v1/servers` 已返回（`price_cents` / `currency` / `billing_cycle_count` / `billing_cycle_unit` / `paid_until`）。缺的是**汇率设置**和**聚合/排期逻辑**，不是 schema。v1 可以前端纯函数；规模大时再加 `GET /api/v1/overview/cost`。
**Conclusion**: all raw billing fields already exist and are returned by `/api/v1/servers`. What is missing is FX settings and the aggregation/schedule logic, not schema. v1 can be a front-end pure function; add a server endpoint at scale.

### 2.3 服务器态势 / Server posture

| 指标 / Metric | 来源 / Source | 状态 / Status | 备注 / Notes |
|---|---|---|---|
| 24h / 7d 在线率 / uptime | `server_samples.online`（5 分钟，7 天） | **已有 / Existing** raw；**需新增 / Add** 管理端聚合 | 公开页有 `buckets_24h` / `buckets_7d`，但那是公开白名单口径；管理端概览目前只有全局平均 `uptime_24h` |
| 7×24 小时热力图 / heatmap | `server_samples` | **已有 / Existing** raw；**需新增 / Add** `GROUP BY server_id, hour` | 一 SQL 查完，不按服务器循环；缺桶补 `null`，不补 0 |
| 负载 / load | `server_samples.load1` | **已有 / Existing** | **没有 CPU 核数**，只能显示 load1 绝对值；跨规格不可直接比较 |
| 内存 / memory | `mem_used` / `mem_total` | **已有 / Existing** | 计算 ratio；总量为 0 时视为无数据 |
| 硬盘 / disk | `disk_used` / `disk_total` | **已有 / Existing** | 计算 ratio；原型用 ≥90% 作为高警戒 |
| 延迟 / RTT | `server_samples.latency_ms` | **已有 / Existing** | 不是本视图主指标；NULL = 探测失败/旧 Agent |
| 速率 / rx/tx | `server_samples.rx_bps` / `tx_bps` | **已有 / Existing** | 本视图未用；NULL 不画 0 |
| 异常窗口 / anomaly runs | 从小时桶推导 / derived | **需新增 / Add** | 没有独立 outage 表；按连续 offline / 超阈值扫描 |
| 年度趋势 / annual trend | — | **不可得 / Not available** | 7 天保留；年度需要日汇总表（见 §5） |
| 当前快照 / current | `servers.load1/mem/disk` | **已有 / Existing** | 两次采样之间可能比 5 分钟桶更新，也可能滞后 |

**结论**：`server_samples` 足够画「哪台机器、什么时候」的 7 天热力图，但**不够做年度趋势**；也缺 CPU 核数，负载只能按绝对值解释。The raw samples are enough for a 7-day “which machine, when” heatmap; they are not enough for annual trends, and there is no CPU-core count for normalized load.

### 2.4 链路态势 / Chain posture

| 指标 / Metric | 来源 / Source | 状态 / Status | 备注 / Notes |
|---|---|---|---|
| 链路 → 组 → 成员 / topology | `chains` + `chain_groups` + `chain_group_members` | **已有 / Existing** | 当前模型；`chain_hops` 旧模型已空 |
| 每段历史 / per-hop history | `forward_latency_samples` | **已有 / Existing** raw | 成功探测才落；30 秒去重；保留 7 天；`server_id` = 谁测的，`target_server_id` = 测谁 |
| 成员 forward id / member forward id | 派生 / derived | **已有 / Existing** | 单成员组 `chain-<chain>-<seq>`；多成员组 `chain-<chain>-<seq>-<server_id>` |
| 逐跳聚合 / per-hop series | 上述两表 / above | **需新增 / Add** 接口 | 现有 `/api/v1/chains/{id}/latency` 只给单链；没有跨链总览 |
| 整体历史 / overall history | 同一时刻各段 P50 之和 / sum of segment P50s | **需新增 / Add** 接口 | **不含最后一跳到链目标**；多路径是估算 |
| 当前端到端 / current end-to-end | `/api/v1/chains` 的 `total_latency_ms` | **已有 / Existing** | 包含最后一跳到目标；与历史口径不同，不能混用 |
| 最后一跳到目标的历史 / final-target history | `forward_status.targets_json` 只有当前值 | **不可得 / Not available** | 需要新列或 rollup 才能进历史 |
| 空样本 / empty samples | — | **需造数 / Seed needed** | preview 为 0；临时副本已造 864 条并验证 |
| 年度趋势 / annual trend | — | **不可得 / Not available** | 7 天保留；需要链路小时/日 rollup |
| 迁移历史脏样本 / orphan samples | `forward_latency_samples` 无外键 | 已有防护 / guarded | 现有路由会跳过“目标已不在链里”的样本 |

**关键口径 / Critical semantics**：

- 链路历史按 `forward_id` + `target_server_id` 映射到「段」；`forward_latency_samples` **没有 `chain_id` / `seq`**，所以跨链总览要么在 Rust 里用 `chain_groups` 推导 forward id（v1 推荐），要么加列（v2）。
- 当前 `/api/v1/chains/{id}/latency?hours=1..168` 只给单链，且明确排除最后一跳到目标；历史总览不能用 `total_latency_ms` 冒充。
- `forward_latency_samples` 只存成功探测，失败不写样本；空桶/缺失必须显示为缺数据，不能当 0 ms。
- 多成员组（`strategy` + 多 member）没有单一确定路径；逐段中位数之和只能标“估算”。
- preview 的 `chain_group_members = 0` 说明预览库的链只有组、没有成员；即使造了 samples，也映射不到段。必须先补成员（临时库或 seed 脚本），否则链视图一定是空态。

### 2.5 状态汇总 / Status matrix

| 能力 / Capability | 状态 / Status |
|---|---|
| 成本原始字段 / raw cost fields | 已有 / Existing |
| 汇率设置 / FX settings | 需新增 / Add |
| 成本聚合与排期 / cost aggregation + schedule | 需新增 / Add（前端或接口）/ add (frontend or API) |
| 服务器 7 天小时桶 / server 7d hourly buckets | 已有 raw；需新增接口 / raw existing; API needed |
| 服务器年度趋势 / server annual trend | 不可得 / Not available |
| 负载按核数归一 / load per core | 不可得（缺 CPU 核数）/ Not available |
| 链路逐段原始样本 / chain per-hop raw | 已有 raw / Existing |
| 跨链整体/逐段聚合 / cross-chain aggregation | 需新增接口 / Add API |
| 最后一跳到目标历史 / final-target history | 不可得 / Not available |
| 链路年度趋势 / chain annual trend | 不可得 / Not available |
| 实际成本账单 / actual cost ledger | 不可得 / Not available |

## 3. 方案取舍 / Decisions

### 3.1 多币种：统一折算 CNY / Multi-currency: convert to CNY

- 所有成本数字最终以 **CNY** 展示；原币金额保留在 tooltip / 币种构成 / 付款日历 tooltip 里。
- 汇率来自设置项 **`fx_rates`**（JSON：`{"USD":7.20,"EUR":7.80,"JPY":0.048}`），不是前端常量。等价于示例里的 `fx_rate_usd_cny` / `fx_rate_eur_cny` / `fx_rate_jpy_cny`，但支持任意 3 位币种，避免“加一个币种就要改代码”。
- 默认值只是初值：**手动汇率，需自行维护**。设置页需要明确写这一句，并在成本页显示“按设置中的手动汇率折算为 CNY”。
- 未知币种（不在 `fx_rates` 里）：**不计入总额**，单列一行 `AED · 1 台使用未配置汇率的币种，未计入总额`，并给“去设置”。绝不静默按 1:1 或 0 处理。
- 汇率变化会影响所有历史/预测数字；没有汇率历史表，所以不能重算“当时汇率”。v1 接受这个限制，页面上标注手动汇率即可。
- 计算顺序：`monthly_cny = round(price_cents / cycle_months × rate)`；先按单台算，再求和，避免先四舍五入再加总产生漂移。
- 零小数币种（JPY）：现有 `price_cents` / UI 口径统一按“分”处理，展示 `JPY 1,280.00`；这是现有 `formatPrice` 的行为，不在本次改动范围内，但文档要提醒管理员。

**设置页草案 / Settings sketch**（放在「常规」或新的「计费」分组）：
```text
手动汇率 / Manual FX rates                     CNY per 1 unit
USD  [7.20]   EUR  [7.80]   JPY  [0.048]      [+ 添加币种]
手动汇率，需自行维护。保存后立即影响成本视图。       [取消] [保存]
```
保存走 `PATCH /api/v1/settings`，服务端校验：币种 3 位大写、汇率 > 0 且 ≤ 1000、最多 20 项；非法返回 `settings.fx_rate_invalid`。没有配置的币种在成本视图里单列，不会静默按 1:1 处理。
Save via `PATCH /api/v1/settings`; validate 3-letter uppercase code, rate > 0 and ≤ 1000, at most 20 entries; invalid → `settings.fx_rate_invalid`. Unconfigured currencies are listed separately, never silently treated as 1:1.

- All cost figures are CNY; original amounts remain in tooltips / currency mix / calendar tooltips.
- Rates come from settings **`fx_rates`**, not front-end constants. This is equivalent to the suggested `fx_rate_*_cny` keys but supports any 3-letter currency without code changes.
- Defaults are seeds only: **manual rates, maintain them yourself**. The settings UI and cost view must say so.
- Unknown currency: excluded from totals, shown as a dedicated warning row with a settings link. Never 1:1 or zero silently.
- Rate changes are retroactive for all projections; no FX history table. Documented limitation.
- Compute per server then sum, to avoid rounding drift.
- JPY: existing `price_cents` / UI treat amounts as minor units and show `JPY 1,280.00`; documented, not changed here.

### 3.2 一次性费用：不计入年化 / One-time: excluded

选择 **明确不计入年化/未来 12 个月**，单列“一次性：美西-01 ¥1,999.00（2027-06-30 到期）”。
理由：`once` 没有续费周期，也没有可信的折旧年限；按 `paid_until - today` 摊销会让同一台机器的“年化”随剩余天数每天变化，无法与其他机器比较。单列更诚实，也更容易解释。

**Chosen: exclude** from annualized / next-12-month, list separately. `once` has no renewal cycle or defensible depreciation period; amortizing over remaining days makes the annualized number change daily. A separate line is more honest and easier to explain.

### 3.3 未来 12 个月 / Next 12 months

- 年度总开销 = 月均 × 12（年化，run-rate）。
- 未来 12 个月 = 从 `paid_until` 起按 `billing_cycle_count/unit` 排期：每笔金额是**该周期的全额**（年付就是年付全额，不是月均），折算 CNY；`paid_until` 之前的月份标“已预付”，不重复计。`paid_until` 缺失或已过期：从今天起算，过期视为现在应付。
- 这样“未来 12 个月”可能小于“年度总开销”（预付覆盖了一部分），原型里 ¥20,246.80 vs ¥21,729，差额 ¥1,482.20 就是预付覆盖。
- 无 `paid_until` 的服务器是**假设**从今天开始下一期；tooltip / 文档必须标这个假设。

- Annual total = monthly run-rate × 12.
- Next 12 months = schedule from `paid_until` using the real cycle; each payment is the **full cycle amount** (yearly = yearly price), converted to CNY. Months before `paid_until` are “prepaid” and not charged again. Missing/overdue `paid_until` starts today.
- This is why next-12-months (¥20,246.80) can be lower than annualized (¥21,729); the ¥1,482.20 gap is prepaid coverage.
- Missing `paid_until` is an explicit assumption: next payment starts today.

### 3.4 7 天窗口 / 7-day window

能做 / Possible：
- 24h / 7d 在线率；7×24 小时热力图；每台服务器的小时负载 / 内存 / 硬盘；连续异常窗口；7 天基线与当前值对比。
- 24h / 7d 链路逐段时延；5/15 分钟桶；7 天基线；单段 vs 整体诊断。

不能做 / Not possible：
- 年度、季度、月度趋势；同比/环比；年度可用率 SLA；年度成本趋势。
- 把 5 分钟样本保留一年：9 台 × 288/天 × 365 ≈ 94.6 万行/年，且查询会扫全表；应做日/小时 rollup，而不是延长原始样本。

- 24h/7d uptime, 7×24 heatmap, hourly load/mem/disk, contiguous anomaly windows, 7d baseline.
- 24h/7d per-hop chain latency, 5/15-min buckets, single-segment vs overall diagnosis.
- **Not** annual/quarterly/monthly trends, YoY/QoQ, annual SLA, annual cost trend.
- Keeping 5-minute samples for a year is ~946k rows/year for 9 servers and makes queries scan too much; use a daily/hourly rollup instead.

### 3.5 链路空样本、最后一跳与多路径 / Empty samples, final target, multi-path

- preview 的 `forward_latency_samples` 为 0，链视图必须是**明确空态**：“还没有跳间探测样本。链配置完成并产生心跳后，这里会显示 24h 时延。” 不画 0 线。
- **最后一跳到链目标**：历史表里没有可靠归属；当前 `/chains` 的 `total_latency_ms` 包含目标段。原型把历史标成“跳间 P50 之和”，并在 footnote 写“不含最后一跳到链目标”。如果产品需要真正端到端历史，必须新增列/rollup（§5），否则不要在 UI 上写“端到端”。
- **多路径**：`chain_groups.strategy` 多成员时没有单一确定路径；按每段中位数求和是**估算值**。原型用“多路径 · 估算”chip，并在 footnote 说明。v1 可以只对单路径链显示“整体”，多路径链只显示逐段。
- **单跳链**：没有段（入口组没有上一跳），逐段卡显示空态；端到端当前值看链列表。

- Empty `forward_latency_samples` must produce an explicit empty state, not a zero line.
- Final hop → target is not reliably attributed in history; current `total_latency_ms` includes it. The prototype labels history “sum of inter-hop P50s” and footnotes the exclusion. True end-to-end history needs new columns/rollup (§5).
- Multi-path chains have no single path; sum of per-segment medians is an estimate. Prototype marks it “multi-path · estimate”. v1 may show overall only for single-path chains.
- Single-hop chains have no segments; show an empty state and point to the chain list for current end-to-end.

### 3.6 负载口径 / Load semantics

`server_samples.load1` 是 1 分钟负载绝对值，**没有 CPU 核数**。原型的热力图用 `load1 / 4` 作为“4 核满载”的近似，并在 footnote 明确“未按 CPU 核数归一，不同规格不能直接比较”。
正式实现二选一：
1. v1 继续显示绝对值 + 固定阈值（简单、诚实，但跨规格不公平）；
2. 新增 `servers.cpu_cores` / Agent 心跳上报 `nproc`，用 `load1 / cores` 归一（需要协议版本升级，见 §5）。

`load1` is an absolute 1-minute value; there is no CPU-core count. The prototype uses `load1 / 4` as a rough 4-core approximation and states the limitation. Production should either keep absolute thresholds (honest but unfair across sizes) or add `cpu_cores` via the Agent heartbeat (protocol bump).

## 4. 原型 / Prototypes

### 4.1 共同结构 / Shared shell

每个 HTML 都是独立、可离线打开的设计稿：页面头 + 4 个全局 KPI + 三视图标签 + 当前视图的 2–3 个数字 + 1–2 个主图 + 说明。
共同交互：右上角主题切换（也支持 `?theme=light|dark`）、标签链接（`server.html` / `cost.html` / `chain.html`）、服务器热力图的维度切换、链路行点击切换逐段视图。
`?shot=1` 只用于截图，隐藏底部数据映射说明。

Each HTML is standalone and works offline: header + 4 global KPIs + view tabs + 2–3 view metrics + 1–2 main charts + footnotes. Theme toggle (`?theme=`), tab links, heatmap mode switch, chain row selection. `?shot=1` hides the data-mapping drawer for screenshots.

### 4.2 服务器状态 / Server status（默认 / default）

**顶部数字**：24h 在线率 96.4%（7 天 99.0%）；异常服务器 3；磁盘最高 91%。
**主图 1：服务器 × 时间热力图**（桌面 7×24，移动最近 24h）。x = 小时桶；y = 服务器；颜色 = 综合（负载/4、内存、硬盘的最大值）或单维度；斜纹 = 离线；点纹 = 无采样；浅灰 = 未来。Tooltip = 服务器 + 时间 + 在线 + load1 + 内存 + 硬盘 + RTT。空态 = 保留网格并标“暂无采样”。
**主图 2：当前资源 + 异常窗口**。右侧列出连续异常，直接回答“哪台机器在什么时候有问题”；左侧 3 条 mini bar 给出当前负载/内存/硬盘，按最差维度排序。

**设计点**：默认综合色能在一屏里找到“哪台机器”；维度切换让“到底哪个资源高”可核对；移动端只保留 24h，避免 168 列在 390 上不可读；离线/无采样/未来用三种不同纹理，避免都画成 0。**已知边界**：负载未按核数归一；7 天窗口不足以做年度趋势。

- Metrics: 24h uptime 96.4% (7d 99.0%), 3 anomaly servers, 91% max disk.
- Main 1: server × time heatmap (7×24 desktop, last 24h mobile). x = hourly bucket, y = server, color = worst of load/4, memory, disk (or one dimension); hatch = offline, dot = no samples, pale = future. Tooltip includes all raw values. Empty state keeps the grid and says “no samples”.
- Main 2: current resources + anomaly windows; mini bars answer “which resource” and the right list answers “when”.
- Boundaries: load not normalized per core; 7 days cannot answer annual questions.

### 4.3 成本开销 / Cost

**顶部数字**：月均 ¥1,810.75；年度（年化）¥21,729；未来 12 个月 ¥20,246.80。
**主图 1：未来 12 个月付款日历** heatmap。x = 12 个月；y = 服务器（按币种分组）；颜色 = 该月应付金额（全部按 CNY 归一）；斜纹 = 已预付；虚线框 = 本周期无付款。Tooltip = 原币金额 + 手动汇率 + 折算 CNY。空态 = 引导去填写价格/周期；未知币种不进入图，单独 warning。
**主图 2：开销大头** sorted bars（Top 5，CNY 月均，占比）+ **币种构成** 100% stacked bar（原币与 CNY 对照）。
**必须画出来的两种状态**：`AED · 1 台使用未配置汇率的币种，未计入总额`（warning row + 去设置）；`一次性：美西-01 ¥1,999.00，不计入年化/预测`（footnote）。
**汇率说明**：“按设置中的手动汇率折算为 CNY（USD 7.20 · EUR 7.80 · JPY 0.048）· 手动汇率，需自行维护”，并提供“管理汇率”。

- Metrics: ¥1,810.75 monthly; ¥21,729 annualized; ¥20,246.80 next 12 months.
- Main 1: 12-month payment calendar heatmap. x = month, y = server grouped by currency, color = amount due in CNY, hatch = prepaid, dashed = no payment. Tooltip = original amount + manual rate + CNY. Empty = CTA to fill billing; unknown currencies are not plotted.
- Main 2: Top 5 sorted bars + currency mix 100% stacked bar.
- Explicit states: unknown AED row; one-time US-01 footnote; manual FX note + settings link.

### 4.4 链路时延 / Chain latency

**顶部数字**：跳间 P50 67 ms（较 7 天基线 +15 ms）；变慢的链 1/4；最慢段 43 ms（港日新链 · 第 2 段）。
**主图 1：整体时延小多图**。每条链一行，x = 24h（15 分钟桶），y = 跳间 P50 之和；P10–P90 带；虚线 = 7 天基线；橙色底 = 异常窗口；每行独立刻度，避免长链把短链压平。点击一行切换下方逐段图。
**主图 2：逐段时延 heatmap + 增量贡献 + 诊断**。heatmap x = 15 分钟桶，y = 段，颜色 = 该段 P50；右侧 diverging bars = 各段相对基线的增量；诊断句区分：
- `单段变慢`：整体 +15 ms，其中第 2 段 +15 ms，贡献 95%，其余持平；
- `整体变慢`：整体上升，各段同步，没有单段主导；
- `稳定`：没有超过 8 ms 的变化。
**空态**：单跳链 / 无 samples 时显示“没有跳间样本”，不画 0；多路径 chip“估算”。

**设计点**：整体小多图回答“哪条链变慢”，逐段 heatmap + 贡献条回答“是不是某一跳”；诊断句把两件事合成一句可读结论。footnote 固定写明“不含最后一跳到链目标；多路径为估算值”。

- Metrics: inter-hop P50 67 ms (+15 ms vs 7d baseline); 1/4 slow chains; slowest segment 43 ms.
- Main 1: small multiples per chain, 24h, P10–P90 band, 7d baseline, incident highlight, per-row scale. Click a row to select.
- Main 2: per-segment heatmap + diverging delta bars + diagnosis: single-segment, all-segments, or stable.
- Empty: single-hop / no samples shows an empty state; multi-path is marked estimate.
- Fixed footnote: excludes final hop → target; multi-path is an estimate.

### 4.5 图表数据映射 / Chart data mapping

| 视图 / View | x | y | 颜色 / Color | Tooltip | 空态 / Empty |
|---|---|---|---|---|---|
| 服务器热力图 / Server heatmap | 小时桶 / hourly bucket | 服务器 / server | 综合或单维度，4 档 / worst or one metric, 4 steps | 时间、在线、load1、内存、硬盘、RTT / time, online, load, mem, disk, RTT | 保留网格 + “暂无采样” / keep grid + “no samples” |
| 成本日历 / Cost calendar | 12 个月 / 12 months | 服务器（按币种分组）/ server | 该月 CNY 金额 / CNY due | 原币、汇率、CNY / original, rate, CNY | 引导填价格 / billing CTA |
| 开销大头 / Top bars | 排序 / rank | 服务器 / server | 单一 primary / primary | 原币 + CNY + 占比 / original, CNY, share | 暂无计费 / no cost data |
| 链路整体 / Chain overall | 15 分钟桶 / 15-min | 链 / chain | 单一 primary + P10–P90 + 异常窗 / primary + band + incident | 链、当前、基线、增量 / chain, current, baseline, delta | 保留空行 / keep empty row |
| 逐段 heatmap / Hop heatmap | 15 分钟桶 / 15-min | 段 / segment | 该段 P50，4 档 / segment P50, 4 steps | 段、起止、时间、P50、样本、增量 / segment, endpoints, time, P50, samples, delta | 斜纹 + “无样本” / hatch + “no samples” |

## 5. 需要新增的接口/字段与成本 / Backend gaps and effort

| # | 新增 / Change | 为什么 / Why | 成本 / Effort |
|---|---|---|---|
| 1 | `settings.fx_rates`（JSON，默认 USD 7.20 / EUR 7.80 / JPY 0.048） | 手动汇率，任何币种可配；不在前端硬编码 | S（1.5–2 人日 / days） |
| 2 | `GET /api/v1/overview/cost?base=CNY`（可选） | 规模大时避免拉全量 `/servers`；统一聚合与测试 | S（1 人日） |
| 3 | `GET /api/v1/overview/server-health?hours=168&bucket=3600` | 每台服务器的在线率、load、mem、disk 小时桶；管理端目前没有 | S（1.5–2 人日） |
| 4 | `GET /api/v1/overview/chain-health?hours=24&bucket=900` | 跨链整体 + 逐段；复用 `forward_latency_samples` / 链组映射 | M（2–3 人日） |
| 5 | `server_daily_rollup`（新迁移，按 server/day 聚合 uptime/load/mem/disk，保留 ~400 天） | 年度/季度趋势；避免保留 5 分钟原始样本 | M（3–5 人日） |
| 6 | `chain_latency_rollup` 或给 `forward_latency_samples` 加 `chain_id` / `seq` / `hop_kind` | 去掉 forward id 解析；把最后一跳到目标纳入历史 | M（2–4 人日） |
| 7 | `servers.cpu_cores` + Agent 心跳 `nproc`（协议字段，升 `PROTOCOL_VERSION`） | 负载按核数归一；当前只能看绝对值 | M（2–3 人日） |
| 8 | `server_cost_events`（付款流水：server_id, paid_at, amount, currency, cycle） | 真正的“年度已花/历史成本”；当前只有投影 | M（2–3 人日） |

**不需要改 schema 的 v1**：`fx_rates` 落现有 `settings` 表；server/chain 健康接口只读现有表；成本可以用现有 `/servers` + `/settings` 前端计算。
**v1 without schema changes**: `fx_rates` uses the existing `settings` table; server/chain health endpoints only read existing tables; cost can be computed client-side from `/servers` + `/settings`.

### 5.1 接口草案 / Response sketches

`GET /api/v1/overview/server-health?hours=168&bucket=3600`
```json
{
  "window": { "hours": 168, "bucket_secs": 3600, "generated_at": 1795318800 },
  "servers": [{
    "id": "srv_...", "name": "香港-01", "status": "online",
    "current": { "load1": 0.42, "mem_used": 3650722201, "mem_total": 8589934592,
                 "disk_used": 45097156608, "disk_total": 85899345920, "latency_ms": 28 },
    "buckets": [{ "ts": 1795237200, "online_ratio": 1.0, "load1_avg": 0.42,
                  "load1_max": 0.91, "mem_ratio_max": 0.44, "disk_ratio_max": 0.53,
                  "samples": 12, "outage_samples": 0 }]
  }],
  "summary": { "uptime_24h": 0.964, "uptime_7d": 0.99, "anomaly_servers": 3,
               "disk_max": 0.91, "servers_without_samples": 1 }
}
```

`GET /api/v1/overview/chain-health?hours=24&bucket=900`
```json
{
  "window": { "hours": 24, "bucket_secs": 900 },
  "chains": [{
    "id": "chain_...", "name": "港日新链", "path_mode": "single",
    "segments": [{
      "seq": 2, "from": { "server_id": "...", "name": "东京-01" },
      "to": { "server_id": "...", "name": "新加坡-01" },
      "points": [{ "ts": 1795317000, "latency_ms": 42, "p90_ms": 48, "samples": 12 }],
      "baseline_ms": 28, "current_ms": 42, "delta_ms": 14
    }],
    "overall": { "points": [{ "ts": 1795317000, "latency_ms": 67 }],
                 "baseline_ms": 52, "current_ms": 67, "delta_ms": 15 },
    "diagnosis": { "kind": "single_segment", "segment_seq": 2, "contribution": 0.95 }
  }]
}
```

## 6. 链路造数验证 / Chain sample validation

在 `/tmp/overview-views/chain-validation.db`（`data/preview.db` 的副本）里：
1. 给 3 条链补齐 `chain_group_members`（9 行；不碰 `data/preview.db`）。
2. 给四跳链造 24h × 5min × 3 段 = 864 条成功样本；第 3 段在最近 8h +25ms，其余段不变。
3. 额外造 1 条 `target_server_id = ''` 的“最后一跳到目标”样本，验证历史口径会忽略它。
4. 用与 `repo::latency` 相同的映射（`forward_id` + `target_server_id` → `chain_groups.seq`）聚合。

结果 / Results：

| 段 / Segment | 基线 / Baseline | 事件窗口 / Incident | 增量 / Delta |
|---|---:|---:|---:|
| 第 1 段 / segment 1 | 14.1 ms | 14.1 ms | 0.0 ms |
| 第 2 段 / segment 2 | 20.2 ms | 20.0 ms | -0.2 ms |
| 第 3 段 / segment 3 | 31.8 ms | 56.5 ms | **+24.8 ms** |
| 整体 / overall | 66.1 ms | 90.6 ms | **+24.5 ms** |

- 865 条样本，其中 1 条 `target_server_id` 为空；按段聚合只有 864 条进入，证明最后一跳样本被排除。
- 整体 +24.5ms，其中第 3 段 +24.8ms，其余段持平 → 这就是“单段变慢”的判据；如果三段都 +8ms，则判“整体变慢”。
- 说明：现有 per-chain endpoint 用 5 分钟桶 + 中位数；本验证用平均/5min 桶，只验证映射与“整体 vs 逐段”的形状，不改变生产口径。

- Temp copy only; 9 member rows added; 864 success samples + 1 empty-target sample; per-segment baseline vs incident; segment 3 +24.8ms, overall +24.5ms, other segments flat; empty-target row excluded (864 mapped out of 865). This proves the data can answer “overall vs one hop”.

## 7. 标签结构 / Tab structure

### 7.1 顺序与默认 / Order and default

**服务器状态 → 成本开销 → 链路时延**，默认 **服务器状态**。
理由：
1. 运维每天打开概览的第一问题是“现在有没有问题”，不是“这个月花了多少”；
2. 服务器状态不依赖计费字段或链配置，任何已接入 Agent 的实例都有数据；成本在没填价格时是空的，链路在没配链/没探测时是空的；
3. 服务器状态与现有概览的实时健康语义一致，放在 KPI 下方不会造成“这是另一个页面”的断层；
4. 成本是周期性查看（月/续费前），链路是排障时查看，二者都不适合做默认。

**Order: Server status → Cost → Chain latency; default Server status.**
1. Daily question is “is anything wrong now”, not “what did we spend this month”.
2. Server status needs no billing metadata or chain config; any connected Agent gives data. Cost is empty until billing is filled; chain is empty until chains/probes exist.
3. It matches the existing overview's real-time health semantics, so the new section doesn't feel like a different page.
4. Cost is periodic; chain is troubleshooting-only.

### 7.2 URL / 深链 / URL state

- `?view=server|cost|chain`；默认 `server` **不写参数**（与 Settings / Logs 的默认 tab 约定一致）。
- 切换用 `setSearchParams(next, { replace: true })`，避免每次 tab 切换都塞一条历史；保留其它 query 参数（如未来 `range`）。
- 非法值回退 `server`；刷新、后退、外部链接都能恢复到同一视图。
- 视图内部的过滤（服务器热力图维度、链选中项）v1 放组件 state，不写 URL；如果以后要分享“某条链的逐段视图”，再加 `chain=<id>`。

- `?view=server|cost|chain`; default `server` omits the parameter.
- Use `replace: true`; preserve other params; invalid falls back to server.
- Internal filters (heatmap dimension, selected chain) stay in component state for v1; add `chain=<id>` later if deep-linking a chain is needed.

### 7.3 懒加载与缓存 / Lazy loading and cache

- 三个视图都用 `React.lazy` + `Suspense`；首次进入某个 tab 才挂载，避免首屏同时渲染三套 recharts 图表。
- 不 `forceMount`；切走再回来会重新挂载，但数据来自 React Query cache，不会重新请求（除非 stale）。
- Query keys：`["overview","server-health",hours]`、`["overview","cost",base]`、`["overview","chain-health",hours]`。
- `staleTime`：server 60s（5 分钟采样）、cost 5min（元数据）、chain 60s（5 分钟桶）；窗口切换用 `placeholderData: keepPreviousData`。
- 汇率设置保存后 `invalidateQueries(["overview","cost"])`；服务器采样 5 分钟一次，60s 轮询足够。
- 可选：首屏加载完后 `requestIdleCallback` 预取默认 tab 之外的缓存；v1 不做，避免首屏多打两个接口。

- Lazy mount each view with `React.lazy`; no `forceMount`; React Query cache survives unmounts.
- Query keys and stale times as above; `keepPreviousData` for window changes.
- Invalidate cost on FX settings save; 60s polling for sample-based views.
- Optional idle prefetch; not in v1.

### 7.4 位置与回归 / Placement and regression

新 tab 区放在 **KPI 卡片下方、现有“近 7 天趋势”上方**。现有趋势 / 分布 / 链路健康 / 告警 / 榜单**保持不动**，只把页面变长；不替换已验收卡片。默认服务器状态在 1440×900 首屏可见（截图内容高度约 1,304px，含现有卡片时会超过一屏，这是可接受的增量）。
The tab section goes **below the KPI row and above the existing 7-day trend**. Existing cards stay untouched; the page gets longer rather than replacing accepted content. Server status is visible in the first 1440×900 screen.

### 7.5 可访问性 / Accessibility

- 生产用 Radix Tabs：`role=tablist/tab/tabpanel`、`aria-selected`、`aria-controls`、`←/→` 键盘切换。
- 热力图每格有 `title` / `aria-label`，颜色不是唯一信息：离线 / 无采样用纹理，数值在 tooltip。
- 打印/截图：`prefers-reduced-motion` 下关闭过渡。
- 390px：标签条横向可滚动或三等分；原型用三等分，无横向溢出。

- Radix Tabs in production with ARIA and arrow-key support.
- Every heatmap cell has a title/label; texture distinguishes offline/no-data so color is not the only channel.
- Reduced-motion support; 390px tabs fit in three columns with no horizontal overflow.

## 8. 推荐实现顺序 / Implementation order

1. **服务器状态（默认）**：先做 `server-health` 接口 + 热力图 + 资源/异常列表。它不依赖汇率或链拓扑，能最快验证“新 tab 区”的版式与性能。
2. **Tab 壳 + URL + lazy + i18n**：把三个视图的容器、`?view=`、骨架/错误态一次做好，再逐个填内容。
3. **成本**：`fx_rates` 设置 + 成本纯函数（含 4 个单测：多币种、未知币种、年付/一次、预付排期）+ 成本视图。
4. **链路**：`chain-health` 聚合（先单路径、后多路径估算）+ 整体小多图 + 逐段 heatmap + 诊断。
5. **保留期/汇总（后续）**：`server_daily_rollup`、链路 rollup、`cpu_cores`、成本流水，按“年度趋势/更公平负载/真实账单”的优先级排。

1. **Server status** first: endpoint + heatmap + resource/anomaly lists; no FX or chain dependency.
2. **Tab shell** with URL/lazy/i18n, then fill views.
3. **Cost**: `fx_rates` + pure function (4 unit tests: multi-currency, unknown, yearly/once, prepaid schedule) + view.
4. **Chain**: `chain-health` aggregation + overall small multiples + per-hop heatmap + diagnosis.
5. **Later**: rollups, `cpu_cores`, cost ledger.

## 9. 工作量估算 / Effort

| 工作 / Work | 人日 / Person-days |
|---|---:|
| 本次设计探索（数据审计 + 3 原型 + 12 截图 + 文档）/ this exploration | 1.5 |
| `fx_rates` 设置 + 设置 UI + 校验/测试 / FX setting + UI + tests | 1.5–2 |
| 成本纯函数 + 单测（或 +1d 接口）/ cost pure function + tests | 1 (+1 API) |
| `server-health` 接口 + 测试 / endpoint + tests | 1.5–2 |
| `chain-health` 接口 + 聚合 + 测试 / endpoint + aggregation + tests | 2–3 |
| Tab 壳 + URL + lazy + i18n / tab shell | 1 |
| 服务器视图 / server view | 3–4 |
| 成本视图 / cost view | 2–3 |
| 链路视图 / chain view | 3–4 |
| 响应式 / 四态 / a11y / 截图回归 / responsive, states, a11y, visual QA | 2 |
| **v1 合计 / v1 total** | **16–21** |
| 可选：日汇总 + 链路 rollup + cpu_cores + 成本流水 / optional rollups etc. | +6–9 |

假设 1 名熟悉仓库的前端/全栈工程师；不含产品评审与发版。One engineer familiar with the repo; excludes product review and release.

## 10. 复现 / Reproduce

```bash
# 12 张截图（file://，无需启动 master）
node web/screenshots/overview-views/shots.mjs

# 产物：server/cost/chain-{dark,light}-{1440,390}.png + report.json
```

- Playwright 从仓库 `.npm-cache/_npx/.../playwright` 取，不新增项目依赖。
- `report.json` 记录每张图的 `scrollWidth/scrollHeight`、`overflowX`、标签顺序、指标值和 console errors；本次 12 张全部 `overflowX=false`，`errors=[]`。
- 链路验证步骤见 §6；临时库在 `/tmp/overview-views/chain-validation.db`，可随时删除。

- Playwright is taken from the repo's npx cache; no new project dependency.
- `report.json` records size, overflow, tab order, metrics and console errors; all 12 shots have `overflowX=false` and no console errors.
- Chain validation is in §6; the temp DB is under `/tmp/overview-views/` and can be deleted.

## 11. 未做 / Limitations

- 只做设计稿；`web/src`、`crates/`、schema 未改；没有接真实接口。
- 汇率默认值是示意，不是实时汇率；没有汇率历史。
- 成本年度数字是当前配置的**投影**，不是实际付款流水。
- 服务器负载未按核数归一；热力图综合色是“最差维度”的近似，具体维度要切 chip 或看 tooltip。
- 链路历史不含最后一跳到目标；多路径为估算；preview 的链成员为 0，真实环境需要可用的链配置。
- 未提交 commit；`git status` 只有 `web/screenshots/overview-views/` 新增。
- 没有跑 `make check`：本次没有产品代码改动；真正落地时再按仓库约定跑 `make check`（fmt / clippy / test / web-build / web-test）。

- Design only; no product code/schema changes and no live API. `make check` was not run because no product code changed; run it when implementing.
- FX defaults are illustrative; no rate history.
- Annual cost is a projection, not a payment ledger.
- Load is not per-core; composite heatmap is a “worst dimension” approximation.
- Chain history excludes final hop → target; multi-path is an estimate; preview has zero members.
- Not committed; `git status` shows only the new `web/screenshots/overview-views/` directory.
