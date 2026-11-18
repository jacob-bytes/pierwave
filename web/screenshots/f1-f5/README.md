# F1–F5 一致性修复：改前 / 改后实测

F1–F5 consistency pass: before/after measurements.

本轮只动 `web/`。截图与几何数据由 Playwright（Chrome for Testing，headless）在
1440×900 / 390×844、`deviceScaleFactor=1` 下用 `getBoundingClientRect()` 测得；
数据来自 fresh master（admin/devpass）+ 2 服务器 / 6 节点 / 4 套餐 / 6 用户 / 3 条链。

This pass touches `web/` only. Screenshots and geometry come from Playwright
(Chrome for Testing, headless) at 1440×900 / 390×844 with `deviceScaleFactor=1`,
measured via `getBoundingClientRect()` against a fresh master seeded with
2 servers / 6 nodes / 4 packages / 6 users / 3 chains.

## F3 行高 / Row height

表头 `h-10` 始终为 40.0px；数据行实测包含行边框，故为 40.5–41.4px。

The header row is a constant 40.0px; data rows measure 40.5–41.4px because the
row border is included in `getBoundingClientRect()`.

| 表格 / Table | 改前 / Before (px) | 改后 / After (px) |
|---|---|---|
| servers | 48.5 | 40.5 |
| users | 58.4–58.9 | 40.9–41.4 |
| packages | 48.9–49.4 | 40.9–41.4 |
| chains | 66.9–67.4 | 40.5–41.0 |
| nodes (`/servers/:id/nodes`) | 72.9–73.4 | 40.9–41.4 |
| subscriptions | 78.5–79.0 | 40.5–41.0 |
| forwards | 48.9 | 40.9 |

`outbounds` 在无数据时显示空态行（262.4px），不计入数据行。`outbounds` falls
back to its empty-state row (262.4px) with no data, so it is not a data row.

## F1 错误态 `role="alert"`

统计口径：让对应列表接口返回 500，数页面里 `[role="alert"]` 与「重试」按钮。

Method: force the list endpoint to return 500, then count `[role="alert"]` and
retry buttons on the page.

| 页面 / Surface | 改前 / Before | 改后 / After |
|---|---|---|
| /servers | 0 | 1 |
| /users | 0 | 1 |
| /packages | 0 | 1 |
| /chains | 0 | 1 |
| /nodes | 0 | 1 |
| /servers/:id/nodes | 0 | 1 |
| /servers/:id/forwards | 1（realm 提示 / realm notice） | 2（错误 + realm 提示 / error + realm notice） |
| /servers/:id/outbounds | 1（realm 提示 / realm notice） | 2（错误 + realm 提示 / error + realm notice） |
| /subscriptions | 0 | 1 |
| /logs?tab=events | 0 | 1 |
| /logs?tab=audit | 0 | 1 |
| /me | 0 | 1 |
| /me/forwards | 0 | 1 |
| /me/packages | 0 | 1 |
| /settings（10 个 panel / panels） | 4（仅 Alert 组件 / Alert only） | 10 |

改后每个错误态都同时有 `role="alert"` 与「重试」。After the change every error
state has both `role="alert"` and a retry button.

## F5 对话框页脚是否在视口内 / Dialog footer in viewport

`footerInViewport` = 页脚上下沿都落在视口内。`footerInViewport` means the footer's
top and bottom edges are both inside the viewport.

| 对话框 / Dialog | 改前 1440 | 改后 1440 | 改前 390 | 改后 390 |
|---|---|---|---|---|
| server create | ✅ | ✅ | ❌ (bottom 1022 > 844) | ✅ |
| server edit（同一套外壳，未单独测量 / same shell, not measured） | — | — | — | — |
| package | ❌ (1626 > 900) | ✅ | ❌ (2039 > 844) | ✅ |
| node | ❌ (1018 > 900) | ✅ | ❌ (1631 > 844) | ✅ |
| chain（基准 / baseline） | ✅ | ✅ | ✅ | ✅ |

## 复现 / Reproduce

```bash
# 1. fresh DB 启动 master / fresh DB master
PIERWAVE_ADDR=127.0.0.1:8787 \
PIERWAVE_DB='sqlite:///tmp/pw-f1/db.sqlite?mode=rwc' \
PIERWAVE_ADMIN_PASSWORD=devpass ./target/debug/pierwave-master

# 2. vite dev
cd web && npm run dev

# 3. 用 admin/devpass 登录后截图与测量 / sign in as admin/devpass, then measure
#    （脚本未入库：一次性验证用 / throwaway verification script）
```

截图命名：`before-*` / `after-*`，表格页为 1440，移动端补充 390。
Screenshots are named `before-*` / `after-*`; table pages are 1440, with 390 for
mobile checks.
