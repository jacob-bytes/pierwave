#!/usr/bin/env bash
# 公开状态页压测：造 1000 台服务器（每台 24 个 buckets_24h + 24 点 series_24h +
# 7 天桶），测量列表 / 详情接口在「无压缩 / gzip」下的响应体积与耗时。
#
# 用途：
#   * 改公开接口前后的体积对比（拆 `series_24h` 前后）；
#   * 验证 CompressionLayer 真的发 `Content-Encoding: gzip` 与 `Vary`；
#   * 记录 1000 台规模的基线，回归时不靠感觉。
#
# English: public-status payload benchmark. Seeds 1000 servers (24 hourly
# buckets, a 24-point per-server series and 7 daily buckets each), then measures
# list / detail response sizes and latency with and without gzip. Use it to
# compare before/after a payload change; unit-level cold-cache timings live in
# `crates/master/src/routes/public_status/payload.rs`.
#
# 用法 / Usage:
#   scripts/bench-public-status.sh                # 重建临时库 + 默认 20 轮
#   REPEAT=50 scripts/bench-public-status.sh      # 每接口 50 轮
#   KEEP=1 scripts/bench-public-status.sh         # 结束后保留 master 与数据
#   SKIP_BUILD=1 scripts/bench-public-status.sh   # 复用已构建的二进制
#
# 依赖 / Requires: cargo（仓库内 CARGO_HOME）、sqlite3、curl、python3。
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD

PORT=${PORT:-8895}
WORK=${WORK:-/tmp/pierwave-public-bench}
BASE="http://127.0.0.1:${PORT}"
REPEAT=${REPEAT:-20}
ADMIN_PASSWORD=${ADMIN_PASSWORD:-benchpass}
KEEP=${KEEP:-0}
SKIP_BUILD=${SKIP_BUILD:-0}
BIN=${BIN:-$ROOT/target/debug/pierwave-master}

log() { printf '%s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

command -v sqlite3 >/dev/null 2>&1 || fail "需要 sqlite3（造数）"
command -v python3 >/dev/null 2>&1 || fail "需要 python3（计算 p50/p95）"
command -v curl >/dev/null 2>&1 || fail "需要 curl"

if [ "$SKIP_BUILD" != "1" ]; then
  log "==> 构建 master"
  CARGO_HOME=$ROOT/.cargo-home cargo build -q -p pierwave-master
fi
[ -x "$BIN" ] || fail "找不到 master 可执行文件：$BIN"

DB="$WORK/bench.sqlite"
DB_URL="sqlite://${DB}?mode=rwc"
rm -rf "$WORK"; mkdir -p "$WORK"

MASTER_PID=""
cleanup() {
  if [ -n "$MASTER_PID" ] && kill -0 "$MASTER_PID" 2>/dev/null; then
    kill "$MASTER_PID" 2>/dev/null || true
    wait "$MASTER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

start_master() {
  # 端口被别人占用时，下面的健康检查会打到别人的进程上：必须显式拒绝，
  # 否则会误以为「启动成功」，然后对着旧进程测一组假数据。
  if curl -sf "${BASE}/api/v1/health" >/dev/null 2>&1; then
    fail "端口 ${PORT} 已有服务在监听，请换个 PORT 再跑（避免测到别人的进程）"
  fi
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

log "==> 启动一次以执行迁移"
start_master
stop_master

log "==> 造数：1000 台服务器 / 每台 24 个小桶 + 7 天桶"
# 造数 SQL 内嵌在这里，保证 scripts/ 下只新增一个文件；时间戳与
# `repo::server_samples::align_ts` 一样对齐到 5 分钟 / 整点。
sqlite3 "$DB" <<'SEED' || fail "造数失败"
BEGIN;

WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM seq WHERE i < 999)
INSERT INTO servers
   (id, name, address, token_hash, xray_mode, status, created_at,
    country_code, group_name, os_name, os_version, virt, arch,
    load1, mem_used, mem_total, disk_used, disk_total, uptime_secs,
    last_seen_at, latency_ms, net_rx_bytes, net_tx_bytes,
    net_rx_bps, net_tx_bps, paid_until, price_cents, currency, billing_cycle)
SELECT printf('%08x-0000-4000-8000-%012x',
              (i * 2654435761) % 4294967296, i * 7919 + 17),
       printf('香港-节点-%04d', i),
       printf('10.%d.%d.1', i / 250, i % 250),
       printf('hash-%04d', i),
       'external',
       CASE WHEN i % 10 = 0 THEN 'offline' ELSE 'online' END,
       CAST(strftime('%s','now') AS INTEGER) - i * 86400,
       CASE i % 3 WHEN 0 THEN 'HK' WHEN 1 THEN 'JP' ELSE NULL END,
       CASE i % 4 WHEN 0 THEN 'premium' WHEN 1 THEN 'standard' ELSE NULL END,
       'Debian GNU/Linux', '12', 'kvm', 'x86_64',
       0.42, 1073741824, 4294967296, 10737418240, 107374182400,
       1234567, CAST(strftime('%s','now') AS INTEGER) - 30, 28,
       123456789012, 98765432109, 1048576.5, 262144.25,
       '2026-12-31', 4999, 'CNY', 'monthly'
FROM seq;

-- 每小时两条采样（整点 + 半点）：online_ratio 出现 0 / 0.5 / 1 三种值。
WITH RECURSIVE hours(h) AS (SELECT 0 UNION ALL SELECT h+1 FROM hours WHERE h < 23)
INSERT INTO server_samples
   (server_id, ts, online, load1, mem_used, mem_total, disk_used, disk_total,
    latency_ms, rx_bps, tx_bps)
SELECT s.id,
       CAST(strftime('%s','now') AS INTEGER) / 3600 * 3600 - h * 3600 + off,
       CASE WHEN (s.rowid + h + off / 1800) % 13 = 0 THEN 0 ELSE 1 END,
       0.42, 1073741824, 4294967296, 10737418240, 107374182400,
       20 + (h % 7) + (s.rowid % 11),
       1048576.5 + h * 1234.25 + (s.rowid % 97) * 7919.125,
       262144.25 + h * 456.5 + (s.rowid % 89) * 3571.75
FROM servers s CROSS JOIN hours
CROSS JOIN (SELECT 0 AS off UNION ALL SELECT 1800);

-- 更早的 5 个自然日各一条采样：buckets_7d 的 7 个桶全部有数据。
WITH RECURSIVE days(d) AS (SELECT 2 UNION ALL SELECT d+1 FROM days WHERE d < 6)
INSERT INTO server_samples
   (server_id, ts, online, load1, mem_used, mem_total, disk_used, disk_total,
    latency_ms, rx_bps, tx_bps)
SELECT s.id, CAST(strftime('%s','now') AS INTEGER) / 3600 * 3600 - d * 86400, 1,
       0.42, 1073741824, 4294967296, 10737418240, 107374182400,
       20 + d + (s.rowid % 11),
       1048576.5 + d * 1234.25 + (s.rowid % 97) * 7919.125,
       262144.25 + d * 456.5 + (s.rowid % 89) * 3571.75
FROM servers s CROSS JOIN days;

COMMIT;
SEED

SERVERS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM servers;")
SAMPLES=$(sqlite3 "$DB" "SELECT COUNT(*) FROM server_samples;")
log "    服务器 ${SERVERS} 台 / 采样 ${SAMPLES} 行"

log "==> 启动 master 并测量"
start_master

# $1 = path, $2 = output file, $3 = encoding (identity|gzip)
# 用 curl 自己的 `time_total` 计时，避免 python 启动开销混进冷缓存耗时。
fetch() {
  if [ "$3" = "gzip" ]; then
    curl -sf -H 'Accept-Encoding: gzip' -D "$2.headers" -o "$2" \
      -w '%{time_total}' "${BASE}$1"
  else
    curl -sf -H 'Accept-Encoding: identity' -D "$2.headers" -o "$2" \
      -w '%{time_total}' "${BASE}$1"
  fi
}

# 冷缓存：此时进程刚启动，第一次请求要走完整聚合。
COLD_LIST=$(fetch "/api/v1/public/status" "$WORK/list-identity.json" identity)

SERVER_ID=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["servers"][0]["id"])' "$WORK/list-identity.json")
COLD_DETAIL=$(fetch "/api/v1/public/status/${SERVER_ID}" "$WORK/detail-identity.json" identity)
fetch "/api/v1/public/status/${SERVER_ID}" "$WORK/detail-gzip.json" gzip >/dev/null
fetch "/api/v1/public/status" "$WORK/list-gzip.json" gzip >/dev/null

# 同一个 (server_id) 的详情会命中 30 秒缓存；列表也一样。p50/p95 反映的是
# 「缓存命中 + gzip」的真实线上热路径。
timing() { # $1 = path, $2 = encoding, $3 = output prefix
  : > "$WORK/$3.times"
  for _ in $(seq 1 "$REPEAT"); do
    if [ "$2" = "gzip" ]; then
      curl -sf -H 'Accept-Encoding: gzip' -o "$WORK/$3.body" \
        -w '%{time_total}\n' "${BASE}$1" >> "$WORK/$3.times"
    else
      curl -sf -H 'Accept-Encoding: identity' -o "$WORK/$3.body" \
        -w '%{time_total}\n' "${BASE}$1" >> "$WORK/$3.times"
    fi
  done
}

timing "/api/v1/public/status" identity list-identity-timing
timing "/api/v1/public/status" gzip list-gzip-timing
timing "/api/v1/public/status/${SERVER_ID}" identity detail-identity-timing
timing "/api/v1/public/status/${SERVER_ID}" gzip detail-gzip-timing

bytes() { wc -c < "$1" | tr -d ' '; }

log ""
log "==> 结果（${REPEAT} 轮热缓存；冷缓存 = 进程启动后第一次请求）"
python3 - "$WORK" "$REPEAT" "$COLD_LIST" "$COLD_DETAIL" "$SERVERS" <<'PY'
import json, os, sys

work, repeat = sys.argv[1], int(sys.argv[2])
cold_list = float(sys.argv[3]) * 1000
cold_detail = float(sys.argv[4]) * 1000
servers = int(sys.argv[5])

def size(name):
    return os.path.getsize(os.path.join(work, name))

def stats(name):
    values = []
    with open(os.path.join(work, name)) as fh:
        for line in fh:
            line = line.strip()
            if line:
                values.append(float(line) * 1000)
    values.sort()
    if not values:
        return (0.0, 0.0)
    def pct(p):
        index = min(len(values) - 1, int(round((len(values) - 1) * p)))
        return values[index]
    return (pct(0.5), pct(0.95))

def headers(name):
    encoding = vary = "-"
    with open(os.path.join(work, name)) as fh:
        for line in fh:
            lower = line.lower()
            if lower.startswith("content-encoding:"):
                encoding = line.split(":", 1)[1].strip()
            elif lower.startswith("vary:"):
                vary = line.split(":", 1)[1].strip()
    return encoding, vary

rows = [
    ("list", "identity", "list-identity.json", "list-identity-timing.times"),
    ("list", "gzip", "list-gzip.json", "list-gzip-timing.times"),
    ("detail", "identity", "detail-identity.json", "detail-identity-timing.times"),
    ("detail", "gzip", "detail-gzip.json", "detail-gzip-timing.times"),
]
print(f"{'endpoint':8} {'encoding':9} {'bytes':>10} {'B/server':>9} {'p50 ms':>8} {'p95 ms':>8}"
      f" {'Content-Encoding':>17} {'Vary':>16}")
for endpoint, encoding, body, times in rows:
    payload = size(body)
    per_server = payload / servers if endpoint == "list" else payload
    p50, p95 = stats(times)
    enc, vary = headers(body + ".headers")
    print(f"{endpoint:8} {encoding:9} {payload:10d} {per_server:9.0f} {p50:8.1f} {p95:8.1f}"
          f" {enc:>17} {vary:>16}")

list_raw = size("list-identity.json")
list_gzip = size("list-gzip.json")
print()
print(f"list cold (cache miss): {cold_list:.1f} ms; detail cold: {cold_detail:.1f} ms")
print(f"list gzip ratio: {list_gzip * 100 / list_raw:.1f}%"
      f" (saved {list_raw - list_gzip} bytes)")
print(f"detail gzip ratio: {size('detail-gzip.json') * 100 / size('detail-identity.json'):.1f}%")

# 校验 gzip 确实是 gzip（magic 1f 8b），避免只看 header 自欺。
with open(os.path.join(work, "list-gzip.json"), "rb") as fh:
    magic = fh.read(2)
if magic != b"\x1f\x8b":
    print("FAIL: list-gzip.json 不是 gzip 数据")
    sys.exit(1)

# 列表里不能有 series_24h；详情必须有。
with open(os.path.join(work, "list-identity.json")) as fh:
    listing = json.load(fh)
if any("series_24h" in row for row in listing["servers"]):
    print("FAIL: 列表仍然包含 series_24h")
    sys.exit(1)
with open(os.path.join(work, "detail-identity.json")) as fh:
    detail = json.load(fh)
if "series_24h" not in detail or len(detail["series_24h"]["t"]) != 24:
    print("FAIL: 详情缺少 24 点 series_24h")
    sys.exit(1)
print("ok: 列表无 series_24h，详情含 24 点 series_24h，gzip 生效")
PY

if [ "$KEEP" = "1" ]; then
  log ""
  log "已保留：${WORK}（master PID 已停止；可手动用 BIN + PIERWAVE_DB=${DB_URL} 复跑）"
fi
