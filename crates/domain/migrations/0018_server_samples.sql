-- P10：探针公开页的服务器采样。只追加，不改 0001–0017。
--
-- 调度器每 5 分钟把 `servers` 当前的在线状态与健康字段抄一份到这里，
-- 公开状态页的 24h/7d 可用率与小时桶全部由本表聚合而来。
-- `ts` 是 5 分钟对齐的 Unix 秒；同一台服务器同一时间点只有一行，
-- 重复采样（进程重启/补跑）用 upsert 覆盖，不会把可用率算重。
--
-- 服务器离线时也要写一行（online = 0），否则「离线期间」不会进入分母，
-- 可用率会永远显示 100%。
CREATE TABLE server_samples (
    server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    ts         INTEGER NOT NULL,
    online     INTEGER NOT NULL,
    load1      REAL NOT NULL DEFAULT 0,
    mem_used   INTEGER NOT NULL DEFAULT 0,
    mem_total  INTEGER NOT NULL DEFAULT 0,
    disk_used  INTEGER NOT NULL DEFAULT 0,
    disk_total INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (server_id, ts)
);

-- 主键前缀是 server_id，跨服务器按时间窗口扫描（清理 + 公开页聚合）用不上。
CREATE INDEX idx_server_samples_ts ON server_samples(ts);
