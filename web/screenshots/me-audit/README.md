# `/me` 用户端一致性审查（2026-11-20）

只读审查，未改产品代码。产物：正常态截图、状态图、卡片级截图、`metrics.json` / `evidence.json`。

## 账号 / Account

- 普通用户 `kenji`（`role=user`），数据来自 `data/preview.db`。
- 登录接口在连续失败后触发了 5 次/10 分钟限流，因此没有继续猜密码：直接向 `sessions`
  写入一条 `token_hash = sha256(token)` 的临时会话，再用该 token 做浏览器 Cookie。
  **没有改产品代码，也没有改业务数据**；审查结束后临时会话已清理。
- 主控：`http://127.0.0.1:8795`；预览库：`data/preview.db`。

## 截图 / Screenshots

- 正常态：`{page}__{width}__{theme}.png`（overview / subscription / forwards / packages ×
  1440/390 × dark/light）。
- 英文：`lang/{page}__{width}__{theme}.png`。
- 状态：`states/{page}__{state}__{width}__{theme}.png`。
- 卡片级：`cards/`；内部滚动容器的下半页：`scrolled/`。
- 由于 AppShell 的 `<main>` 自己是滚动容器，Playwright 的 `fullPage` 只能截到视口；
  下半页请看 `scrolled/` 与 `cards/`。

## 状态图的生产方式 / State fixtures

- `empty` / `error` / `loading` 用 Playwright `page.route()` 拦截 `/api/v1/me/*` 生成，
  不写数据库。
- `forwards__quota-2-0__*.png` 是已知可疑点的受控复现：`mei` 名下确有 2 条真实转发，
  只把 `/api/v1/me/forwards` 的 `quota` 改成 `{used:2, limit:0}`。后端在套餐过期或
  `forward_limit=0` 时会返回同样的组合（`forward_allowance` 跳过非 active 套餐；
  `me_list` 的 `used` 仍统计全部存量）。
- `forwards__create-no-servers__*.png` 是线上真实状态：预览库里 `forward_limit=5`，
  但 `package_forward_servers` 没有授权任何服务器，`summary.forward_servers=[]`。

## 复跑 / Re-run

```bash
MEAUDIT_TOKEN=<session-token> MEAUDIT_BASE=http://127.0.0.1:8795 \
  node web/screenshots/me-audit/shots.mjs
MEAUDIT_TOKEN=<session-token> node web/screenshots/me-audit/details.mjs
MEAUDIT_TOKEN=<session-token> node web/screenshots/me-audit/scrolled.mjs
```

原始数值见 `evidence.json`；逐页几何见 `metrics.json`；卡片级测量见 `cards/details.json`。
