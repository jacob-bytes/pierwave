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

## 6. 转发流量（第二期，迁移 0045）

单跳转发不经过 Xray，Agent 在心跳里上报每条规则的**累计字节**
`forward_status.traffic_in/out`。主控每 60 秒采样一次
（`scheduler::spawn_forward_traffic_sampler`）：

```
delta = current - last                    // 正常递增
delta = current                           // current < last：计数器重置
```

- 只处理 `owner_user_id IS NOT NULL AND count_traffic = 1 AND enabled = 1`；
  管理员规则（无 owner）与关闭计费的规则不参与。
- 差值按 UTC+8 自然日写 `forward_traffic_daily(day, forward_id, user_id, bytes)`；
  与 `traffic_daily` 分账，Xray 口径不变。
- 同一个 delta 累加到 `users.used_bytes` 与生效套餐的
  `user_packages.used_bytes`（瀑布分配）；无生效套餐时只记日表。
- 「认领差值 + 日表 upsert + 用户/套餐累加」在一个 `BEGIN IMMEDIATE` 事务内，
  `forwards.last_traffic_in/out` 作为上次采样基线并用旧值做条件更新，
  并发两轮采样不会重复计同一段增量。

English: single-hop forwards bypass Xray; the Agent reports cumulative
`forward_status.traffic_in/out` per rule in heartbeats. The master samples every
60 seconds and computes `current - last` (treating `current < last` as a counter
reset, delta = `current`). Only owned rules with `count_traffic = 1` and
`enabled = 1` are sampled. Deltas go to `forward_traffic_daily` (separate from
`traffic_daily`, so Xray accounting is untouched) and to `users.used_bytes` plus
the active package's `user_packages.used_bytes` via waterfall allocation. Each
rule's claim/upsert/allocation is one `BEGIN IMMEDIATE` transaction with a
conditional update on `forwards.last_traffic_in/out`, so concurrent rounds
cannot double-count the same delta.
