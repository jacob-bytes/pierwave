#!/usr/bin/env bash
# API 基准：造 1 万用户 / 1000 节点 / 30 天流量，然后 curl 反复打主要接口，
# 输出每个接口的 p50 / p95。优化前后各跑一次即可对比。
#
# English: API benchmark. Seeds 10k users, 1000 nodes and 30 days of traffic,
# then repeatedly curls the main admin endpoints and prints p50 / p95 per
# endpoint. Run it before and after an optimization to compare.
#
# 用法 / Usage:
#   scripts/bench-api.sh                 # 重建数据库、跑默认 30 轮
#   REPEAT=50 scripts/bench-api.sh       # 每接口 50 轮
#   NO_SEED=1 scripts/bench-api.sh       # 复用已有数据库（快速复跑）
#   KEEP=1 scripts/bench-api.sh          # 结束后保留 master 与数据（排障）
#
# 依赖 / Requires: cargo（仓库内 CARGO_HOME）、sqlite3、curl、python3。
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD

PORT=${PORT:-8793}
WORK=${WORK:-/tmp/pierwave-bench}
BASE="http://127.0.0.1:${PORT}"
REPEAT=${REPEAT:-30}
WARMUP=${WARMUP:-3}
ADMIN_PASSWORD=${ADMIN_PASSWORD:-benchpass}
NO_SEED=${NO_SEED:-0}
KEEP=${KEEP:-0}
SKIP_BUILD=${SKIP_BUILD:-0}
BIN=${BIN:-$ROOT/target/debug/pierwave-master}

log() { printf '%s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

command -v sqlite3 >/dev/null 2>&1 || fail "需要 sqlite3（造数 / 查询计划都靠它）"
command -v python3 >/dev/null 2>&1 || fail "需要 python3（计算 p50/p95）"
command -v curl >/dev/null 2>&1 || fail "需要 curl"

if [ "$SKIP_BUILD" != "1" ]; then
  log "==> 构建 master"
  CARGO_HOME=$ROOT/.cargo-home cargo build -q -p pierwave-master
fi
[ -x "$BIN" ] || fail "找不到 master 可执行文件：$BIN"

DB="$WORK/bench.sqlite"
DB_URL="sqlite://${DB}?mode=rwc"
mkdir -p "$WORK"

MASTER_PID=""
cleanup() {
  if [ -n "$MASTER_PID" ] && kill -0 "$MASTER_PID" 2>/dev/null; then
    kill "$MASTER_PID" 2>/dev/null || true
    wait "$MASTER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

start_master() {
  PIERWAVE_ADDR="127.0.0.1:${PORT}" \
  PIERWAVE_DB="$DB_URL" \
  PIERWAVE_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  RUST_LOG="${RUST_LOG:-warn}" \
  "$BIN" > "$WORK/master.log" 2>&1 &
  MASTER_PID=$!
  for _ in $(seq 1 200); do
    if curl -sf "${BASE}/api/v1/health" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$MASTER_PID" 2>/dev/null; then
      tail -30 "$WORK/master.log" >&2
      fail "master 启动失败"
    fi
    sleep 0.2
  done
  tail -30 "$WORK/master.log" >&2
  fail "master 健康检查超时"
}

stop_master() {
  if [ -n "$MASTER_PID" ] && kill -0 "$MASTER_PID" 2>/dev/null; then
    kill "$MASTER_PID" 2>/dev/null || true
    wait "$MASTER_PID" 2>/dev/null || true
  fi
  MASTER_PID=""
}

login() {
  curl -sf -c "$WORK/cookie" -X POST "${BASE}/api/v1/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"${ADMIN_PASSWORD}\"}" >/dev/null
}

if [ "$NO_SEED" != "1" ]; then
  log "==> 重建数据库并启动一次以执行迁移"
  rm -rf "$WORK"
  mkdir -p "$WORK"
  start_master
  login
  stop_master

  log "==> 造数：1 万用户 / 1000 节点 / 30 天流量"
  # 造数 SQL 内嵌在本脚本里，保证 scripts/ 下只新增这一个文件。
  # 日期用 UTC+8 的业务日（与 repo::time::business_date 同口径）。
  sqlite3 "$DB" <<'SEED' || fail "造数失败"
PRAGMA foreign_keys=ON;
BEGIN;

-- 10 台服务器（8 在线 / 2 离线）
WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM seq WHERE i<9)
INSERT INTO servers (id,name,address,token_hash,xray_mode,status,created_at)
SELECT printf('s-%03d',i), printf('server-%03d',i), printf('10.0.%d.1',i),
       printf('hash-s-%03d',i), 'external',
       CASE WHEN i<8 THEN 'online' ELSE 'offline' END, 1700000000+i
FROM seq;

-- 1000 个节点，协议 / 标签 / 地区循环分布
WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM seq WHERE i<999)
INSERT INTO nodes (id,server_id,tag,name,protocol,transport,security,port,config_json,enabled,created_at,tags,region)
SELECT printf('n-%04d',i), printf('s-%03d', i%10), printf('node%04d',i), printf('节点-%04d',i),
       CASE i%4 WHEN 0 THEN 'vless' WHEN 1 THEN 'trojan' WHEN 2 THEN 'vmess' ELSE 'hysteria2' END,
       'tcp','none', 10000+i,
       '{"settings":{"clients":[]},"streamSettings":{"network":"tcp","security":"none"}}',
       CASE WHEN i%17=0 THEN 0 ELSE 1 END, 1700001000+i,
       CASE i%3 WHEN 0 THEN '["hk","edge"]' WHEN 1 THEN '["jp"]' ELSE '[]' END,
       CASE i%3 WHEN 0 THEN 'HK' WHEN 1 THEN 'JP' ELSE NULL END
FROM seq;

-- 10000 个用户（每 50 个有 1 个停用）
WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM seq WHERE i<9999)
INSERT INTO users (id,username,password_hash,role,status,short_code,quota_bytes,used_bytes,created_at,updated_at)
SELECT printf('u-%05d',i), printf('user%05d',i), 'x', 'user',
       CASE WHEN i%50=0 THEN 'disabled' ELSE 'active' END,
       printf('sc%06d',i), 107374182400, (i*1000)%1000000,
       1700000000+i*10, 1700000000+i*10
FROM seq;

-- 20 个套餐模板 + 每个用户一张实例
WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM seq WHERE i<19)
INSERT INTO packages (id,name,quota_bytes,period_days,direction,node_ratio,created_at)
SELECT printf('p-%03d',i), printf('套餐-%02d',i), 107374182400, 30, 'both',
       1.0+(i%3)*0.5, 1700000000+i
FROM seq;

WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM seq WHERE i<9999)
INSERT INTO user_packages (id,user_id,package_id,quota_override,used_bytes,direction,node_ratio,expires_at,reset_day,status,created_at)
SELECT printf('up-%05d',i), printf('u-%05d',i), printf('p-%03d',i%20), NULL,
       (i*777)%1000000, 'both', 1.0, NULL, NULL,
       CASE WHEN i%50=0 THEN 'disabled' ELSE 'active' END, 1700000000+i*10
FROM seq;

-- 30 天 x 10000 用户 = 30 万行用户日账本
WITH RECURSIVE d(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM d WHERE n<29),
u AS (SELECT id, rowid AS rid FROM users)
INSERT INTO traffic_daily (day, server_id, subject, uplink, downlink, weighted)
SELECT date('now','+8 hours', printf('-%d days', n)), printf('s-%03d',(rid-1)%10), id,
       1000+n, 2000+n, 3000+2*n
FROM d CROSS JOIN u;

-- 30 天 x 1000 节点 = 3 万行节点切片
WITH RECURSIVE d(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM d WHERE n<29)
INSERT INTO traffic_node_daily (day, server_id, node_tag, user_id, uplink, downlink, weighted)
SELECT date('now','+8 hours', printf('-%d days', n)), server_id, tag,
       printf('u-%05d',(rowid-1)%10000), 500+n, 800+n, 1300+2*n
FROM d CROSS JOIN nodes;

-- 1000 条转发规则 + 30 天 x 1000 条 = 3 万行转发明细
WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM seq WHERE i<999)
INSERT INTO forwards (id,server_id,name,listen_port,target_host,target_port,enabled,created_at,updated_at,engine,udp,protocol,owner_user_id,count_traffic,proxy_protocol)
SELECT printf('f-%04d',i), printf('s-%03d', i%10), printf('forward-%04d',i), 20000+i,
       '1.1.1.1', 443, 1, 1700005000+i, 1700005000+i, 'native', 0, 'tcp',
       printf('u-%05d', i%10000), 1, 0
FROM seq;

WITH RECURSIVE d(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM d WHERE n<29)
INSERT INTO forward_traffic_daily (day, forward_id, user_id, bytes, weighted)
SELECT date('now','+8 hours', printf('-%d days', n)), id,
       printf('u-%05d',(rowid-1)%10000), 400+n, 600+2*n
FROM d CROSS JOIN forwards;

-- 10 台服务器 x 30 天 x 288 个采样点（5 分钟粒度）
WITH RECURSIVE d(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM d WHERE n<29),
m(k) AS (SELECT 0 UNION ALL SELECT k+1 FROM m WHERE k<287)
INSERT INTO server_samples (server_id, ts, online, load1, mem_used, mem_total, disk_used, disk_total)
SELECT printf('s-%03d',(n*7+k)%10),
       strftime('%s','now') - n*86400 - k*300,
       CASE WHEN (n+k)%97=0 THEN 0 ELSE 1 END,
       0.5, 1000, 2000, 3000, 4000
FROM d CROSS JOIN m;

-- 5 万行审计日志（登录 / 用户变更 / 下发）
WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM seq WHERE i<49999)
INSERT INTO audit_log (id, actor_id, action, target, detail, created_at)
SELECT printf('a-%06d',i), printf('u-%05d',i%10000),
       CASE i%3 WHEN 0 THEN 'auth.login' WHEN 1 THEN 'user.update' ELSE 'config.apply' END,
       printf('t-%06d',i), '{"ip":"10.0.0.1","user_agent":"bench"}',
       1700000000+i
FROM seq;

-- 1 万条会话（每用户一条）
WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM seq WHERE i<9999)
INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, user_agent, ip, last_seen_at)
SELECT printf('sess-%05d',i), printf('u-%05d',i), printf('th-%06d',i),
       1800000000, 1700000000+i, 'bench-agent', '10.0.0.1', 1700000000+i
FROM seq;

COMMIT;
SEED

  # 大表 ANALYZE：让 SQLite 的查询计划与线上（有统计信息）一致。
  sqlite3 "$DB" "ANALYZE;" >/dev/null
fi

[ -f "$DB" ] || fail "数据库不存在：$DB（去掉 NO_SEED=1 可重建）"

log "==> 启动 master"
start_master
login

SERVER_ID=$(curl -sf -b "$WORK/cookie" "${BASE}/api/v1/servers" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["items"][0]["id"])')
[ -n "$SERVER_ID" ] || fail "没有服务器可测"

counts=$(sqlite3 "$DB" "SELECT (SELECT COUNT(*) FROM users)||' users, '||(SELECT COUNT(*) FROM nodes)||' nodes, '||(SELECT COUNT(*) FROM traffic_daily)||' traffic_daily, '||(SELECT COUNT(*) FROM traffic_node_daily)||' traffic_node_daily, '||(SELECT COUNT(*) FROM forward_traffic_daily)||' forward_traffic_daily, '||(SELECT COUNT(*) FROM server_samples)||' server_samples';")
log "==> 数据量：${counts}"
log "==> 每接口 ${REPEAT} 轮（预热 ${WARMUP} 轮）"

export BENCH_BASE="$BASE"
export BENCH_COOKIE="$WORK/cookie"
export BENCH_WORK="$WORK"
export BENCH_REPEAT="$REPEAT"
export BENCH_WARMUP="$WARMUP"
export BENCH_SERVER_ID="$SERVER_ID"
export BENCH_COUNTS="$counts"

python3 - "$WORK/raw.json" <<'PY'
import json, os, statistics, subprocess, sys, time

base = os.environ["BENCH_BASE"]
cookie = os.environ["BENCH_COOKIE"]
repeat = int(os.environ["BENCH_REPEAT"])
warmup = int(os.environ["BENCH_WARMUP"])
server_id = os.environ["BENCH_SERVER_ID"]
counts = os.environ["BENCH_COUNTS"]
raw_path = sys.argv[1]

endpoints = [
    ("overview", "/api/v1/overview?days=7"),
    ("stats/overview", "/api/v1/stats/overview"),
    ("stats/traffic", "/api/v1/stats/traffic?days=30"),
    ("stats/nodes", "/api/v1/stats/nodes?days=30"),
    ("nodes (global)", "/api/v1/nodes?page=1&per_page=50"),
    ("nodes (global deep)", "/api/v1/nodes?page=20&per_page=50"),
    ("nodes (server)", f"/api/v1/servers/{server_id}/nodes?page=1&per_page=50"),
    ("users", "/api/v1/users?limit=200"),
    ("forward-traffic", "/api/v1/forward-traffic?days=30"),
    ("audit (page 1)", "/api/v1/audit?limit=50"),
]

def one(path):
    fmt = "%{http_code} %{time_total}"
    out = subprocess.run(
        ["curl", "-s", "-o", "/dev/null", "-b", cookie, "-w", fmt, base + path],
        capture_output=True, text=True,
    )
    code, seconds = out.stdout.strip().split()
    return int(code), float(seconds)

results = {}
for name, path in endpoints:
    for _ in range(warmup):
        code, _ = one(path)
        if code != 200:
            raise SystemExit(f"{name}: 预热返回 HTTP {code}（可能是鉴权/参数问题）")
    samples = []
    codes = set()
    for _ in range(repeat):
        code, seconds = one(path)
        codes.add(code)
        samples.append(seconds * 1000.0)
    samples.sort()
    def pct(p):
        # nearest-rank，n>=1
        index = max(0, min(len(samples) - 1, int(-(-p * len(samples) // 100)) - 1))
        return samples[index]
    results[name] = {
        "path": path,
        "n": len(samples),
        "http": sorted(codes),
        "p50_ms": round(pct(50), 2),
        "p95_ms": round(pct(95), 2),
        "min_ms": round(samples[0], 2),
        "max_ms": round(samples[-1], 2),
        "mean_ms": round(statistics.fmean(samples), 2),
    }

with open(raw_path, "w") as fh:
    json.dump({"counts": counts, "repeat": repeat, "results": results}, fh, indent=2)

print()
print(f"数据集：{counts}")
print(f"每接口重复 {repeat} 次（另预热 {warmup} 次），单位 ms")
print()
print("| 接口 | HTTP | p50 | p95 | mean | min | max |")
print("|---|---:|---:|---:|---:|---:|---:|")
for name, row in results.items():
    print(f"| {name} | {','.join(map(str, row['http']))} | {row['p50_ms']} | "
          f"{row['p95_ms']} | {row['mean_ms']} | {row['min_ms']} | {row['max_ms']} |")
print()
print(f"原始数据：{raw_path}")
PY

if [ "$KEEP" != "1" ]; then
  stop_master
else
  log "==> KEEP=1：master 仍在运行（pid ${MASTER_PID}），数据库 ${DB}"
  MASTER_PID=""
fi
