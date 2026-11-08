-- P10 网络质量：Agent 自己测到公网探测目标的 TCP 握手 RTT。
--
-- servers.latency_ms 是最新一次心跳带上的毫秒数；NULL = 这轮探测失败、
-- 旧 Agent 不上报、或从未上报。不要用 0 表示失败：0 会被读成「极快」。
--
-- server_samples.latency_ms 保留每次 5 分钟采样的值，供后续趋势图使用；
-- 首期公开页只读 servers 的当前值，采样列先落库不丢数据。
ALTER TABLE servers ADD COLUMN latency_ms INTEGER;
ALTER TABLE server_samples ADD COLUMN latency_ms INTEGER;
