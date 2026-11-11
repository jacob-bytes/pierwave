-- nftables 转发引擎的能力缓存（P17）。
--
-- Agent 心跳时实际执行一次 `nft list tables`：成功说明二进制存在且有
-- CAP_NET_ADMIN，才上报 1。NULL = 旧 Agent 未上报 / 从未连过；0 = 明确不可用。
--
-- 主控只有在看到 1 时才允许保存/下发 nftables 规则；未知按「不可用」处理，
-- 避免旧 Agent 收到不认识的 ForwardEngine::Nftables 而整份期望态解析失败。
ALTER TABLE servers ADD COLUMN nftables_available INTEGER;
