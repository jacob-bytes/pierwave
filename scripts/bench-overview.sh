#!/usr/bin/env bash
# 概览接口专用基准：造 1 万用户 / 1000 节点 / 30 天流量，测量
# `GET /api/v1/overview` 的冷查询与稳定态 p50 / p95，并给出查询计划。
#
# English: overview-only benchmark. Seeds 10k users, 1000 nodes and 30 days of
# traffic, then measures the first (cold) request plus steady-state p50 / p95
# of GET /api/v1/overview and prints the query plans. Set WRITE_EVERY_MS=200 to
# add a background traffic writer; INTERVAL_MS spaces requests apart (use 250
# with REPEAT=50 to cross the 12 s cache TTL).
#
# 用法 / Usage:
#   scripts/bench-overview.sh                 # 缓存开启（默认 TTL 12s），跑 20 轮
#   REPEAT=50 scripts/bench-overview.sh       # 每轮重复次数
#   CACHE=0 scripts/bench-overview.sh         # 关闭缓存，测「只读日汇总」的冷成本
#   NO_SEED=1 scripts/bench-overview.sh       # 复用已有数据库
#   PLAN=1 scripts/bench-overview.sh          # 额外打印 EXPLAIN QUERY PLAN
#   WRITE_EVERY_MS=200 scripts/bench-overview.sh
#                                             # 后台每 200ms 写一次流量（模拟 Agent 上报）
#   INTERVAL_MS=250 REPEAT=50 WRITE_EVERY_MS=200 scripts/bench-overview.sh
#                                             # 每 250ms 请求一次，跨过 12s TTL 看真实命中
#   KEEP=1 scripts/bench-overview.sh          # 结束后保留 master 与数据
#
# 依赖 / Requires: cargo（仓库内 CARGO_HOME）、sqlite3、curl、python3。
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD

PORT=${PORT:-8794}
WORK=${WORK:-/tmp/pierwave-bench-overview}
BASE="http://127.0.0.1:${PORT}"
REPEAT=${REPEAT:-20}
WARMUP=${WARMUP:-3}
CACHE=${CACHE:-1}
PLAN=${PLAN:-0}
WRITE_EVERY_MS=${WRITE_EVERY_MS:-0}
INTERVAL_MS=${INTERVAL_MS:-0}
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
WRITER_PID=""
cleanup() {
  stop_writer
  if [ -n "$MASTER_PID" ] && kill -0 "$MASTER_PID" 2>/dev/null; then
    kill "$MASTER_PID" 2>/dev/null || true
    wait "$MASTER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# 后台写入：模拟生产里 Agent 持续上报。直接写 traffic_daily / traffic_node_daily，
# 触发器会同步维护日汇总；每写成功一次就更新计数文件。
start_writer() {
  [ "$WRITE_EVERY_MS" -gt 0 ] || return 0
  rm -f "$WORK/stop-writer" "$WORK/writer.count"
  local interval_s
  interval_s=$(awk "BEGIN { printf \"%.3f\", $WRITE_EVERY_MS / 1000 }")
  (
    count=0
    while [ ! -f "$WORK/stop-writer" ]; do
      if sqlite3 -cmd '.timeout 5000' "$DB" <<'SQL' >/dev/null 2>&1
INSERT INTO traffic_daily (day, server_id, subject, uplink, downlink, weighted)
VALUES (date('now','+8 hours'), 's-000', 'bench-writer', 1, 1, 2)
ON CONFLICT(day, server_id, subject) DO UPDATE SET
  uplink = traffic_daily.uplink + excluded.uplink,
  downlink = traffic_daily.downlink + excluded.downlink,
  weighted = traffic_daily.weighted + excluded.weighted;
INSERT INTO traffic_node_daily (day, server_id, node_tag, user_id, uplink, downlink, weighted)
VALUES (date('now','+8 hours'), 's-000', 'node0000', 'bench-writer', 1, 1, 2)
ON CONFLICT(day, server_id, node_tag, user_id) DO UPDATE SET
  uplink = traffic_node_daily.uplink + excluded.uplink,
  downlink = traffic_node_daily.downlink + excluded.downlink,
  weighted = traffic_node_daily.weighted + excluded.weighted;
SQL
      then
        count=$((count + 1))
        printf '%s\n' "$count" > "$WORK/writer.count"
      fi
      sleep "$interval_s"
    done
  ) &
  WRITER_PID=$!
}

stop_writer() {
  if [ -n "$WRITER_PID" ]; then
    touch "$WORK/stop-writer"
    wait "$WRITER_PID" 2>/dev/null || true
    WRITER_PID=""
  fi
}

start_master() {
  # CACHE=0 时显式把概览缓存 TTL 设为 0：只测日汇总本身的冷查询成本。
  PIERWAVE_ADDR="127.0.0.1:${PORT}" \
  PIERWAVE_DB="$DB_URL" \
  PIERWAVE_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  PIERWAVE_OVERVIEW_CACHE_SECS="$([ "$CACHE" = "1" ] && echo 12 || echo 0)" \
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
  # 只造概览用得到的表：服务器、节点、用户、套餐实例、两张日账本、采样。
  # 日期用 UTC+8 业务日，与 repo::time::business_date 同口径。
  # traffic_daily / traffic_node_daily 的触发器会同步维护日汇总表，因此这里
  # 用普通 INSERT 即可，顺便验证写路径。
  sqlite3 "$DB" <<'SEED' || fail "造数失败"
PRAGMA foreign_keys=ON;
BEGIN;

WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM seq WHERE i<9)
INSERT INTO servers (id,name,address,token_hash,xray_mode,status,created_at)
SELECT printf('s-%03d',i), printf('server-%03d',i), printf('10.0.%d.1',i),
       printf('hash-s-%03d',i), 'external',
       CASE WHEN i<8 THEN 'online' ELSE 'offline' END, 1700000000+i
FROM seq;

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

WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM seq WHERE i<9999)
INSERT INTO users (id,username,password_hash,role,status,short_code,quota_bytes,used_bytes,created_at,updated_at)
SELECT printf('u-%05d',i), printf('user%05d',i), 'x', 'user',
       CASE WHEN i%50=0 THEN 'disabled' ELSE 'active' END,
       printf('sc%06d',i), 107374182400, (i*1000)%1000000,
       1700000000+i*10, 1700000000+i*10
FROM seq;

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

-- 30 天 × 10000 用户 = 30 万行用户日账本（触发器同步写汇总）
WITH RECURSIVE d(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM d WHERE n<29),
u AS (SELECT id, rowid AS rid FROM users)
INSERT INTO traffic_daily (day, server_id, subject, uplink, downlink, weighted)
SELECT date('now','+8 hours', printf('-%d days', n)), printf('s-%03d',(rid-1)%10), id,
       1000+n, 2000+n, 3000+2*n
FROM d CROSS JOIN u;

-- 30 天 × 1000 节点 = 3 万行节点切片
WITH RECURSIVE d(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM d WHERE n<29)
INSERT INTO traffic_node_daily (day, server_id, node_tag, user_id, uplink, downlink, weighted)
SELECT date('now','+8 hours', printf('-%d days', n)), server_id, tag,
       printf('u-%05d',(rowid-1)%10000), 500+n, 800+n, 1300+2*n
FROM d CROSS JOIN nodes;

-- 10 台服务器 × 288 个采样点（最近 24 小时，5 分钟一个点）
WITH RECURSIVE s(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM s WHERE i<9),
k(j) AS (SELECT 0 UNION ALL SELECT j+1 FROM k WHERE j<287)
INSERT INTO server_samples (server_id, ts, online, load1, mem_used, mem_total, disk_used, disk_total)
SELECT printf('s-%03d',i), strftime('%s','now') - j*300, 1, 0.5, 1000, 2000, 3000, 4000
FROM s CROSS JOIN k;

COMMIT;
SEED

  # 让查询计划与线上（有统计信息）一致。
  sqlite3 "$DB" "ANALYZE;" >/dev/null
fi

[ -f "$DB" ] || fail "数据库不存在：$DB（去掉 NO_SEED=1 可重建）"

log "==> 启动 master（CACHE=${CACHE}，0=关闭概览缓存；WRITE_EVERY_MS=${WRITE_EVERY_MS}；INTERVAL_MS=${INTERVAL_MS}）"
start_master
login
start_writer

counts=$(sqlite3 "$DB" "SELECT (SELECT COUNT(*) FROM users)||' users, '||(SELECT COUNT(*) FROM nodes)||' nodes, '||(SELECT COUNT(*) FROM traffic_daily)||' traffic_daily, '||(SELECT COUNT(*) FROM traffic_node_daily)||' traffic_node_daily, '||(SELECT COUNT(*) FROM traffic_daily_rollup)||' rollup rows';")
rollup_ok=$(sqlite3 "$DB" "SELECT CASE WHEN
  (SELECT COALESCE(SUM(weighted),0) FROM traffic_daily)
    = (SELECT COALESCE(SUM(weighted),0) FROM traffic_daily_rollup WHERE scope='server')
  AND (SELECT COALESCE(SUM(weighted),0) FROM traffic_node_daily)
    = (SELECT COALESCE(SUM(weighted),0) FROM traffic_daily_rollup WHERE scope='node')
  THEN 'ok' ELSE 'MISMATCH' END;")
log "==> 数据量：${counts}（rollup 校验：${rollup_ok}）"
log "==> overview 预热 ${WARMUP} 次，重复 ${REPEAT} 次"

export BENCH_BASE="$BASE"
export BENCH_COOKIE="$WORK/cookie"
export BENCH_WORK="$WORK"
export BENCH_REPEAT="$REPEAT"
export BENCH_WARMUP="$WARMUP"
export BENCH_CACHE="$CACHE"
export BENCH_WRITE_EVERY_MS="$WRITE_EVERY_MS"
export BENCH_INTERVAL_MS="$INTERVAL_MS"
export BENCH_COUNTS="$counts"

python3 - "$WORK/raw-overview.json" <<'PY'
import json, os, statistics, subprocess, sys, time

base = os.environ["BENCH_BASE"]
cookie = os.environ["BENCH_COOKIE"]
work = os.environ["BENCH_WORK"]
repeat = int(os.environ["BENCH_REPEAT"])
warmup = int(os.environ["BENCH_WARMUP"])
cache = os.environ["BENCH_CACHE"]
write_every_ms = int(os.environ["BENCH_WRITE_EVERY_MS"])
interval_ms = int(os.environ["BENCH_INTERVAL_MS"])
counts = os.environ["BENCH_COUNTS"]
raw_path = sys.argv[1]
path = "/api/v1/overview?days=7"

def one():
    """返回 (http_code, ms, cache_header)。"""
    header_path = os.path.join(work, "last-header.txt")
    out = subprocess.run(
        [
            "curl", "-s", "-o", "/dev/null", "-D", header_path,
            "-b", cookie, "-w", "%{http_code} %{time_total}", base + path,
        ],
        capture_output=True, text=True,
    )
    code, seconds = out.stdout.strip().split()
    marker = "?"
    try:
        with open(header_path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if line.lower().startswith("x-overview-cache:"):
                    marker = line.split(":", 1)[1].strip()
    except OSError:
        pass
    return int(code), float(seconds) * 1000.0, marker

# 第一次请求：缓存开启时是 miss + 冷查询；CACHE=0 时同样是一次完整冷查询。
code, cold_ms, cold_marker = one()
if code != 200:
    raise SystemExit(f"overview 返回 HTTP {code}（检查登录/迁移）")

for _ in range(warmup):
    code, _, _ = one()
    if code != 200:
        raise SystemExit(f"预热返回 HTTP {code}")

samples = []
markers = {"hit": 0, "miss": 0, "?": 0}
codes = set()
for _ in range(repeat):
    code, ms, marker = one()
    codes.add(code)
    markers[marker if marker in markers else "?"] += 1
    samples.append(ms)
    if interval_ms > 0:
        # 跨过 TTL 观察正常过期，而不是只测一段“永远命中”的窗口。
        time.sleep(interval_ms / 1000.0)
samples.sort()

def pct(p):
    # nearest-rank，n>=1
    index = max(0, min(len(samples) - 1, int(-(-p * len(samples) // 100)) - 1))
    return samples[index]

result = {
    "counts": counts,
    "cache_enabled": cache == "1",
    "write_every_ms": write_every_ms,
    "interval_ms": interval_ms,
    "repeat": repeat,
    "cold_ms": round(cold_ms, 2),
    "cold_marker": cold_marker,
    "http": sorted(codes),
    "p50_ms": round(pct(50), 2),
    "p95_ms": round(pct(95), 2),
    "mean_ms": round(statistics.fmean(samples), 2),
    "min_ms": round(samples[0], 2),
    "max_ms": round(samples[-1], 2),
    "cache_headers": markers,
}
with open(raw_path, "w") as fh:
    json.dump(result, fh, indent=2)

print()
print(f"数据集：{counts}")
print(f"概览缓存：{'开启（12s TTL）' if cache == '1' else '关闭'}")
if write_every_ms > 0:
    print(f"后台写入：每 {write_every_ms}ms 一次；请求间隔：{interval_ms}ms")
else:
    print("后台写入：关闭")
print()
print("| 请求 | HTTP | 耗时 ms | 缓存头 |")
print("|---|---:|---:|---|")
print(f"| 首次（冷） | {code} | {result['cold_ms']} | {cold_marker} |")
print(f"| 稳定态 p50 | {','.join(map(str, result['http']))} | {result['p50_ms']} | "
      f"hit={markers['hit']} miss={markers['miss']} |")
print(f"| 稳定态 p95 | — | {result['p95_ms']} | — |")
print(f"| 稳定态 mean / min / max | — | {result['mean_ms']} / "
      f"{result['min_ms']} / {result['max_ms']} | — |")
print()
print(f"原始数据：{raw_path}")
PY

if [ "$WRITE_EVERY_MS" -gt 0 ]; then
  stop_writer
  writes=$(cat "$WORK/writer.count" 2>/dev/null || echo 0)
  log "==> 测量期间后台写入：${writes} 次（每 ${WRITE_EVERY_MS}ms 一次）"
fi

if [ "$PLAN" = "1" ]; then
  log ""
  log "==> EXPLAIN QUERY PLAN（关键查询，日期用占位符）"
  sqlite3 "$DB" <<'PLAN'
.headers on
.mode list
SELECT '-- KPI 今日/本月（server scope）';
EXPLAIN QUERY PLAN
SELECT COALESCE(SUM(weighted),0) FROM traffic_daily_rollup
WHERE scope = 'server' AND day >= '2026-11-01' AND day <= '2026-11-30';
SELECT '-- 日趋势（server scope）';
EXPLAIN QUERY PLAN
SELECT day, SUM(uplink), SUM(downlink) FROM traffic_daily_rollup
WHERE scope = 'server' AND day >= '2026-11-01' AND day <= '2026-11-30'
GROUP BY day;
SELECT '-- 协议归属（node + legacy scope）';
EXPLAIN QUERY PLAN
SELECT r.day, COALESCE(n.protocol,'unknown'), SUM(r.uplink)
FROM traffic_daily_rollup r
LEFT JOIN nodes n
  ON n.server_id = substr(r.key, 1, instr(r.key, char(31)) - 1)
 AND n.tag = substr(r.key, instr(r.key, char(31)) + 1)
WHERE r.scope = 'node' AND r.day >= '2026-11-01' AND r.day <= '2026-11-30'
GROUP BY r.day, 2;
SELECT '-- Top 用户（subject scope）';
EXPLAIN QUERY PLAN
SELECT key, SUM(uplink + downlink) FROM traffic_daily_rollup
WHERE scope = 'subject' AND day >= '2026-11-01' AND day <= '2026-11-30'
GROUP BY key HAVING SUM(uplink + downlink) > 0;
SELECT '-- Top 服务器（server scope + key 索引）';
EXPLAIN QUERY PLAN
SELECT s.id, COALESCE(SUM(t.uplink + t.downlink), 0)
FROM servers s
LEFT JOIN traffic_daily_rollup t
  ON t.scope = 'server' AND t.key = s.id
 AND t.day >= '2026-11-01' AND t.day <= '2026-11-30'
GROUP BY s.id ORDER BY 2 DESC LIMIT 5;
PLAN
fi

if [ "$KEEP" != "1" ]; then
  stop_master
else
  log "==> KEEP=1：master 仍在运行（pid ${MASTER_PID}），数据库 ${DB}"
  MASTER_PID=""
fi
