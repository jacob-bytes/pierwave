# 入口端口未采用 + 降级 · 无样本 验收 / Ignored entry port + degraded-no-samples

**中文**：本目录验收这一轮 `web/` 改动：

1. 管理员与用户建链成功后，比较**请求里的 `entry_port`** 与响应里的实际入口端口。
   一致 / 没填 → 原成功 toast；不一致（旧主控忽略 `entry_port`）→ warning toast
   「端口 24321 未被采用，实际为 24000（保存后可在链路详情看到）」。
2. 详情徽章在 `status.kind = degraded` 且 `cause = no_samples` 时显示
   `降级 · 无样本`；节点离线 / 异常仍是 `阻断 · 大阪-01 离线` /
   `降级 · 东京-01 异常`，`slow` 仍是 `降级 · 变慢`。
3. 模板没有 `entry_port_start` / `entry_port_end` 时不显示任何端口范围提示，
   前端不再拿入口服务器的 `port_start` / `port_end` 拼范围。

**English**: Acceptance for this round of `web/` changes:

1. after a successful create from either side, compare the requested
   `entry_port` with the actual entry port in the response. Equal / omitted →
   the existing success toast; different (an old master ignored `entry_port`) →
   a warning toast: “端口 24321 未被采用，实际为 24000（保存后可在链路详情看到）”.
2. the detail badge shows `降级 · 无样本` when `status.kind = degraded` and
   `cause = no_samples`. Node causes stay `阻断 · 大阪-01 离线` /
   `降级 · 东京-01 异常`, and `slow` stays `降级 · 变慢`.
3. no port-range hint is rendered when the template lacks
   `entry_port_start` / `entry_port_end`; the entry server's
   `port_start` / `port_end` is no longer used as a fabricated range.

## 文件 / Files

- `user-create-ignored-port-{1440,390}-dark.png`：用户建链后 warning toast，
  列表里显示实际入口 `203.0.113.11:24000`。
- `admin-create-ignored-port-{1440,390}-dark.png`：管理员「从模板创建」后
  同样的 warning toast。
- `degraded-no-samples-{1440,390}-dark.png`：详情弹窗徽章 `降级 · 无样本`，
  曲线与逐段数据为空（与「无样本」一致）。
- `report.json`：6 项断言（两侧 toast 文案 + Sonner `data-type=warning` +
  请求确实带 `entry_port: 24321`、详情徽章文案 / 状态、390 宽度）。

## 数据说明 / Data note

截图来自真实主控与 `data/entry-port-preview.db`（`data/template-chain-preview.db`
的副本，只把预览账号密码重置为 `devpass`）。创建请求在浏览器层被拦截并返回
「旧主控忽略 entry_port」的响应：请求 `24321`、实际 `24000`，不会往预览库写链。
详情徽章的 `status` 与无样本曲线也只在浏览器层注入。

The screenshots use a real master with `data/entry-port-preview.db` (a copy of
`data/template-chain-preview.db` whose preview accounts were reset to
`devpass`). Create requests are intercepted in the browser and answered with an
“old master ignored entry_port” response (requested `24321`, actual `24000`);
no chain is written to the preview DB. The detail badge `status` and empty
no-sample series are also injected at the browser layer only.

## 重新生成 / Regenerate

```bash
# 0) 复制预览库并确认预览账号密码（示例为 admin / alice，密码 devpass）
#    copy the preview DB and make sure the preview accounts use a known password
cp data/template-chain-preview.db data/entry-port-preview.db
# 若密码不是 devpass：用本地 argon2id 重算 users.password_hash 后再启动。
# If the password is not devpass, recompute users.password_hash with local argon2id.

# 1) 起主控 / start the master
PIERWAVE_ADMIN_PASSWORD=devpass PIERWAVE_ADDR=127.0.0.1:8787 \
  PIERWAVE_DB='sqlite://data/entry-port-preview.db?mode=rwc' \
  ./target/debug/pierwave-master

# 2) 起前端 / start the dev server
cd web && npm run dev        # http://localhost:5173

# 3) 截图 + 断言 / shoot and assert
node web/screenshots/entry-port-guard/shots.mjs
```

Playwright 取自仓库 `.npm-cache/_npx/.../playwright`，不新增依赖；需要本机
Chrome（默认 `/Applications/Google Chrome.app`，可用 `CHROME_PATH` 覆盖）。
Playwright is loaded from the repo's `.npm-cache/_npx/.../playwright` (no new
dependency) and uses local Chrome (default `/Applications/Google Chrome.app`,
override with `CHROME_PATH`).

## 实测 / Measured

| 项目 | 结果 |
|---|---|
| 用户 toast | `端口 24321 未被采用，实际为 24000（保存后可在链路详情看到）`，warning |
| 管理员 toast | 同上，warning |
| 请求体 | `entry_port: 24321`（用户 / 管理员两侧都带） |
| 详情徽章 | `降级 · 无样本`，`data-state=degraded` |
| 390 宽度 | toast / 弹窗无横向溢出 |
