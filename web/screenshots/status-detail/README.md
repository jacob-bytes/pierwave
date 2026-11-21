# 服务器详情 `/status/:id` · 方案 B 仪表盘 / Dashboard

所有者选定的方案 B：桌面 1352px 两栏（左栏 420px + 右栏），移动端单列；
不新增接口，只读现有 `GET /api/v1/public/status`，20 秒轮询。

## 怎么跑 / How to run

```bash
cd web
NPM_CONFIG_CACHE=/Users/jlthzy/Documents/mmrust/.npm-cache npm run build
npx vite preview --port 4173 --strictPort
# 另一个终端 / another shell
BASE_URL=http://localhost:4173 node screenshots/status-detail/shots.mjs
```

Playwright 拦截公开状态接口，不启动后端、不写库。产物：7 态 × 1440/390 ×
亮/暗（28）+ 英文 healthy 1 + 加载骨架 1 + 列表入口 1 + hover tooltip 1 +
error-last-success 1 = **33 张** + `report.json`。

## 版式 / Layout

- 桌面：`grid-cols-[420px_minmax(0,1fr)]`，`items-stretch`，间距统一 16px。
  - 左栏：状态卡 → 三个数字 → 内存/硬盘环 + 负载。
  - 右栏：24h 曲线卡 → 费用 + 系统（同一行两张，等宽）。
  - 底部：全宽累计流量带，左右边界与两栏内容宽度一致。
- 卡片共享行基线（1440 实测）：
  - 状态卡顶边 = 曲线卡顶边 = **137px**；
  - 三个数字卡底边 = 曲线卡底边 = **510.59px**；
  - 资源卡顶边 = 费用/系统顶边 = **526.59px**；
  - 资源卡底边 = 费用/系统底边 = **812.48px**；
  - 流量带 x=44、宽 **1352px**，与 grid 完全对齐。
- 页面高 **1000px（1440）/ 1343px（390）**；页脚与流量带间距 **16px**，
  页底空白 **16px**；无横向滚动。
- 移动端顺序：状态 → 三个数字 → 24h 曲线 → 资源 → 费用 → 系统 → 累计流量。
- 资源选**环形**而不是条形：左栏只有 420px，两个环可以并排一次性表达
  “内存/硬盘百分比 + used/total”，不会像两条 Meter 那样再各占一整行。

## 24h 曲线 / 24h curve

- 0–100% 纵轴 + 时间横轴；step line + area，不是 24 根柱。
- **null 不参与高度**：缺失小时是整列斜线 hatch，不连线、不填充，绝不画成 100%。
- **0% 落基线且可见**：`y=96`（viewBox 高度 100 的底部留 4 给描边），
  实测 incident 的 3 个 0% 小时 step 线 y1=96。
- 相邻采样才连线；缺口两侧没有 step、没有 area、没有跨缺口 transition。
- 分段色：≥99 primary、95–99 warning、<95 destructive；健康态只有 primary
  + 极淡 area，不出现红色高饱和。
- crosshair + tooltip：鼠标 hover、触摸 pointerdown、键盘 focus + ←/→、Escape；
  tooltip 显示区间、百分比/无采样、档位；另有 24 条 `sr-only` 逐小时文本。
- 7 天可用率是 `uptime_7d` 标量 + 64px mini bar，不伪造逐日数据。

## 状态 / States

| 状态 | 断言 |
|---|---|
| healthy | 24 条 step 全 100%、0 缺口、无 warning/down；7d 100%；页面安静 |
| incident | 21 条 step、缺失 `[2,3,18]`；3 个 0% 贴基线；91% 为 down；缺口不连线 |
| offline | pill 离线；保留最后已知值；曲线仍是最后 24h |
| nodata | 0 step、24 个缺失 hatch；数字 `—`；7d `—`；费用卡消失，系统卡铺满 |
| notfound | `该节点不存在或已下线` + 返回列表 |
| error | 错误面板 + 重试 + 上次成功时间 |
| disabled | 404 沿用「状态页未开放」 |

交互路径（`report.json` 的 `interactions`）：列表点击进入、返回列表（8 张卡）、
键盘 Enter、直接深链接、曲线 hover / 键盘 / 触摸点按 tooltip、先成功后失败的上次成功时间。
触摸在 390px `hasTouch` 上下文实测：点 0% 小时返回 `08:00–09:00 0% 中断`。

## 文案 / Copy

- 「平均延迟」→ **延迟 / Latency**（`latency_ms` 是最近一次握手 RTT）。
- 404 → **该节点不存在或已下线 / This node does not exist or is offline**，
  与公开页「节点」术语一致。
- 三个时间信号：顶栏「更新于」、pill「在线 13 天」、页脚「最后上报」
  （绝对时间在 `title`；状态卡不再重复最后上报）。
- 不展示地址、节点列表、用户数；累计流量只用 `net_rx_bytes` / `net_tx_bytes`
  并标注「自开机以来」。

---

## English summary

`/status/:id` is the owner-selected dashboard (plan B), built from the existing
public status payload only. Desktop is a 1352px two-column grid (420px left +
right) with 16px gaps and `align-items: stretch`: status card, three numbers,
resource rings on the left; 24h curve, billing and system on the right; a
full-width cumulative-traffic band below. Rows align exactly (status top =
chart top, numbers bottom = chart bottom, resources top/bottom = billing/system
top/bottom). The page is 1000px tall at 1440 (1343px at 390), with 16px between
traffic and footer and 16px at the page bottom.

The 24h curve is a step line + area on a 0–100% / time axis. Missing hours are
full-height hatched columns and are never encoded as 100%; 0% sits visibly on
the baseline (y=96). Adjacent samples only are connected; gaps break both the
line and the area and never produce a transition across the gap. Segments are
tinted by the existing availability tiers, while an all-100% day stays quiet
(primary line + faint area). Crosshair tooltips work with mouse, touch and
keyboard, and a 24-item `sr-only` list gives every hour to screen readers.
Health/incident/offline/no-data/not-found/error are captured at 1440/390 in
both themes with zero horizontal overflow.
