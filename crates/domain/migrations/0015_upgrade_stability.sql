-- 升级确认加「稳定窗口」：心跳第一次报上新版本只是开始，持续稳定一段时间才算成功。
-- 同时给超时失败留出判断依据。
ALTER TABLE agent_upgrades ADD COLUMN confirmed_at INTEGER;
