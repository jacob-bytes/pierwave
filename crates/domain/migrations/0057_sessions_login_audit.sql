-- 迁移 0057：登录设备管理 + 登录审计/告警的持久化基础。
--
-- 1. `sessions` 补两个字段（`user_agent` 在 0001 已存在，这里不重复添加）：
--    * `ip`：签发该会话时的客户端 IP，只用于「登录设备」列表与审计；
--    * `last_seen_at`：最近一次活跃时间，由主控按低频节流写回（默认 60 秒），
--      不是每个请求都写库。历史会话用 `created_at` 回填，避免列表出现空值。
-- 2. `login_ips`：某用户成功登录过的 IP 集合，用于「新 IP 登录」告警的去重。
--    放在独立表而不是从 `audit_log.detail` 里反查 JSON：查询是一等公民，
--    并且不依赖 SQLite 的 JSON1 扩展。
-- 3. `alert_events` 追加两个新事件：`login_failed`、`login_new_ip`。
--    只追加非空列表（显式清空 = 全关，继续保持全关）；从未保存过事件列表的
--    实例不需要写库，读取侧的默认值已经包含这两个事件。
--
-- English: migration 0057 adds the session IP / last-seen columns, a
-- `login_ips` table used to de-duplicate "new IP" login alerts, and appends the
-- two new alert events (`login_failed`, `login_new_ip`) to any stored
-- `alert_events` list. An explicitly empty list stays empty (all alerts off);
-- instances that never saved the list pick the new events up from the defaults.

ALTER TABLE sessions ADD COLUMN ip TEXT;
ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;

-- 老会话没有活跃时间：用签发时间回填，列表按「创建时间」展示仍然正确。
UPDATE sessions SET last_seen_at = created_at WHERE last_seen_at IS NULL;

-- 用户成功登录过的 IP；(user_id, ip) 唯一，首次出现时 rows_affected = 1。
CREATE TABLE login_ips (
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ip            TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, ip)
);

CREATE INDEX idx_login_ips_user ON login_ips(user_id);

-- 新事件默认开启：已有非空事件列表追加两项；显式空列表保持为空。
UPDATE settings
SET value = rtrim(value, ',') || ',login_failed'
WHERE key = 'alert_events'
  AND trim(value) <> ''
  AND instr(',' || value || ',', ',login_failed,') = 0;

UPDATE settings
SET value = rtrim(value, ',') || ',login_new_ip'
WHERE key = 'alert_events'
  AND trim(value) <> ''
  AND instr(',' || value || ',', ',login_new_ip,') = 0;
