# 四项前端改动验收 / Four frontend changes

只改 `web/`。截图均为 1440×1000 / 390×844、亮/暗两套；亮暗通过
`localStorage.pierwave.theme` 固定，语言固定为 `zh-CN`。数据全部来自本地
master（`admin/devpass`，fresh DB）；公开详情用 `status-detail/fixtures.mjs`
的 fixture 走路由拦截，未新增后端接口。

All changes are limited to `web/`. Screenshots cover 1440×1000 and 390×844 in
both light and dark; theme is pinned through `localStorage.pierwave.theme` and
the UI language is `zh-CN`. Data comes from a local master (`admin/devpass`,
fresh DB); the public detail page is driven by the existing fixtures through
route interception, with no new backend endpoint.

## 1. 常规设置：短卡双列 / Short cards side by side

实际页面（当前 `main`）的常规 tab 只有 **5 张卡**，不是需求里写的 10 张。
顺序固定为：面板 → 版本更新 → 对外地址 → Agent 升级 → 公开状态页，
桌面端与 390 单列完全一致。

The current regular tab has **five cards**, not the ten mentioned in the brief.
The order is fixed: Panel → Updates → Public base → Agent upgrade → Public
status, identical on desktop and at 390.

实测卡片高度（1440，亮色）：

Measured card heights at 1440 light:

| 卡片 / Card | 整卡高 / Card height | 正文高 / Body height | 处理 / Treatment |
|---|---:|---:|---|
| 面板 / Panel | 173 | 83 | 整宽 / full width |
| 版本更新 / Updates | 316 | 222 | 与对外地址并排 / paired with public base |
| 对外地址 / Public base | 311 | 221 | 与版本更新并排 / paired with updates |
| Agent 升级 / Agent upgrade | 173 | 83 | 整宽 / full width |
| 公开状态页 / Public status | 218 | 128 | 整宽 / full width |

理由：只并排语义相邻、高度接近的「版本更新 + 对外地址」。两张卡的正文
222/221px < 260px，并排后 564px 宽仍能放下各自的两列字段与示例块，
整卡 316/311px，并排后按 `items-stretch` 拉平为 316/316（差 5px）。
面板与 Agent 升级都是单字段短卡，但不拆开版本相关的一组；公开状态页
内部已经是双列，外层再并排会过窄，因此三者都保持整宽。

Rationale: only the semantically adjacent and height-compatible pair
"Updates + Public base" is put side by side. Their body heights are 222/221px
(< 260px), and at 564px wide each still fits its internal two-column fields
and example block; the 316/311px cards stretch to 316/316 (5px difference).
Panel and Agent upgrade stay full width so the version-related group is not
split, and public status already has a two-column body and would be too narrow
if paired.

- 面板整宽 / panel full width: 173px
- 版本更新 + 对外地址 / updates + public base: 316 / 316，等高于 564px 宽
- Agent 升级整宽 / agent upgrade full width: 173px
- 公开状态页整宽 / public status full width: 218px
- 行内空白 / inner blank: PublicBase 5px, Updates 0px.

页面高度 / Page height:

| 宽度 / Width | 改前 / Before | 改后 / After | 变化 / Delta |
|---|---:|---:|---:|
| 1440 | 1573 | 1238 | −335 (−21.3%) |
| 390 | 2141 | 2141 | 0% (单列，顺序不变 / single column, same order) |

390 顺序 / 390 order（未变 / unchanged）：
面板 → 版本更新 → 对外地址 → Agent 升级 → 公开状态页。

1440 视觉顺序 / 1440 visual order（与 390 相同 / same as 390）：
面板整宽 → 版本更新 + 对外地址并排 → Agent 升级整宽 → 公开状态页整宽。

截图 / Screenshots：`before-settings-{light,dark}-{1440,390}.png`、
`after-settings-{light,dark}-{1440,390}.png`；几何数据见
`before-settings-report.json` / `after-settings-report.json`。

## 2. 404

- 公开区 `/status/*` 的未知子路径（`/status/no/such/path`）→ 公开 404；
- 登录后未知路径（`/no-such-page`）→ 控制台 404；
- 未登录访问受保护路径仍先去登录：`/settings`、`/servers`、
  `/me/packages`、`/no-such-page` 均跳到 `/login?next=...`。
- 三个出口：回控制台 / 查看公开状态 / 返回上一页。
- 卡片高度：1440 317px；390 373px。

- Unknown `/status/*` subpaths render the public 404; unknown signed-in paths
  render the console 404. Unauthenticated protected paths still go to
  `/login?next=...` first. Three exits: console / public status / back.

截图 / Screenshots：`notfound-{public,console}-{light,dark}-{1440,390}.png`，
另有英文 `notfound-public-light-1440-en.png`；几何见 `notfound-report.json`。

## 3. 用户端套餐空态 / Packages empty states

| 状态 / State | 1440 内容高 / content height | 390 内容高 / content height |
|---|---:|---:|
| 无套餐 / no packages | 676 → 395 (−41.6%) | 698 → 395 (−43.4%) |
| 有套餐、无历史 / one package, no history | 536 → 588 (+52) | 579 → 631 (+52) |

- 无套餐：只有一张页面级空态（含「联系管理员开通」），历史与事件区都不渲染；
  事件查询也停止（`enabled=false`）。
- 有套餐、无历史：历史区只保留 36px 高的一行提示；事件区正常显示。
- 页面级空态卡 253px（内层 EmptyState 221px）。

- No packages: one page-level empty state with the contact-admin hint; history
  and events are not rendered and the events query is disabled.
- Has packages, empty history: a 36px one-line hint; events still render.

截图 / Screenshots：`{before,after}-packages-{nopkg,onepkg}-{light,dark}-{1440,390}.png`，
几何见对应的 `*-packages-report.json`。

## 4. 详情页 ② 卡摘要 / Availability summary

由现有 `buckets_24h` + `outage_minutes_24h` 推导，没有新接口：

Derived from existing `buckets_24h` + `outage_minutes_24h`, no new API:

- 全正常 / healthy：「过去 24 小时持续在线，无中断」
- 有中断 / incident：「过去 24 小时中断 2 次，累计 3 小时 12 分」
- 无采样 / no samples：「过去 24 小时暂无采样」

摘要为 12px 次要色一句话，位于标题下、栅格上；栅格未动。
1440：② 卡 359.19px（与 ① 卡等高），摘要行高 19.19px，栅格 y=206.19。
390：② 卡 345.19 / 365.19 / 344.19px（healthy / incident / nodata），
页面高度 1447 / 1467 / 1289px，无横向溢出。

12px muted one-liner above the existing grid; grid unchanged. At 1440 the
availability card is 359.19px and equals the overview card. At 390 the card
is 345.19 / 365.19 / 344.19px and the page is 1447 / 1467 / 1289px with no
horizontal overflow.

截图 / Screenshots：`status-summary-{healthy,incident,nodata}-{light,dark}-{1440,390}.png`，
几何见 `status-summary-report.json`。

## 5. 我的概览底部卡 / Me overview bottom cards

删除「最近登录」卡及其数据链路，只保留整宽的「登录设备」：

- 删除 `RecentLoginsCard`、`useRecentLogins`、`queryKeys.recentLogins`、
  `RecentLogin` 类型、`api.sessions.recentLogins()`、`formatLoginTime`、
  `LoginRecordLike`、`LOGINS_EMPTY_KEY` 与 `sessions.history.*` 中英键；
- `/api/v1/me/logins` 不再被请求：改前 1 次，改后 0 次；
- 页面文字不再出现「最近登录」：`hasRecentLoginText=false`；
- 登录设备不再包在 `lg:grid-cols-2` 里，直接进入页面纵向卡片流。

几何 / Geometry（亮色，暗色相同 / light, dark identical）：

| 项目 / Item | 1440 改前 / before | 1440 改后 / after | 390 改前 / before | 390 改后 / after |
|---|---:|---:|---:|---:|
| 登录设备宽 / devices width | 568 | **1152** | 342 | **342** |
| 登录设备高 / devices height | 269.7 | 269.7 | 385.7 | 385.7 |
| 最近登录高 / recent height | 185.7 | 删除 / removed | 185.7 | 删除 / removed |
| 两卡底边差 / bottom mismatch | 84 | 0 (no pair) | — (stacked) | — |
| 页面高 / page height | 1099 | 1099 | 1468 | **1266** |
| 卡片内空白 / inner blank | 0 | 0 | 0 | 0 |
| 退出按钮高 / exit button | 28 | 28 | **40** | **40** |

- 1440 页面高度不变，因为该行由较高的登录设备卡决定；删除后 84px 的底边
  错位直接消失，没有留下空列或残留间距。
- 390 页面高度 −202px（−13.8%），单列、无横向溢出，退出按钮 40px。
- 其余卡片（概览卡、近 7 天用量）均为 1152/342px 整宽，`innerBlank=0`，
  没有 >24px 的无用底部空白。

At 1440 the page height stays 1099px because the taller devices card already
set the row height; removing the shorter card eliminates the 84px bottom
mismatch without leaving an empty column or gap. At 390 the page shrinks from
1468 to 1266px with no horizontal overflow; exit buttons are 40px. All cards
are full-width (1152/342px) with zero inner bottom blank.

截图 / Screenshots：`me-overview-{before,after}-{light,dark}-{1440,390}.png`，
几何见 `me-overview-{before,after}-report.json`。

## 验证 / Verification


```bash
cd web
npm test                 # green；基线 846 全绿（并行 lane 另有新增用例，当前总数 863）
npx tsc -b --noEmit      # green
npm run build            # green
```

未 commit / not committed.
