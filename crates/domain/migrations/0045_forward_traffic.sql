-- 转发流量计入用户套餐（第二期）。
--
-- * forward_traffic_daily：按 (UTC+8 自然日, 转发规则) 累计的原始字节
--   （入方向 + 出方向）。它与 traffic_daily **分账存储**：Xray 流量的既有口径
--   一行都不改，两张日表各自保留来源，最终都汇总到 user_packages.used_bytes。
-- * forwards.last_traffic_in / last_traffic_out：上一次采样时的 Agent 累计
--   计数器。主控每 60 秒采样一次，用 `current - last` 求增量；`current < last`
--   说明 Agent 重启或规则重建导致计数器归零，此时增量取 `current`
--   （不回退、不记负数）。历史规则两列默认 0，count_traffic 默认 0，
--   因此升级后不会把升级前的历史流量补记进套餐。
--
-- 迁移只追加：不改 0001–0044。
CREATE TABLE forward_traffic_daily (
    day        TEXT NOT NULL,              -- UTC+8 自然日
    forward_id TEXT NOT NULL,
    user_id    TEXT NOT NULL,              -- 创建者；采样时该规则必须已有 owner
    bytes      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, forward_id)
);

ALTER TABLE forwards ADD COLUMN last_traffic_in INTEGER NOT NULL DEFAULT 0;
ALTER TABLE forwards ADD COLUMN last_traffic_out INTEGER NOT NULL DEFAULT 0;

-- 用户维度对账：主键前缀是 day，按用户回看需要单独索引。
CREATE INDEX idx_forward_traffic_daily_user ON forward_traffic_daily(user_id, day);

-- English: forward traffic counts toward user packages (phase 2).
-- forward_traffic_daily keeps per-day, per-rule raw bytes (in + out), separate
-- from traffic_daily so the existing Xray accounting is untouched; both feed
-- into user_packages.used_bytes. forwards.last_traffic_in/out hold the previous
-- cumulative counters sampled from the Agent; the master computes
-- `current - last` every 60s and treats `current < last` as a counter reset
-- (the delta becomes `current`, never negative). Existing rows default to 0,
-- so no historical traffic is back-filled on upgrade.
