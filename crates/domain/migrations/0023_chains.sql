-- 线性多跳链：入口 → 中转(1..n) → 出口 → 目标。
--
-- 链本身只是「跳的配置」；实际下发时由主控推导成每台服务器上的若干
-- DesiredForward，复用既有转发通道，Agent 不需要知道「链」这个概念。
-- seq 从 0 开始，0 是入口；同一台服务器在一条链里只能出现一次。
CREATE TABLE chains (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    target_host TEXT NOT NULL,
    target_port INTEGER NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_chains_created
    ON chains(created_at);

CREATE TABLE chain_hops (
    chain_id    TEXT NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,
    server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    listen_port INTEGER NOT NULL,
    PRIMARY KEY (chain_id, seq),
    -- 校验层会先拒绝重复服务器；这里兜住并发写入，避免出现两个同服务器跳。
    UNIQUE(chain_id, server_id)
);

CREATE INDEX idx_chain_hops_server
    ON chain_hops(server_id, listen_port);
