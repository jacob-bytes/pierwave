# 流量计量（P2 的核心）

目标：把 `used_bytes` 从 0 变成真数字，并且**口径在代码里只有一处**。

## 1. 数据从哪来

Xray 的计数器。两层：

- `user>>>{email}>>>traffic>>>uplink|downlink` —— 按 client email 聚合，**计费只用这个**；
- `inbound>>>{tag}>>>traffic>>>uplink|downlink` —— 按入站聚合，用于节点视图与对账。

要让它有数，`build_config()` 必须补三块（当前没有，所以现在全是 0）：

```jsonc
"stats": {},
"policy": {
  "levels": { "0": { "statsUserUplink": true, "statsUserDownlink": true } },  // 用户级在 levels，不在 system
  "system": { "statsInboundUplink": true, "statsInboundDownlink": true }
},
// 再加一个只监听 127.0.0.1 的 api inbound（10085）+ 一条 routing 把 api 流量转给 api outbound
```

API 端口不要暴露公网：`listen: "127.0.0.1"`，且 routing 规则 `{"type":"field","inboundTag":["api"],"outboundTag":"api"}`。

## 2. Agent 侧：采样 + 增量

每 60s 执行一次（命令可配，便于测试）：

```
xray api statsquery --server=127.0.0.1:10085 -pattern "user>>>" -reset=false
```

输出是 `{"stat":[{"name":"user>>>a@b>>>traffic>>>uplink","value":"123"}, ...]}`。

- 内存里保留 `last: HashMap<email, (up, down)>`；
- `delta = now - last`；**若 `now < last` 说明 Xray 重启过，计数器归零** → `delta = now` 并记一次 warn；
- 只上报 delta 非零的项，`TrafficReport { seq, boot_id, deltas }` 走已有的 WS 通道；
- 失败不 panic：命令失败/输出不是 JSON → 记 warn，跳过本轮，下一轮重新建立基线（不要用失败值覆盖 last）。

## 3. 主控侧：归因 + 加权

email 格式 `{user_id}@{node_tag}`，按**最后一个 `@`** 切分（UUID 里没有 @）。

```
计费增量 = Σ (上行 + 下行) × 方向倍率 × 节点倍率
```

- 方向：`both` → up+down；`upload` → 仅 up；`download` → 仅 down。
  （注意：这**不采用**参考实现里「单向 ×1 / 双向 ×2」的写法——那种写法把「计哪几个方向」和「乘几倍」混在一起，容易算错。）
- 节点倍率：绑卡时快照在 `user_packages.node_ratio`，**之后改套餐模板不回溯**。
- 落库：
  - `traffic_daily(day, server_id, subject, uplink, downlink, weighted)` 累加原始值 + 加权值；
  - `users.used_bytes` 累加计费值；
  - 实例层：**瀑布分配** —— 按 `created_at` 顺序，先填满第一个未用尽的 active 实例，再填下一个。
    多卡拼车的用户在「哪张卡先扣」上不需要公平，只需要确定性。
- 幂等：`(server_id, boot_id, seq)` 已有一张 `traffic_reports` 表，重复上报直接丢。

## 4. 每日重置

`reset_day` 命中当天（UTC+8 自然日）时，把该实例 `used_bytes` 归零并把 `users.used_bytes` 相应扣减。
调度器用 tokio 每小时醒来一次、按「今天是否该重置 + 今天是否已经重置过」判断，不要做成常驻精确定时器。

## 5. 明确不做（本轮）

- 实时速率（需要两次采样求导，先不做，探针页后面再说）；
- 用尽自动断流（要改 inbound，属于「限速/封禁」那一层）；
- 外部订阅用量合并。

## 6. 转发流量（第二期，迁移 0045 / 0048 / 0051）

单跳转发不经过 Xray，Agent 在心跳里上报每条规则的**累计字节**
`forward_status.traffic_in/out`。方向与 Xray 对齐：`traffic_in` = 客户端 → 目标
（上行 / uplink），`traffic_out` = 目标 → 客户端（下行 / downlink）。主控每 60 秒
采样一次（`scheduler::spawn_forward_traffic_sampler`）：

```
delta = current - last                    // 正常递增
delta = current                           // current < last：计数器重置
```

- 只处理 `owner_user_id IS NOT NULL AND count_traffic = 1 AND enabled = 1`；
  管理员规则（无 owner）与关闭计费的规则不参与。
- **计费口径与 Xray 完全一致，而且用同一份实现**（不复制换算逻辑）：
  1. `metering::billing_terms(&instances)` 取生效套餐的 `(direction, node_ratio)`；
  2. `metering::weighted_bytes(delta_in, delta_out, direction, node_ratio)`：
     先按方向取数 → 再乘 ratio → 四舍五入到整数；
  3. `metering::waterfall(weighted, &instances)` 做实例瀑布分配。

  顺序固定为「方向取数 → 乘 ratio → 累加」，与
  `crates/master/src/routes/agent.rs::record_delta` 的 Xray 路径逐字节一致。
- 日表 `forward_traffic_daily(day, forward_id, user_id, bytes, weighted)`（迁移 0048）：
  - `bytes`：**原始**上下行之和，供对账；不受 direction / ratio 影响。
  - `weighted`：按上述口径换算后的值，参与配额。
  - 一次增量会按采样窗口分摊到它实际覆盖的每一天（迁移 0051，见下节
    「采样窗口与跨天分摊」）。
  - 升级前的历史行 `weighted` 默认 0，**不追算**：当时的方向/倍率没有留存快照，
    用今天的套餐去回填只会张冠李戴。
- 配额：`users.used_bytes` 与生效套餐的 `user_packages.used_bytes` 只累加
  **weighted**（瀑布分配，与 Xray 相同）；没有生效套餐时只写日表两列，不累加。
- 「认领差值 + 日表 upsert + 用户/套餐累加」在同一个 `BEGIN IMMEDIATE` 事务内，
  `forwards.last_traffic_in/out` 作为上次采样基线、`forwards.last_sampled_at`
  作为窗口起点，并用旧值做条件更新（CAS），并发两轮采样不会重复计同一段增量。

### 为什么日表要同时留 `bytes` 与 `weighted`

`bytes` 回答「这条规则实际搬了多少字节」：对账（nftables / realm 计数、用户申诉、
跨表核对）只认它，任何一次 `node_ratio` 调整都不会改写历史原始量。
`weighted` 回答「按套餐口径占多少额度」：配额判定与用量展示只认它。
两者合成一列时，倍率一变历史数字就跟着变，且无法解释差值来自哪里。
历史行不追算也是同一原则：宁可显示 0（升级前没有加权数据），也不伪造。

English: single-hop forwards bypass Xray; the Agent reports cumulative
`forward_status.traffic_in/out` per rule in heartbeats. `traffic_in` is the
client-to-target (uplink) direction and `traffic_out` is target-to-client
(downlink), matching Xray. Every 60 seconds the master computes
`current - last` (treating `current < last` as a counter reset, delta =
`current`). Only owned rules with `count_traffic = 1` and `enabled = 1` are
sampled. The billing terms are identical to the Xray path and share the same
implementation: `metering::billing_terms` picks `(direction, node_ratio)` from
the active package, `metering::weighted_bytes` selects bytes by direction, then
multiplies by the ratio and rounds, and `metering::waterfall` allocates the
weighted value. The order is always "direction → ratio → accumulate";
`crates/master/src/routes/agent.rs::record_delta` uses the exact same functions,
so both paths agree byte for byte.

`forward_traffic_daily` keeps `bytes` (the raw uplink+downlink sum, used for
reconciliation and independent of direction/ratio) and `weighted` (the billed
value, used for quota). Rows written before migration 0048 default `weighted`
to 0 and are not back-filled: the direction/ratio in effect at the time was
never stored, so replaying today's package over old traffic would misattribute
it. Only `weighted` feeds `users.used_bytes` and the active package's
`user_packages.used_bytes` (waterfall, same as Xray); without an active package
both columns are still written but nothing is accumulated. Claiming the delta,
the daily upsert and the allocation share one `BEGIN IMMEDIATE` transaction
with a conditional update on `forwards.last_traffic_in/out` and
`forwards.last_sampled_at`, so concurrent rounds cannot double-count the same
delta.

### 采样窗口与跨天分摊（迁移 0051）

Agent 只上报**累计计数器**，没有「每个字节发生在哪一秒」的信息；主控能确定的
只有「上一轮采样」到「这一轮采样」之间这段窗口的总增量。因此一次增量按下面的
规则分摊到它实际覆盖的 UTC+8 自然日：

- 窗口 = `[forwards.last_sampled_at, now)`。`last_sampled_at = 0`（从未采样，
  迁移 0051 带过来的历史行也是 0）按 `[now - 60s, now)` 处理，不回溯、不 panic；
- 按窗口落在各天的**秒数占比**切分，四舍五入到整字节，**余数补给最后一天**：
  各天 `bytes` 之和严格等于本轮认领的增量，不丢字节、不凭空造字节；
- `weighted` 用**同一组**秒数权重独立切分，各天之和严格等于本轮认领的总额；
  `users.used_bytes` / `user_packages.used_bytes` 仍然只累加一次总额；
- 窗口跨度 > 7 天时仍按比例分摊，但每轮在日志里 warn 一次（提示这是估算）；
  窗口超过 400 天（只可能来自脏数据或极端时钟跳变）裁剪到最近 400 天，
  只影响「摊到哪几天」，总量不变；
- 计数器没有变化（本轮没认领到增量）时**不推进** `last_sampled_at`，窗口保持
  打开。这样服务器离线 / 主控停机多天后重连，那段增量才会摊到离线实际覆盖的
  每一天，而不是全记到重连当天；
- 计数器归零（`current < last`）时 `delta = current`，这段 `current` 按整个窗口
  均速分摊——重启发生在窗口内的哪一刻不可观测，这是同一估算的一部分。

**这是按均匀速率的估算，不是真实时间归因。** 适用场景：正常 60 秒采样
（误差可忽略）、跨零点的一次采样、离线数小时到数天后的重连。误差来源：窗口内
流量通常不是匀速的（夜间空闲、白天突发、下载高峰），秒数比例会把高峰期的字节
摊到空闲时段；窗口越长误差越大（所以 > 7 天要 warn）；计数器重置时整段
`current` 被均摊在窗口内。我们**不做**别的近似：不按小时流量画像分配（没有每个
字节的时序数据，画像只会凭空造数据）；不拆到比自然日更细的粒度（对外口径只有
日账本，多出来的精度无法解释）；不沿用「整段记到本轮采样日」的旧行为（跨零点
与重连时会系统性错账）；也不用心跳间隔做插值（心跳同样只有累计值，只会引入
更多状态与竞态）。

升级影响：`last_sampled_at` 默认 0，升级后第一轮按「首次采样」处理，只记
`[now - 60s, now)` 的窗口，升级前的历史流量不回填。跨天分摊只改变「记在哪一
天」：用户 / 套餐用量与增量总额保持不变，只有日表 `day` 维度的数字（以及按天
查询的对账视图）会从「全记采样日」变成「按窗口分摊」。

English: Agents only report cumulative counters, so the master cannot see in
which second a byte moved. It only knows the total increment between the
previous sample and `now`, and allocates that increment across the UTC+8 days
the sampling window actually covers:

- window `[forwards.last_sampled_at, now)`. `last_sampled_at = 0` (never
  sampled; rows carried over by migration 0051 also start at 0) means
  `[now - 60s, now)` — no back-fill and no panic;
- split by the fraction of seconds each day falls inside the window, rounded
  to whole bytes, remainder to the last day, so the per-day `bytes` sum equals
  the claimed delta exactly: no byte lost, none invented;
- `weighted` is split independently with the same second weights, so its
  per-day sum equals the claimed total; `users.used_bytes` /
  `user_packages.used_bytes` still accumulate the total exactly once;
- spans longer than 7 days are still split proportionally but log one warning
  per round (flagging the estimate); spans longer than 400 days (only possible
  with corrupt data or extreme clock jumps) are clamped to the latest 400 days,
  which changes allocation only, never the total;
- a round that claims no delta does **not** advance `last_sampled_at`, keeping
  the window open. That is why an increment after hours or days offline spreads
  over the days it actually covers instead of landing on the reconnect day;
- on a counter reset (`current < last`) the delta is `current`, spread evenly
  over the whole window — the restart instant is unobservable and is part of
  the same estimate.

**This is a uniform-rate estimate, not true time attribution.** It applies to
normal 60-second sampling (negligible error), a single sample crossing
midnight, and reconnects after hours or days. Error sources: traffic is not
uniform inside the window (idle nights, daytime bursts, download peaks), so
byte-seconds get smeared into idle time; longer windows are worse (hence the
> 7 day warning); on a counter reset the whole `current` is smeared over the
window. We deliberately do **not** use an hourly traffic profile (no per-byte
timing data exists; a profile would invent one), split finer than a calendar
day (the external accounting unit is the daily table), keep the old "all bytes
to the sample day" behaviour (systematically wrong across midnight and
reconnects), or interpolate between heartbeats (heartbeats only carry
cumulative counters too and would add state and races).

Upgrade impact: `last_sampled_at` defaults to 0, so the first round after the
upgrade is treated as a first sample covering `[now - 60s, now)`; nothing from
before the upgrade is back-filled. Splitting only changes which day a byte
lands on: user/package totals and the increment total stay the same, while
day-level rows (and day-window reports) move from the sample day to the days
the window covers.

### 开启计费时的基线（离线场景）

`count_traffic` 从关到开必须与基线写在同一个 `BEGIN IMMEDIATE` 事务里：

- 服务器**在线**：基线对齐到当前累计计数器，关闭期间的增量不计；
- 服务器**离线**：心跳里的计数是旧的，此时基线写「待对齐」哨兵 `-1`，采样轮
  遇到离线服务器整条跳过；重连后的第一轮只把基线对齐到新鲜计数，不补记
  离线期间从旧计数涨到当前计数的那一段。

离线期间「计费开启时刻」的计数器不可观测：`1000 → 5000`（开启前）与
`5000 → 9000`（开启后）在重连时只剩一个 `9000`。因此这里**宁可少计 0，
也不把 8000 全部补记**；之后的增量照常计费。创建时 `count_traffic=true`
的新规则没有历史计数，基线从 0 开始，不受离线影响。

English: turning `count_traffic` on writes the baseline in the same
`BEGIN IMMEDIATE` transaction. When the server is online the baseline is aligned
to the current counters; when it is offline the old heartbeat is not trustworthy,
so both counters are set to a pending sentinel `-1`. Sampling skips offline
servers and the first sample after reconnect only aligns the baseline, never
back-fills the old counter range. The counter at the moment metering was enabled
is not observable (only `9000` remains after reconnect for `1000 → 5000 → 9000`),
so this deliberately under-counts that interval (0) instead of over-counting
`8000`; later increments bill normally. A newly created rule with
`count_traffic=true` has no history and starts from 0.

## 7. 对账接口

日表不再只写不读。管理员与用户各有一个**只读**接口，SQL 在
`repo::forward_traffic::summary`：

- `GET /api/v1/forward-traffic?days=7&user_id=&forward_id=`（仅管理员）
- `GET /api/v1/me/forward-traffic?days=7`（普通用户，只按会话用户过滤，响应不含 `user_name`）

`days` 必须是 1–90（缺省 7），越界或非整数一律 400（`forward_usage.days_invalid`）。
`days` 数组按 UTC+8 自然日升序补齐，缺失日补 0；`totals` 是窗口合计；
`by_forward` 按 `weighted`、`bytes` 降序。转发或用户被删除后，历史行**不丢**：
`name` / `user_name` 回落为「已删除」，并带 `forward_deleted` / `user_deleted`
标记，前端按当前语言显示。接口没有任何写路径，也不触发采样。

English: the daily table now has read paths. Both endpoints are read-only and
share `repo::forward_traffic::summary`. `days` must be 1–90 (default 7);
anything else is a 400 (`forward_usage.days_invalid`). The `days` array is
zero-filled in ascending UTC+8 day order, `totals` is the window sum, and
`by_forward` is ordered by `weighted` then `bytes` descending. Rows are never
dropped when a forward or user is deleted: `name` / `user_name` fall back to the
backend placeholder 「已删除」 and `forward_deleted` / `user_deleted` let the UI
render “Deleted” in English. The admin endpoint accepts optional `user_id` /
`forward_id` filters; the user endpoint always scopes to the session user and
omits `user_name`.
