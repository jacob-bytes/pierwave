-- 每跳目标可达性：Agent 对每条转发的 target 做周期 TCP 探测，
-- 心跳里独立于 listening 上报 target_ok。
--
-- target_ok 三态：NULL = 尚未探测 / 旧 Agent 不认识；1 = 目标可达；0 = 目标不可达。
-- target_fail_count 记录**连续** false 的次数，主控据此实现「连续 2 次失败才判降级」；
-- 任何一次非 false（true 或未知）都会清零。
ALTER TABLE forward_status ADD COLUMN target_ok INTEGER;
ALTER TABLE forward_status ADD COLUMN target_fail_count INTEGER NOT NULL DEFAULT 0;
