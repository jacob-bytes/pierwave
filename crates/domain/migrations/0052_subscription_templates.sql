-- 订阅模板：节点元数据（标签 / 地区）+ 声明式代理组模板。
--
-- 只追加，不改历史迁移。没有模板的用户/套餐绑定列都是 NULL，
-- 订阅渲染继续走原来的硬编码分组（PROXY / AUTO / 地区组），
-- 输出与升级前逐字节一致（golden 覆盖）。
ALTER TABLE nodes ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';  -- JSON 数组，如 ["香港","中转"]
ALTER TABLE nodes ADD COLUMN region TEXT;                      -- 单值，如 "HK"

CREATE TABLE subscription_templates (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    groups_json TEXT NOT NULL,   -- 声明式分组数组，不允许脚本
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

-- 绑定优先级：用户级 > 套餐级 > 无模板（回落硬编码）。
-- ON DELETE SET NULL 是回落链路的一部分：模板被删后绑定列自动清空，
-- 订阅解析继续看下一级，不会 502。
ALTER TABLE users
    ADD COLUMN subscription_template_id TEXT REFERENCES subscription_templates(id) ON DELETE SET NULL;

ALTER TABLE packages
    ADD COLUMN subscription_template_id TEXT REFERENCES subscription_templates(id) ON DELETE SET NULL;

-- 订阅端按用户取「最近一个绑定了订阅模板的生效套餐」，需要 (user_id, created_at)
-- 的排序覆盖；0017 已经建过同名索引，这里不重复创建。
