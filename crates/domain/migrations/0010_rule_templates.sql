-- 规则模板：订阅 clash 配置里的 rules 段。
--
-- 初始数据必须与旧版写死的两条规则完全一致（GEOIP,CN,DIRECT + MATCH,PROXY），
-- 否则升级后所有已发出的订阅内容都会变。时间戳用固定 0，保证迁移结果确定；
-- 迁移里不能调应用侧的 now()。
CREATE TABLE rule_templates (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    rules       TEXT NOT NULL,              -- JSON 数组，每个元素是一条 Clash 规则
    is_default  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

-- 数据库层再兜一层「同时只能有一个默认模板」。应用侧设新默认时会在同一事务里
-- 先清掉其它行；这个部分唯一索引负责在并发/绕过仓储时也不会出现两个 1。
CREATE UNIQUE INDEX idx_rule_templates_single_default
    ON rule_templates(is_default) WHERE is_default = 1;

-- 默认模板：与旧行为完全一致，升级后不传 ?rule= 的订阅内容不变。
INSERT INTO rule_templates
    (id, name, description, rules, is_default, created_at, updated_at)
VALUES (
    '00000000-0000-4000-8000-000000000001',
    '默认',
    '大陆直连，其余走代理',
    '["GEOIP,CN,DIRECT","MATCH,PROXY"]',
    1,
    0,
    0
);
