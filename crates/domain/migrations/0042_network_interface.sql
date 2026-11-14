-- 限定服务器从某块网卡出入流量。
--
-- * servers.nic_name：管理员选择的网卡名；NULL = 不限制（旧行为逐字节不变）。
-- * servers.interfaces_json：Agent 最近一次心跳上报的网卡列表
--   （JSON 数组：[{"name":"eth0","addresses":["10.0.0.2"]}]，地址不带 CIDR）。
--   默认 '[]' + NOT NULL：旧 Agent / 从未上线的服务器读出来就是空列表，
--   主控据此判定「尚未上报」，只允许保存 nic_name 并标记 nic_unverified。
--
-- 历史数据 nic_name 为 NULL、interfaces_json 为 '[]'，因此本次升级不会改变
-- 任何现有服务器的期望态、xray 配置或订阅输出。

ALTER TABLE servers ADD COLUMN nic_name TEXT;

ALTER TABLE servers ADD COLUMN interfaces_json TEXT NOT NULL DEFAULT '[]';

-- 最近一次「新版 Agent 明确上报过网卡」的时间戳（Unix 秒）；NULL = 从未上报。
-- 空列表既可能是旧 Agent 完全没上报，也可能是新 Agent 采集失败，所以不能只用
-- interfaces_json 的 '[]' 判断，否则前端会把「还没连过」误显示成「没有可用网卡」。
ALTER TABLE servers ADD COLUMN interfaces_reported_at INTEGER;

-- English: pin a server's traffic to one NIC.
-- servers.nic_name NULL means unrestricted (legacy behaviour); interfaces_json
-- keeps the most recent agent-reported NIC list (JSON array, IPs without CIDR),
-- and interfaces_reported_at is NULL until a new agent explicitly reports.
-- Existing rows default to NULL / '[]', so every generated config and subscription
-- stays byte-identical after this migration.
