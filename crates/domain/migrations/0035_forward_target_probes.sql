-- 逐目标探测结果（P15.4 链路跳间延迟）。
--
-- Agent 心跳里的 ForwardStatus.targets 是「这条规则的每个 target 最近一轮
-- TCP 握手探测」结果：server_id / ok / latency_ms。落成一行 JSON 数组，
-- 避免为一张纯观测表再建子表（每轮心跳整体覆盖，无需索引、无需 JOIN）。
--
-- NULL 或空数组 = 未探测（旧 Agent、UDP 规则、nftables 引擎等），
-- 主控据此在链视图里把延迟保持为 null，绝不能当成 0ms。
--
-- 只追加列：未加密 / 单跳规则的既有行为完全不变。
ALTER TABLE forward_status ADD COLUMN targets_json TEXT;

-- English: per-target TCP probe results for a forward, as a JSON array of
-- {server_id, ok, latency_ms}. NULL/[] means "not probed" (old agents, UDP,
-- nftables), so the master reports null latency instead of a fake 0 ms.
