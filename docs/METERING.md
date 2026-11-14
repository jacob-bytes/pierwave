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

## 6. 转发流量（第二期，迁移 0045 / 0048）

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
  - 升级前的历史行 `weighted` 默认 0，**不追算**：当时的方向/倍率没有留存快照，
    用今天的套餐去回填只会张冠李戴。
- 配额：`users.used_bytes` 与生效套餐的 `user_packages.used_bytes` 只累加
  **weighted**（瀑布分配，与 Xray 相同）；没有生效套餐时只写日表两列，不累加。
- 「认领差值 + 日表 upsert + 用户/套餐累加」在同一个 `BEGIN IMMEDIATE` 事务内，
  `forwards.last_traffic_in/out` 作为上次采样基线并用旧值做条件更新，
  并发两轮采样不会重复计同一段增量。

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
with a conditional update on `forwards.last_traffic_in/out`, so concurrent
rounds cannot double-count the same delta.

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
