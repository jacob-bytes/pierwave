-- 转发链「组」：一跳可以有 1..N 台服务器，由上一跳按策略选一台。
--
-- 数据模型只追加：chain_hops 保留不动，本迁移把每条链现有的 hops 原样搬成
-- 「每组一台成员」的 groups。单台组的下发结果与旧的单跳完全一致（走
-- DesiredForward 的 target_host/target_port 兼容字段，targets 为空）。
--
-- 约束说明：
-- * (group_id, server_id) 是主键，天然拒绝「同一服务器在同一组出现两次」；
-- * 「同一服务器不能出现在同一链的不同组」由领域层校验，SQL 无法跨行表达；
-- * server_id 保留外键级联：删除服务器时成员一起消失（与 chain_hops 的历史语义一致）。
CREATE TABLE chain_groups (
    id       TEXT PRIMARY KEY,
    chain_id TEXT NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
    seq      INTEGER NOT NULL,              -- 组在链里的顺序，0 = 入口组
    name     TEXT,                          -- 可选展示名
    strategy TEXT NOT NULL DEFAULT 'round_robin'
);

CREATE INDEX idx_chain_groups_chain
    ON chain_groups(chain_id, seq);

CREATE TABLE chain_group_members (
    group_id    TEXT NOT NULL REFERENCES chain_groups(id) ON DELETE CASCADE,
    server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    listen_port INTEGER NOT NULL,
    priority    INTEGER NOT NULL DEFAULT 0, -- 主备用：小的优先
    weight      INTEGER NOT NULL DEFAULT 1, -- 预留给加权，本轮只存不用
    PRIMARY KEY (group_id, server_id)
);

-- 端口冲突检查按 (server_id, listen_port) 查其它链的成员。
CREATE INDEX idx_chain_group_members_server
    ON chain_group_members(server_id, listen_port);

-- 每个旧 hop → 一个单成员组。id 用确定性前缀，迁移可重复执行也不会产生新 id。
INSERT INTO chain_groups (id, chain_id, seq, name, strategy)
SELECT 'grp-' || h.chain_id || '-' || h.seq, h.chain_id, h.seq, NULL, 'round_robin'
FROM chain_hops h;

INSERT INTO chain_group_members (group_id, server_id, listen_port, priority, weight)
SELECT 'grp-' || h.chain_id || '-' || h.seq, h.server_id, h.listen_port, 0, 1
FROM chain_hops h;
