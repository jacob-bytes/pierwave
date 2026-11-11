-- 转发协议模式：tcp / udp / both（P15.4）。
--
-- 旧模型是「TCP 恒开 + udp 布尔位」，无法表达「仅 UDP」。这里只追加协议列，
-- 不回写、不删除旧的 udp 列：udp 只作为本次迁移的来源，之后读写路径一律以
-- protocol 为准（领域层 `protocol::from_db` 负责读路径兜底）。
--
-- 历史行映射：
--   udp = 1 → both（升级前 native/nftables 的语义就是同端口双开）
--   udp = 0 → tcp （只监听 TCP）
ALTER TABLE forwards ADD COLUMN protocol TEXT NOT NULL DEFAULT 'tcp';
ALTER TABLE chains   ADD COLUMN protocol TEXT NOT NULL DEFAULT 'tcp';

UPDATE forwards SET protocol = CASE WHEN udp = 1 THEN 'both' ELSE 'tcp' END;
UPDATE chains   SET protocol = CASE WHEN udp = 1 THEN 'both' ELSE 'tcp' END;
