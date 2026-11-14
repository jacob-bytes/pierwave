-- 对外端口：只改变「给用户看什么」，不改变监听。
--
-- * nodes.public_port：订阅里的端口；NULL = 与 nodes.port 相同（旧行为逐字节不变）。
-- * chain_groups.public_port：入口组的公网展示端口；NULL = 与入口成员 listen_port 相同。
--   仅 seq = 0 的入口组有意义，链下发仍然只用 chain_group_members.listen_port。
--
-- 历史数据一律为 NULL，因此升级后的订阅输出与升级前完全一致。

ALTER TABLE nodes ADD COLUMN public_port INTEGER;

ALTER TABLE chain_groups ADD COLUMN public_port INTEGER;

-- English: public-facing port. Presentation only; NULL keeps the legacy behaviour
-- (nodes: same as port; chain_groups: same as the entry member's listen_port).
-- Existing rows stay NULL, so subscriptions remain byte-for-byte unchanged.
