-- 加密链 TLS 握手失败原因（P15.3 可观测性）。
--
-- 值来自 Agent 的 TLS 探针，是稳定的英文短串（便于主控/前端翻译）：
--   tcp_connect_failed | cert_expired | unknown_issuer |
--   name_mismatch | handshake_failed | timeout
--
-- NULL = 未探测 / 本轮握手成功 / 旧 Agent 不认识该字段。
-- 与 target_ok 一起由心跳整体覆盖；明文规则（没有 remote_transport）永远是 NULL，
-- 因此这一列不改变未加密规则的任何既有行为。
ALTER TABLE forward_status ADD COLUMN target_error TEXT;
