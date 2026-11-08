-- 单跳 TCP 端口转发：主控下发「在 listen_port 监听 → 原样转到 target_host:target_port」，
-- Agent 自己监听并转发，不经 Xray（因此不计入用户流量，也没有 stats 计数器）。
--
-- 运行状态不放在本表：心跳上报的是「当前时刻的监听结果」，每轮都会整体覆盖，
-- 放主表会让规则行每 15 秒被写一次，还会让「规则配置」和「运行时状态」混在一起。
-- 所以单独一张轻量状态表 forward_status（见下），列表查询再按 forward_id 合并。
CREATE TABLE forwards (
    id          TEXT PRIMARY KEY,
    server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    listen_port INTEGER NOT NULL,
    target_host TEXT NOT NULL,
    target_port INTEGER NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE(server_id, listen_port)
);

CREATE INDEX idx_forwards_server
    ON forwards(server_id, created_at);

-- Agent 心跳里的 ForwardStatus 缓存。每次心跳按服务器整体替换（DELETE + INSERT），
-- 所以不会残留上一轮的 error。刻意不建 forward_id → forwards(id) 的外键：
-- 规则刚删除、Agent 还没收敛时，心跳可能仍带着旧 id，外键会让整次心跳写入失败；
-- 列表查询只合并现存规则的 id，这些短暂残留行不会被显示。
CREATE TABLE forward_status (
    server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    forward_id TEXT NOT NULL,
    listening  INTEGER NOT NULL DEFAULT 0,
    error      TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, forward_id)
);
