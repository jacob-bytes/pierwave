-- 作用域化 API Token（只读 / 管理员）。
--
-- 只追加，不改 0001–0053。与 Agent token / 会话 token 一样，库里只存
-- SHA-256 十六进制哈希；明文 `pwt_...` 只在创建响应里返回一次，之后无法再取回。
--
-- English: scoped API tokens. Only a SHA-256 hash is stored (same approach as
-- agent/session tokens); the plaintext `pwt_...` is returned exactly once by
-- `POST /api/v1/api-tokens` and can never be read back.
CREATE TABLE api_tokens (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    scope        TEXT NOT NULL DEFAULT 'read',  -- read | admin
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER,                       -- NULL = 从未使用；批量异步更新
    expires_at   INTEGER,                       -- NULL = 永久有效
    revoked_at   INTEGER                        -- NULL = 未吊销
);

CREATE INDEX idx_api_tokens_created_at ON api_tokens(created_at);
CREATE INDEX idx_api_tokens_revoked_at ON api_tokens(revoked_at);
