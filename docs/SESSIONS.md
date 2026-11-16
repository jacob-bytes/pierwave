# 登录设备与登录审计 / Sign-in devices and login audit

本文档说明「登录设备（会话）」与「登录审计 / 异常提醒」两份能力，对应迁移
`0057_sessions_login_audit.sql`。中文在前，English follows.

## 1. 数据模型 / Data model

迁移 0057 只追加：

```sql
ALTER TABLE sessions ADD COLUMN ip TEXT;
ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;
UPDATE sessions SET last_seen_at = created_at WHERE last_seen_at IS NULL;

CREATE TABLE login_ips (
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ip            TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, ip)
);

UPDATE settings SET value = rtrim(value, ',') || ',login_failed'
WHERE key = 'alert_events' AND trim(value) <> ''
  AND instr(',' || value || ',', ',login_failed,') = 0;
UPDATE settings SET value = rtrim(value, ',') || ',login_new_ip'
WHERE key = 'alert_events' AND trim(value) <> ''
  AND instr(',' || value || ',', ',login_new_ip,') = 0;
```

`user_agent` 在 `0001_init.sql` 就已经存在，本次不重复添加。

`login_ips` 记录「某用户成功登录过的 IP」，用于 `login_new_ip` 去重；老会话的
`ip` 为 `NULL`，列表显示「IP 未知」。

**迁移兼容 / Migration compatibility**：已有非空 `alert_events` 会追加两个新事件
（默认开启）；显式保存过空列表的实例保持为空（管理员明确关闭了全部告警）；
从未保存过事件列表的实例直接读取新的默认值，不需要写库。

## 2. 会话识别 / Current session

- 登录成功后签发随机 token，只把 `SHA-256(token)` 存进 `sessions.token_hash`；
  明文只出现在 `Set-Cookie: pierwave_session=...`。
- `GET /api/v1/sessions` 从 Cookie 取 token、算哈希，与每条会话的
  `token_hash` 比对，命中那条标记 `current: true`。响应永远不返回哈希或明文。
- `last_seen_at` 在鉴权提取器里低频写回：默认 60 秒最多一次。内存时间表 +
  数据库值双重判断，重启/多实例不会对同一条会话重复写；写失败只打日志，
  不影响请求。
- 踢掉当前会话时后端同时下发清 Cookie 的响应，前端立即跳 `/login`。

## 3. API

| Method | Path | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/v1/sessions` | 登录用户 | 自己的全部会话，`current` 标记当前 |
| DELETE | `/api/v1/sessions/{id}` | 登录用户 | 踢自己的；别人的 id 返回 **404** |
| DELETE | `/api/v1/sessions?others=1` | 登录用户 | 保留当前，踢掉其它全部；缺参数 400 |
| GET | `/api/v1/me/logins` | 登录用户 | 自己最近 5 条**成功**登录（IP/UA/时间） |
| GET | `/api/v1/users/{id}/sessions` | 管理员 | 查看某用户的会话 |
| DELETE | `/api/v1/users/{id}/sessions/{session_id}` | 管理员 | 踢掉某用户的一条会话 |

管理员接口与用户端复用同一组 `repo::sessions::*` 函数；路径 user id 与会话归属
不一致时返回 404，避免拿「用户 A 的页面」删除任意 session id。

设备摘要（浏览器 / 系统）由前端 `web/src/lib/sessions.ts` 解析；解析失败显示
截断后的原始 UA，空 UA 显示「未知设备」。

## 4. 审计 / Audit

写入 `audit_log`，动作：

| action | 触发 | detail |
|---|---|---|
| `auth.login` | 登录成功 | `ip`、`user_agent`、`new_ip` |
| `auth.login_failed` | 登录失败/限流 | `username`、`reason`、`ip` |
| `auth.logout` | 主动登出 | `session_id` |
| `auth.session_kick` | 踢单个设备 | `session_id`、`ip`、`user_agent`、`current`、`other_user` |
| `auth.sessions_kick_others` | 退出其它设备 | `revoked` |

`reason` 分类：`bad_password`、`unknown_user`、`rate_limited`、`disabled`。
失败记录包含用户名（即使账号不存在，便于排查撞库），**任何一条都不包含密码**。

`/api/v1/audit` 与 `/logs?tab=audit` 仍然只对管理员开放；普通用户的「最近登录」
只返回自己的成功登录，不暴露别人的失败尝试。

## 5. 告警 / Alerts

两个事件都加入 `alert_events` 白名单，默认开启，设置页可单独取消：

- `login_failed`：同一用户名在 **10 分钟**内连续失败达到 `login_max_attempts`
  （默认 5，和登录限流共用设置）时触发一次。成功登录或窗口过期后计数清零；
  同一窗口内不再重复触发。计数在进程内，重启最多多发一次，不会漏发。
  渠道层仍按 `alert_cooldown_secs`（默认 600 秒）对 `(login_failed, 用户名)` 去抖。
- `login_new_ip`：某用户第一次从某个 IP 成功登录时触发一次；`login_ips`
  保证同一 `(user, ip)` 只发一次。首次登录也算「从未见过的 IP」，因此会告警。
  IP 为 `unknown` 时不告警也不落库。

两类告警与现有 6 类事件共用同一套 Telegram / Webhook 投递、`alert_events`
白名单与冷却；关闭渠道或取消勾选后不会发送。

## 6. 截图 / Screenshots

- [登录设备列表 / Sign-in devices](images/sessions/01-session-list.png)
- [最近登录 / Recent sign-ins](images/sessions/02-recent-logins.png)
- [踢出确认 / Sign-out confirmation](images/sessions/03-kick-confirm.png)
- [通知事件列表（新增两项）/ Alert events](images/sessions/04-alert-events.png)

## 7. 已知未做 / Not included

- 「记住此设备」：当前没有设备信任列表，新 IP 登录每次都会校验密码。
- TOTP / 二次验证：本代码库目前没有 TOTP，登录失败分类里也不存在「TOTP 未启用」
  这一项；未来接入 2FA 时应在 `reason` 里新增独立分类，而不是复用 `bad_password`。
- 管理员「踢掉某用户其它全部会话」：当前只支持单个会话；用户端的
  `?others=1` 只作用于自己。

---

## English

Migration `0057_sessions_login_audit.sql` appends `ip` and `last_seen_at` to
`sessions` (the `user_agent` column already existed in `0001_init.sql`), creates
`login_ips` for new-IP de-duplication, and appends the `login_failed` /
`login_new_ip` events to any non-empty stored `alert_events` list. An explicitly
empty list stays empty; installations that never saved the list pick the new
events up from the defaults.

The current session is identified by hashing the `pierwave_session` cookie token
and comparing it with `sessions.token_hash`; hashes and plaintext tokens are
never returned. `last_seen_at` is written back at most once per 60 seconds using
an in-memory throttle plus the database value, so restarts and multiple
instances do not cause repeated writes.

Audit actions: `auth.login`, `auth.login_failed`, `auth.logout`,
`auth.session_kick`, `auth.sessions_kick_others`. Failures include the username
and a reason (`bad_password`, `unknown_user`, `rate_limited`, `disabled`) but
never the password. The audit API and panel remain admin-only; regular users
can see their own last five successful sign-ins via `/api/v1/me/logins`.

`login_failed` fires once when the same username reaches `login_max_attempts`
(default 5) consecutive failures within 10 minutes, then respects the channel
cooldown. `login_new_ip` fires once per user/IP pair and is on by default. Both
are toggled through `alert_events` and share the existing Telegram / Webhook
delivery path.

Not included: a "remember this device" trust list, TOTP/2FA (not present in the
codebase), and an admin action to sign out all of another user's sessions.
