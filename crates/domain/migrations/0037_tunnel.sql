-- P16 隧道：自有 CA + 每台服务器一张属证书 + Agent 能力位。
--
-- 只追加，不改历史表结构。tunnel_available 与 realm_available /
-- nftables_available 同语义：NULL = 旧 Agent 未上报（未知，按不支持处理），
-- 0 = 明确不可用，1 = 可用。主控只有看到 1 才允许保存/下发 tunnel 链。
ALTER TABLE servers ADD COLUMN tunnel_available INTEGER;

-- 单例 CA：id 固定为 1，主控首次需要签发证书时生成。
-- 私钥只落库、不通过 DesiredState 下发给任何 Agent；下行只有 ca.pem。
CREATE TABLE tunnel_ca (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    cert_pem   TEXT NOT NULL,
    key_pem    TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- 每台服务器一张由上述 CA 签发的属证书。
-- subject 记录签发时的服务器地址（IP 或域名），地址变化时主控据此重签；
-- not_after 是 Unix 秒，临近过期也会重签。
CREATE TABLE tunnel_server_certs (
    server_id  TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
    cert_pem   TEXT NOT NULL,
    key_pem    TEXT NOT NULL,
    subject    TEXT NOT NULL,
    not_after  INTEGER NOT NULL,
    issued_at  INTEGER NOT NULL
);

-- English: P16 tunnel CA (singleton) + per-server leaf certificates, and the
-- agent tunnel capability bit. NULL tunnel_available means "unknown/old agent"
-- and is treated as unsupported (fail closed).
