-- 用户与管理端会话
CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user',      -- admin | user
    status        TEXT NOT NULL DEFAULT 'active',    -- active | disabled
    short_code    TEXT NOT NULL UNIQUE,              -- 订阅短码
    quota_bytes   INTEGER,                           -- NULL = 不限
    used_bytes    INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- 远程服务器与 Agent 配对
CREATE TABLE servers (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    address        TEXT NOT NULL,
    token_hash     TEXT NOT NULL UNIQUE,
    xray_mode      TEXT NOT NULL DEFAULT 'external', -- external | embedded
    status         TEXT NOT NULL DEFAULT 'offline',  -- online | offline
    last_seen_at   INTEGER,
    config_version INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL
);

-- 入站 ⇄ 节点：配置以 Xray 原生 JSON 为准，不二次建模
CREATE TABLE nodes (
    id          TEXT PRIMARY KEY,
    server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    tag         TEXT NOT NULL,
    name        TEXT NOT NULL,
    protocol    TEXT NOT NULL,
    transport   TEXT NOT NULL,
    security    TEXT NOT NULL,
    port        INTEGER NOT NULL,
    config_json TEXT NOT NULL DEFAULT '{}',
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    UNIQUE(server_id, tag)
);

-- 套餐模板 → 套餐实例（拼车核心：一个用户可挂多张卡，各自独立额度/到期）
CREATE TABLE packages (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    quota_bytes INTEGER,
    period_days INTEGER,
    direction   TEXT NOT NULL DEFAULT 'both',        -- both | upload | download
    node_ratio  REAL NOT NULL DEFAULT 1.0,
    created_at  INTEGER NOT NULL
);

CREATE TABLE user_packages (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    package_id     TEXT NOT NULL REFERENCES packages(id),
    quota_override INTEGER,
    used_bytes     INTEGER NOT NULL DEFAULT 0,
    direction      TEXT NOT NULL DEFAULT 'both',
    node_ratio     REAL NOT NULL DEFAULT 1.0,
    expires_at     INTEGER,
    reset_day      INTEGER,
    status         TEXT NOT NULL DEFAULT 'active',
    created_at     INTEGER NOT NULL
);
CREATE INDEX idx_user_packages_user ON user_packages(user_id);

-- 订阅文件
CREATE TABLE subscriptions (
    id         TEXT PRIMARY KEY,
    owner_id   TEXT REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    node_ids   TEXT NOT NULL DEFAULT '[]',
    format     TEXT NOT NULL DEFAULT 'clash',
    created_at INTEGER NOT NULL
);

-- 日账本：只落事实，加权在采集时冻结
CREATE TABLE traffic_daily (
    day        TEXT NOT NULL,                        -- YYYY-MM-DD
    server_id  TEXT NOT NULL,
    subject    TEXT NOT NULL,                        -- xray email / 子账号
    uplink     INTEGER NOT NULL DEFAULT 0,
    downlink   INTEGER NOT NULL DEFAULT 0,
    weighted   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, server_id, subject)
);

-- 上报幂等：(server_id, boot_id, seq) 唯一
CREATE TABLE traffic_reports (
    server_id   TEXT NOT NULL,
    boot_id     TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, boot_id, seq)
);

CREATE TABLE audit_log (
    id         TEXT PRIMARY KEY,
    actor_id   TEXT,
    action     TEXT NOT NULL,
    target     TEXT,
    detail     TEXT,
    created_at INTEGER NOT NULL
);
