# 服务器详情 `/status/:id` / Server detail

所有者决策的独立公开页面：**不展示节点、不新增后端接口**，只读现有
`GET /api/v1/public/status` 的服务器字段，沿用 20 秒轮询。

## 怎么跑 / How to run

```bash
cd web
NPM_CONFIG_CACHE=/Users/jlthzy/Documents/mmrust/.npm-cache npm run build
npx vite preview --port 4173 --strictPort
# 另一个终端 / another shell
BASE_URL=http://localhost:4173 node screenshots/status-detail/shots.mjs
```

Playwright 拦截公开状态接口，不启动后端、不写库。产物是 24 张状态矩阵
（6 态 × 1440/390 × 亮/暗）+ 英文 1 张 + 加载骨架 1 张 + 列表入口 1 张 +
「先成功后失败」的 error-last-success 1 张，共 **28 张** + `report.json`。

## 覆盖 / Coverage

| 状态 | 断言 |
|---|---|
| normal | 名称 / 国旗 / 分组 / 在线 pill；三个关键数字；24 格竖条 24 个；最低时段 03:00–04:00 · 91%；资源；`27 天后到期 · ¥268.00 / 月`；系统信息；页脚刷新提示；返回链接 40px |
| offline | pill 显示「离线」，仍展示离线前最后已知值（18 ms / 98% / 17.5 MB/s）；页脚显示最后上报 |
| nodata | 三个数字全是 `—`；24 格全是灰色空桶；最低时段省略；费用卡不渲染；`未上报` / `从未上报` |
| notfound | `该服务器不存在或已下线` + 返回列表 |
| error | 错误面板 + 重试 + 返回列表；`error-last-success` 额外验证「上次成功」时间 |
| disabled | 404 时沿用「状态页未开放」 |
| loading | 详情同形骨架（头部 / 三个数字 / 24 格 / 资源 / 系统），不是后台宽骨架 |

交互路径（`report.json` 的 `interactions`）：

- `fromList`：列表卡片点击 → `/status/srv-hk`；
- `backToList`：详情「返回列表」→ `/status`，8 张卡恢复；
- `keyboard`：聚焦卡片链接 + Enter → 详情；
- `deepLink`：直接打开 `/status/srv-hk`；
- `errorLastSuccess`：先成功、再让接口 500，错误面板显示上次成功时间。

## 规则 / Rules

- 卡片是一个真实的 `<Link>`，不是 `role="link"` 的手写键盘处理；保留
  `group-hover:ring-1 group-hover:ring-primary/70 group-hover:shadow-sm`，
  右上角只加一个极轻的 `ChevronRightIcon`，不加文字。
- 详情页用与 hero 相同的文字层级：数字 **19/28px**、单位 **12px**；390 下
  三组数字单列堆叠，无横向溢出；返回按钮 **40px** 高。
- 不展示 IP / 地址、节点列表、用户数、流量明细；只用公开 DTO 已有字段。
- 详情页与列表共用 `StatusHeader`，页头在跳转时不会跳动。
- `buckets_24h` 全空时详情数字也显示 `—`（与 hero 的 F6 一致），不拿
  `uptime_24h` 造一个「100% + 灰色空桶」的矛盾。

## 文件 / Files

- `shots.mjs`：截图 + 断言 + 交互路径。
- `fixtures.mjs`：normal / offline / nodata；失败与 404 由脚本注入。
- `report.json`：最近一次实测。
- `normal-*`, `offline-*`, `nodata-*`, `notfound-*`, `error-*`, `disabled-*`：
  6 态 × 亮/暗 × 1440/390。
- `normal-dark-1440-en.png`、`loading-dark-1440.png`、`list-entry-dark-1440.png`、
  `error-last-success-dark-1440.png`。

---

## English summary

`/status/:id` is a separate public server-detail page built entirely from the
existing `GET /api/v1/public/status` payload — no new backend endpoint, no
addresses, node lists, users or traffic detail. The page reuses the shared
status header, keeps 20-second polling, and shows name/flag/group/state pill,
three key numbers (19/28px with 12px units), 24 vertical availability bars with
the three availability tiers, resources, billing/expiry (only when present),
system information, and a footer with relative last-seen time (absolute on
hover) plus the refresh hint.

The list cards are real links to the detail page (whole card clickable, keyboard
Enter works), keep the 1px primary hover ring and shadow, and add only a small
chevron hint. Back links, retry buttons and not-found actions are 40px tall.
States covered: normal, offline (last known values kept, "offline" pill), no
data (`—`, grey empty buckets, no billing card), not found (with back), request
failure (retry + last success), disabled (404 reuses the closed-page panel), and
a detail-shaped loading skeleton. All six states are captured at 1440/390 in
both themes with zero horizontal overflow.
