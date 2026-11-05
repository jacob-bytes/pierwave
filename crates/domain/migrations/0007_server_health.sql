-- Agent 心跳里的健康数据：以前只用了 last_seen_at，其余全丢弃，
-- 导致「agent 活着但 xray 崩了」在面板上看不出来。
ALTER TABLE servers ADD COLUMN agent_version TEXT;
ALTER TABLE servers ADD COLUMN xray_running INTEGER;
ALTER TABLE servers ADD COLUMN nginx_running INTEGER;
ALTER TABLE servers ADD COLUMN load1 REAL;
ALTER TABLE servers ADD COLUMN mem_used INTEGER;
ALTER TABLE servers ADD COLUMN mem_total INTEGER;
ALTER TABLE servers ADD COLUMN disk_used INTEGER;
ALTER TABLE servers ADD COLUMN disk_total INTEGER;
ALTER TABLE servers ADD COLUMN uptime_secs INTEGER;
ALTER TABLE servers ADD COLUMN health_at INTEGER;
