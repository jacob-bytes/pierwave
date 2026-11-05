-- 每日重置水位：记录实例上次执行 reset_day 清零的时间（UTC Unix 秒）。
-- 调度器用「今天是否该重置 + 今天是否已经重置过」判断，避免每小时重复清零。
-- 只追加，不改 0001/0002。
ALTER TABLE user_packages ADD COLUMN last_reset_at INTEGER;
