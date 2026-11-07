-- 出站与路由：让每台服务器可以配置中转/落地链路，而不是只能直连。
--
-- 配置生成时 outbounds 固定为 direct(freedom) + blocked(blackhole) + api，
-- 再把这里 enabled = 1 的自定义出站按创建顺序追加；routing.rules 固定有一条
-- 「api 入站 → api 出站」，再接这里 enabled = 1 的规则（按 sort_order, created_at）。
--
-- tag / protocol 以数据库列为准：config_json 里就算写了同名键也会被覆盖，
-- 避免同一行出现「列表显示 socks、实际配置是 vmess」的双写不一致。
CREATE TABLE server_outbounds (
    id          TEXT PRIMARY KEY,
    server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    tag         TEXT NOT NULL,
    protocol    TEXT NOT NULL,           -- socks / http / vmess / vless / trojan / shadowsocks / freedom / blackhole
    config_json TEXT NOT NULL DEFAULT '{}',
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    UNIQUE(server_id, tag)
);

CREATE INDEX idx_server_outbounds_server
    ON server_outbounds(server_id, created_at);

-- inbound_tag / domain / ip 三者至少一个非空（业务层校验，否则规则会吞掉全部流量）。
-- domain / ip 是逗号分隔的 Xray 匹配串，生成配置时拆成数组。
CREATE TABLE server_routing_rules (
    id           TEXT PRIMARY KEY,
    server_id    TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    inbound_tag  TEXT,                   -- 空 = 不限定入站
    domain       TEXT,                   -- 逗号分隔的 Xray 域名匹配串，空 = 不按域名
    ip           TEXT,                   -- 逗号分隔的 IP/CIDR，空 = 不按 IP
    outbound_tag TEXT NOT NULL,
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_at   INTEGER NOT NULL
);

CREATE INDEX idx_server_routing_rules_order
    ON server_routing_rules(server_id, sort_order, created_at);

CREATE INDEX idx_server_routing_rules_outbound
    ON server_routing_rules(server_id, outbound_tag);
