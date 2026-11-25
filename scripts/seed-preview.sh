#!/usr/bin/env bash
#
# 预览数据库种子 / Preview database seed
# ============================================================
# 只写 data/preview.db，绝不触碰 data/pierwave.db。
#
# 数据形态（15 台主机，故意混合状态，让探针页与后台都像真实使用）：
#   8 台在线（Agent + Xray 都正常）
#   2 台异常（Agent 在线、Xray 未运行：新加坡-02、曼谷-01）
#   4 台离线（香港-03 3 小时前、东京-02 2 小时前、吉隆坡-01 6 小时前、
#     美西-01 已离线两天）
#   1 台从未上报（无采集数据，探针卡片显示「从未上报 / 暂无采样」）
# 东京-02 在 2 小时前掉线，是港日多路径中间组的**第二台成员**，演示「多成员组里
# 非代表成员离线」；大阪-01 恢复在线后，4 跳模板的最后一跳才有完整时延 / 探测
# 样本，四跳丝带能看到一条完整可 pulse 的路径。
# 每台 1–3 个节点，另有用户、套餐实例、订阅、转发与 7 天流量/可用率采样。
#
# 链路模板与链：8 个模板覆盖 1–5 跳、共 24 条链。原有 5 个模板 / 17 条链原样
# 保留（701 港日双路、702 港新单跳、703 美西备用线、704 港日新四跳、705 港新
# 入口分叉）；新增 3 个深链模板 / 7 条链：
#   * 706 五跳全展开：每跳 5 / 3 / 2 / 4 / 1 个成员，2 条链在入口分叉、第 3 跳
#     共用东京-03、出口共用新加坡-03；一条活跃、一条空闲（含离线成员）；
#   * 707 四跳混合：每跳 1 / 4 / 3 / 2 个成员，两条活跃链在第 2–4 跳分开、共享
#     出口目标；一条空闲链只走在线 / 异常成员，演示「配置可用但没有流量」；
#   * 708 三跳大扇出：每跳 1 / 5 / 3 个成员，一条活跃链在中间跳扇出到 4 个
#     候选，一条空闲链经异常 + 离线成员。
# 每条链的每个 forward 都有最近 24h、5 分钟粒度的时延与探测样本；离线 / 异常
# 成员只写到停止之前。深链 706 活跃链的第 4 跳（新加坡-01 → 新加坡-03）时延
# 刻意偏高、探测失败率约 3%，其余路径约 0.2%，便于在详情里诊断单跳异常。
#
# 活跃 / 空闲的口径：活跃链的每个成员服务器在 traffic_daily / traffic_node_daily
# 里都有「今天」的行，且 forward_status 的累计流量 > 0；空闲链的 forward_status
# 累计流量为 0，专属成员（离线 / Xray 停止）在今天没有流量行，链路样本也只保留
# 到成员停止之前（707 空闲链的成员都还在线，因此能保留部分最近样本，证明链路
# 可用只是没流量）。流量表本身是「服务器 × 节点/账号」维度、没有 chain_id，
# 所以链级活跃度以 forward_status（按链推导的 forward id）为准，traffic_* 用来
# 证明成员机器上确实有 / 没有在搬运数据。
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
BEFORE_CHAIN_TEMPLATES="$(count_of chain_templates)"
BEFORE_CHAIN_GROUPS="$(count_of chain_groups)"
BEFORE_CHAIN_MEMBERS="$(count_of chain_group_members)"
BEFORE_LATENCY="$(count_of forward_latency_samples)"
BEFORE_PROBES="$(count_of forward_probe_samples)"
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

-- 固定 id + 先删后插：重复执行后仍是同样 15 台，不累积。
DELETE FROM servers;
-- 链没有指向 servers 的外键；成员已随 DELETE servers 级联清掉，这里把
-- 空的链壳也删掉，避免重复执行留下旧链。
DELETE FROM chains;
-- 链模板与链一起重建：模板是静态形态，不参与 chain-health 的样本映射；
-- package_chain_templates 的外键级联会一起清掉。
DELETE FROM chain_templates;

-- 删掉不属于任何现存主机的历史孤行，重复执行不会让计数越滚越大。
DELETE FROM traffic_daily WHERE server_id NOT IN (SELECT id FROM servers);
DELETE FROM traffic_node_daily WHERE server_id NOT IN (SELECT id FROM servers);
DELETE FROM traffic_reports WHERE server_id NOT IN (SELECT id FROM servers);
DELETE FROM forward_probe_samples WHERE server_id NOT IN (SELECT id FROM servers);
DELETE FROM forward_latency_samples WHERE server_id NOT IN (SELECT id FROM servers);
DELETE FROM enforcement_events WHERE server_id NOT IN (SELECT id FROM servers);

-- ------------------------------------------------------------
-- 15 台主机
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
  -- 东京 02：2 小时前掉线（港日多路径中间组的第二台成员，演示多成员 + 阻断）
  ('c0ffee00-0000-4000-8000-000000000005', '东京-02', '198.51.100.22', 'preview-token-jp-02', 'offline', 7200, 9, 25,
   '0.9.3', 0, 1, 0.93, 6549825126, 17179869184, 128849018880, 343597383680,
   1728000, 49, 'Debian GNU/Linux', '12', 'kvm', 'x86_64', 'JP', '日本',
   0.0, 0.0, 198765432109, 45678901234, 'failed', 'xray.service 启动失败：exit status 1', 1, 1, 1,
   'eth0', '10.0.0.22', '[{"name":"eth0","addresses":["198.51.100.22"]}]'),
  -- 大阪 01：健康在线（4 跳模板的最后一跳；在线才有完整四跳样本）
  ('c0ffee00-0000-4000-8000-000000000006', '大阪-01', '198.51.100.23', 'preview-token-jp-03', 'online', -86437, 4, 40,
   '0.9.3', 1, 1, 0.58, 3221225472, 8589934592, 59055800320, 171798691840,
   864000, 46, 'Debian GNU/Linux', '12', 'kvm', 'x86_64', 'JP', '日本',
   1572864.0, 524288.0, 54321098765, 12345678901, 'ok', NULL, 0, 1, 0,
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
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]'),
  -- 东京 03：健康在线（706 活跃路径第 3 跳；707 / 708 的在线候选）
  ('c0ffee00-0000-4000-8000-000000000011', '东京-03', '198.51.100.24', 'preview-token-jp-04', 'online', -86429, 6, 12,
   '0.9.3', 1, 1, 0.63, 3650722201, 8589934592, 51539607552, 171798691840,
   1296000, 57, 'Debian GNU/Linux', '12', 'kvm', 'x86_64', 'JP', '日本',
   2516582.4, 734003.2, 112345678901, 23456789012, 'ok', NULL, 1, 1, 1,
   'eth0', '10.0.0.24', '[{"name":"eth0","addresses":["198.51.100.24"]}]'),
  -- 新加坡 03：健康在线（706 活跃出口；707 / 708 的在线候选）
  ('c0ffee00-0000-4000-8000-000000000012', '新加坡-03', '192.0.2.34', 'preview-token-sg-03', 'online', -86431, 9, 9,
   '0.9.3', 1, 1, 0.47, 2899102925, 8589934592, 38654705664, 107374182400,
   1036800, 64, 'Ubuntu', '24.04', 'kvm', 'x86_64', 'SG', '新加坡',
   2936012.8, 891289.6, 72345678901, 15678901234, 'ok', NULL, 1, 1, 1,
   'eth0', '10.0.0.34', '[{"name":"eth0","addresses":["192.0.2.34"]}]'),
  -- 首尔 01：健康在线（706 第 4 跳候选；707 / 708 的在线候选）
  ('c0ffee00-0000-4000-8000-000000000013', '首尔-01', '198.51.100.52', 'preview-token-kr-01', 'online', -86423, 5, 6,
   '0.9.3', 1, 1, 0.39, 2684354560, 8589934592, 27917287424, 85899345920,
   691200, 71, 'Debian GNU/Linux', '12', 'kvm', 'x86_64', 'KR', '韩国',
   1992294.4, 629145.6, 45678901234, 9876543210, 'ok', NULL, 1, 1, 0,
   'eth0', '10.0.0.52', '[{"name":"eth0","addresses":["198.51.100.52"]}]'),
  -- 曼谷 01：Agent 在线、Xray 停止（异常成员；707 空闲链的第 2 跳）
  ('c0ffee00-0000-4000-8000-000000000014', '曼谷-01', '203.0.113.71', 'preview-token-th-01', 'online', -86443, 8, 16,
   '0.9.3', 0, 1, 1.41, 7086696038, 17179869184, 84700692480, 343597383680,
   1209600, 96, 'Ubuntu', '22.04', 'kvm', 'x86_64', 'TH', '泰国',
   0.0, 0.0, 34567890123, 8765432109, 'partial', '1 个受管文件写入失败', 1, 1, 0,
   'eth0', '10.0.0.71', '[{"name":"eth0","addresses":["203.0.113.71"]}]'),
  -- 吉隆坡 01：6 小时前掉线（706 / 708 空闲链的离线成员）
  ('c0ffee00-0000-4000-8000-000000000015', '吉隆坡-01', '203.0.113.81', 'preview-token-my-01', 'offline', 21600, 3, 33,
   '0.9.2', 1, 1, 0.12, 1610612736, 4294967296, 17179869184, 85899345920,
   432000, 118, 'Debian GNU/Linux', '12', 'kvm', 'x86_64', 'MY', '马来西亚',
   NULL, NULL, 23456789012, 6789012345, 'ok', NULL, 1, 1, 0,
   'eth0', '10.0.0.81', '[{"name":"eth0","addresses":["203.0.113.81"]}]')
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
-- 大阪-01 已恢复在线，保留「已过期」账单用于到期提醒；「离线不计入成本」
-- 由仍在离线的东京-02 / 美西-01 演示。
UPDATE servers SET paid_until = date('now', '-1 day'),
                   price_cents = 128000, currency = 'JPY',
                   billing_cycle = 'monthly', billing_cycle_count = 1, billing_cycle_unit = 'month'
 WHERE name = '大阪-01';
UPDATE servers SET paid_until = date('now', '+222 days'),
                   price_cents = 199900, currency = 'CNY',
                   billing_cycle = 'once', billing_cycle_count = 1, billing_cycle_unit = 'once'
 WHERE name = '美西-01';
-- 深链新增的 5 台：都填上费用，避免成本页出现「未知」的空行。
UPDATE servers SET paid_until = date('now', '+55 days'),
                   price_cents = 18800, currency = 'USD',
                   billing_cycle = 'monthly', billing_cycle_count = 1, billing_cycle_unit = 'month'
 WHERE name = '东京-03';
UPDATE servers SET paid_until = date('now', '+12 days'),
                   price_cents = 26800, currency = 'CNY',
                   billing_cycle = 'monthly', billing_cycle_count = 1, billing_cycle_unit = 'month'
 WHERE name = '新加坡-03';
UPDATE servers SET paid_until = date('now', '+33 days'),
                   price_cents = 15800, currency = 'USD',
                   billing_cycle = 'monthly', billing_cycle_count = 1, billing_cycle_unit = 'month'
 WHERE name = '首尔-01';
UPDATE servers SET paid_until = date('now', '+9 days'),
                   price_cents = 12800, currency = 'CNY',
                   billing_cycle = 'monthly', billing_cycle_count = 1, billing_cycle_unit = 'month'
 WHERE name = '曼谷-01';
UPDATE servers SET paid_until = date('now', '-2 days'),
                   price_cents = 9800, currency = 'CNY',
                   billing_cycle = 'monthly', billing_cycle_count = 1, billing_cycle_unit = 'month'
 WHERE name = '吉隆坡-01';

-- ------------------------------------------------------------
-- 节点：每台 1–3 个，共 23 个
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
   '{"flow":"xtls-rprx-vision"}', 1, '["待接入"]', NULL, 100000, 28),

  -- 深链新增主机各 1 个节点（traffic_node_daily 按 node_tag 归因）
  ('c0ffee00-0001-4000-8000-000000000119', 'c0ffee00-0000-4000-8000-000000000011', 'jp-04-vless', '东京三-VLESS', 'vless', 'tcp', 'reality', 443,
   '{"flow":"xtls-rprx-vision"}', 1, '["日本","深链"]', 'JP', 200000, 12),
  ('c0ffee00-0001-4000-8000-000000000120', 'c0ffee00-0000-4000-8000-000000000012', 'sg-03-vless', '新加坡三-VLESS', 'vless', 'tcp', 'reality', 443,
   '{"flow":"xtls-rprx-vision"}', 1, '["新加坡","深链"]', 'SG', 200000, 9),
  ('c0ffee00-0001-4000-8000-000000000121', 'c0ffee00-0000-4000-8000-000000000013', 'kr-01-reality', '首尔-REALITY', 'vless', 'tcp', 'reality', 443,
   '{"flow":"xtls-rprx-vision"}', 1, '["韩国","深链"]', 'KR', 200000, 6),
  ('c0ffee00-0001-4000-8000-000000000122', 'c0ffee00-0000-4000-8000-000000000014', 'th-01-vmess', '曼谷-VMess', 'vmess', 'ws', 'tls', 8443,
   '{"path":"/bangkok"}', 1, '["泰国","备用"]', 'TH', 100000, 16),
  ('c0ffee00-0001-4000-8000-000000000123', 'c0ffee00-0000-4000-8000-000000000015', 'my-01-vmess', '吉隆坡-VMess', 'vmess', 'ws', 'tls', 8443,
   '{"path":"/kl"}', 1, '["马来西亚","备用"]', 'MY', 100000, 33)
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
-- 转发链模板（概览 → 链路时延 → 模板洞察的预览数据）
-- ------------------------------------------------------------
-- 8 个模板，覆盖 1–5 跳与四种策略（前 5 个是既有模板，后 3 个是深链）：
--   港日双路 3 跳：入口 [香港-01/02/03]、中转 [东京-01/02]、
--     出口 [新加坡-01/02/大阪-01]；香港-03、东京-02 离线 →
--     blocked/member_offline。真实链在每一跳换成员，形成分叉 + 汇合；
--   港新单跳 1 跳：香港-02 → ok；
--   美西备用线 2 跳、已停用 → blocked/disabled（链仍保留，展示「停用模板
--     仍有历史链」的计数口径）；
--   港日新四跳 4 跳：中间两跳各 2 个候选、最后一跳单成员（大阪-01，在线），
--     四条链在中转 / 出口分叉、在出口汇合；东京-02 离线仍是候选 →
--     模板 blocked，但最后一跳的边都有当前 p50 / loss；
--   港新入口分叉 2 跳：入口 3 台（香港-01 / 香港-02 / 新加坡-02），
--     三条链各用一个入口，再汇入新加坡-01；
--   五跳全展开 5 跳：5 / 3 / 2 / 4 / 1 个候选（706）；
--   四跳混合 4 跳：1 / 4 / 3 / 2 个候选（707）；
--   三跳大扇出 3 跳：1 / 5 / 3 个候选（708）。
-- 新加坡-02 是「Agent 在线、Xray 停止」的异常成员（xray_running = 0），
-- 出现在 701 / 704 / 705 的候选里，真实链也会走到它；模板洞察按契约透传
-- servers.status（仍是 online），但样本在它停止后截断。
-- groups_json 的形态与 POST /api/v1/chain-templates 落库后的完全一致。
INSERT INTO chain_templates (
  id, name, engine, security, transport, protocol, groups_json, enabled, created_at
) VALUES
  ('c0ffee00-0007-4000-8000-000000000701', '港日双路', 'native', 'tls', 'none', 'tcp',
   '[{"seq":0,"strategy":"ip_hashed","server_ids":["c0ffee00-0000-4000-8000-000000000001","c0ffee00-0000-4000-8000-000000000002","c0ffee00-0000-4000-8000-000000000003"]},{"seq":1,"strategy":"lowest_latency","server_ids":["c0ffee00-0000-4000-8000-000000000004","c0ffee00-0000-4000-8000-000000000005"]},{"seq":2,"strategy":"failover","server_ids":["c0ffee00-0000-4000-8000-000000000007","c0ffee00-0000-4000-8000-000000000008","c0ffee00-0000-4000-8000-000000000006"]}]',
   1, CAST(strftime('%s','now') AS INTEGER) - 90 * 86400),
  ('c0ffee00-0007-4000-8000-000000000702', '港新单跳', 'native', 'tls', 'none', 'tcp',
   '[{"seq":0,"strategy":"round_robin","server_ids":["c0ffee00-0000-4000-8000-000000000002"]}]',
   1, CAST(strftime('%s','now') AS INTEGER) - 75 * 86400),
  ('c0ffee00-0007-4000-8000-000000000703', '美西备用线', 'native', 'tls', 'none', 'tcp',
   '[{"seq":0,"strategy":"lowest_latency","server_ids":["c0ffee00-0000-4000-8000-000000000002"]},{"seq":1,"strategy":"round_robin","server_ids":["c0ffee00-0000-4000-8000-000000000009"]}]',
   0, CAST(strftime('%s','now') AS INTEGER) - 60 * 86400),
  ('c0ffee00-0007-4000-8000-000000000704', '港日新四跳', 'native', 'tls', 'none', 'tcp',
   '[{"seq":0,"strategy":"round_robin","server_ids":["c0ffee00-0000-4000-8000-000000000001","c0ffee00-0000-4000-8000-000000000002"]},{"seq":1,"strategy":"ip_hashed","server_ids":["c0ffee00-0000-4000-8000-000000000004","c0ffee00-0000-4000-8000-000000000005"]},{"seq":2,"strategy":"lowest_latency","server_ids":["c0ffee00-0000-4000-8000-000000000007","c0ffee00-0000-4000-8000-000000000008"]},{"seq":3,"strategy":"failover","server_ids":["c0ffee00-0000-4000-8000-000000000006"]}]',
   1, CAST(strftime('%s','now') AS INTEGER) - 40 * 86400),
  ('c0ffee00-0007-4000-8000-000000000705', '港新入口分叉', 'native', 'tls', 'none', 'tcp',
   '[{"seq":0,"strategy":"ip_hashed","server_ids":["c0ffee00-0000-4000-8000-000000000001","c0ffee00-0000-4000-8000-000000000002","c0ffee00-0000-4000-8000-000000000008"]},{"seq":1,"strategy":"round_robin","server_ids":["c0ffee00-0000-4000-8000-000000000007"]}]',
   1, CAST(strftime('%s','now') AS INTEGER) - 20 * 86400),
  -- 706 五跳全展开：5 / 3 / 2 / 4 / 1 个候选。15 台服务器全部用上，两个链
  -- 在第 3 跳（东京-03）和出口（新加坡-03）汇合，其余跳分叉。
  ('c0ffee00-0007-4000-8000-000000000706', '五跳全展开', 'native', 'tls', 'none', 'tcp',
   '[{"seq":0,"strategy":"ip_hashed","server_ids":["c0ffee00-0000-4000-8000-000000000001","c0ffee00-0000-4000-8000-000000000003","c0ffee00-0000-4000-8000-000000000005","c0ffee00-0000-4000-8000-000000000009","c0ffee00-0000-4000-8000-000000000010"]},{"seq":1,"strategy":"lowest_latency","server_ids":["c0ffee00-0000-4000-8000-000000000004","c0ffee00-0000-4000-8000-000000000008","c0ffee00-0000-4000-8000-000000000014"]},{"seq":2,"strategy":"round_robin","server_ids":["c0ffee00-0000-4000-8000-000000000011","c0ffee00-0000-4000-8000-000000000015"]},{"seq":3,"strategy":"failover","server_ids":["c0ffee00-0000-4000-8000-000000000007","c0ffee00-0000-4000-8000-000000000002","c0ffee00-0000-4000-8000-000000000006","c0ffee00-0000-4000-8000-000000000013"]},{"seq":4,"strategy":"round_robin","server_ids":["c0ffee00-0000-4000-8000-000000000012"]}]',
   1, CAST(strftime('%s','now') AS INTEGER) - 18 * 86400),
  -- 707 四跳混合：1 / 4 / 3 / 2 个候选；两条活跃链 + 一条只走在线 / 异常的
  -- 空闲链（成员状态都不是 offline，所以链路是 degraded 而不是 blocked）。
  ('c0ffee00-0007-4000-8000-000000000707', '四跳混合', 'native', 'tls', 'none', 'tcp',
   '[{"seq":0,"strategy":"ip_hashed","server_ids":["c0ffee00-0000-4000-8000-000000000007"]},{"seq":1,"strategy":"round_robin","server_ids":["c0ffee00-0000-4000-8000-000000000001","c0ffee00-0000-4000-8000-000000000002","c0ffee00-0000-4000-8000-000000000004","c0ffee00-0000-4000-8000-000000000008"]},{"seq":2,"strategy":"lowest_latency","server_ids":["c0ffee00-0000-4000-8000-000000000006","c0ffee00-0000-4000-8000-000000000012","c0ffee00-0000-4000-8000-000000000014"]},{"seq":3,"strategy":"failover","server_ids":["c0ffee00-0000-4000-8000-000000000011","c0ffee00-0000-4000-8000-000000000013"]}]',
   1, CAST(strftime('%s','now') AS INTEGER) - 14 * 86400),
  -- 708 三跳大扇出：1 / 5 / 3 个候选；活跃链中间跳 4 个候选，空闲链经
  -- 新加坡-02（异常）到香港-03（离线）。
  ('c0ffee00-0007-4000-8000-000000000708', '三跳大扇出', 'native', 'tls', 'none', 'tcp',
   '[{"seq":0,"strategy":"round_robin","server_ids":["c0ffee00-0000-4000-8000-000000000007"]},{"seq":1,"strategy":"ip_hashed","server_ids":["c0ffee00-0000-4000-8000-000000000001","c0ffee00-0000-4000-8000-000000000002","c0ffee00-0000-4000-8000-000000000004","c0ffee00-0000-4000-8000-000000000011","c0ffee00-0000-4000-8000-000000000008"]},{"seq":2,"strategy":"lowest_latency","server_ids":["c0ffee00-0000-4000-8000-000000000012","c0ffee00-0000-4000-8000-000000000013","c0ffee00-0000-4000-8000-000000000003"]}]',
   1, CAST(strftime('%s','now') AS INTEGER) - 9 * 86400);

-- ------------------------------------------------------------
-- 链路拓扑：22 条模板链 + 2 条不挂模板的管理员链（共 24 条）
-- ------------------------------------------------------------
-- 每条链的跳数 / 成员都落在对应模板的候选集合里（template.stale = false）：
--   港日双路   3 跳：603 管理员「港日多路径」/ 711 kenji / 712 mei /
--              713 mei / 717 nora；入口 香港-01|香港-02，中转 东京-01|东京-02，
--              出口 新加坡-01|新加坡-02|大阪-01
--              （603 走东京双路再到大阪-01，东京-02 离线 → 链级 blocked）；
--   港新单跳   1 跳：714 kenji / 715 nora（出口 香港-02）
--   美西备用线 2 跳：716 nora（停用模板上的历史链）
--   港日新四跳 4 跳：721 kenji / 722 mei / 723 nora / 724 demo
--              香港 → 东京 → 新加坡 → 大阪，最后一跳单成员（大阪-01 在线），
--              四条链的最后一跳都有完整 24h 样本；
--   港新入口分叉 2 跳：731 kenji / 732 nora / 733 demo
--              入口分别是 香港-01 / 香港-02 / 新加坡-02，都汇入新加坡-01
--   五跳全展开 5 跳：751 kenji（活跃）/ 752 nora（空闲），
--              入口 5 台、第 2 跳 3 台、第 3 跳 2 台、第 4 跳 4 台、出口 1 台；
--              751 每跳单成员全在线，752 用其余候选并含离线 / 异常成员；
--   四跳混合   4 跳：761 kenji（活跃）/ 762 mei（活跃）/ 763 nora（空闲），
--              入口 1 台、第 2 跳 4 台、第 3 跳 3 台、出口 2 台；
--              761 / 762 共享入口和目标、在中段分开，763 只走在线 / 异常成员；
--   三跳大扇出 3 跳：771 kenji（活跃）/ 772 nora（空闲），
--              入口 1 台、扇出 5 台、出口 3 台；771 中间跳 4 台、772 经异常到离线。
-- 模板 701–708 共 22 条链（601 / 602 两条不挂模板），深链新增 6 个目标
-- （706 / 707 / 708 各 2 个）；707 的 761 / 762 共享同一目标，用于叶子汇合。
-- 端口按 (server_id, listen_port) 全局唯一分配，避免撞迁移 0047 的索引。
-- 既有链的 id / 名称 / 成员 / 端口全部原样保留，新链从 26001 起分配端口。
WITH chain_seed(
  id, name, target_host, target_port, enabled, created_secs, template_id, owner_name
) AS (VALUES
  -- 原管理员链：601 / 602 不挂模板；603「港日多路径」挂到 701，中间组含
  -- 已离线的 东京-02，用来演示 blocked/node_offline。
  ('c0ffee00-0006-4000-8000-000000000601', '港日中转链', '198.51.100.100', 443, 1,
   -45 * 86400, NULL, NULL),
  ('c0ffee00-0006-4000-8000-000000000602', '港新直达链', '192.0.2.100', 443, 1,
   -30 * 86400, NULL, NULL),
  ('c0ffee00-0006-4000-8000-000000000603', '港日多路径', '198.51.100.101', 8443, 1,
   -45 * 86400, 'c0ffee00-0007-4000-8000-000000000701', NULL),

  -- 港日双路：入口 / 中转 / 出口每一跳都换成员，717 与 713 在出口汇合。
  ('c0ffee00-0006-4000-8000-000000000711', 'kenji · 港日双路', '198.51.100.200', 443, 1,
   -6 * 86400, 'c0ffee00-0007-4000-8000-000000000701', 'kenji'),
  ('c0ffee00-0006-4000-8000-000000000712', 'mei · 港日双路 A', '198.51.100.201', 443, 1,
   -5 * 86400, 'c0ffee00-0007-4000-8000-000000000701', 'mei'),
  -- 713 保留原目标 198.51.100.201:443，与 712 一起验证「同目标 + 不同路径」
  -- 时目标节点合并、叶子不重复计数。
  ('c0ffee00-0006-4000-8000-000000000713', 'mei · 港日双路 B', '198.51.100.201', 443, 1,
   -4 * 86400, 'c0ffee00-0007-4000-8000-000000000701', 'mei'),
  ('c0ffee00-0006-4000-8000-000000000717', 'nora · 港日双路 C', '203.0.113.60', 8443, 1,
   -10 * 3600, 'c0ffee00-0007-4000-8000-000000000701', 'nora'),

  -- 港新单跳 / 美西备用线：保持原有链路语义。
  ('c0ffee00-0006-4000-8000-000000000714', 'kenji · 港新单跳', '203.0.113.50', 8443, 1,
   -3 * 86400, 'c0ffee00-0007-4000-8000-000000000702', 'kenji'),
  ('c0ffee00-0006-4000-8000-000000000715', 'nora · 港新单跳', '203.0.113.50', 8443, 1,
   -2 * 86400, 'c0ffee00-0007-4000-8000-000000000702', 'nora'),
  ('c0ffee00-0006-4000-8000-000000000716', 'nora · 美西备用', '198.51.100.210', 443, 1,
   -1 * 86400, 'c0ffee00-0007-4000-8000-000000000703', 'nora'),

  -- 港日新四跳：中间两跳各 2 个成员，最后一跳单成员（大阪-01）。
  ('c0ffee00-0006-4000-8000-000000000721', 'kenji · 港日新四跳', '198.51.100.220', 443, 1,
   -8 * 86400, 'c0ffee00-0007-4000-8000-000000000704', 'kenji'),
  ('c0ffee00-0006-4000-8000-000000000722', 'mei · 港日新四跳', '198.51.100.221', 443, 1,
   -7 * 86400, 'c0ffee00-0007-4000-8000-000000000704', 'mei'),
  ('c0ffee00-0006-4000-8000-000000000723', 'nora · 港日新四跳', '198.51.100.222', 8443, 1,
   -3 * 86400, 'c0ffee00-0007-4000-8000-000000000704', 'nora'),
  ('c0ffee00-0006-4000-8000-000000000724', 'demo · 港日新四跳', '198.51.100.220', 443, 1,
   -5 * 3600, 'c0ffee00-0007-4000-8000-000000000704', 'demo'),

  -- 港新入口分叉：三条链各用一个入口，最后都汇入新加坡-01。
  ('c0ffee00-0006-4000-8000-000000000731', 'kenji · 港新入口 A', '203.0.113.230', 443, 1,
   -2 * 86400, 'c0ffee00-0007-4000-8000-000000000705', 'kenji'),
  ('c0ffee00-0006-4000-8000-000000000732', 'nora · 港新入口 B', '203.0.113.231', 443, 1,
   -6 * 86400, 'c0ffee00-0007-4000-8000-000000000705', 'nora'),
  ('c0ffee00-0006-4000-8000-000000000733', 'demo · 港新入口 C', '203.0.113.232', 443, 1,
   -1 * 3600, 'c0ffee00-0007-4000-8000-000000000705', 'demo'),

  -- 706 五跳全展开：751 是活跃链（全在线成员），752 是空闲链（含离线 /
  -- 异常成员），两条链在第 3 跳（东京-03）和出口（新加坡-03）汇合。
  ('c0ffee00-0006-4000-8000-000000000751', 'kenji · 五跳快线', '198.51.100.240', 443, 1,
   -7 * 86400, 'c0ffee00-0007-4000-8000-000000000706', 'kenji'),
  ('c0ffee00-0006-4000-8000-000000000752', 'nora · 五跳备线', '198.51.100.241', 8443, 1,
   -4 * 86400, 'c0ffee00-0007-4000-8000-000000000706', 'nora'),

  -- 707 四跳混合：761 / 762 活跃，762 与 761 共享目标；763 空闲。
  ('c0ffee00-0006-4000-8000-000000000761', 'kenji · 四跳主用', '203.0.113.250', 443, 1,
   -5 * 86400, 'c0ffee00-0007-4000-8000-000000000707', 'kenji'),
  ('c0ffee00-0006-4000-8000-000000000762', 'mei · 四跳备用', '203.0.113.250', 443, 1,
   -3 * 86400, 'c0ffee00-0007-4000-8000-000000000707', 'mei'),
  ('c0ffee00-0006-4000-8000-000000000763', 'nora · 四跳空闲', '203.0.113.251', 8443, 1,
   -2 * 86400, 'c0ffee00-0007-4000-8000-000000000707', 'nora'),

  -- 708 三跳大扇出：771 活跃、772 空闲。
  ('c0ffee00-0006-4000-8000-000000000771', 'kenji · 三跳扇出', '192.0.2.180', 443, 1,
   -6 * 86400, 'c0ffee00-0007-4000-8000-000000000708', 'kenji'),
  ('c0ffee00-0006-4000-8000-000000000772', 'nora · 三跳空闲', '192.0.2.181', 8443, 1,
   -2 * 86400, 'c0ffee00-0007-4000-8000-000000000708', 'nora')
)
INSERT INTO chains (
  id, name, target_host, target_port, enabled, created_at, updated_at,
  template_id, owner_user_id
)
SELECT
  id, name, target_host, target_port, enabled,
  CAST(strftime('%s','now') AS INTEGER) + created_secs,
  CAST(strftime('%s','now') AS INTEGER) - 3600,
  template_id,
  CASE
    WHEN owner_name IS NULL THEN NULL
    -- demo 在预览库里是已有的随机 id 用户；新库没有 demo 时回退到 kenji，
    -- 避免 owner_user_id 指向不存在的用户、让模板 users 出现悬空 id。
    ELSE COALESCE(
      (SELECT u.id FROM users u WHERE u.username = owner_name),
      'c0ffee00-0002-4000-8000-000000000201'
    )
  END
FROM chain_seed;

-- ------------------------------------------------------------
-- 链的组（跳）与成员
-- ------------------------------------------------------------
-- 组的策略与模板一致；多成员组用 priority 0/1 区分主备。
INSERT INTO chain_groups (id, chain_id, seq, name, strategy, cert_id, public_port, use_internal_address)
VALUES
  -- 601 / 602：原样保留
  ('c0ffee00-0006-4000-8000-000000000611', 'c0ffee00-0006-4000-8000-000000000601', 0, '香港入口', 'round_robin', NULL, NULL, 0),
  ('c0ffee00-0006-4000-8000-000000000612', 'c0ffee00-0006-4000-8000-000000000601', 1, '东京中转', 'round_robin', NULL, NULL, 0),
  ('c0ffee00-0006-4000-8000-000000000613', 'c0ffee00-0006-4000-8000-000000000601', 2, '新加坡中转', 'round_robin', NULL, NULL, 0),
  ('c0ffee00-0006-4000-8000-000000000614', 'c0ffee00-0006-4000-8000-000000000601', 3, '大阪出口', 'round_robin', NULL, NULL, 0),
  ('c0ffee00-0006-4000-8000-000000000621', 'c0ffee00-0006-4000-8000-000000000602', 0, '香港入口', 'round_robin', NULL, NULL, 0),
  ('c0ffee00-0006-4000-8000-000000000622', 'c0ffee00-0006-4000-8000-000000000602', 1, '新加坡出口', 'round_robin', NULL, NULL, 0),

  -- 港日双路：603 管理员（多路径）+ 711 / 712 / 713 / 717 用户链
  ('c0ffee00-0006-4000-8000-000000000631', 'c0ffee00-0006-4000-8000-000000000603', 0, '香港入口', 'ip_hashed', NULL, NULL, 0),
  ('c0ffee00-0006-4000-8000-000000000632', 'c0ffee00-0006-4000-8000-000000000603', 1, '东京中转（双路）', 'lowest_latency', NULL, NULL, 0),
  ('c0ffee00-0006-4000-8000-000000000633', 'c0ffee00-0006-4000-8000-000000000603', 2, '大阪出口', 'failover', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000711', 'c0ffee00-0006-4000-8000-000000000711', 0, '香港入口', 'ip_hashed', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000712', 'c0ffee00-0006-4000-8000-000000000711', 1, '东京中转', 'lowest_latency', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000713', 'c0ffee00-0006-4000-8000-000000000711', 2, '新加坡出口', 'failover', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000721', 'c0ffee00-0006-4000-8000-000000000712', 0, '香港入口', 'ip_hashed', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000722', 'c0ffee00-0006-4000-8000-000000000712', 1, '东京中转', 'lowest_latency', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000723', 'c0ffee00-0006-4000-8000-000000000712', 2, '新加坡出口', 'failover', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000731', 'c0ffee00-0006-4000-8000-000000000713', 0, '香港入口', 'ip_hashed', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000732', 'c0ffee00-0006-4000-8000-000000000713', 1, '东京备用', 'lowest_latency', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000733', 'c0ffee00-0006-4000-8000-000000000713', 2, '新加坡出口', 'failover', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000771', 'c0ffee00-0006-4000-8000-000000000717', 0, '香港入口', 'ip_hashed', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000772', 'c0ffee00-0006-4000-8000-000000000717', 1, '东京中转', 'lowest_latency', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000773', 'c0ffee00-0006-4000-8000-000000000717', 2, '新加坡出口', 'failover', NULL, NULL, 0),

  -- 港新单跳 / 美西备用线
  ('c0ffee00-0008-4000-8000-000000000741', 'c0ffee00-0006-4000-8000-000000000714', 0, '香港入口', 'round_robin', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000751', 'c0ffee00-0006-4000-8000-000000000715', 0, '香港入口', 'round_robin', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000761', 'c0ffee00-0006-4000-8000-000000000716', 0, '香港入口', 'lowest_latency', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000762', 'c0ffee00-0006-4000-8000-000000000716', 1, '美西出口', 'round_robin', NULL, NULL, 0),

  -- 港日新四跳：721 / 722 / 723 / 724
  ('c0ffee00-0008-4000-8000-000000000801', 'c0ffee00-0006-4000-8000-000000000721', 0, '香港入口', 'round_robin', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000802', 'c0ffee00-0006-4000-8000-000000000721', 1, '东京中转', 'ip_hashed', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000803', 'c0ffee00-0006-4000-8000-000000000721', 2, '新加坡中转', 'lowest_latency', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000804', 'c0ffee00-0006-4000-8000-000000000721', 3, '大阪出口', 'failover', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000811', 'c0ffee00-0006-4000-8000-000000000722', 0, '香港入口', 'round_robin', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000812', 'c0ffee00-0006-4000-8000-000000000722', 1, '东京中转', 'ip_hashed', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000813', 'c0ffee00-0006-4000-8000-000000000722', 2, '新加坡中转', 'lowest_latency', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000814', 'c0ffee00-0006-4000-8000-000000000722', 3, '大阪出口', 'failover', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000821', 'c0ffee00-0006-4000-8000-000000000723', 0, '香港入口', 'round_robin', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000822', 'c0ffee00-0006-4000-8000-000000000723', 1, '东京备用', 'ip_hashed', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000823', 'c0ffee00-0006-4000-8000-000000000723', 2, '新加坡中转', 'lowest_latency', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000824', 'c0ffee00-0006-4000-8000-000000000723', 3, '大阪出口', 'failover', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000831', 'c0ffee00-0006-4000-8000-000000000724', 0, '香港入口', 'round_robin', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000832', 'c0ffee00-0006-4000-8000-000000000724', 1, '东京中转', 'ip_hashed', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000833', 'c0ffee00-0006-4000-8000-000000000724', 2, '新加坡中转', 'lowest_latency', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000834', 'c0ffee00-0006-4000-8000-000000000724', 3, '大阪出口', 'failover', NULL, NULL, 0),

  -- 港新入口分叉：731 / 732 / 733
  ('c0ffee00-0008-4000-8000-000000000841', 'c0ffee00-0006-4000-8000-000000000731', 0, '香港入口', 'ip_hashed', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000842', 'c0ffee00-0006-4000-8000-000000000731', 1, '新加坡出口', 'round_robin', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000851', 'c0ffee00-0006-4000-8000-000000000732', 0, '香港入口', 'ip_hashed', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000852', 'c0ffee00-0006-4000-8000-000000000732', 1, '新加坡出口', 'round_robin', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000861', 'c0ffee00-0006-4000-8000-000000000733', 0, '新加坡入口', 'ip_hashed', NULL, NULL, 0),
  ('c0ffee00-0008-4000-8000-000000000862', 'c0ffee00-0006-4000-8000-000000000733', 1, '新加坡出口', 'round_robin', NULL, NULL, 0),

  -- 706 五跳全展开：751 活跃（每跳单成员）/ 752 空闲（多成员候选）
  ('c0ffee00-0009-4000-8000-000000007510', 'c0ffee00-0006-4000-8000-000000000751', 0, '香港入口', 'ip_hashed', NULL, NULL, 0),
  ('c0ffee00-0009-4000-8000-000000007511', 'c0ffee00-0006-4000-8000-000000000751', 1, '东京中转', 'lowest_latency', NULL, NULL, 0),
  ('c0ffee00-0009-4000-8000-000000007512', 'c0ffee00-0006-4000-8000-000000000751', 2, '东京三中转', 'round_robin', NULL, NULL, 0),
  ('c0ffee00-0009-4000-8000-000000007513', 'c0ffee00-0006-4000-8000-000000000751', 3, '新加坡中转', 'failover', NULL, NULL, 0),
  ('c0ffee00-0009-4000-8000-000000007514', 'c0ffee00-0006-4000-8000-000000000751', 4, '新加坡三出口', 'round_robin', NULL, NULL, 0),
  ('c0ffee00-0009-4000-8000-000000007520', 'c0ffee00-0006-4000-8000-000000000752', 0, '香港入口', 'ip_hashed', NULL, NULL, 0),
  ('c0ffee00-0009-4000-8000-000000007521', 'c0ffee00-0006-4000-8000-000000000752', 1, '东京备用', 'lowest_latency', NULL, NULL, 0),
  ('c0ffee00-0009-4000-8000-000000007522', 'c0ffee00-0006-4000-8000-000000000752', 2, '东京三备用', 'round_robin', NULL, NULL, 0),
  ('c0ffee00-0009-4000-8000-000000007523', 'c0ffee00-0006-4000-8000-000000000752', 3, '首尔中转', 'failover', NULL, NULL, 0),
  ('c0ffee00-0009-4000-8000-000000007524', 'c0ffee00-0006-4000-8000-000000000752', 4, '新加坡三出口', 'round_robin', NULL, NULL, 0),

  -- 707 四跳混合：761 / 762 活跃，763 空闲
  ('c0ffee00-0009-4000-8000-000000007610', 'c0ffee00-0006-4000-8000-000000000761', 0, '新加坡入口', 'ip_hashed', NULL, NULL, 0),
  ('c0ffee00-0009-4000-8000-000000007611', 'c0ffee00-0006-4000-8000-000000000761', 1, '香港分流', 'round_robin', NULL, NULL, 0),
  ('c0ffee00-0009-4000-8000-000000007612', 'c0ffee00-0006-4000-8000-000000000761', 2, '大阪中转', 'lowest_latency', NULL, NULL, 0),
  ('c0ffee00-0009-4000-8000-000000007613', 'c0ffee00-0006-4000-8000-000000000761', 3, '东京三出口', 'failover', NULL, NULL, 0),
  ('c0ffee00-0009-4000-8000-000000007620', 'c0ffee00-0006-4000-8000-000000000762', 0, '新加坡入口', 'ip_hashed', NULL, NULL, 0),
  ('c0ffee00-0009-4000-8000-000000007621', 'c0ffee00-0006-4000-8000-000000000762', 1, '东京中转', 'round_robin', NULL, NULL, 0),
  ('c0ffee00-0009-4000-8000-000000007622', 'c0ffee00-0006-4000-8000-000000000762', 2, '新加坡三中转', 'lowest_latency', NULL, NULL, 0),
  ('c0ffee00-0009-4000-8000-000000007623', 'c0ffee00-0006-4000-8000-000000000762', 3, '首尔出口', 'failover', NULL, NULL, 0),
  ('c0ffee00-0009-4000-8000-000000007630', 'c0ffee00-0006-4000-8000-000000000763', 0, '新加坡入口', 'ip_hashed', NULL, NULL, 0),
  ('c0ffee00-0009-4000-8000-000000007631', 'c0ffee00-0006-4000-8000-000000000763', 1, '新加坡二中转', 'round_robin', NULL, NULL, 0),
  ('c0ffee00-0009-4000-8000-000000007632', 'c0ffee00-0006-4000-8000-000000000763', 2, '曼谷中转', 'lowest_latency', NULL, NULL, 0),
  ('c0ffee00-0009-4000-8000-000000007633', 'c0ffee00-0006-4000-8000-000000000763', 3, '首尔出口', 'failover', NULL, NULL, 0),

  -- 708 三跳大扇出：771 活跃，772 空闲
  ('c0ffee00-0009-4000-8000-000000007710', 'c0ffee00-0006-4000-8000-000000000771', 0, '新加坡入口', 'round_robin', NULL, NULL, 0),
  ('c0ffee00-0009-4000-8000-000000007711', 'c0ffee00-0006-4000-8000-000000000771', 1, '港日扇出', 'ip_hashed', NULL, NULL, 0),
  ('c0ffee00-0009-4000-8000-000000007712', 'c0ffee00-0006-4000-8000-000000000771', 2, '新首出口', 'lowest_latency', NULL, NULL, 0),
  ('c0ffee00-0009-4000-8000-000000007720', 'c0ffee00-0006-4000-8000-000000000772', 0, '新加坡入口', 'round_robin', NULL, NULL, 0),
  ('c0ffee00-0009-4000-8000-000000007721', 'c0ffee00-0006-4000-8000-000000000772', 1, '新加坡二扇出', 'ip_hashed', NULL, NULL, 0),
  ('c0ffee00-0009-4000-8000-000000007722', 'c0ffee00-0006-4000-8000-000000000772', 2, '香港三出口', 'lowest_latency', NULL, NULL, 0);

INSERT INTO chain_group_members (group_id, server_id, listen_port, priority, weight)
VALUES
  -- 601 / 602：原样保留
  ('c0ffee00-0006-4000-8000-000000000611', 'c0ffee00-0000-4000-8000-000000000001', 21001, 0, 1),
  ('c0ffee00-0006-4000-8000-000000000612', 'c0ffee00-0000-4000-8000-000000000004', 21002, 0, 1),
  ('c0ffee00-0006-4000-8000-000000000613', 'c0ffee00-0000-4000-8000-000000000007', 21003, 0, 1),
  ('c0ffee00-0006-4000-8000-000000000614', 'c0ffee00-0000-4000-8000-000000000006', 21004, 0, 1),
  ('c0ffee00-0006-4000-8000-000000000621', 'c0ffee00-0000-4000-8000-000000000002', 21101, 0, 1),
  ('c0ffee00-0006-4000-8000-000000000622', 'c0ffee00-0000-4000-8000-000000000008', 21102, 0, 1),

  -- 603（管理员，港日多路径）：香港-01 →（东京-01 / 东京-02）→ 大阪-01；
  -- 东京-02 离线 → 链级 blocked/node_offline；大阪-01 在线，最后一跳有完整样本。
  ('c0ffee00-0006-4000-8000-000000000631', 'c0ffee00-0000-4000-8000-000000000001', 23001, 0, 1),
  ('c0ffee00-0006-4000-8000-000000000632', 'c0ffee00-0000-4000-8000-000000000004', 23002, 0, 1),
  ('c0ffee00-0006-4000-8000-000000000632', 'c0ffee00-0000-4000-8000-000000000005', 23005, 1, 1),
  ('c0ffee00-0006-4000-8000-000000000633', 'c0ffee00-0000-4000-8000-000000000006', 23003, 0, 1),

  -- 711（kenji）：香港-02 → 东京-01 → 新加坡-01
  ('c0ffee00-0008-4000-8000-000000000711', 'c0ffee00-0000-4000-8000-000000000002', 23101, 0, 1),
  ('c0ffee00-0008-4000-8000-000000000712', 'c0ffee00-0000-4000-8000-000000000004', 23102, 0, 1),
  ('c0ffee00-0008-4000-8000-000000000713', 'c0ffee00-0000-4000-8000-000000000007', 23103, 0, 1),

  -- 712（mei）：入口组两台（香港-01 / 香港-02）真实分流 → 东京-01 → 新加坡-01
  ('c0ffee00-0008-4000-8000-000000000721', 'c0ffee00-0000-4000-8000-000000000001', 23111, 0, 1),
  ('c0ffee00-0008-4000-8000-000000000721', 'c0ffee00-0000-4000-8000-000000000002', 23112, 1, 1),
  ('c0ffee00-0008-4000-8000-000000000722', 'c0ffee00-0000-4000-8000-000000000004', 23113, 0, 1),
  ('c0ffee00-0008-4000-8000-000000000723', 'c0ffee00-0000-4000-8000-000000000007', 23115, 0, 1),

  -- 713（mei）：香港-02 → 东京-02（离线）→ 新加坡-02（异常）
  ('c0ffee00-0008-4000-8000-000000000731', 'c0ffee00-0000-4000-8000-000000000002', 23121, 0, 1),
  ('c0ffee00-0008-4000-8000-000000000732', 'c0ffee00-0000-4000-8000-000000000005', 23122, 0, 1),
  ('c0ffee00-0008-4000-8000-000000000733', 'c0ffee00-0000-4000-8000-000000000008', 23123, 0, 1),

  -- 717（nora）：香港-01 → 东京-01 → 新加坡-02（异常），与 713 在出口汇合
  ('c0ffee00-0008-4000-8000-000000000771', 'c0ffee00-0000-4000-8000-000000000001', 23131, 0, 1),
  ('c0ffee00-0008-4000-8000-000000000772', 'c0ffee00-0000-4000-8000-000000000004', 23132, 0, 1),
  ('c0ffee00-0008-4000-8000-000000000773', 'c0ffee00-0000-4000-8000-000000000008', 23133, 0, 1),

  -- 714 / 715 / 716
  ('c0ffee00-0008-4000-8000-000000000741', 'c0ffee00-0000-4000-8000-000000000002', 22301, 0, 1),
  ('c0ffee00-0008-4000-8000-000000000751', 'c0ffee00-0000-4000-8000-000000000002', 22302, 0, 1),
  ('c0ffee00-0008-4000-8000-000000000761', 'c0ffee00-0000-4000-8000-000000000002', 22401, 0, 1),
  ('c0ffee00-0008-4000-8000-000000000762', 'c0ffee00-0000-4000-8000-000000000009', 22402, 0, 1),

  -- 721（kenji）：香港-01 → 东京-01 → 新加坡-01 → 大阪-01
  ('c0ffee00-0008-4000-8000-000000000801', 'c0ffee00-0000-4000-8000-000000000001', 24001, 0, 1),
  ('c0ffee00-0008-4000-8000-000000000802', 'c0ffee00-0000-4000-8000-000000000004', 24002, 0, 1),
  ('c0ffee00-0008-4000-8000-000000000803', 'c0ffee00-0000-4000-8000-000000000007', 24003, 0, 1),
  ('c0ffee00-0008-4000-8000-000000000804', 'c0ffee00-0000-4000-8000-000000000006', 24004, 0, 1),

  -- 722（mei）：香港-02 → 东京-01 → 新加坡-02（异常）→ 大阪-01
  ('c0ffee00-0008-4000-8000-000000000811', 'c0ffee00-0000-4000-8000-000000000002', 24101, 0, 1),
  ('c0ffee00-0008-4000-8000-000000000812', 'c0ffee00-0000-4000-8000-000000000004', 24102, 0, 1),
  ('c0ffee00-0008-4000-8000-000000000813', 'c0ffee00-0000-4000-8000-000000000008', 24103, 0, 1),
  ('c0ffee00-0008-4000-8000-000000000814', 'c0ffee00-0000-4000-8000-000000000006', 24104, 0, 1),

  -- 723（nora）：香港-01 → 东京-02（离线）→ 新加坡-01 → 大阪-01
  ('c0ffee00-0008-4000-8000-000000000821', 'c0ffee00-0000-4000-8000-000000000001', 24111, 0, 1),
  ('c0ffee00-0008-4000-8000-000000000822', 'c0ffee00-0000-4000-8000-000000000005', 24112, 0, 1),
  ('c0ffee00-0008-4000-8000-000000000823', 'c0ffee00-0000-4000-8000-000000000007', 24113, 0, 1),
  ('c0ffee00-0008-4000-8000-000000000824', 'c0ffee00-0000-4000-8000-000000000006', 24114, 0, 1),

  -- 724（demo）：香港-02 → 东京-01 → 新加坡-01 → 大阪-01
  ('c0ffee00-0008-4000-8000-000000000831', 'c0ffee00-0000-4000-8000-000000000002', 24121, 0, 1),
  ('c0ffee00-0008-4000-8000-000000000832', 'c0ffee00-0000-4000-8000-000000000004', 24122, 0, 1),
  ('c0ffee00-0008-4000-8000-000000000833', 'c0ffee00-0000-4000-8000-000000000007', 24123, 0, 1),
  ('c0ffee00-0008-4000-8000-000000000834', 'c0ffee00-0000-4000-8000-000000000006', 24124, 0, 1),

  -- 731 / 732 / 733：入口各一台，都汇入新加坡-01
  ('c0ffee00-0008-4000-8000-000000000841', 'c0ffee00-0000-4000-8000-000000000001', 25001, 0, 1),
  ('c0ffee00-0008-4000-8000-000000000842', 'c0ffee00-0000-4000-8000-000000000007', 25002, 0, 1),
  ('c0ffee00-0008-4000-8000-000000000851', 'c0ffee00-0000-4000-8000-000000000002', 25101, 0, 1),
  ('c0ffee00-0008-4000-8000-000000000852', 'c0ffee00-0000-4000-8000-000000000007', 25102, 0, 1),
  ('c0ffee00-0008-4000-8000-000000000861', 'c0ffee00-0000-4000-8000-000000000008', 25201, 0, 1),
  ('c0ffee00-0008-4000-8000-000000000862', 'c0ffee00-0000-4000-8000-000000000007', 25202, 0, 1),

  -- 751（kenji · 五跳快线，活跃）：香港-01 → 东京-01 → 东京-03 → 新加坡-01
  -- → 新加坡-03，每跳单成员，全部在线且 Xray 正常。
  ('c0ffee00-0009-4000-8000-000000007510', 'c0ffee00-0000-4000-8000-000000000001', 26001, 0, 1),
  ('c0ffee00-0009-4000-8000-000000007511', 'c0ffee00-0000-4000-8000-000000000004', 26002, 0, 1),
  ('c0ffee00-0009-4000-8000-000000007512', 'c0ffee00-0000-4000-8000-000000000011', 26003, 0, 1),
  ('c0ffee00-0009-4000-8000-000000007513', 'c0ffee00-0000-4000-8000-000000000007', 26004, 0, 1),
  ('c0ffee00-0009-4000-8000-000000007514', 'c0ffee00-0000-4000-8000-000000000012', 26005, 0, 1),

  -- 752（nora · 五跳备线，空闲）：入口 4 台（含离线）、第 2 跳两台异常、
  -- 第 3 跳与 751 共用东京-03 后接吉隆坡-01（离线）、第 4 跳三台在线、
  -- 出口与 751 共用新加坡-03。整条链没有流量，样本只到成员停止之前。
  ('c0ffee00-0009-4000-8000-000000007520', 'c0ffee00-0000-4000-8000-000000000003', 26006, 0, 1),
  ('c0ffee00-0009-4000-8000-000000007520', 'c0ffee00-0000-4000-8000-000000000005', 26007, 1, 1),
  ('c0ffee00-0009-4000-8000-000000007520', 'c0ffee00-0000-4000-8000-000000000009', 26008, 2, 1),
  ('c0ffee00-0009-4000-8000-000000007520', 'c0ffee00-0000-4000-8000-000000000010', 26009, 3, 1),
  ('c0ffee00-0009-4000-8000-000000007521', 'c0ffee00-0000-4000-8000-000000000008', 26010, 0, 1),
  ('c0ffee00-0009-4000-8000-000000007521', 'c0ffee00-0000-4000-8000-000000000014', 26011, 1, 1),
  ('c0ffee00-0009-4000-8000-000000007522', 'c0ffee00-0000-4000-8000-000000000011', 26012, 0, 1),
  ('c0ffee00-0009-4000-8000-000000007522', 'c0ffee00-0000-4000-8000-000000000015', 26013, 1, 1),
  ('c0ffee00-0009-4000-8000-000000007523', 'c0ffee00-0000-4000-8000-000000000002', 26014, 0, 1),
  ('c0ffee00-0009-4000-8000-000000007523', 'c0ffee00-0000-4000-8000-000000000006', 26015, 1, 1),
  ('c0ffee00-0009-4000-8000-000000007523', 'c0ffee00-0000-4000-8000-000000000013', 26016, 2, 1),
  ('c0ffee00-0009-4000-8000-000000007524', 'c0ffee00-0000-4000-8000-000000000012', 26017, 0, 1),

  -- 761（kenji · 四跳主用，活跃）：新加坡-01 → 香港分流 → 大阪-01 → 东京-03
  ('c0ffee00-0009-4000-8000-000000007610', 'c0ffee00-0000-4000-8000-000000000007', 26018, 0, 1),
  ('c0ffee00-0009-4000-8000-000000007611', 'c0ffee00-0000-4000-8000-000000000001', 26019, 0, 1),
  ('c0ffee00-0009-4000-8000-000000007611', 'c0ffee00-0000-4000-8000-000000000002', 26020, 1, 1),
  ('c0ffee00-0009-4000-8000-000000007612', 'c0ffee00-0000-4000-8000-000000000006', 26021, 0, 1),
  ('c0ffee00-0009-4000-8000-000000007613', 'c0ffee00-0000-4000-8000-000000000011', 26022, 0, 1),

  -- 762（mei · 四跳备用，活跃）：在新加坡-01 / 东京-01 / 新加坡-03 /
  -- 首尔-01 上走另一组成员，出口与 761 不是同一台，但目标相同。
  ('c0ffee00-0009-4000-8000-000000007620', 'c0ffee00-0000-4000-8000-000000000007', 26023, 0, 1),
  ('c0ffee00-0009-4000-8000-000000007621', 'c0ffee00-0000-4000-8000-000000000004', 26024, 0, 1),
  ('c0ffee00-0009-4000-8000-000000007622', 'c0ffee00-0000-4000-8000-000000000012', 26025, 0, 1),
  ('c0ffee00-0009-4000-8000-000000007623', 'c0ffee00-0000-4000-8000-000000000013', 26026, 0, 1),

  -- 763（nora · 四跳空闲）：新加坡-01 → 新加坡-02（异常）→ 曼谷-01
  -- （异常）→ 首尔-01。成员状态都是 online（Xray 停止），所以链是
  -- degraded/no_samples 而不是 blocked；没有流量。
  ('c0ffee00-0009-4000-8000-000000007630', 'c0ffee00-0000-4000-8000-000000000007', 26027, 0, 1),
  ('c0ffee00-0009-4000-8000-000000007631', 'c0ffee00-0000-4000-8000-000000000008', 26028, 0, 1),
  ('c0ffee00-0009-4000-8000-000000007632', 'c0ffee00-0000-4000-8000-000000000014', 26029, 0, 1),
  ('c0ffee00-0009-4000-8000-000000007633', 'c0ffee00-0000-4000-8000-000000000013', 26030, 0, 1),

  -- 771（kenji · 三跳扇出，活跃）：新加坡-01 入口，第 2 跳 4 个在线候选，
  -- 第 3 跳两个在线候选；全在线。
  ('c0ffee00-0009-4000-8000-000000007710', 'c0ffee00-0000-4000-8000-000000000007', 26031, 0, 1),
  ('c0ffee00-0009-4000-8000-000000007711', 'c0ffee00-0000-4000-8000-000000000001', 26032, 0, 1),
  ('c0ffee00-0009-4000-8000-000000007711', 'c0ffee00-0000-4000-8000-000000000002', 26033, 1, 1),
  ('c0ffee00-0009-4000-8000-000000007711', 'c0ffee00-0000-4000-8000-000000000004', 26034, 2, 1),
  ('c0ffee00-0009-4000-8000-000000007711', 'c0ffee00-0000-4000-8000-000000000011', 26035, 3, 1),
  ('c0ffee00-0009-4000-8000-000000007712', 'c0ffee00-0000-4000-8000-000000000012', 26036, 0, 1),
  ('c0ffee00-0009-4000-8000-000000007712', 'c0ffee00-0000-4000-8000-000000000013', 26037, 1, 1),

  -- 772（nora · 三跳空闲）：新加坡-01 → 新加坡-02（异常）→ 香港-03（离线）
  ('c0ffee00-0009-4000-8000-000000007720', 'c0ffee00-0000-4000-8000-000000000007', 26038, 0, 1),
  ('c0ffee00-0009-4000-8000-000000007721', 'c0ffee00-0000-4000-8000-000000000008', 26039, 0, 1),
  ('c0ffee00-0009-4000-8000-000000007722', 'c0ffee00-0000-4000-8000-000000000003', 26040, 0, 1);

-- ------------------------------------------------------------
-- 新增深链的 forward 运行时状态：活跃链有累计流量，空闲链为 0
-- ------------------------------------------------------------
-- 预览库没有真实 Agent 心跳，链详情默认每个 forward 都是 `—`。这里只给 706 /
-- 707 / 708 的 7 条新链补状态，让「正在搬数据 / 空闲」在链详情和逐跳流量里
-- 直接可见：活跃链（751 / 761 / 762 / 771）监听正常且累计 traffic_in/out > 0；
-- 空闲链（752 / 763 / 772）同样监听成功，但累计流量固定为 0 —— 证明链路配置
-- 可用、只是没有流量。离线成员 listening = 0（异常成员仍按 online 处理）。
-- 既有 17 条链的状态保持原样（不写），避免改动已验收的链详情。
WITH group_members AS (
  SELECT
    g.chain_id,
    g.seq,
    m.server_id,
    (SELECT COUNT(*) FROM chain_group_members x WHERE x.group_id = g.id) AS member_count
  FROM chain_groups g
  JOIN chain_group_members m ON m.group_id = g.id
  WHERE g.chain_id IN (
    'c0ffee00-0006-4000-8000-000000000751',
    'c0ffee00-0006-4000-8000-000000000752',
    'c0ffee00-0006-4000-8000-000000000761',
    'c0ffee00-0006-4000-8000-000000000762',
    'c0ffee00-0006-4000-8000-000000000763',
    'c0ffee00-0006-4000-8000-000000000771',
    'c0ffee00-0006-4000-8000-000000000772'
  )
),
listening AS (
  SELECT
    gm.*,
    CASE
      WHEN s.status = 'online' AND COALESCE(s.xray_running, 1) <> 0 THEN 1
      ELSE 0
    END AS up
  FROM group_members gm
  JOIN servers s ON s.id = gm.server_id
)
INSERT INTO forward_status (
  server_id, forward_id, listening, error, updated_at,
  target_ok, target_fail_count, traffic_in, traffic_out
)
SELECT
  listening.server_id,
  CASE
    WHEN listening.member_count <= 1
      THEN 'chain-' || listening.chain_id || '-' || listening.seq
    ELSE 'chain-' || listening.chain_id || '-' || listening.seq
      || '-' || listening.server_id
  END,
  listening.up,
  '',
  CAST(strftime('%s','now') AS INTEGER) - 120,
  listening.up,
  0,
  CASE
    WHEN listening.up = 1 AND listening.chain_id IN (
      'c0ffee00-0006-4000-8000-000000000751',
      'c0ffee00-0006-4000-8000-000000000761',
      'c0ffee00-0006-4000-8000-000000000762',
      'c0ffee00-0006-4000-8000-000000000771'
    ) THEN 180000000 + listening.seq * 90000000
    ELSE 0
  END,
  CASE
    WHEN listening.up = 1 AND listening.chain_id IN (
      'c0ffee00-0006-4000-8000-000000000751',
      'c0ffee00-0006-4000-8000-000000000761',
      'c0ffee00-0006-4000-8000-000000000762',
      'c0ffee00-0006-4000-8000-000000000771'
    ) THEN 1200000000 + listening.seq * 450000000
    ELSE 0
  END
FROM listening;

-- ------------------------------------------------------------
-- 每跳时延样本：最近 24h，每 5 分钟一条（链路时延 / 模板洞察的边 p50）
-- ------------------------------------------------------------
-- 样本从**真实链拓扑**推导，保证每条链的每个 forward 都有数据：
--   * forward_id 与 DesiredForward 的规则一致：单成员组
--     `chain-<id>-<seq>`，多成员组 `chain-<id>-<seq>-<server_id>`；
--   * 相邻两组的成员对逐个写；最后一跳的 target_server_id 留空（目标是
--     chains.target_host，没有下一台服务器）；
--   * 离线 / 异常的服务器只写到「停止之前」（与东京-02 的做法一致）：
--     离线按 last_seen_at 换算成 5 分钟槽位，在线但 Xray 停止的异常成员
--     按 3 小时前停止；从未上报的探针机不写。指向已离线 / 异常下一跳的
--     样本同样截断，避免「目标已离线却仍有最新时延」。
--   * 时延基数由成员 id 推出来（香港 → 东京 ~20ms、东京 → 新加坡 ~22ms
--     这类量级），不追求真实测量值，只保证 p50 稳定可读。
-- 端口 / 样本都用固定公式，重复执行结果一致。
WITH RECURSIVE slots(n) AS (
  SELECT 0 UNION ALL SELECT n + 1 FROM slots WHERE n < 288
),
group_members AS (
  SELECT
    g.chain_id,
    g.seq,
    g.id AS group_id,
    m.server_id,
    (SELECT COUNT(*) FROM chain_group_members x WHERE x.group_id = g.id) AS member_count
  FROM chain_groups g
  JOIN chain_group_members m ON m.group_id = g.id
),
links AS (
  -- 相邻两组：源成员 × 下一组成员（多成员组因此有多条出边）。
  SELECT
    gm.chain_id, gm.seq, gm.server_id, gm.member_count,
    next_member.server_id AS to_id
  FROM group_members gm
  JOIN group_members next_member
    ON next_member.chain_id = gm.chain_id AND next_member.seq = gm.seq + 1
  UNION ALL
  -- 最后一组：每个成员 → 链目标（to_id 为空）。
  SELECT gm.chain_id, gm.seq, gm.server_id, gm.member_count, NULL
  FROM group_members gm
  WHERE gm.seq = (
    SELECT MAX(g2.seq) FROM chain_groups g2 WHERE g2.chain_id = gm.chain_id
  )
),
cutoff AS (
  SELECT
    id AS server_id,
    CASE
      WHEN status = 'online' AND COALESCE(xray_running, 1) <> 0 THEN 0
      -- Agent 在线、Xray 停止（异常成员）：当作 3 小时前停止上报。
      WHEN status = 'online' THEN 36
      -- 从未上报的探针机没有样本可写。
      WHEN last_seen_at IS NULL THEN 289
      -- 离线：保留 last_seen 之前的样本，槽位按 5 分钟对齐。
      ELSE MIN(
        289,
        -- 减 30s 再向上取整，避免 last_seen_secs 正好落在 300s 边界时，
        -- 两次执行的截止槽位相差 1（17 条既有链的样本数要可复现）。
        (CAST(strftime('%s','now') AS INTEGER) - last_seen_at - 30 + 299) / 300
      )
    END AS min_slot
  FROM servers
),
enriched AS (
  SELECT
    l.chain_id, l.seq, l.server_id, l.to_id,
    CASE
      WHEN l.member_count <= 1 THEN 'chain-' || l.chain_id || '-' || l.seq
      ELSE 'chain-' || l.chain_id || '-' || l.seq || '-' || l.server_id
    END AS forward_id,
    CAST(substr(l.server_id, -3) AS INTEGER) AS from_no,
    CAST(substr(COALESCE(l.to_id, ''), -3) AS INTEGER) AS to_no,
    f.min_slot AS from_min_slot,
    COALESCE(t.min_slot, 0) AS to_min_slot
  FROM links l
  JOIN cutoff f ON f.server_id = l.server_id
  LEFT JOIN cutoff t ON t.server_id = l.to_id
)
INSERT INTO forward_latency_samples (
  ts, server_id, forward_id, target_server_id, latency_ms
)
SELECT
  (CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s','now') AS INTEGER) % 300)
    - slots.n * 300,
  enriched.server_id,
  enriched.forward_id,
  COALESCE(enriched.to_id, ''),
  CASE
    WHEN enriched.to_id IS NULL THEN 6 + enriched.from_no % 5
    ELSE 10 + (enriched.from_no * 7 + enriched.to_no * 5) % 17
  END
  -- 706 活跃链的第 4 跳（新加坡-01 → 新加坡-03）刻意偏高：p50 约 160ms，
  -- 与其它跳的 20–30ms 拉开，详情里可以直接定位到这一段。
  + CASE
      WHEN enriched.chain_id = 'c0ffee00-0006-4000-8000-000000000751'
        AND enriched.seq = 3 THEN 140
      ELSE 0
    END
  + slots.n % 4
FROM enriched
CROSS JOIN slots
WHERE slots.n >= enriched.from_min_slot
  AND slots.n >= enriched.to_min_slot;

-- ------------------------------------------------------------
-- 每跳探测计数（丢包）：最近 24h、5 分钟一桶的增量
-- ------------------------------------------------------------
-- 与时延样本同一套 forward 映射；每个 forward 的探测就是该跳入口到下一跳。
-- 失败率基线约 0.2%（每两个桶 1 次失败 / 240 次探测），其余路径都在
-- 0.1–2% 内；`chain-...751-3`（新加坡-01 → 新加坡-03）24h 约 2.9%，
-- `chain-...721-1`（东京-01 → 新加坡-01）最近 2h 约 2.9%，用于验证
-- 「单段丢包 vs 整链连乘」与「某条深链某跳偏高」。
-- 离线 / 异常成员只写到停止之前：与时延样本相同的 cutoff（源或下一跳任一
-- 停止就停），避免「节点已离线、却仍有最新探测计数」。
WITH RECURSIVE slots(n) AS (
  SELECT 0 UNION ALL SELECT n + 1 FROM slots WHERE n < 288
),
group_members AS (
  SELECT
    g.chain_id,
    g.seq,
    g.id AS group_id,
    m.server_id,
    (SELECT COUNT(*) FROM chain_group_members x WHERE x.group_id = g.id) AS member_count
  FROM chain_groups g
  JOIN chain_group_members m ON m.group_id = g.id
),
cutoff AS (
  SELECT
    id AS server_id,
    CASE
      WHEN status = 'online' AND COALESCE(xray_running, 1) <> 0 THEN 0
      WHEN status = 'online' THEN 36
      WHEN last_seen_at IS NULL THEN 289
      ELSE MIN(
        289,
        -- 减 30s 再向上取整，避免 last_seen_secs 正好落在 300s 边界时，
        -- 两次执行的截止槽位相差 1（17 条既有链的样本数要可复现）。
        (CAST(strftime('%s','now') AS INTEGER) - last_seen_at - 30 + 299) / 300
      )
    END AS min_slot
  FROM servers
),
forward_cutoffs AS (
  SELECT
    gm.chain_id,
    gm.seq,
    gm.server_id,
    gm.member_count,
    MAX(src.min_slot) AS from_min_slot,
    COALESCE(MAX(tgt.min_slot), 0) AS to_min_slot
  FROM group_members gm
  JOIN cutoff src ON src.server_id = gm.server_id
  LEFT JOIN group_members next_member
    ON next_member.chain_id = gm.chain_id AND next_member.seq = gm.seq + 1
  LEFT JOIN cutoff tgt ON tgt.server_id = next_member.server_id
  GROUP BY gm.chain_id, gm.seq, gm.server_id, gm.member_count
)
INSERT INTO forward_probe_samples (ts, server_id, forward_id, attempts, failures)
SELECT
  (CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s','now') AS INTEGER) % 900)
    - slots.n * 300,
  forward_cutoffs.server_id,
  CASE
    WHEN forward_cutoffs.member_count <= 1
      THEN 'chain-' || forward_cutoffs.chain_id || '-' || forward_cutoffs.seq
    ELSE 'chain-' || forward_cutoffs.chain_id || '-' || forward_cutoffs.seq
      || '-' || forward_cutoffs.server_id
  END,
  240,
  CASE
    -- 751 的新加坡-01 → 新加坡-03（706 五跳活跃链第 4 跳）与上面同一段：
    -- 24h 每桶 7/240 ≈ 2.9%，用来演示「某条深链单跳丢包偏高」。
    WHEN forward_cutoffs.chain_id = 'c0ffee00-0006-4000-8000-000000000751'
      AND forward_cutoffs.seq = 3 THEN 7
    -- 721 的东京-01 → 新加坡-01 是「偏高」路径：最近 2h 每桶 7/240 ≈ 2.9%。
    WHEN forward_cutoffs.chain_id = 'c0ffee00-0006-4000-8000-000000000721'
      AND forward_cutoffs.seq = 1 AND slots.n < 25 THEN 7
    WHEN slots.n % 2 = 0 THEN 1
    ELSE 0
  END
FROM forward_cutoffs
CROSS JOIN slots
WHERE slots.n >= forward_cutoffs.from_min_slot
  AND slots.n >= forward_cutoffs.to_min_slot;
-- ------------------------------------------------------------
-- 7 天计费流量：14 台有数据的主机（无数据的探针不产生流量）。
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
  ('c0ffee00-0000-4000-8000-000000000009', 'nora@us-01-vless', 157286400, 838860800),
  -- 深链新增主机：11–13 在线（今天仍有流量），14 异常 / 15 离线（今天没有流量，
  -- 只保留停止之前的 6 天历史）。
  ('c0ffee00-0000-4000-8000-000000000011', 'kenji@jp-04-vless', 209715200, 1258291200),
  ('c0ffee00-0000-4000-8000-000000000012', 'mei@sg-03-vless', 314572800, 2097152000),
  ('c0ffee00-0000-4000-8000-000000000013', 'kenji@kr-01-reality', 104857600, 734003200),
  ('c0ffee00-0000-4000-8000-000000000014', 'kenji@th-01-vmess', 52428800, 209715200),
  ('c0ffee00-0000-4000-8000-000000000015', 'mei@my-01-vmess', 83886080, 419430400)
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
     'c0ffee00-0000-4000-8000-000000000006',
     'c0ffee00-0000-4000-8000-000000000007',
     'c0ffee00-0000-4000-8000-000000000011',
     'c0ffee00-0000-4000-8000-000000000012',
     'c0ffee00-0000-4000-8000-000000000013'
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
      'c0ffee00-0000-4000-8000-000000000006',
      'c0ffee00-0000-4000-8000-000000000007',
      'c0ffee00-0000-4000-8000-000000000011',
      'c0ffee00-0000-4000-8000-000000000012',
      'c0ffee00-0000-4000-8000-000000000013'
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
    WHEN servers.id = 'c0ffee00-0000-4000-8000-000000000005'
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
      WHEN servers.id = 'c0ffee00-0000-4000-8000-000000000005'
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
AFTER_CHAINS="$(count_of chains)"
AFTER_CHAIN_TEMPLATES="$(count_of chain_templates)"
AFTER_CHAIN_GROUPS="$(count_of chain_groups)"
AFTER_CHAIN_MEMBERS="$(count_of chain_group_members)"
AFTER_LATENCY="$(count_of forward_latency_samples)"
AFTER_SAMPLES="$(count_of server_samples)"
AFTER_PROBES="$(count_of forward_probe_samples)"
AFTER_TRAFFIC_DAILY="$(count_of traffic_daily)"
AFTER_TRAFFIC_NODE="$(count_of traffic_node_daily)"

USERS_INSERTED=$((AFTER_USERS - BEFORE_USERS))
PACKAGES_INSERTED=$((AFTER_PACKAGES - BEFORE_PACKAGES))
USER_PACKAGES_INSERTED=$((AFTER_USER_PACKAGES - BEFORE_USER_PACKAGES))
SUBSCRIPTIONS_INSERTED=$((AFTER_SUBSCRIPTIONS - BEFORE_SUBSCRIPTIONS))
CHAIN_TEMPLATES_INSERTED=$((AFTER_CHAIN_TEMPLATES - BEFORE_CHAIN_TEMPLATES))
CHAINS_INSERTED=$((AFTER_CHAINS - BEFORE_CHAINS))
CHAIN_GROUPS_INSERTED=$((AFTER_CHAIN_GROUPS - BEFORE_CHAIN_GROUPS))
CHAIN_MEMBERS_INSERTED=$((AFTER_CHAIN_MEMBERS - BEFORE_CHAIN_MEMBERS))
LATENCY_INSERTED=$((AFTER_LATENCY - BEFORE_LATENCY))
PROBES_INSERTED=$((AFTER_PROBES - BEFORE_PROBES))
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

echo "seed-preview: 已写入 ${AFTER_SERVERS} 台主机（在线 ${ONLINE} / 异常 ${ABNORMAL} / 离线 ${OFFLINE} / 无数据 ${NO_DATA}），${AFTER_NODES} 个节点，${AFTER_FORWARDS} 条转发。" >&2
echo "seed-preview: ${AFTER_CHAIN_TEMPLATES} 个链模板 / ${AFTER_CHAINS} 条链（${AFTER_CHAIN_GROUPS} 组 / ${AFTER_CHAIN_MEMBERS} 成员），${AFTER_LATENCY} 条时延样本 / ${AFTER_PROBES} 条每跳探测样本。" >&2
echo "seed-preview: 数据库 ${DB_REAL}（真实库 ${REAL_DB_REAL} 未被触碰）。" >&2

printf '{"database":"data/preview.db","deleted":{"servers":%d,"chains":%d,"chain_templates":%d},"inserted":{"servers":%d,"nodes":%d,"users":%d,"packages":%d,"user_packages":%d,"subscriptions":%d,"forwards":%d,"chain_templates":%d,"chains":%d,"chain_groups":%d,"chain_group_members":%d,"forward_latency_samples":%d,"forward_probe_samples":%d,"server_samples":%d,"traffic_daily":%d,"traffic_node_daily":%d},"skipped":{"users":%d,"packages":%d,"user_packages":%d,"subscriptions":%d},"totals":{"servers":%d,"nodes":%d,"users":%d,"packages":%d,"user_packages":%d,"subscriptions":%d,"forwards":%d,"chain_templates":%d,"chains":%d,"chain_groups":%d,"chain_group_members":%d,"forward_latency_samples":%d,"forward_probe_samples":%d,"server_samples":%d,"traffic_daily":%d,"traffic_node_daily":%d},"statuses":{"online":%d,"abnormal":%d,"offline":%d,"no_data":%d}}\n' \
  "$BEFORE_SERVERS" "$BEFORE_CHAINS" "$BEFORE_CHAIN_TEMPLATES" \
  "$AFTER_SERVERS" "$AFTER_NODES" "$USERS_INSERTED" "$PACKAGES_INSERTED" "$USER_PACKAGES_INSERTED" "$SUBSCRIPTIONS_INSERTED" "$AFTER_FORWARDS" "$CHAIN_TEMPLATES_INSERTED" "$CHAINS_INSERTED" "$CHAIN_GROUPS_INSERTED" "$CHAIN_MEMBERS_INSERTED" "$LATENCY_INSERTED" "$PROBES_INSERTED" "$AFTER_SAMPLES" "$AFTER_TRAFFIC_DAILY" "$AFTER_TRAFFIC_NODE" \
  "$USERS_SKIPPED" "$PACKAGES_SKIPPED" "$USER_PACKAGES_SKIPPED" "$SUBSCRIPTIONS_SKIPPED" \
  "$AFTER_SERVERS" "$AFTER_NODES" "$AFTER_USERS" "$AFTER_PACKAGES" "$AFTER_USER_PACKAGES" "$AFTER_SUBSCRIPTIONS" "$AFTER_FORWARDS" "$AFTER_CHAIN_TEMPLATES" "$AFTER_CHAINS" "$AFTER_CHAIN_GROUPS" "$AFTER_CHAIN_MEMBERS" "$AFTER_LATENCY" "$AFTER_PROBES" "$AFTER_SAMPLES" "$AFTER_TRAFFIC_DAILY" "$AFTER_TRAFFIC_NODE" \
  "$ONLINE" "$ABNORMAL" "$OFFLINE" "$NO_DATA"
