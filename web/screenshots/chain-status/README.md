# 链状态与状态点验收 / Chain status and status dot

**中文**：本目录验收「链路时延」这一版的状态改动，全部在 `web/`：

1. 列表状态列的圆点从 6px 增到 8px；详情拓扑节点圆点从 6px 增到 7px。
   呼吸动画（`status-breathe`，2s）不变，`prefers-reduced-motion` 仍然静止。
2. `chainStatus()` 优先读新契约 `chains[].status.kind`：`blocked` → 阻断、
   `degraded` → 降级；缺失 / `kind` 非法时回退到旧的「变慢 / 样本」判定。
   `kind = ok` 没有样本时仍显示「样本不足」，不会被画成正常。
3. 列表状态文案与颜色：正常 `--primary`、降级 `--warning`、阻断
   `--destructive`、样本不足 muted；停用保留。
4. `cause = node_offline / node_unhealthy` 且 `node` 存在时，行内在链路名下补
   一行小字（`节点 大阪-01 离线` / `节点 东京-01 异常`），状态列 title 同步带
   原因；详情弹窗顶部显示徽章 + 原因（`阻断 · 大阪-01 离线`）。
5. 「变慢」徽章只在 `kind = ok`（或旧契约回退）且时延 ≥ 8ms 时出现；
   阻断 / 降级 / 停用时不再同时挂「变慢」，避免两个徽章打架。

**English**: Acceptance for the chain-status change, entirely under `web/`:

1. the list status dot grows from 6px to 8px, and the topology node dot from
   6px to 7px. The 2s `status-breathe` animation is unchanged and still stops
   under `prefers-reduced-motion`.
2. `chainStatus()` now prefers the new `chains[].status.kind`: `blocked` →
   Blocked, `degraded` → Degraded. When the field is missing or the kind is
   invalid it falls back to the existing slow / sample logic. `kind = ok` with
   no samples is still "Not enough samples", never "Normal".
3. list status labels/colours: Normal `--primary`, Degraded `--warning`,
   Blocked `--destructive`, Not enough samples muted; Disabled is preserved.
4. when `cause = node_offline / node_unhealthy` and `node` is present, the row
   adds one small line under the chain name (`节点 大阪-01 离线` /
   `节点 东京-01 异常`) and the status-cell title carries the reason. The
   detail dialog header area shows the badge plus reason
   (`阻断 · 大阪-01 离线`).
5. the "Slow" badge only appears when the chain is `ok` (or on the old
   fallback path) and latency is ≥ 8ms; Blocked / Degraded / Disabled never
   show it at the same time.

## 文件 / Files

- `list-{1440,390}-{dark,light}.png`：三种状态同屏的列表（阻断 / 正常 + 变慢 /
  降级）。
- `detail-blocked-{1440,390}-{dark,light}.png`：阻断详情，顶部徽章
  `阻断 · 大阪-01 离线`，拓扑 `大阪-01` 红点与其余绿点同屏。
- `detail-degraded-{1440,390}-{dark,light}.png`：降级详情，
  `降级 · 东京-01 异常`。
- `report.json`：33 项断言（状态文案 / 顺序、圆点 8px 与 7px、语义色、
  行内原因与 title、变慢徽章互斥、390 无溢出、详情徽章、拓扑红点与
  呼吸动画、reduced-motion）。

## 数据说明 / Data note

数据来自真实主控（`data/preview.db` 的副本，样本平移到当前窗口）。后端
另一条 lane 尚未把 `chains[].status` 合入本机二进制，因此 `shots.mjs` 只在
浏览器层补该字段：

- `港日中转链` → `blocked / node_offline / 大阪-01`（节点状态是真实的
  `offline`，其它跳样本正常——正是回归要求的场景）；
- `港新直达链` → `ok`，只把第一段 `delta_ms` 调成 9 让它出现「变慢」；
- `港日多路径` → `degraded / node_unhealthy / 东京-01`，并把该链的
  `大阪-01` 节点改为 online、`东京-01` 改为 unhealthy，使拓扑红点与徽章
  原因一致。

曲线、P50、丢包、端点、链列表其余字段都来自真实接口；只有上面列出的
状态字段与一个 `delta_ms` 是为了同屏演示而注入。

Data comes from a real controller (a copy of `data/preview.db` with samples
shifted into the current window). The backend lane has not landed
`chains[].status` in the local binary yet, so `shots.mjs` only patches that
field in the browser. `港日中转链` becomes Blocked from its real offline
`大阪-01` node (other hops have healthy samples — the required regression),
`港新直达链` becomes Ok with one segment's `delta_ms` set to 9 to show the Slow
badge, and `港日多路径` becomes Degraded on `东京-01` (its node status is
patched to `unhealthy` and `大阪-01` back to `online` so the topology dot and
the badge agree). Series, P50, loss, endpoints and the rest of the list stay
real.

## 重新生成 / Regenerate

```bash
# 1) 复制真实预览库并平移样本到当前窗口
sqlite3 data/preview.db ".backup 'data/chain-status-preview.db'"
NOW=$(date +%s)
MAXL=$(sqlite3 data/chain-status-preview.db "select max(ts) from forward_latency_samples;")
MAXP=$(sqlite3 data/chain-status-preview.db "select max(ts) from forward_probe_samples;")
sqlite3 data/chain-status-preview.db \
  "update forward_latency_samples set ts = ts + $((NOW - 120 - MAXL));
   update forward_probe_samples  set ts = ts + $((NOW - 120 - MAXP));"

# 2) 起主控（后台）与前端
PIERWAVE_ADMIN_PASSWORD=devpass PIERWAVE_ADDR=127.0.0.1:8787 \
  PIERWAVE_DB='sqlite://data/chain-status-preview.db?mode=rwc' \
  ./target/debug/pierwave-master
cd web && npm run dev

# 3) 生成截图与断言
node web/screenshots/chain-status/shots.mjs
```

预览库里的 admin 密码不是 `devpass` 时，先用本地 `argon2id` 重算
`users.password_hash`，或设置 `ADMIN_PASSWORD` 指向已有密码。
Playwright 从仓库 `.npm-cache/_npx/.../playwright` 取，不新增项目依赖；
需要本机 Chrome（默认 `/Applications/Google Chrome.app`，可用
`CHROME_PATH` 覆盖）。

If the preview DB's admin password is not `devpass`, recompute
`users.password_hash` with local `argon2id`, or point `ADMIN_PASSWORD` at the
existing password. Playwright is loaded from the repo's
`.npm-cache/_npx/.../playwright` (no new dependency) and needs local Chrome
(default `/Applications/Google Chrome.app`, override with `CHROME_PATH`).

## 实测 / Measured

| 项目 | 结果 |
|---|---|
| 列表状态点 | 8 × 8 px（阻断、正常、降级三行一致） |
| 拓扑状态点 | 7 × 7 px；target 不画点 |
| 阻断链 | 节点 `大阪-01` 离线、其它跳有样本 → 状态 `阻断`，不显示「变慢」 |
| 正常链 | `kind=ok` + delta 9ms → `正常` + 「变慢」 |
| 降级链 | `降级`，拓扑 `东京-01` 红点，不显示「变慢」 |
| 行内原因 | `节点 大阪-01 离线`；title `阻断 · 节点 大阪-01 离线` |
| 详情徽章 | `阻断 · 大阪-01 离线`、`降级 · 东京-01 异常` |
| 390 | 页面与三行均无横向溢出 |
| reduced-motion | 在线点 `animation: none` |

`report.json` 的 33 项全部通过；light / dark 两套主题都读实际计算色再比对。
