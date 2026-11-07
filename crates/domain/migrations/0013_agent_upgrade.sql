-- P4：Agent 自升级。只追加，不改 0001–0012。

-- 是否允许主控向这台服务器下发 Agent 升级计划（默认关闭，需管理员显式开启）。
ALTER TABLE servers ADD COLUMN allow_agent_upgrade INTEGER NOT NULL DEFAULT 0;
-- 期望的 Agent 版本；NULL = 没有待执行的升级。
ALTER TABLE servers ADD COLUMN agent_target_version TEXT;

-- 每次升级尝试一条记录；同一时间每台服务器最多一条 pending。
CREATE TABLE agent_upgrades (
    id           TEXT PRIMARY KEY,
    server_id    TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    from_version TEXT NOT NULL,
    to_version   TEXT NOT NULL,
    status       TEXT NOT NULL,          -- pending | succeeded | failed
    error        TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_agent_upgrades_server ON agent_upgrades(server_id, created_at DESC);
