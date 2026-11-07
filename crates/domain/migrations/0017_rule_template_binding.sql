-- P6：规则模板绑定到用户 / 套餐。只追加，不改 0001–0016。
--
-- `ON DELETE SET NULL` 是回落链路的一部分：模板被删后绑定列自动清空，
-- 订阅解析会继续看下一级（套餐 → 全局默认 → 内置规则），不会报 502。
ALTER TABLE users
    ADD COLUMN rule_template_id TEXT REFERENCES rule_templates(id) ON DELETE SET NULL;

ALTER TABLE packages
    ADD COLUMN rule_template_id TEXT REFERENCES rule_templates(id) ON DELETE SET NULL;

-- 订阅列表按用户取「最近一次未过期实例」的套餐绑定，补一个覆盖该排序的索引。
CREATE INDEX idx_user_packages_user_created
    ON user_packages(user_id, created_at DESC);
