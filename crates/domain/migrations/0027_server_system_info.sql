-- 探针卡片展示服务器形态与国家/地区：
-- * os_name / os_version / virt 来自 Agent 心跳，旧 Agent 不上报时保持 NULL；
-- * country_code 由管理员填写（ISO 3166-1 alpha-2，如 CN / US / JP），可空。
-- 只追加，不改历史迁移。
ALTER TABLE servers ADD COLUMN os_name TEXT;
ALTER TABLE servers ADD COLUMN os_version TEXT;
ALTER TABLE servers ADD COLUMN virt TEXT;
ALTER TABLE servers ADD COLUMN country_code TEXT;
