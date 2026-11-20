# W1–W5：改前 / 改后截图与实测 / Before–after screenshots and measurements

五项只改 `web/`。截图数据由 `seed.mjs` 写入本机预览库，`refresh.mjs` 在每次截图
前重采 24h 可用率；`shots.mjs` 按 `PHASE=before|after` 输出到对应目录并跑断言。

All five changes are in `web/` only. `seed.mjs` seeds a local preview DB,
`refresh.mjs` re-samples the 24h availability before every run, and `shots.mjs`
writes `before/` or `after/` based on `PHASE` and runs the assertions.

```bash
# 1) fresh DB + master (admin / devpass), then seed
PREVIEW_BASE=http://127.0.0.1:8798 DB_PATH=/tmp/pw-w15/db.sqlite \
  node web/screenshots/w1-w5/seed.mjs

# 2) W5 needs a *different* master key so the settings secrets cannot decrypt
PIERWAVE_SECRET_KEY="$(openssl rand -base64 32)" PIERWAVE_HEARTBEAT_TIMEOUT_SECS=86400 \
  PIERWAVE_ADDR=127.0.0.1:8798 PIERWAVE_DB='sqlite:///tmp/pw-w15/db.sqlite?mode=rwc' \
  ./target/debug/pierwave-master

# 3) before / after
DB_PATH=/tmp/pw-w15/db.sqlite node web/screenshots/w1-w5/refresh.mjs
PHASE=after BASE=http://127.0.0.1:8798 node web/screenshots/w1-w5/shots.mjs
```

## W1 可用率三档 / Three availability tiers

规则 / Rule：`≥99%` primary（正常）、`95–99%` warning（可用性下降）、`<95%`
destructive（可用性不足）。除颜色外，卡片 24h 进度条、7 天 / 列表可用率条、
汇总「平均可用率」都按同一百分比画**填充长度**，色盲用户也能区分 96% 与 71%。

| 样本 / Sample | 改前 / Before | 改后 / After |
|---|---|---|
| 100% | primary，条 139px/139px | primary，条 139px/139px |
| 99% | primary，条 137.6px | primary，条 137.6px |
| 96% | warning `oklch(0.53 0.146 49)`，条 133.4px | warning 同色，条 133.4px |
| 88% | warning，条 122.3px | **destructive** `oklch(0.57 0.208 25.3)`，条 122.3px |
| 71% | warning，条 98.7px | **destructive**，条 98.7px |
| 汇总 91% | 默认前景色，无填充条 | destructive + 填充条 |

（条宽是 24h Meter 的实测 `width`；百分比越低条越短。）

截图 / Screenshots：

- `before/w1-status-{light,dark}-{1440,390}.png`
- `after/w1-status-{light,dark}-{1440,390}.png`
- `after/w1-list-dark-1440.png`（列表视图 / list view）
- `before|after/w1-tier-100-primary-light-1440.png`
- `before|after/w1-tier-96-warning-light-1440.png`
- `before/w1-tier-71-warning-light-1440.png`、`after/w1-tier-71-destructive-light-1440.png`

概览页没有以百分比展示可用率的卡片；既有「转发链健康」卡是
ok / degraded / blocked → primary / warning / destructive，已是同一套语义色，
因此没有改它的状态定义。 / The overview page has no percentage-based
availability card; its existing chain-health card already maps
ok / degraded / blocked to primary / warning / destructive, so its status
semantics were left untouched.

## W2 概览榜单「服务器」行 / Overview server leaderboard rows

`<md` 收敛为两行：名称 + 状态点 + sparkline / `负载 0.82 · 925 GB` + 箭头；
`md` 以上用 `md:contents` 拆回单行，桌面顺序仍是「名称 → sparkline → 流量 →
状态点 → 负载 → 箭头」。

| 几何 / Geometry | 改前 390 / Before | 改后 390 / After |
|---|---|---|
| 每行高度 / row height | 44px | 64px |
| 行宽 / row width | 326px | 326px |
| 页面横向溢出 / page overflow | false（doc 390/390，main 390/390） | false（390/390，390/390） |
| 行内容 / text | `名称 \| 925 GB` | `名称 \| 负载 0.82 \| · \| 925 GB` |
| 点击 / click | → `/servers` | → `/servers`（断言通过） |

截图 / Screenshots：`w2-board-{light,dark}-{1440,390}.png`、
`w2-overview-{light,dark}-{1440,390}.png`（before/after 同名）。

## W3 移动端长文本复制 / Copy on mobile cards

服务器窄屏卡片的名称与地址行各加一个行内 `CopyButton`（仅卡片视图，即 `<md`），
桌面表格的 `title` 保留（名称与地址都补了）。复制成功走既有 sonner toast。

| 实测 / Measurement | 改前 / Before | 改后 / After |
|---|---|---|
| 卡片内复制按钮 / copy buttons | 0 | 2（名称、地址） |
| 名称 `title` | null | 完整名称 |
| 复制反馈 / toast | — | `已复制` |
| 390 横向溢出 | false | false |

截图 / Screenshots：`before|after/w3-servers-dark-390.png`、
`after/w3-copied-{dark,light}-390.png`（含 `已复制` toast）。

## W4 审计筛选收敛 / Audit filter groups

选择：**分组 tab（4 组 + 全部）**，不是下拉。

理由 / Why：5 个两字标签在 390 下只占 216px，能一屏看全、保持原来的
tab 键盘模型；下拉会把分类藏进二次点击，而且这一屏已有两个搜索框和一个
每页条数下拉。分组与侧栏一致：账号 / 资源 / 转发 / 系统。

| 实测 390 / Measurement | 改前 / Before | 改后 / After |
|---|---|---|
| 分类数 / categories | 11（`全部` + 10；任务写的 12 与代码实际不符） | 5 |
| 标签条宽度 / strip width | 580px（容器裁切） | 216px（完整可见） |
| 页面横向溢出 / page overflow | false（靠 ScrollFade 裁切） | false（doc 390/390，main 390/390） |
| 搜索 / 对象筛选 | 保留 | 保留 |

动作前缀 / Prefixes（后端 `LIKE 'prefix%'`）：

- 账号：`user.`, `user_package.`, `package.`, `package_instance.`
- 资源：`server.`, `node.`, `certificate.`, `rule_template.`, `routing_rule.`, `outbound.`
- 转发：`chain.`, `chain_template.`, `forward.`, `user_chain.`, `user_forward.`
- 系统：`settings.`, `password.`, `config.apply`, `agent.upgrade`, `auth.`, `backup.`, `api_token.`, `event.`, `updates.`, `subscription_template.`

截图 / Screenshots：`before|after/w4-audit-{light,dark}-{1440,390}.png`。

## W5 `hmac_secret_v1` 的下一步 / Next step for the internal secret

后端核对 / Backend check：

- `GET /api/v1/settings` 只上报三个可重填秘密（telegram / webhook / WebDAV），
  故意不读 `hmac_secret_v1`（`crates/master/src/routes/settings.rs` 的
  `load_inner`）。
- `credentials::master_secret` 只在行不存在时生成；已存在但解不开时
  `reveal_setting` 直接报错，没有“重新生成”语义（`crates/domain/src/credentials.rs`）。
- 没有设置接口 / 路由可以写 `hmac_secret_v1`，所以**不加「重新生成」按钮**。
- `POST /api/v1/backup/restore?force=true` 会丢弃解不开的 `enc:v1:` 行（含
  `hmac_secret_v1`），首次使用时重新生成，旧订阅链接失效
  （`crates/master/src/routes/backup.rs`；`docs/BACKUP_ENCRYPTION.md` §3–§4）。

因此恢复卡在该键旁给出后果与文档链接：

> 已生成的订阅链接也会失效，所有客户端需重新获取订阅链接。如需保留旧链接，
> 请从备份恢复 `secret.key`（或设置相同的 `PIERWAVE_SECRET_KEY`）；服务端没有
> 重新生成接口。

链接 / Link：`https://github.com/jacob-bytes/pierwave/blob/main/docs/BACKUP_ENCRYPTION.md`

因为后端不上报 `hmac_secret_v1`，前端在「任一秘密解不开」时按同一把主密钥
推断它也受影响，并显示该键的指引（`lib/settingsSecrets.ts`；有单测覆盖）。

| 实测 / Measurement | 改前 / Before | 改后 / After |
|---|---|---|
| 恢复卡高度 1440 / height | 152px | 273px |
| 展示的键 / keys | Telegram、WebDAV | Telegram、WebDAV、订阅派生 secret |
| 文档链接 / doc link | 无 | 1 条 |
| 「重新生成」按钮 | 无 | 无（后端不支持，不伪造） |
| 390 横向溢出 | false | false |

截图 / Screenshots：`before|after/w5-settings-{light,dark}-{1440,390}.png`。

## 测试 / Tests

`npm test`：654 pass（改前 647 + 新增 7 个用例），`npx tsc -b --noEmit` 与
`npm run build` 通过。

新增断言 / New assertions：

- `publicStatus.test.mjs`：99 / 95 / 0.949 / 71% 的三档边界；`availabilityFill` 夹取 0–100。
- `audit.test.mjs`：4 组 + 全部；每个后端 action 恰好落在一组；`user_chain` /
  `user_forward` 归转发；5 个标签中英都存在。
- `settingsSecrets.test.mjs`：keys 非空时推断 `hmac_secret_v1`、内部键不重复、
  文档 URL、`subscriptionSecretAtRisk` 边界。
- `tableCells.test.mjs`：W2 的 `md:flex-row` / `md:contents` / order 类；W3 的
  `titleCopyValue` / `subtitleCopyValue` / `CopyButton`，以及桌面 `title`。
- `shots.mjs`：W2 点击仍跳 `/servers`；W3 名称/地址复制按钮存在且 toast 出现；
  W4 390 只有 5 个 tab 且无横向溢出；W5 有文档链接、无伪造的重新生成按钮。

## English summary

- **W1**: availability is now `≥99%` primary, `95–99%` warning, `<95%`
  destructive. Every availability value also draws a proportional fill bar
  (24h meter, 7-day value, list cell, summary average), so colour-blind users
  can separate 96% from 71%. Before, 88% and 71% rendered as the same amber;
  after, both are destructive. Card 24h bar widths in the fixture: 139px
  (100%), 137.6px (99%), 133.4px (96%), 122.3px (88%), 98.7px (71%). The
  overview page has no percentage-based availability surface; its chain-health
  card already uses primary / warning / destructive and was left alone.
- **W2**: below `md` each server leaderboard row is two lines — name + status
  dot + sparkline, then `load 0.82 · 925 GB` + chevron. Row height goes from
  44px to 64px at 390px; the link stays 326px wide, the page has no horizontal
  overflow (`doc 390/390`, `main 390/390`), and clicking still navigates to
  `/servers`. Desktop order is unchanged via `md:contents` and explicit
  `md:order-*` classes.
- **W3**: server mobile cards now render an inline `CopyButton` next to the
  name and the address (0 → 2 buttons), keep the full text in `title`, and show
  the existing `已复制` toast. Desktop table cells keep their `title`; no
  horizontal overflow at 390px.
- **W4**: twelve-ish category tabs were grouped into four tabs plus `全部`
  (account / resources / forwarding / system). Chosen over a dropdown because
  the five two-character labels fit in 216px at 390px, keep the existing
  keyboard tab model, and avoid adding another click to every filter. The
  observed before state was 11 tabs (not 12) in a 580px strip clipped by
  `ScrollFade`; search and object filters are unchanged. Every backend action
  maps to exactly one group, and every group has rows in the fixture
  (13 / 10 / 1 / 11).
- **W5**: the backend has **no regenerate endpoint** for `hmac_secret_v1` and
  `GET /settings` never reports it; `master_secret` only generates when the row
  is absent and otherwise fails on decryption. The card therefore shows the
  consequence plus a link to `docs/BACKUP_ENCRYPTION.md`, and no fake
  “regenerate” button. The UI infers the internal key when any secret is
  unreadable because all `enc:v1:` values share the master key. Card height
  grows from 152px to 273px at 1440px.
- **Checks**: `npm test` 654 pass (647 baseline + 7 new tests),
  `npx tsc -b --noEmit` and `npm run build` pass.
