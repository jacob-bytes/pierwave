# 节点可达性探测（TCPing）/ Node reachability (TCPing)

## 中文

管理员在节点列表点行内「探测」，主控从**主控所在主机**发起一次 TCP 握手，
返回实时结果。结果不落库，也不自动轮询。

### 接口

```
POST /api/v1/nodes/{id}/tcping
```

成功（`200`）：

```json
{
  "reachable": true,
  "latency_ms": 42,
  "address": "203.0.113.10:443",
  "checked_at": 1730000000
}
```

失败也是 `200`（不可达是正常结果，不是服务端错误）：

```json
{
  "reachable": false,
  "error": "连接超时 / Connection timed out",
  "address": "203.0.113.10:443",
  "checked_at": 1730000000
}
```

只有这些情况会返回非 `200`：

| 状态 | 场景 |
|---|---|
| `401` | 未登录 |
| `403` | 已登录但不是管理员 |
| `404` | 节点不存在（`node.not_found`） |

### 目标地址优先级

1. **端口**：节点的 `public_port`（合法时）优先，否则用监听端口 `port`。
   NAT 机器上 `port` 只是 Agent 实际监听的端口，用户能连到的是映射后的
   `public_port`。
2. **主机**：服务器填了 `internal_address`，且**主控与服务器同网**时用内网
   地址；否则用服务器的公网 `address`。
   - 「同网」= 内网地址落在主控某个本机网卡的同一子网里（按网卡掩码计算）。
   - 内网地址填的是主机名、或与主控不同网段时，一律回退公网地址；主控不会
     先试探内网地址，因此不同网时不会白等一个超时。

### 限制与频控

- 单次 TCP 握手超时 `3s`；
- 仅管理员；
- 同一节点同时只跑一次探测：并发请求排队并复用同一个结果；
- 每个节点每 `5s` 最多真实探测一次，窗口内**复用上一次结果**（返回同样的
  `checked_at`），而不是返回 `429`。重复点击因此不会被当成扫描器；
- 每次真实探测写一条 `node.tcping` 审计，`detail` 只有 `reachable` /
  `latency_ms` / `error`，不含地址明文。

### 前端

- 每行一个图标按钮（tooltip「探测节点可达性」），点击后按钮进入 loading；
- 成功显示 `42 ms`（状态点 + primary 文字），失败显示「不可达」（muted）；
- 失败悬停显示后端返回的可读原因；成功悬停显示实际探测的 `host:port`；
- 结果保留到下次刷新页面，不自动轮询；
- `<768px` 时结果放在名称下方一行，避免行内空间不足；
- 不做批量探测。

## English

An admin clicks the inline Probe button in the node list. The controller opens one
TCP connection **from the controller host** and returns a live result. Results are
never persisted and never polled automatically.

### Endpoint

```
POST /api/v1/nodes/{id}/tcping
```

Success (`200`):

```json
{
  "reachable": true,
  "latency_ms": 42,
  "address": "203.0.113.10:443",
  "checked_at": 1730000000
}
```

Unreachable is also `200` (it is a normal result, not a server error):

```json
{
  "reachable": false,
  "error": "连接超时 / Connection timed out",
  "address": "203.0.113.10:443",
  "checked_at": 1730000000
}
```

Only these cases return a non-`200` status:

| Status | Case |
|---|---|
| `401` | Not signed in |
| `403` | Signed in but not an admin |
| `404` | Node not found (`node.not_found`) |

### Target address priority

1. **Port**: a valid `public_port` wins, otherwise the listen `port`. On NAT
   machines `port` is only what the Agent listens on; users can only reach the
   mapped `public_port`.
2. **Host**: use the server's `internal_address` only when the controller shares
   its network; otherwise use the public `address`.
   - "Shares its network" means the internal address falls inside the subnet of
     one of the controller's local interfaces (computed from the interface mask).
   - A hostname internal address or a different subnet always falls back to the
     public address. The controller never probes the internal address first, so
     a different network never costs an extra timeout.

### Limits and throttling

- TCP handshake timeout: `3s`;
- Admin only;
- At most one probe per node at a time: concurrent requests wait and reuse the
  same result;
- At most one real probe per node every `5s`; inside the window the **previous
  result is reused** (same `checked_at`) instead of returning `429`, so repeated
  clicks never look like scanning;
- Every real probe writes one `node.tcping` audit entry. `detail` contains only
  `reachable` / `latency_ms` / `error`, never the address in plaintext.

### Frontend

- One icon button per row (tooltip "Probe reachability"); the button enters
  loading on click;
- Success shows `42 ms` (status dot + primary text); failure shows "Unreachable"
  (muted);
- Hovering a failure shows the readable reason returned by the backend; hovering
  a success shows the probed `host:port`;
- Results stay until the next page refresh; no automatic polling;
- Below `<768px` the result moves to a line under the node name to save row space;
- No batch probing.
