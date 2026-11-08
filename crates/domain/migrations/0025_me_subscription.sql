-- P4 用户自助：记录订阅短码最后一次被用户自己重置的时间。
--
-- `short_code` 本身早就在 0001 里，但「最后一次换链接」没有时间戳；自助页要
-- 显示订阅更新时间，重置接口也要能证明「旧链接立即失效」。这里只加一列，
-- 历史用户回填 created_at（升级前从未重置过）。
ALTER TABLE users
    ADD COLUMN short_code_updated_at INTEGER NOT NULL DEFAULT 0;

UPDATE users
SET short_code_updated_at = created_at
WHERE short_code_updated_at = 0;
