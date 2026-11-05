-- 键值配置：首个用户是订阅凭据派生用的 HMAC master secret（key = hmac_secret_v1）。
-- 只追加，不改 0001。
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
