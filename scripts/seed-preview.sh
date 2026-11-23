#!/usr/bin/env bash
#
# 预览数据库种子 / Preview database seed
# ============================================================
# 只写 data/preview.db，绝不触碰 data/pierwave.db。
#
# 数据形态（10 台主机，故意混合状态，让探针页与后台都像真实使用）：
#   4 台在线（Agent + Xray 都正常）
#   2 台异常（Agent 在线、Xray 未运行）
#   3 台离线（其中 1 台 2 小时前掉线、1 台 3 小时前掉线、1 台已离线两天）
#   1 台从未上报（无采集数据，探针卡片显示「从未上报 / 暂无采样」）
# 每台 1–3 个节点，另有用户、套餐实例、订阅、转发与 7 天流量/可用率采样。
#
# 幂等：主机与转发用固定 id + 事务内先删后插；用户/套餐/订阅用固定 id +
# INSERT OR IGNORE。重复执行不会产生重复行，也不会改动 schema。
#
# 重置范围：servers（级联节点、转发、采样、期望态等）及其历史流量。
# 用户、套餐与订阅**不删除**，缺少的用固定 id 补齐，避免把预览库里的
# 登录账号冲掉。这是预览库种子，不是生产迁移脚本。
#
# 用法 / Usage:
#   ./scripts/seed-preview.sh
#
# 输出 / Output:
#   stdout 一行 JSON（机读摘要：inserted / skipped / deleted / totals / statuses）
#   stderr 面向人的提示
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="$ROOT/data/preview.db"
REAL_DB="$ROOT/data/pierwave.db"

die() {
  echo "seed-preview: $*" >&2
  exit 1
}

command -v sqlite3 >/dev/null 2>&1 || die "需要 sqlite3"
command -v python3 >/dev/null 2>&1 || die "需要 python3（仅用于安全地解析真实路径）"

[ -f "$DB" ] || die "找不到 ${DB}。先用 PIERWAVE_DB=sqlite://data/preview.db?mode=rwc 启动一次主控生成 schema。"

# 安全闸：解析符号链接后必须仍是 data/preview.db，并且绝不能是 data/pierwave.db。
DB_REAL="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$DB")"
REAL_DB_REAL="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$REAL_DB")"
DATA_REAL="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$ROOT/data")"

[ "$DB_REAL" != "$REAL_DB_REAL" ] || die "拒绝执行：目标是真实数据库 data/pierwave.db"
case "$DB_REAL" in
  "$DATA_REAL"/*) ;;
  *) die "拒绝执行：数据库不在 $DATA_REAL 下（${DB_REAL}）" ;;
esac
[ "$(basename "$DB_REAL")" = "preview.db" ] || die "拒绝执行：只允许写 data/preview.db（${DB_REAL}）"

if [ "$(sqlite3 "$DB" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='servers';")" != "1" ]; then
  die "$DB 还不是有效的 PierWave 数据库（缺 servers 表）。先用主控启动一次生成 schema。"
fi

count_of() {
  sqlite3 "$DB" "SELECT COUNT(*) FROM $1;"
}

# 执行前快照，用于计算 inserted / skipped 与删除数量。
BEFORE_SERVERS="$(count_of servers)"
BEFORE_NODES="$(count_of nodes)"
BEFORE_USERS="$(count_of users)"
BEFORE_PACKAGES="$(count_of packages)"
BEFORE_USER_PACKAGES="$(count_of user_packages)"
BEFORE_SUBSCRIPTIONS="$(count_of subscriptions)"
BEFORE_FORWARDS="$(count_of forwards)"
BEFORE_CHAINS="$(count_of chains)"
BEFORE_SAMPLES="$(count_of server_samples)"
BEFORE_TRAFFIC_DAILY="$(count_of traffic_daily)"
BEFORE_TRAFFIC_NODE="$(count_of traffic_node_daily)"

sqlite3 -bail "$DB" <<'SQL'
.timeout 5000
PRAGMA foreign_keys = ON;

BEGIN IMMEDIATE;

-- 先清掉旧主机引用的非外键表；其余 server_id 外键会在 DELETE servers 时级联。
DELETE FROM traffic_daily
 WHERE server_id IN (SELECT id FROM servers);
DELETE FROM traffic_node_daily
 WHERE server_id IN (SELECT id FROM servers);
DELETE FROM traffic_reports
 WHERE server_id IN (SELECT id FROM servers);
DELETE FROM forward_probe_samples
 WHERE server_id IN (SELECT id FROM servers);
DELETE FROM forward_latency_samples
 WHERE server_id IN (SELECT id FROM servers);
DELETE FROM enforcement_events
 WHERE server_id IN (SELECT id FROM servers);

-- 固定 id + 先删后插：重复执行后仍是同样 10 台，不累积。
DELETE FROM servers;
-- 链没有指向 servers 的外键；成员已随 DELETE servers 级联清掉，这里把
-- 空的链壳也删掉，避免重复执行留下旧链。
DELETE FROM chains;

-- 删掉不属于任何现存主机的历史孤行，重复执行不会让计数越滚越大。
DELETE FROM traffic_daily WHERE server_id NOT IN (SELECT id FROM servers);
DELETE FROM traffic_node_daily WHERE server_id NOT IN (SELECT id FROM servers);
DELETE FROM traffic_reports WHERE server_id NOT IN (SELECT id FROM servers);
DELETE FROM forward_probe_samples WHERE server_id NOT IN (SELECT id FROM servers);
DELETE FROM forward_latency_samples WHERE server_id NOT IN (SELECT id FROM servers);
DELETE FROM enforcement_events WHERE server_id NOT IN (SELECT id FROM servers);

-- ------------------------------------------------------------
-- 10 台主机
-- ------------------------------------------------------------
-- 注意：预览库没有真实 Agent 心跳，心跳巡检（默认 90 秒）会把 status=online
-- 的行改回 offline。在线 / 异常主机的 last_seen 因此写在未来 24 小时，
-- 保证预览状态在一天内稳定；离线主机保持过去时间。真实 Agent 连上后会
-- 用真实心跳覆盖这个值。这里的 `last_seen_secs` 为负数表示「未来」。
WITH seed(
  id, name, address, token_hash, status, last_seen_secs, config_version, created_days,
  agent_version, xray_running, nginx_running, load1, mem_used, mem_total,
  disk_used, disk_total, uptime_secs, latency_ms, os_name, os_version, virt, arch,
  country_code, group_name, net_rx_bps, net_tx_bps, net_rx_bytes, net_tx_bytes,
  apply_status, apply_error, realm_available, nftables_available, tunnel_available,
  nic_name, internal_address, interfaces_json
) AS (VALUES
  -- 香港 01：健康在线
  ('c0ffee00-0000-4000-8000-000000000001', '香港-01', '203.0.113.11', 'preview-token-hk-01', 'online', -86425, 18, 8,
   '0.9.3', 1, 1, 0.42, 3650722201, 8589934592, 45097156608, 85899345920,
   1123200, 28, 'Debian GNU/Linux', '12', 'kvm', 'x86_64', 'HK', '香港',
   1887436.8, 524288.0, 182536110080, 56789012345, 'ok', NULL, 1, 1, 1,
   'eth0', '10.0.0.11', '[{"name":"eth0","addresses":["203.0.113.11"]}]'),
  -- 香港 02：健康在线
  ('c0ffee00-0000-4000-8000-000000000002', '香港-02', '203.0.113.12', 'preview-token-hk-02', 'online', -86441, 12, 12,
   '0.9.3', 1, 1, 1.27, 6227702579, 17179869184, 225485783040, 429496729600,
   3456000, 31, 'Ubuntu', '24.04', 'kvm', 'x86_64', 'HK', '香港',
   4404019.2, 1153433.6, 302365697638, 98765432109, 'ok', NULL, 1, 1, 1,
   'eth0', '10.0.0.12', '[{"name":"eth0","addresses":["203.0.113.12"]}]'),
  -- 香港 03：3 小时前掉线
  ('c0ffee00-0000-4000-8000-000000000003', '香港-03', '203.0.113.13', 'preview-token-hk-03', 'offline', 10800, 7, 35,
   '0.9.2', 1, 1, 0.18, 2254857830, 8589934592, 33285996544, 85899345920,
   864000, 35, 'Debian GNU/Linux', '12', 'kvm', 'x86_64', 'HK', '香港',
   NULL, NULL, 76543210987, 23456789012, 'ok', NULL, 1, 1, 1,
   'eth0', '10.0.0.13', '[{"name":"eth0","addresses":["203.0.113.13"]}]'),
  -- 东京 01：健康在线
  ('c0ffee00-0000-4000-8000-000000000004', '东京-01', '198.51.100.21', 'preview-token-jp-01', 'online', -86433, 15, 15,
   '0.9.3', 1, 1, 0.71, 4509715661, 8589934592, 66571993088, 171798691840,
   6048000, 52, 'Ubuntu', '24.04', 'kvm', 'x86_64', 'JP', '日本',
   2726297.6, 838860.8, 412345678901, 123456789012, 'ok', NULL, 1, 1, 1,
   'eth0', '10.0.0.21', '[{"name":"eth0","addresses":["198.51.100.21"]}]'),
  -- 东京 02：Agent 在线，Xray 启动失败（异常 / 降级）
  ('c0ffee00-0000-4000-8000-000000000005', '东京-02', '198.51.100.22', 'preview-token-jp-02', 'online', -86458, 9, 25,
   '0.9.3', 0, 1, 0.93, 6549825126, 17179869184, 128849018880, 343597383680,
   1728000, 49, 'Debian GNU/Linux', '12', 'kvm', 'x86_64', 'JP', '日本',
   0.0, 0.0, 198765432109, 45678901234, 'failed', 'xray.service 启动失败：exit status 1', 1, 1, 1,
   'eth0', '10.0.0.22', '[{"name":"eth0","addresses":["198.51.100.22"]}]'),
  -- 大阪 01：2 小时前掉线（链详情里用它演示「节点掉线 → 链 blocked」）
  ('c0ffee00-0000-4000-8000-000000000006', '大阪-01', '198.51.100.23', 'preview-token-jp-03', 'offline', 7200, 4, 40,
   '0.9.1', 0, 1, 0.0, 3221225472, 8589934592, 59055800320, 171798691840,
   172800, NULL, 'Debian GNU/Linux', '11', 'kvm', 'x86_64', 'JP', '日本',
   NULL, NULL, 54321098765, 12345678901, 'partial', NULL, 0, 1, 0,
   'eth0', '10.0.0.23', '[{"name":"eth0","addresses":["198.51.100.23"]}]'),
  -- 新加坡 01：健康在线
  ('c0ffee00-0000-4000-8000-000000000007', '新加坡-01', '192.0.2.31', 'preview-token-sg-01', 'online', -86419, 22, 20,
   '0.9.3', 1, 1, 0.35, 3006477107, 8589934592, 40802189312, 107374182400,
   9504000, 78, 'Ubuntu', '22.04', 'kvm', 'x86_64', 'SG', '新加坡',
   3250585.6, 996147.2, 612345678901, 234567890123, 'ok', NULL, 1, 1, 1,
   'eth0', '10.0.0.31', '[{"name":"eth0","addresses":["192.0.2.31"]}]'),
  -- 新加坡 02：Agent 在线，Xray 停止（异常 / 降级）
  ('c0ffee00-0000-4000-8000-000000000008', '新加坡-02', '192.0.2.32', 'preview-token-sg-02', 'online', -86447, 11, 28,
   '0.9.3', 0, 1, 1.62, 7945689498, 17179869184, 193273528320, 343597383680,
   432000, 81, 'Ubuntu', '24.04', 'kvm', 'x86_64', 'SG', '新加坡',
   0.0, 0.0, 234567890123, 67890123456, 'partial', '1 个受管文件写入失败', 1, 1, 0,
   'eth0', '10.0.0.32', '[{"name":"eth0","addresses":["192.0.2.32"]}]'),
  -- 美西 01：已离线两天
  ('c0ffee00-0000-4000-8000-000000000009', '美西-01', '198.51.100.41', 'preview-token-us-01', 'offline', 172800, 6, 50,
   '0.9.1', 0, 0, 0.08, 1288490189, 4294967296, 21474836480, 85899345920,
   259200, 168, 'Debian GNU/Linux', '12', 'kvm', 'x86_64', 'US', '美西',
   NULL, NULL, 87654321098, 34567890123, 'ok', NULL, 0, 1, 0,
   'eth0', '10.0.0.41', '[{"name":"eth0","addresses":["198.51.100.41"]}]'),
  -- 探针：从未上报（无数据）
  ('c0ffee00-0000-4000-8000-000000000010', '探针-待接入', '192.0.2.99', 'preview-token-probe', 'offline', NULL, 0, 60,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   NULL, NULL, NULL, '', NULL, NULL, NULL, NULL, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]')
)
INSERT INTO servers (
  id, name, address, token_hash, xray_mode, status, last_seen_at, config_version, created_at,
  agent_version, xray_running, nginx_running, load1, mem_used, mem_total,
  disk_used, disk_total, uptime_secs, health_at, allow_agent_upgrade,
  arch, latency_ms, os_name, os_version, virt, country_code,
  realm_available, nftables_available, tunnel_available, group_name,
  port_start, port_end, port_allow_json, internal_address, nic_name,
  interfaces_json, interfaces_reported_at, protocol_version,
  net_rx_bytes, net_tx_bytes, net_at, net_rx_bps, net_tx_bps,
  apply_status, apply_error, apply_version, apply_at
)
SELECT
  id, name, address, token_hash, 'external', status,
  CASE WHEN last_seen_secs IS NULL THEN NULL
       ELSE CAST(strftime('%s','now') AS INTEGER) - last_seen_secs END,
  config_version,
  CAST(strftime('%s','now') AS INTEGER) - created_days * 86400,
  agent_version, xray_running, nginx_running, load1, mem_used, mem_total,
  disk_used, disk_total, uptime_secs,
  CASE WHEN last_seen_secs IS NULL THEN NULL
       ELSE CAST(strftime('%s','now') AS INTEGER) - last_seen_secs END,
  0, arch, latency_ms, os_name, os_version, virt, country_code,
  realm_available, nftables_available, tunnel_available, group_name,
  10000, 60000, '[]', internal_address, nic_name,
  interfaces_json,
  CASE WHEN last_seen_secs IS NULL THEN NULL
       ELSE CAST(strftime('%s','now') AS INTEGER) - last_seen_secs END,
  1, net_rx_bytes, net_tx_bytes,
  CASE WHEN last_seen_secs IS NULL THEN NULL
       ELSE CAST(strftime('%s','now') AS INTEGER) - last_seen_secs END,
  net_rx_bps, net_tx_bps, apply_status, apply_error,
  CASE WHEN apply_status IS NULL THEN NULL ELSE config_version END,
  CASE WHEN last_seen_secs IS NULL THEN NULL
       ELSE CAST(strftime('%s','now') AS INTEGER) - last_seen_secs END
FROM seed;

-- ------------------------------------------------------------
-- 费用与到期：给多数服务器填上，用于成本概览与探针页展示
-- 日期用相对 now 的偏移，重建预览后语义仍然成立。
-- 覆盖：月付 / 年付 / 3 个月 / 一次性 / 未知币种（不计入总额）。
-- ------------------------------------------------------------
UPDATE servers SET paid_until = date('now', '+27 days'),
                   price_cents = 26800, currency = 'CNY',
                   billing_cycle = 'monthly', billing_cycle_count = 1, billing_cycle_unit = 'month'
 WHERE name = '香港-01';
-- 未知币种：展示"不计入总额但单列提示"
UPDATE servers SET paid_until = date('now', '+40 days'),
                   price_cents = 32000, currency = 'AED',
                   billing_cycle = 'monthly', billing_cycle_count = 1, billing_cycle_unit = 'month'
 WHERE name = '香港-02';
UPDATE servers SET paid_until = date('now', '+101 days'),
                   price_cents = 120000, currency = 'USD',
                   billing_cycle = 'yearly', billing_cycle_count = 1, billing_cycle_unit = 'year'
 WHERE name = '东京-01';
UPDATE servers SET paid_until = date('now', '+3 days'),
                   price_cents = 36000, currency = 'USD',
                   billing_cycle = 'monthly', billing_cycle_count = 1, billing_cycle_unit = 'month'
 WHERE name = '东京-02';
UPDATE servers SET paid_until = date('now', '+222 days'),
                   price_cents = 99900, currency = 'CNY',
                   billing_cycle = NULL, billing_cycle_count = 3, billing_cycle_unit = 'month'
 WHERE name = '新加坡-01';
UPDATE servers SET paid_until = date('now', '+18 days'),
                   price_cents = 15800, currency = 'CNY',
                   billing_cycle = 'monthly', billing_cycle_count = 1, billing_cycle_unit = 'month'
 WHERE name = '新加坡-02';
-- 离线服务器：保留费用，用于验证"离线不计入成本"
UPDATE servers SET paid_until = date('now', '-1 day'),
                   price_cents = 128000, currency = 'JPY',
                   billing_cycle = 'monthly', billing_cycle_count = 1, billing_cycle_unit = 'month'
 WHERE name = '大阪-01';
UPDATE servers SET paid_until = date('now', '+222 days'),
                   price_cents = 199900, currency = 'CNY',
                   billing_cycle = 'once', billing_cycle_count = 1, billing_cycle_unit = 'once'
 WHERE name = '美西-01';

-- ------------------------------------------------------------
-- 节点：每台 1–3 个，共 18 个
-- ------------------------------------------------------------
WITH seed(
  id, server_id, tag, name, protocol, transport, security, port,
  config_json, enabled, tags, region, bandwidth_kbps, created_days
) AS (VALUES
  ('c0ffee00-0001-4000-8000-000000000101', 'c0ffee00-0000-4000-8000-000000000001', 'hk-01-reality', '香港-REALITY', 'vless', 'tcp', 'reality', 443,
   '{"flow":"xtls-rprx-vision"}', 1, '["香港","流媒体"]', 'HK', 200000, 175),
  ('c0ffee00-0001-4000-8000-000000000102', 'c0ffee00-0000-4000-8000-000000000001', 'hk-01-ws', '香港-WS', 'vmess', 'ws', 'tls', 8443,
   '{"path":"/ws"}', 1, '["香港","中转"]', 'HK', 100000, 170),
  ('c0ffee00-0001-4000-8000-000000000103', 'c0ffee00-0000-4000-8000-000000000001', 'hk-01-ss', '香港-SS', 'shadowsocks', 'tcp', 'none', 8388,
   '{"method":"aes-256-gcm"}', 1, '["香港"]', 'HK', NULL, 160),

  ('c0ffee00-0001-4000-8000-000000000104', 'c0ffee00-0000-4000-8000-000000000002', 'hk-02-reality', '香港二-REALITY', 'vless', 'tcp', 'reality', 443,
   '{"flow":"xtls-rprx-vision"}', 1, '["香港","流媒体"]', 'HK', 200000, 118),
  ('c0ffee00-0001-4000-8000-000000000105', 'c0ffee00-0000-4000-8000-000000000002', 'hk-02-trojan', '香港二-Trojan', 'trojan', 'grpc', 'tls', 2053,
   '{"serviceName":"trojan"}', 1, '["香港"]', 'HK', 100000, 110),

  ('c0ffee00-0001-4000-8000-000000000106', 'c0ffee00-0000-4000-8000-000000000003', 'hk-03-vmess', '香港三-VMess', 'vmess', 'ws', 'tls', 8080,
   '{"path":"/vm"}', 1, '["香港","备用"]', 'HK', 100000, 88),

  ('c0ffee00-0001-4000-8000-000000000107', 'c0ffee00-0000-4000-8000-000000000004', 'jp-01-reality', '东京-REALITY', 'vless', 'tcp', 'reality', 443,
   '{"flow":"xtls-rprx-vision"}', 1, '["日本","流媒体"]', 'JP', 200000, 195),
  ('c0ffee00-0001-4000-8000-000000000108', 'c0ffee00-0000-4000-8000-000000000004', 'jp-01-h2', '东京-H2', 'vmess', 'h2', 'tls', 8443,
   '{"path":"/h2"}', 1, '["日本","中转"]', 'JP', 100000, 190),
  ('c0ffee00-0001-4000-8000-000000000109', 'c0ffee00-0000-4000-8000-000000000004', 'jp-01-trojan', '东京-Trojan', 'trojan', 'tcp', 'tls', 2053,
   '{}', 1, '["日本"]', 'JP', 100000, 180),

  ('c0ffee00-0001-4000-8000-000000000110', 'c0ffee00-0000-4000-8000-000000000005', 'jp-02-vless', '东京二-VLESS', 'vless', 'ws', 'tls', 8443,
   '{"path":"/vless"}', 1, '["日本","备用"]', 'JP', 100000, 58),
  ('c0ffee00-0001-4000-8000-000000000111', 'c0ffee00-0000-4000-8000-000000000005', 'jp-02-ss', '东京二-SS', 'shadowsocks', 'tcp', 'none', 8388,
   '{"method":"chacha20-ietf-poly1305"}', 1, '["日本"]', 'JP', NULL, 50),

  ('c0ffee00-0001-4000-8000-000000000112', 'c0ffee00-0000-4000-8000-000000000006', 'jp-03-vmess', '大阪-VMess', 'vmess', 'ws', 'tls', 2053,
   '{"path":"/osaka"}', 1, '["日本","备用"]', 'JP', 100000, 290),

  ('c0ffee00-0001-4000-8000-000000000113', 'c0ffee00-0000-4000-8000-000000000007', 'sg-01-reality', '新加坡-REALITY', 'vless', 'tcp', 'reality', 443,
   '{"flow":"xtls-rprx-vision"}', 1, '["新加坡","流媒体"]', 'SG', 200000, 235),
  ('c0ffee00-0001-4000-8000-000000000114', 'c0ffee00-0000-4000-8000-000000000007', 'sg-01-trojan', '新加坡-Trojan', 'trojan', 'grpc', 'tls', 2053,
   '{"serviceName":"sg-trojan"}', 1, '["新加坡"]', 'SG', 100000, 230),

  ('c0ffee00-0001-4000-8000-000000000115', 'c0ffee00-0000-4000-8000-000000000008', 'sg-02-vmess', '新加坡二-VMess', 'vmess', 'ws', 'tls', 8443,
   '{"path":"/vmess"}', 1, '["新加坡","备用"]', 'SG', 100000, 42),

  ('c0ffee00-0001-4000-8000-000000000116', 'c0ffee00-0000-4000-8000-000000000009', 'us-01-vless', '美西-VLESS', 'vless', 'ws', 'tls', 443,
   '{"path":"/us"}', 1, '["美西"]', 'US', 100000, 145),
  ('c0ffee00-0001-4000-8000-000000000117', 'c0ffee00-0000-4000-8000-000000000009', 'us-01-trojan', '美西-Trojan', 'trojan', 'tcp', 'tls', 2053,
   '{}', 0, '["美西","备用"]', 'US', 100000, 140),

  ('c0ffee00-0001-4000-8000-000000000118', 'c0ffee00-0000-4000-8000-000000000010', 'probe-01-vless', '探针-VLESS', 'vless', 'tcp', 'reality', 443,
   '{"flow":"xtls-rprx-vision"}', 1, '["待接入"]', NULL, 100000, 28)
)
INSERT INTO nodes (
  id, server_id, tag, name, protocol, transport, security, port,
  config_json, enabled, created_at, tags, region, bandwidth_kbps
)
SELECT
  id, server_id, tag, name, protocol, transport, security, port,
  config_json, enabled,
  CAST(strftime('%s','now') AS INTEGER) - created_days * 86400,
  tags, region, bandwidth_kbps
FROM seed;

-- ------------------------------------------------------------
-- 用户：3 个固定 id 的预览用户（密码哈希沿用预览库 alice 的占位值）
-- ------------------------------------------------------------
INSERT OR IGNORE INTO users (
  id, username, password_hash, role, status, short_code,
  quota_bytes, used_bytes, created_at, updated_at, short_code_updated_at
) VALUES
  ('c0ffee00-0002-4000-8000-000000000201', 'kenji',
   '$argon2id$v=19$m=19456,t=2,p=1$SiA8kOrERcaxw5glJ6cJwA$JXIWtC+Tl0KHihwB0NROEUHIrNcwKFJMFMJYLYe8XxU',
   'user', 'active', 'd3adbeef01', NULL, 24700000000,
   CAST(strftime('%s','now') AS INTEGER) - 21 * 86400,
   CAST(strftime('%s','now') AS INTEGER) - 2 * 86400,
   CAST(strftime('%s','now') AS INTEGER) - 21 * 86400),
  ('c0ffee00-0002-4000-8000-000000000202', 'mei',
   '$argon2id$v=19$m=19456,t=2,p=1$SiA8kOrERcaxw5glJ6cJwA$JXIWtC+Tl0KHihwB0NROEUHIrNcwKFJMFMJYLYe8XxU',
   'user', 'active', 'd3adbeef02', NULL, 8600000000,
   CAST(strftime('%s','now') AS INTEGER) - 14 * 86400,
   CAST(strftime('%s','now') AS INTEGER) - 3 * 86400,
   CAST(strftime('%s','now') AS INTEGER) - 14 * 86400),
  ('c0ffee00-0002-4000-8000-000000000203', 'nora',
   '$argon2id$v=19$m=19456,t=2,p=1$SiA8kOrERcaxw5glJ6cJwA$JXIWtC+Tl0KHihwB0NROEUHIrNcwKFJMFMJYLYe8XxU',
   'user', 'active', 'd3adbeef03', NULL, 51200000000,
   CAST(strftime('%s','now') AS INTEGER) - 7 * 86400,
   CAST(strftime('%s','now') AS INTEGER) - 86400,
   CAST(strftime('%s','now') AS INTEGER) - 7 * 86400);

-- ------------------------------------------------------------
-- 套餐模板 + 套餐实例
-- ------------------------------------------------------------
INSERT OR IGNORE INTO packages (
  id, name, quota_bytes, period_days, direction, node_ratio, created_at,
  node_scope_explicit, speed_limit_kbps, forward_limit, chain_limit
) VALUES
  ('c0ffee00-0003-4000-8000-000000000301', '轻量 · 50G', 53687091200, 30, 'both', 1.0,
   CAST(strftime('%s','now') AS INTEGER) - 60 * 86400, 0, 102400, 5, 1),
  ('c0ffee00-0003-4000-8000-000000000302', '团队 · 1T', 1099511627776, 30, 'both', 1.0,
   CAST(strftime('%s','now') AS INTEGER) - 45 * 86400, 0, NULL, 20, 5);

INSERT OR IGNORE INTO user_packages (
  id, user_id, package_id, quota_override, used_bytes, direction, node_ratio,
  expires_at, reset_day, status, created_at
) VALUES
  ('c0ffee00-0003-4000-8000-000000000311', 'c0ffee00-0002-4000-8000-000000000201',
   'c0ffee00-0003-4000-8000-000000000301', NULL, 24700000000, 'both', 1.0,
   CAST(strftime('%s','now') AS INTEGER) + 22 * 86400, 1, 'active',
   CAST(strftime('%s','now') AS INTEGER) - 8 * 86400),
  ('c0ffee00-0003-4000-8000-000000000312', 'c0ffee00-0002-4000-8000-000000000202',
   'c0ffee00-0003-4000-8000-000000000301', NULL, 8600000000, 'both', 1.0,
   CAST(strftime('%s','now') AS INTEGER) + 16 * 86400, 1, 'active',
   CAST(strftime('%s','now') AS INTEGER) - 14 * 86400),
  ('c0ffee00-0003-4000-8000-000000000313', 'c0ffee00-0002-4000-8000-000000000203',
   'c0ffee00-0003-4000-8000-000000000302', NULL, 51200000000, 'both', 1.0,
   CAST(strftime('%s','now') AS INTEGER) + 27 * 86400, 1, 'active',
   CAST(strftime('%s','now') AS INTEGER) - 3 * 86400);

-- ------------------------------------------------------------
-- 订阅：固定 id，重复执行只跳过
-- ------------------------------------------------------------
INSERT OR IGNORE INTO subscriptions (id, owner_id, name, node_ids, format, created_at)
VALUES
  ('c0ffee00-0004-4000-8000-000000000401', 'c0ffee00-0002-4000-8000-000000000201',
   'Kenji · 主订阅',
   '["c0ffee00-0001-4000-8000-000000000101","c0ffee00-0001-4000-8000-000000000107","c0ffee00-0001-4000-8000-000000000113"]',
   'clash', CAST(strftime('%s','now') AS INTEGER) - 20 * 86400),
  ('c0ffee00-0004-4000-8000-000000000402', 'c0ffee00-0002-4000-8000-000000000202',
   'Mei · 备用',
   '["c0ffee00-0001-4000-8000-000000000102","c0ffee00-0001-4000-8000-000000000105"]',
   'clash', CAST(strftime('%s','now') AS INTEGER) - 12 * 86400),
  ('c0ffee00-0004-4000-8000-000000000403', 'c0ffee00-0002-4000-8000-000000000203',
   'Nora · 移动端',
   '["c0ffee00-0001-4000-8000-000000000108","c0ffee00-0001-4000-8000-000000000114"]',
   'singbox', CAST(strftime('%s','now') AS INTEGER) - 6 * 86400);

-- ------------------------------------------------------------
-- 转发：固定 id；旧主机的转发随 DELETE servers 级联清掉
-- ------------------------------------------------------------
INSERT INTO forwards (
  id, server_id, name, listen_port, target_host, target_port, enabled,
  created_at, updated_at, engine, udp, protocol, owner_user_id,
  count_traffic, last_traffic_in, last_traffic_out, last_sampled_at
) VALUES
  ('c0ffee00-0005-4000-8000-000000000501', 'c0ffee00-0000-4000-8000-000000000001', '香港-01 · SSH', 10001, '10.0.0.11', 22, 1,
   CAST(strftime('%s','now') AS INTEGER) - 30 * 86400, CAST(strftime('%s','now') AS INTEGER) - 3600,
   'native', 0, 'tcp', 'c0ffee00-0002-4000-8000-000000000201', 1, 734003200, 3221225472,
   CAST(strftime('%s','now') AS INTEGER) - 120),
  ('c0ffee00-0005-4000-8000-000000000502', 'c0ffee00-0000-4000-8000-000000000001', '香港-01 · DNS', 10002, '1.1.1.1', 53, 1,
   CAST(strftime('%s','now') AS INTEGER) - 30 * 86400, CAST(strftime('%s','now') AS INTEGER) - 3600,
   'native', 1, 'tcp', 'c0ffee00-0002-4000-8000-000000000201', 1, 104857600, 524288000,
   CAST(strftime('%s','now') AS INTEGER) - 120),
  ('c0ffee00-0005-4000-8000-000000000503', 'c0ffee00-0000-4000-8000-000000000002', '香港-02 · 数据库', 10001, '192.0.2.10', 3306, 1,
   CAST(strftime('%s','now') AS INTEGER) - 20 * 86400, CAST(strftime('%s','now') AS INTEGER) - 3600,
   'native', 0, 'tcp', 'c0ffee00-0002-4000-8000-000000000202', 1, 209715200, 838860800,
   CAST(strftime('%s','now') AS INTEGER) - 120),
  ('c0ffee00-0005-4000-8000-000000000504', 'c0ffee00-0000-4000-8000-000000000004', '东京-01 · SSH', 10001, '10.0.0.21', 22, 1,
   CAST(strftime('%s','now') AS INTEGER) - 25 * 86400, CAST(strftime('%s','now') AS INTEGER) - 3600,
   'native', 0, 'tcp', 'c0ffee00-0002-4000-8000-000000000203', 1, 419430400, 2097152000,
   CAST(strftime('%s','now') AS INTEGER) - 120),
  ('c0ffee00-0005-4000-8000-000000000505', 'c0ffee00-0000-4000-8000-000000000004', '东京-01 · DNS', 10002, '1.0.0.1', 53, 1,
   CAST(strftime('%s','now') AS INTEGER) - 25 * 86400, CAST(strftime('%s','now') AS INTEGER) - 3600,
   'native', 1, 'tcp', 'c0ffee00-0002-4000-8000-000000000203', 1, 62914560, 314572800,
   CAST(strftime('%s','now') AS INTEGER) - 120),
  ('c0ffee00-0005-4000-8000-000000000506', 'c0ffee00-0000-4000-8000-000000000007', '新加坡-01 · PostgreSQL', 10001, '10.0.0.31', 5432, 1,
   CAST(strftime('%s','now') AS INTEGER) - 18 * 86400, CAST(strftime('%s','now') AS INTEGER) - 3600,
   'native', 0, 'tcp', 'c0ffee00-0002-4000-8000-000000000201', 1, 314572800, 1258291200,
   CAST(strftime('%s','now') AS INTEGER) - 120),
  ('c0ffee00-0005-4000-8000-000000000507', 'c0ffee00-0000-4000-8000-000000000008', '新加坡-02 · 面板', 10001, '10.0.0.32', 8080, 1,
   CAST(strftime('%s','now') AS INTEGER) - 10 * 86400, CAST(strftime('%s','now') AS INTEGER) - 3600,
   'native', 0, 'tcp', 'c0ffee00-0002-4000-8000-000000000202', 0, 0, 0,
   CAST(strftime('%s','now') AS INTEGER) - 120),
  ('c0ffee00-0005-4000-8000-000000000508', 'c0ffee00-0000-4000-8000-000000000009', '美西-01 · SSH', 10001, '10.0.0.41', 22, 1,
   CAST(strftime('%s','now') AS INTEGER) - 40 * 86400, CAST(strftime('%s','now') AS INTEGER) - 2 * 86400,
   'native', 0, 'tcp', 'c0ffee00-0002-4000-8000-000000000203', 1, 157286400, 734003200,
   CAST(strftime('%s','now') AS INTEGER) - 2 * 86400);

INSERT INTO forward_status (
  server_id, forward_id, listening, error, updated_at, target_ok, target_fail_count, traffic_in, traffic_out
)
SELECT
  server_id, id,
  CASE WHEN server_id IN (
    'c0ffee00-0000-4000-8000-000000000001',
    'c0ffee00-0000-4000-8000-000000000002',
    'c0ffee00-0000-4000-8000-000000000004',
    'c0ffee00-0000-4000-8000-000000000007'
  ) THEN 1 ELSE 0 END,
  '', CAST(strftime('%s','now') AS INTEGER) - 120,
  CASE WHEN server_id IN (
    'c0ffee00-0000-4000-8000-000000000001',
    'c0ffee00-0000-4000-8000-000000000002',
    'c0ffee00-0000-4000-8000-000000000004',
    'c0ffee00-0000-4000-8000-000000000007'
  ) THEN 1 ELSE 0 END,
  0, last_traffic_in, last_traffic_out
FROM forwards
WHERE id LIKE 'c0ffee00-0005-%';

-- ------------------------------------------------------------
-- 链路拓扑 + 24h 时延样本（链路时延 tab 的预览数据）
-- ------------------------------------------------------------
-- 3 条链（每种链的最后一组都再连链目标，所以段数 = 组数）：
--   港日中转链   4 组 / 4 段：香港-01 → 东京-01 → 新加坡-01 → 大阪-01 → 链目标
--   港新直达链   2 组 / 2 段：香港-02 → 新加坡-02 → 链目标
--   港日多路径   3 组 / 3 段：香港-01 → (东京-01 / 东京-02) → 大阪-01 → 链目标
--
-- 大阪-01 在 2 小时前掉线（servers.status = offline），所以「离线后不再有
-- 数据」必须是真的：只为它写掉线之前的时延 / 探测样本，掉线之后一行都不写。
-- 具体到港日中转链：
--   * 第 3 段（新加坡-01 → 大阪-01，源是新加坡-01）与最后一跳
--     （大阪-01 → 链目标，源是大阪-01）都只写到 ~2h 前，最近 2 小时的当前
--     窗口内确实没有样本；
--   * 港日多路径里进入大阪-01 的第 2 段与它的最后一跳同样只写到掉线前；
--   * 上游两段仍持续上报。节点离线优先于「样本不足」，所以这两条链必须判
--     blocked / node_offline，而不是 degraded / no_samples。
-- 其余段保持 24h 采样，用于时延曲线与链路丢包展示。
--
-- 端口按 (server_id, listen_port) 全局唯一分配，避免撞迁移 0047 的索引。
INSERT INTO chains (id, name, target_host, target_port, enabled, created_at, updated_at)
VALUES
  ('c0ffee00-0006-4000-8000-000000000601', '港日中转链', '198.51.100.100', 443, 1,
   CAST(strftime('%s','now') AS INTEGER) - 45 * 86400,
   CAST(strftime('%s','now') AS INTEGER) - 3600),
  ('c0ffee00-0006-4000-8000-000000000602', '港新直达链', '192.0.2.100', 443, 1,
   CAST(strftime('%s','now') AS INTEGER) - 30 * 86400,
   CAST(strftime('%s','now') AS INTEGER) - 3600),
  ('c0ffee00-0006-4000-8000-000000000603', '港日多路径', '198.51.100.101', 8443, 1,
   CAST(strftime('%s','now') AS INTEGER) - 15 * 86400,
   CAST(strftime('%s','now') AS INTEGER) - 3600);

INSERT INTO chain_groups (id, chain_id, seq, name, strategy, cert_id, public_port, use_internal_address)
VALUES
  ('c0ffee00-0006-4000-8000-000000000611', 'c0ffee00-0006-4000-8000-000000000601', 0, '香港入口', 'round_robin', NULL, NULL, 0),
  ('c0ffee00-0006-4000-8000-000000000612', 'c0ffee00-0006-4000-8000-000000000601', 1, '东京中转', 'round_robin', NULL, NULL, 0),
  ('c0ffee00-0006-4000-8000-000000000613', 'c0ffee00-0006-4000-8000-000000000601', 2, '新加坡中转', 'round_robin', NULL, NULL, 0),
  ('c0ffee00-0006-4000-8000-000000000614', 'c0ffee00-0006-4000-8000-000000000601', 3, '大阪出口', 'round_robin', NULL, NULL, 0),
  ('c0ffee00-0006-4000-8000-000000000621', 'c0ffee00-0006-4000-8000-000000000602', 0, '香港入口', 'round_robin', NULL, NULL, 0),
  ('c0ffee00-0006-4000-8000-000000000622', 'c0ffee00-0006-4000-8000-000000000602', 1, '新加坡出口', 'round_robin', NULL, NULL, 0),
  ('c0ffee00-0006-4000-8000-000000000631', 'c0ffee00-0006-4000-8000-000000000603', 0, '香港入口', 'round_robin', NULL, NULL, 0),
  ('c0ffee00-0006-4000-8000-000000000632', 'c0ffee00-0006-4000-8000-000000000603', 1, '东京中转（双路）', 'round_robin', NULL, NULL, 0),
  ('c0ffee00-0006-4000-8000-000000000633', 'c0ffee00-0006-4000-8000-000000000603', 2, '大阪出口', 'round_robin', NULL, NULL, 0);

INSERT INTO chain_group_members (group_id, server_id, listen_port, priority, weight)
VALUES
  ('c0ffee00-0006-4000-8000-000000000611', 'c0ffee00-0000-4000-8000-000000000001', 21001, 0, 1),
  ('c0ffee00-0006-4000-8000-000000000612', 'c0ffee00-0000-4000-8000-000000000004', 21002, 0, 1),
  ('c0ffee00-0006-4000-8000-000000000613', 'c0ffee00-0000-4000-8000-000000000007', 21003, 0, 1),
  ('c0ffee00-0006-4000-8000-000000000614', 'c0ffee00-0000-4000-8000-000000000006', 21004, 0, 1),
  ('c0ffee00-0006-4000-8000-000000000621', 'c0ffee00-0000-4000-8000-000000000002', 21101, 0, 1),
  ('c0ffee00-0006-4000-8000-000000000622', 'c0ffee00-0000-4000-8000-000000000008', 21102, 0, 1),
  ('c0ffee00-0006-4000-8000-000000000631', 'c0ffee00-0000-4000-8000-000000000001', 21201, 0, 1),
  ('c0ffee00-0006-4000-8000-000000000632', 'c0ffee00-0000-4000-8000-000000000004', 21202, 0, 1),
  ('c0ffee00-0006-4000-8000-000000000632', 'c0ffee00-0000-4000-8000-000000000005', 21203, 1, 1),
  ('c0ffee00-0006-4000-8000-000000000633', 'c0ffee00-0000-4000-8000-000000000006', 21204, 0, 1);

-- 最近 24h，每 5 分钟一条。forward_id 与 DesiredForward 的规则一致：
-- 单成员组 = chain-<id>-<seq>；多成员组 = chain-<id>-<seq>-<server_id>。
-- 单成员下一跳的 target_server_id 留空（旧 Agent 兼容字段）；多成员下一跳
-- 写真实 server_id。最后一跳到链目标的样本也写一部分，验证不会混进段、也不计入 unmapped。
WITH RECURSIVE slots(n) AS (
  SELECT 0 UNION ALL SELECT n + 1 FROM slots WHERE n < 288
)
-- 港日中转链：第 1 段（香港 → 东京），稳定 ~14ms
INSERT INTO forward_latency_samples (ts, server_id, forward_id, target_server_id, latency_ms)
SELECT ((CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s','now') AS INTEGER) % 300) - slots.n * 300), 'c0ffee00-0000-4000-8000-000000000001',
       'chain-c0ffee00-0006-4000-8000-000000000601-0', '',
       14 + (slots.n % 5)
FROM slots
UNION ALL
-- 第 2 段（东京 → 新加坡），稳定 ~20ms
SELECT ((CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s','now') AS INTEGER) % 300) - slots.n * 300), 'c0ffee00-0000-4000-8000-000000000004',
       'chain-c0ffee00-0006-4000-8000-000000000601-1', '',
       20 + (slots.n % 5)
FROM slots
UNION ALL
-- 第 3 段（新加坡 → 大阪）：大阪-01 在 2h 前掉线，只写掉线之前的 ~31ms 样本。
-- n < 24 落在最近 2h 的当前窗口内（即使源头新加坡-01 还在线），必须跳过，
-- 否则会出现「目标已离线、却仍有最新时延」的自相矛盾数据。
SELECT ((CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s','now') AS INTEGER) % 300) - slots.n * 300), 'c0ffee00-0000-4000-8000-000000000007',
       'chain-c0ffee00-0006-4000-8000-000000000601-2', '',
       31 + (slots.n % 5)
FROM slots
WHERE slots.n >= 24
UNION ALL
-- 港新直达链：1 段，~35ms
SELECT ((CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s','now') AS INTEGER) % 300) - slots.n * 300), 'c0ffee00-0000-4000-8000-000000000002',
       'chain-c0ffee00-0006-4000-8000-000000000602-0', '',
       35 + (slots.n % 4)
FROM slots
UNION ALL
-- 港日多路径：入口单成员 → 东京两台，Agent 会上报真实目标 id
SELECT ((CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s','now') AS INTEGER) % 300) - slots.n * 300), 'c0ffee00-0000-4000-8000-000000000001',
       'chain-c0ffee00-0006-4000-8000-000000000603-0',
       'c0ffee00-0000-4000-8000-000000000004',
       12 + (slots.n % 4)
FROM slots
UNION ALL
SELECT ((CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s','now') AS INTEGER) % 300) - slots.n * 300), 'c0ffee00-0000-4000-8000-000000000001',
       'chain-c0ffee00-0006-4000-8000-000000000603-0',
       'c0ffee00-0000-4000-8000-000000000005',
       15 + (slots.n % 4)
FROM slots
UNION ALL
-- 多路径第 2 段：东京两台各自上报，target 是单成员大阪 → 空目标。
-- 大阪-01 已离线，所以只写到掉线之前（n >= 24），不再探测一台离线的机器。
SELECT ((CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s','now') AS INTEGER) % 300) - slots.n * 300), 'c0ffee00-0000-4000-8000-000000000004',
       'chain-c0ffee00-0006-4000-8000-000000000603-1-c0ffee00-0000-4000-8000-000000000004', '',
       22 + (slots.n % 4)
FROM slots
WHERE slots.n >= 24
UNION ALL
SELECT ((CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s','now') AS INTEGER) % 300) - slots.n * 300), 'c0ffee00-0000-4000-8000-000000000005',
       'chain-c0ffee00-0006-4000-8000-000000000603-1-c0ffee00-0000-4000-8000-000000000005', '',
       24 + (slots.n % 4)
FROM slots
WHERE slots.n >= 24
UNION ALL
-- 最后一跳到链目标：Agent 对最后一组的 forward 目标就是 chains.target_host，
-- 没有下一台服务器，所以 target_server_id 留空。聚合时它归属「最后一跳」段
-- （seq = 最后一组 seq + 1），不再被丢弃，也不计入 unmapped。港新直达链的
-- 最后一跳源头新加坡-02 在线，造满 24h；港日中转链 / 港日多路径的最后一跳
-- 源头是大阪-01（2h 前掉线），只写到掉线之前。
SELECT ((CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s','now') AS INTEGER) % 300) - slots.n * 300), 'c0ffee00-0000-4000-8000-000000000006',
       'chain-c0ffee00-0006-4000-8000-000000000601-3', '',
       8
FROM slots
WHERE slots.n >= 24
UNION ALL
SELECT ((CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s','now') AS INTEGER) % 300) - slots.n * 300), 'c0ffee00-0000-4000-8000-000000000008',
       'chain-c0ffee00-0006-4000-8000-000000000602-1', '',
       7
FROM slots
UNION ALL
SELECT ((CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s','now') AS INTEGER) % 300) - slots.n * 300), 'c0ffee00-0000-4000-8000-000000000006',
       'chain-c0ffee00-0006-4000-8000-000000000603-2', '',
       6
FROM slots
WHERE slots.n >= 24;

-- ------------------------------------------------------------
-- 每跳探测计数（丢包）：最近 24h、5 分钟一桶的增量
-- ------------------------------------------------------------
-- forward_probe_samples 与上方时延样本用同一套「组 → 成员 → forward」映射，
-- 每个 forward 的探测就是该跳入口到下一跳的探测。第 2 段
-- （东京-01 → 新加坡-01，forward ...-1）最近 2h 失败率约 3%，其余段 <0.2%，
-- 用于验证「单段丢包 vs 整链连乘」。最后一组的 forward 探测的是链目标，
-- 同样写入；聚合时归到最后一跳段（不再被丢弃），并参与整链连乘。
--
-- 大阪-01 在 2h 前掉线：凡是「由大阪-01 发起」或「目标是大阪-01」的 forward
-- 都只写掉线之前（`from_n = 24`）的探测桶，掉线后一行都不写；否则会出现
-- 「节点已离线、却仍有最新探测计数」的自相矛盾数据。其余 forward 仍造满 24h。
WITH RECURSIVE slots(n) AS (
  SELECT 0 UNION ALL SELECT n + 1 FROM slots WHERE n < 288
),
probe_seed(server_id, forward_id, hot, from_n) AS (VALUES
  -- 港日中转链：4 跳
  ('c0ffee00-0000-4000-8000-000000000001', 'chain-c0ffee00-0006-4000-8000-000000000601-0', 0, 0),
  ('c0ffee00-0000-4000-8000-000000000004', 'chain-c0ffee00-0006-4000-8000-000000000601-1', 1, 0),
  -- 目标是已离线的大阪-01；掉线后（最近 2h）不再探测。
  ('c0ffee00-0000-4000-8000-000000000007', 'chain-c0ffee00-0006-4000-8000-000000000601-2', 0, 24),
  -- 由大阪-01 发起；掉线后不可能再上报。
  ('c0ffee00-0000-4000-8000-000000000006', 'chain-c0ffee00-0006-4000-8000-000000000601-3', 0, 24),
  -- 港新直达链：2 跳
  ('c0ffee00-0000-4000-8000-000000000002', 'chain-c0ffee00-0006-4000-8000-000000000602-0', 0, 0),
  ('c0ffee00-0000-4000-8000-000000000008', 'chain-c0ffee00-0006-4000-8000-000000000602-1', 0, 0),
  -- 港日多路径：入口 + 两个中转成员 + 最后一跳
  ('c0ffee00-0000-4000-8000-000000000001', 'chain-c0ffee00-0006-4000-8000-000000000603-0', 0, 0),
  ('c0ffee00-0000-4000-8000-000000000004', 'chain-c0ffee00-0006-4000-8000-000000000603-1-c0ffee00-0000-4000-8000-000000000004', 0, 24),
  ('c0ffee00-0000-4000-8000-000000000005', 'chain-c0ffee00-0006-4000-8000-000000000603-1-c0ffee00-0000-4000-8000-000000000005', 0, 24),
  ('c0ffee00-0000-4000-8000-000000000006', 'chain-c0ffee00-0006-4000-8000-000000000603-2', 0, 24)
)
INSERT INTO forward_probe_samples (ts, server_id, forward_id, attempts, failures)
SELECT
  -- 按 900 对齐：最近 24 个 5 分钟桶正好等于接口的 2h 当前窗口，
  -- 造数里的「最近 2h」在验证时能被完整统计。
  ((CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s','now') AS INTEGER) % 900) - slots.n * 300),
  probe_seed.server_id,
  probe_seed.forward_id,
  240,
  CASE
    -- 最近 2h：n = 0 是当前未结束的桶（查询窗口右开，不计入），
    -- n = 1..24 共 24 个桶，每桶 7/240 ≈ 2.92%，明显高于其它段。
    WHEN probe_seed.hot = 1 AND slots.n < 25 THEN 7
    -- 其余段：每 3 个桶 1 次失败 = 1/240 ≈ 0.14%。
    WHEN slots.n % 3 = 0 THEN 1
    ELSE 0
  END
FROM probe_seed
CROSS JOIN slots
WHERE slots.n >= probe_seed.from_n;

-- ------------------------------------------------------------
-- 7 天计费流量：9 台有数据的主机（无数据的探针不产生流量）
-- ------------------------------------------------------------
WITH traffic_seed(server_id, subject, base_uplink, base_downlink) AS (VALUES
  ('c0ffee00-0000-4000-8000-000000000001', 'kenji@hk-01-reality', 734003200, 3221225472),
  ('c0ffee00-0000-4000-8000-000000000001', 'mei@hk-01-ws', 314572800, 1572864000),
  ('c0ffee00-0000-4000-8000-000000000002', 'nora@hk-02-reality', 524288000, 2415919104),
  ('c0ffee00-0000-4000-8000-000000000003', 'kenji@hk-03-vmess', 209715200, 943718400),
  ('c0ffee00-0000-4000-8000-000000000004', 'mei@jp-01-reality', 419430400, 2097152000),
  ('c0ffee00-0000-4000-8000-000000000004', 'nora@jp-01-h2', 314572800, 1363148800),
  ('c0ffee00-0000-4000-8000-000000000005', 'kenji@jp-02-vless', 157286400, 734003200),
  ('c0ffee00-0000-4000-8000-000000000006', 'mei@jp-03-vmess', 104857600, 524288000),
  ('c0ffee00-0000-4000-8000-000000000007', 'nora@sg-01-reality', 629145600, 2952790016),
  ('c0ffee00-0000-4000-8000-000000000007', 'kenji@sg-01-trojan', 314572800, 1363148800),
  ('c0ffee00-0000-4000-8000-000000000008', 'mei@sg-02-vmess', 209715200, 1048576000),
  ('c0ffee00-0000-4000-8000-000000000009', 'nora@us-01-vless', 157286400, 838860800)
),
days(n) AS (
  SELECT 0 UNION ALL SELECT n + 1 FROM days WHERE n < 6
)
INSERT INTO traffic_daily (day, server_id, subject, uplink, downlink, weighted)
SELECT
  date('now', '+8 hours', '-' || days.n || ' days'),
  traffic_seed.server_id,
  traffic_seed.subject,
  CAST(traffic_seed.base_uplink * (7 - days.n) AS INTEGER),
  CAST(traffic_seed.base_downlink * (7 - days.n) AS INTEGER),
  CAST((traffic_seed.base_uplink + traffic_seed.base_downlink) * (7 - days.n) AS INTEGER)
FROM traffic_seed
CROSS JOIN days
WHERE days.n > 0
   OR traffic_seed.server_id IN (
     'c0ffee00-0000-4000-8000-000000000001',
     'c0ffee00-0000-4000-8000-000000000002',
     'c0ffee00-0000-4000-8000-000000000004',
     'c0ffee00-0000-4000-8000-000000000007'
   );

-- 节点维度流量（后台节点流量图用）
WITH days(n) AS (
  SELECT 0 UNION ALL SELECT n + 1 FROM days WHERE n < 6
)
INSERT INTO traffic_node_daily (day, server_id, node_tag, user_id, uplink, downlink, weighted)
SELECT
  date('now', '+8 hours', '-' || days.n || ' days'),
  nodes.server_id,
  nodes.tag,
  users.id,
  CAST(52428800 * (7 - days.n) * (1 + (nodes.rowid % 3)) AS INTEGER),
  CAST(209715200 * (7 - days.n) * (1 + (nodes.rowid % 3)) AS INTEGER),
  CAST(262144000 * (7 - days.n) * (1 + (nodes.rowid % 3)) AS INTEGER)
FROM nodes
CROSS JOIN days
CROSS JOIN users
WHERE nodes.enabled = 1
  AND users.username IN ('kenji', 'mei')
  AND (
    days.n > 0
    OR nodes.server_id IN (
      'c0ffee00-0000-4000-8000-000000000001',
      'c0ffee00-0000-4000-8000-000000000002',
      'c0ffee00-0000-4000-8000-000000000004',
      'c0ffee00-0000-4000-8000-000000000007'
    )
  );

-- ------------------------------------------------------------
-- 7 天可用率采样，每 15 分钟一格（共 672 格/台）。
-- 无数据的探针没有 last_seen_at，不写采样。
-- ------------------------------------------------------------
WITH RECURSIVE slots(n) AS (
  SELECT 0 UNION ALL SELECT n + 1 FROM slots WHERE n < 671
)
INSERT INTO server_samples (
  server_id, ts, online, load1, mem_used, mem_total, disk_used, disk_total,
  latency_ms, rx_bps, tx_bps
)
SELECT
  servers.id,
  (CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s','now') AS INTEGER) % 900) - slots.n * 900,
  CASE
    WHEN servers.id = 'c0ffee00-0000-4000-8000-000000000002'
      THEN CASE WHEN slots.n BETWEEN 480 AND 492 THEN 0 ELSE 1 END
    WHEN servers.id = 'c0ffee00-0000-4000-8000-000000000003'
      THEN CASE WHEN slots.n < 12 THEN 0 ELSE 1 END
    WHEN servers.id = 'c0ffee00-0000-4000-8000-000000000006'
      THEN CASE WHEN slots.n < 8 THEN 0 ELSE 1 END
    WHEN servers.id = 'c0ffee00-0000-4000-8000-000000000008'
      THEN CASE WHEN slots.n BETWEEN 300 AND 306 THEN 0 ELSE 1 END
    WHEN servers.id = 'c0ffee00-0000-4000-8000-000000000009'
      THEN 0
    ELSE 1
  END,
  CASE WHEN (
    CASE
      WHEN servers.id = 'c0ffee00-0000-4000-8000-000000000002'
        THEN CASE WHEN slots.n BETWEEN 480 AND 492 THEN 0 ELSE 1 END
      WHEN servers.id = 'c0ffee00-0000-4000-8000-000000000003'
        THEN CASE WHEN slots.n < 12 THEN 0 ELSE 1 END
      WHEN servers.id = 'c0ffee00-0000-4000-8000-000000000006'
        THEN CASE WHEN slots.n < 8 THEN 0 ELSE 1 END
      WHEN servers.id = 'c0ffee00-0000-4000-8000-000000000008'
        THEN CASE WHEN slots.n BETWEEN 300 AND 306 THEN 0 ELSE 1 END
      WHEN servers.id = 'c0ffee00-0000-4000-8000-000000000009'
        THEN 0
      ELSE 1
    END
  ) = 1 THEN COALESCE(servers.load1, 0) ELSE 0 END,
  CASE WHEN servers.status = 'online' THEN COALESCE(servers.mem_used, 0) ELSE 0 END,
  CASE WHEN servers.status = 'online' THEN COALESCE(servers.mem_total, 0) ELSE 0 END,
  CASE WHEN servers.status = 'online' THEN COALESCE(servers.disk_used, 0) ELSE 0 END,
  CASE WHEN servers.status = 'online' THEN COALESCE(servers.disk_total, 0) ELSE 0 END,
  CASE WHEN servers.status = 'online' THEN servers.latency_ms ELSE NULL END,
  CASE WHEN servers.status = 'online' THEN servers.net_rx_bps ELSE 0 END,
  CASE WHEN servers.status = 'online' THEN servers.net_tx_bps ELSE 0 END
FROM servers
CROSS JOIN slots
WHERE servers.last_seen_at IS NOT NULL;

COMMIT;
SQL

# 执行后快照。
AFTER_SERVERS="$(count_of servers)"
AFTER_NODES="$(count_of nodes)"
AFTER_USERS="$(count_of users)"
AFTER_PACKAGES="$(count_of packages)"
AFTER_USER_PACKAGES="$(count_of user_packages)"
AFTER_SUBSCRIPTIONS="$(count_of subscriptions)"
AFTER_FORWARDS="$(count_of forwards)"
AFTER_SAMPLES="$(count_of server_samples)"
AFTER_PROBES="$(count_of forward_probe_samples)"
AFTER_TRAFFIC_DAILY="$(count_of traffic_daily)"
AFTER_TRAFFIC_NODE="$(count_of traffic_node_daily)"

USERS_INSERTED=$((AFTER_USERS - BEFORE_USERS))
PACKAGES_INSERTED=$((AFTER_PACKAGES - BEFORE_PACKAGES))
USER_PACKAGES_INSERTED=$((AFTER_USER_PACKAGES - BEFORE_USER_PACKAGES))
SUBSCRIPTIONS_INSERTED=$((AFTER_SUBSCRIPTIONS - BEFORE_SUBSCRIPTIONS))
USERS_SKIPPED=$((3 - USERS_INSERTED))
PACKAGES_SKIPPED=$((2 - PACKAGES_INSERTED))
USER_PACKAGES_SKIPPED=$((3 - USER_PACKAGES_INSERTED))
SUBSCRIPTIONS_SKIPPED=$((3 - SUBSCRIPTIONS_INSERTED))

STATUS_COUNTS="$(sqlite3 "$DB" "
  SELECT
    SUM(CASE WHEN status = 'online'  AND COALESCE(xray_running, 1) <> 0 THEN 1 ELSE 0 END),
    SUM(CASE WHEN status = 'online'  AND xray_running = 0 THEN 1 ELSE 0 END),
    SUM(CASE WHEN status = 'offline' AND last_seen_at IS NOT NULL THEN 1 ELSE 0 END),
    SUM(CASE WHEN status = 'offline' AND last_seen_at IS NULL THEN 1 ELSE 0 END)
  FROM servers;
")"
ONLINE="$(echo "$STATUS_COUNTS" | cut -d'|' -f1)"
ABNORMAL="$(echo "$STATUS_COUNTS" | cut -d'|' -f2)"
OFFLINE="$(echo "$STATUS_COUNTS" | cut -d'|' -f3)"
NO_DATA="$(echo "$STATUS_COUNTS" | cut -d'|' -f4)"

echo "seed-preview: 已写入 $AFTER_SERVERS 台主机（在线 $ONLINE / 异常 $ABNORMAL / 离线 $OFFLINE / 无数据 ${NO_DATA}），$AFTER_NODES 个节点，$AFTER_FORWARDS 条转发，$AFTER_PROBES 条每跳探测样本。" >&2
echo "seed-preview: 数据库 ${DB_REAL}（真实库 ${REAL_DB_REAL} 未被触碰）。" >&2

printf '{"database":"data/preview.db","deleted":{"servers":%d},"inserted":{"servers":%d,"nodes":%d,"users":%d,"packages":%d,"user_packages":%d,"subscriptions":%d,"forwards":%d,"server_samples":%d,"traffic_daily":%d,"traffic_node_daily":%d},"skipped":{"users":%d,"packages":%d,"user_packages":%d,"subscriptions":%d},"totals":{"servers":%d,"nodes":%d,"users":%d,"packages":%d,"user_packages":%d,"subscriptions":%d,"forwards":%d,"server_samples":%d,"traffic_daily":%d,"traffic_node_daily":%d},"statuses":{"online":%d,"abnormal":%d,"offline":%d,"no_data":%d}}\n' \
  "$BEFORE_SERVERS" \
  "$AFTER_SERVERS" "$AFTER_NODES" "$USERS_INSERTED" "$PACKAGES_INSERTED" "$USER_PACKAGES_INSERTED" "$SUBSCRIPTIONS_INSERTED" "$AFTER_FORWARDS" "$AFTER_SAMPLES" "$AFTER_TRAFFIC_DAILY" "$AFTER_TRAFFIC_NODE" \
  "$USERS_SKIPPED" "$PACKAGES_SKIPPED" "$USER_PACKAGES_SKIPPED" "$SUBSCRIPTIONS_SKIPPED" \
  "$AFTER_SERVERS" "$AFTER_NODES" "$AFTER_USERS" "$AFTER_PACKAGES" "$AFTER_USER_PACKAGES" "$AFTER_SUBSCRIPTIONS" "$AFTER_FORWARDS" "$AFTER_SAMPLES" "$AFTER_TRAFFIC_DAILY" "$AFTER_TRAFFIC_NODE" \
  "$ONLINE" "$ABNORMAL" "$OFFLINE" "$NO_DATA"
