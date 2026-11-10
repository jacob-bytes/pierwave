-- 转发引擎选 realm 前，主控需要知道这台服务器到底装没装 realm。
--
-- Agent 心跳上报 `realm_available`，这里缓存最后一轮的值：
-- * NULL  = 未知（旧 Agent 未上报 / 从未连过）——UI 不能据此报「没装」；
-- * 1     = realm_bin 存在且可执行；
-- * 0     = 明确没装 / 不可用。
--
-- 离线只改 servers.status，不碰这一列：保留最后一次已知状态，
-- 重新上线后由下一轮心跳覆盖。只追加迁移，不改历史文件。
ALTER TABLE servers ADD COLUMN realm_available INTEGER;
