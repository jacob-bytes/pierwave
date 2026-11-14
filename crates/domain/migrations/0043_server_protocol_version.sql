-- 服务器上报的 Agent 线协议版本，用于「仅 UDP」能力门禁。
--
-- protocol = udp 从协议 16（v0.8.0）开始支持。旧 Agent 会忽略该字段，按旧的
-- udp 镜像位只监听 TCP，用户会以为「仅 UDP」生效、实际一条监听都没有。
--
-- servers.protocol_version：
--   NULL = 从未上报（旧 Agent / 从未连过），未知按「不支持仅 UDP」处理；
--   >= 16 = 明确支持仅 UDP；
--   < 16  = 旧 Agent，只允许 tcp / both。
-- 迁移只追加列；历史服务器保持 NULL，不改变任何现有规则的下发行为
-- （tcp / both 完全不受影响），仅 udp-only 会在保存与下发时被挡住。
ALTER TABLE servers ADD COLUMN protocol_version INTEGER;

-- English: the agent wire-protocol version reported by its heartbeat.
-- NULL means never reported (old agent / never connected) and is treated as
-- "UDP-only unsupported"; >= 16 supports UDP-only; < 16 only understands
-- tcp / both. Existing rows stay NULL, so no existing tcp / both rule changes.
