-- 证书管理：上传的证书 + 节点绑定。只追加，不改 0001–0005。

CREATE TABLE certificates (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    domains    TEXT NOT NULL,      -- JSON 数组
    cert_pem   TEXT NOT NULL,
    key_pem    TEXT NOT NULL,
    not_before INTEGER NOT NULL,   -- Unix 秒
    not_after  INTEGER NOT NULL,   -- Unix 秒
    created_at INTEGER NOT NULL
);

-- 节点引用证书；NULL = 未绑定。删除被引用的证书由业务层拦成 400，
-- 这里不加外键，避免历史节点/导入数据被迁移卡住。
ALTER TABLE nodes ADD COLUMN cert_id TEXT;
