-- 节点维度流量日账本：回答「哪个节点在跑流量」「某节点上谁占得最多」。
--
-- 只追加，不改 0001–0008。`traffic_daily` 仍然是用户总量与月账单的唯一口径，
-- 本表只是它的切片，不参与计费。
--
-- `node_tag` 来自上报 email 的 `{user_id}@{node_tag}` 后半段：节点 tag 在单个
-- server 内唯一，所以定位节点必须同时带 `server_id`（JOIN nodes 的复合唯一键）。
-- `user_id = ''` 表示无法归因（脏 email / 用户已不存在），这些流量仍计入节点
-- 总量，但不进用户明细。
--
-- 节点删除后这里的历史行**保留**：表上没有指向 nodes 的外键，删除节点不会
-- 连带抹掉已经发生的流量。列表/详情通过 JOIN nodes 展示，因此在节点重建
-- （同 server 同 tag）后历史又会重新挂上；节点永久删除后这些行成为对账用的
-- 孤儿数据，`traffic_daily` 的总量不受影响。
CREATE TABLE traffic_node_daily (
    day       TEXT NOT NULL,              -- UTC+8 自然日
    server_id TEXT NOT NULL,
    node_tag  TEXT NOT NULL,              -- 来自 email 的 {user_id}@{node_tag} 后半段
    user_id   TEXT NOT NULL,              -- '' = 无法归因（脏 email）
    uplink    INTEGER NOT NULL DEFAULT 0,
    downlink  INTEGER NOT NULL DEFAULT 0,
    weighted  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, server_id, node_tag, user_id)
);

-- 节点详情按 (server_id, node_tag) + 日期窗口查询；主键前缀是 day，帮不上忙。
CREATE INDEX idx_traffic_node_daily_node ON traffic_node_daily(server_id, node_tag, day);
