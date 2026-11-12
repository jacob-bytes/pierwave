-- 链路延迟历史 + 每跳流量（观测数据，不参与下发）。
--
-- forward_latency_samples：每轮心跳把 forward_status.targets_json 里每个
-- 成功的目标探测落成一条样本。server_id 是「谁测的」（上一跳成员），
-- target_server_id 是「测谁」（被探测的下一跳成员）。latency_ms 只写成功
-- 的探测；失败/未探测不写样本，避免把「不可达」伪装成 0ms。
--
-- 保留 7 天：写入时（repo::forwards::save_status）顺带 DELETE 更早的行，
-- 所以 (ts) 上单独加索引让清理按时间范围走索引，而不是全表扫描。
-- 同 (forward_id, target_server_id) 30 秒内重复写入走 UPDATE（见仓储），
-- 因此这张表最多每 30 秒产生一行/目标。
CREATE TABLE forward_latency_samples (
    ts               INTEGER NOT NULL,
    server_id        TEXT NOT NULL,
    forward_id       TEXT NOT NULL,
    target_server_id TEXT NOT NULL,
    latency_ms       INTEGER NOT NULL
);

CREATE INDEX idx_forward_latency_samples_forward_ts
    ON forward_latency_samples(forward_id, ts);

CREATE INDEX idx_forward_latency_samples_ts
    ON forward_latency_samples(ts);

-- 每跳流量：Agent 心跳里的 ForwardStatus.traffic_in/out 原样落库。
-- NULL = 没有数据源（realm）/ 旧 Agent 未上报；0 = 确实累计 0 字节。
-- 只追加列，既有 /forwards 与链视图的 status/降级语义完全不变。
ALTER TABLE forward_status ADD COLUMN traffic_in INTEGER;
ALTER TABLE forward_status ADD COLUMN traffic_out INTEGER;

-- English: per-hop traffic counters from agent heartbeats (NULL = no data source,
-- 0 = measured zero), plus the 7-day latency sample ring described above.
