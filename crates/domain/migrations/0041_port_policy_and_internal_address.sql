-- 服务器端口允许集合 + 跳间内网地址。
--
-- * servers.port_start / port_end：允许的端口区间（含边界），NULL = 该侧不设边界；
--   两者都为 NULL 且 port_allow_json 为空 = 不限制（旧行为逐字节不变）。
-- * servers.port_allow_json：区间之外额外允许的端口，JSON 数组文本；默认 '[]'。
-- * servers.internal_address：链路跳间寻址时可替代 address 的内网地址；NULL = 未填写。
-- * chain_groups.use_internal_address：该组是否用**成员服务器的内网地址**被上一跳寻址；
--   每组一个开关，0 = 关闭（默认，行为与升级前完全一致）。
--
-- 历史数据一律是 NULL / '[]' / 0，因此升级后的节点、链与订阅输出都与升级前一致。

ALTER TABLE servers ADD COLUMN port_start INTEGER;

ALTER TABLE servers ADD COLUMN port_end INTEGER;

ALTER TABLE servers ADD COLUMN port_allow_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE servers ADD COLUMN internal_address TEXT;

ALTER TABLE chain_groups ADD COLUMN use_internal_address INTEGER NOT NULL DEFAULT 0;

-- English: allowed-port policy and internal addressing.
-- port_start/port_end are an inclusive optional range; port_allow_json is an extra
-- allow-list (JSON array). All empty means "unrestricted" (legacy behaviour).
-- internal_address is an optional private address used for hop-to-hop targets.
-- chain_groups.use_internal_address is per group: the previous hop reaches this
-- group's members through their internal_address. Existing rows keep the legacy
-- behaviour (NULL / '[]' / 0), so no output changes after upgrading.
