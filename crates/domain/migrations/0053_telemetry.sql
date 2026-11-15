-- 实时网速 + 转发链可用率（只追加；不改 0001–0052）。
--
-- 1) 服务器网速（任务 A）
--
--    Agent 心跳从协议 26 起带 `net_rx_bytes / net_tx_bytes / net_at`（非 lo
--    网卡的累计字节 + 采集时刻）。主控用相邻两次心跳的差值 / 时间差算当前速率：
--
--    * servers.net_rx_bytes / net_tx_bytes / net_at 保存上一份**基线**，
--      只用于下一次差分；
--    * servers.net_rx_bps / net_tx_bps 是最近一次算出的速率（字节/秒），
--      NULL = 没有可用数据（旧 Agent、首次心跳、计数回绕被丢弃）。
--      绝不能写 0：0 会被读成「完全没有流量」。
--    * server_samples 每 5 分钟抄一份速率，供趋势 / sparkline 使用。
--      同样只用于展示。
--
--    **网速只展示，不参与计费。** 计费仍走 Xray 计数器与转发规则的
--    last_traffic_* / forward_traffic_daily，两套数据互不影响。
--
-- English: per-server link rate. `servers.net_rx_bps/net_tx_bps` is the latest
-- rate in bytes/sec computed from the delta between two heartbeats (NULL when
-- unknown — never 0). `server_samples.rx_bps/tx_bps` copies it every 5 minutes
-- for trends. Display only: billing keeps using the Xray / forward counters.

ALTER TABLE servers ADD COLUMN net_rx_bytes INTEGER;
ALTER TABLE servers ADD COLUMN net_tx_bytes INTEGER;
ALTER TABLE servers ADD COLUMN net_at INTEGER;
ALTER TABLE servers ADD COLUMN net_rx_bps REAL;
ALTER TABLE servers ADD COLUMN net_tx_bps REAL;

ALTER TABLE server_samples ADD COLUMN rx_bps REAL;
ALTER TABLE server_samples ADD COLUMN tx_bps REAL;

-- 2) 转发链可用率 / 丢包近似（任务 B）
--
--    Agent 在 ForwardStatus 里带上「自监听启动以来」的目标探测累计次数与
--    失败次数。主控按相邻两次心跳做差分（`forward_probe_counters` 保存基线），
--    把增量累加到 5 分钟桶 `forward_probe_samples`：
--
--    * ts 是 5 分钟桶起点；
--    * attempts / failures 是**增量**（不是累计值），因此 24h 可用率 =
--      1 - SUM(failures) / SUM(attempts)；
--    * 计数回绕（Agent 重启 / 规则重建）时该次差分被丢弃，只把基线换成新值，
--      不会产生负数或巨大的失败数；
--    * 保留 7 天，写入时顺带清理更早的桶。
--
--    **口径**：这是**探测失败率**的近似，不是业务报文的真实丢包率。
--
-- English: per-forward probe window counters. `forward_probe_counters` keeps the
-- last cumulative counters from the agent (baseline for the next delta).
-- `forward_probe_samples` stores 5-minute increments of attempts/failures, so
-- 24h availability = 1 - SUM(failures) / SUM(attempts). This is a probe failure
-- rate approximation, not real packet loss.

CREATE TABLE forward_probe_counters (
    server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    forward_id TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    failures   INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, forward_id)
);

CREATE TABLE forward_probe_samples (
    ts         INTEGER NOT NULL,
    server_id  TEXT NOT NULL,
    forward_id TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    failures   INTEGER NOT NULL DEFAULT 0,
    -- 同一 5 分钟桶同一 forward 只有一行；心跳增量用 upsert 累加。
    PRIMARY KEY (ts, server_id, forward_id)
);

CREATE INDEX idx_forward_probe_samples_forward_ts
    ON forward_probe_samples(forward_id, ts);
CREATE INDEX idx_forward_probe_samples_ts
    ON forward_probe_samples(ts);

-- 链降级状态：连续多少次心跳观测到「近期可用率低于阈值」，以及本轮是否已告警。
-- 落库是为了进程重启后继续累计，避免重启把「连续 N 次」清零后反复告警。
--
-- English: consecutive low-availability observations per chain, persisted so a
-- master restart does not reset the streak (and re-alert). `alerted` means the
-- current outage already produced one `chain_degraded` event.
CREATE TABLE chain_degradation (
    chain_id        TEXT PRIMARY KEY REFERENCES chains(id) ON DELETE CASCADE,
    consecutive_below INTEGER NOT NULL DEFAULT 0,
    alerted         INTEGER NOT NULL DEFAULT 0,
    updated_at      INTEGER NOT NULL
);
