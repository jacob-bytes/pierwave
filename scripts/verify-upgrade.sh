#!/usr/bin/env bash
# 升级路径实测：用当前 HEAD 的前一个 release（默认 v0.15.0）的 master 建库写数据，
# 再用当前 HEAD 的 master 打开同一个库，断言「迁移成功、关键数据还在、
# 旧的明文备份仍能在新版本恢复」，并报告跨了多少个迁移、耗时多少。
#
# 为什么要用两份源码而不是同一个二进制：升级问题几乎都出在
# 「旧库结构 + 新二进制」这个组合上（新增 NOT NULL 列、索引重名、数据回填失败）。
# 用 `git archive` 各导出一份，能保证跑的就是发布出去的那份源码。
#
# 为什么默认起点是 v0.15.0：它是加密备份（PWSB）落地前最后一个 release。
# 这样升级路径自然覆盖两条兼容性：旧库升到新库、旧明文 `.db.gz` 备份在新版本恢复。
#
# 用法：
#   ./scripts/verify-upgrade.sh
#   FROM_TAG=v0.9.0 ./scripts/verify-upgrade.sh      # 换起点版本（跨度更大、更慢）
#   FROM_TAG=v0.14.0 TO_REV=v0.15.0 ./scripts/verify-upgrade.sh   # 只验证已发布版本之间
#   KEEP=1 ./scripts/verify-upgrade.sh               # 保留临时目录（两份源码 + 库 + 日志）
#   VERIFY_UPGRADE_TARGET_DIR=/path ./scripts/verify-upgrade.sh   # 复用编译缓存
#
# 依赖：git、cargo、curl、python3（仓库脚本本来就依赖 python3）。
# 退出码：0 = 升级成功且数据一致；1 = 有失败（会打印 master 日志尾部与可读原因）。
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$PWD

if [ -z "${CARGO_HOME:-}" ] && [ -d "$ROOT/.cargo-home" ]; then
  export CARGO_HOME="$ROOT/.cargo-home"
fi

WORK="${UPGRADE_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/pierwave-upgrade.XXXXXX")}"
mkdir -p "$WORK"
KEEP="${KEEP:-0}"
# 当前 HEAD 的前一个 release：新格式（PWSB）在它之后才落地。
FROM_TAG="${FROM_TAG:-v0.15.0}"
TO_REV="${TO_REV:-HEAD}"
ADMIN_PASSWORD="devpass"
CURL_TIMEOUT="${CURL_TIMEOUT:-120}"

# 新旧主控共用同一把测试主密钥：加密备份/设置跨实例可解。
if [ -z "${PIERWAVE_SECRET_KEY:-}" ]; then
  PIERWAVE_SECRET_KEY=$(python3 -c 'import base64,os;print(base64.b64encode(os.urandom(32)).decode())')
  export PIERWAVE_SECRET_KEY
fi
# 两份源码共用一个 target 目录：依赖只编译一遍，脚本才不会跑成「编译测试」。
TARGET="${VERIFY_UPGRADE_TARGET_DIR:-$WORK/target}"

OLD_SRC="$WORK/src-old"
NEW_SRC="$WORK/src-new"
DB_DIR="$WORK/data"
DB="$DB_DIR/pierwave.db"

MASTER_PID=""
PHASE="初始化"
MASTER_LOG=""
SCRIPT_START=$(python3 -c 'import time; print(f"{time.time():.3f}")')

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m %s\n' "$*"; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$*"; }
die() {
  printf '  \033[31mFAIL\033[0m %s\n' "$*" >&2
  if [ -n "$MASTER_LOG" ] && [ -f "$MASTER_LOG" ]; then
    printf '  --- master 日志尾部（%s）---\n' "$MASTER_LOG" >&2
    tail -30 "$MASTER_LOG" >&2 || true
  fi
  printf '  （阶段：%s；临时目录：%s，KEEP=1 可保留现场）\n' "$PHASE" "$WORK" >&2
  exit 1
}

cleanup() {
  local code=$?
  if [ -n "$MASTER_PID" ]; then
    kill "$MASTER_PID" 2>/dev/null || true
    wait "$MASTER_PID" 2>/dev/null || true
  fi
  if [ "$KEEP" = "1" ]; then
    printf '临时目录已保留：%s\n' "$WORK"
  else
    rm -rf "$WORK"
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ------------------------------------------------------------------ 工具函数
# macOS 没有 `timeout` 时的兜底（同 verify-backup.sh）；这里的用法是防 HTTP 卡死。
if command -v timeout >/dev/null 2>&1; then
  run_timeout() { local secs=$1; shift; timeout "$secs" "$@"; }
elif command -v gtimeout >/dev/null 2>&1; then
  run_timeout() { local secs=$1; shift; gtimeout "$secs" "$@"; }
else
  run_timeout() {
    local secs=$1; shift
    local flag pid watchdog rc
    flag=$(mktemp "${TMPDIR:-/tmp}/pierwave-timeout.XXXXXX")
    "$@" &
    pid=$!
    (
      local ticks=0
      while [ "$ticks" -lt $((secs * 5)) ]; do
        [ -e "$flag" ] && exit 0
        sleep 0.2
        ticks=$((ticks + 1))
      done
      kill -TERM "$pid" 2>/dev/null || true
      sleep 1
      kill -KILL "$pid" 2>/dev/null || true
    ) &
    watchdog=$!
    rc=0
    wait "$pid" || rc=$?
    : >"$flag"
    wait "$watchdog" 2>/dev/null || true
    rm -f "$flag"
    return "$rc"
  }
fi

now_ms() { python3 -c 'import time; print(f"{time.monotonic():.3f}")'; }

pick_port() {
  python3 - "$1" <<'PY'
import socket, sys
start = int(sys.argv[1])
for port in range(start, start + 500):
    sock = socket.socket()
    try:
        sock.bind(("127.0.0.1", port))
    except OSError:
        continue
    finally:
        sock.close()
    print(port)
    break
else:
    sys.exit("找不到空闲端口")
PY
}

wait_health() {
  local base=$1 timeout=${2:-60}
  local start end
  start=$(now_ms)
  for _ in $(seq 1 $((timeout * 5))); do
    if curl -sf --max-time 2 "$base/api/v1/health" >/dev/null 2>&1; then
      end=$(now_ms)
      awk -v a="$start" -v b="$end" 'BEGIN { printf "%.1f", b - a }'
      return 0
    fi
    sleep 0.2
  done
  return 1
}

start_master() {
  # start_master <二进制> <端口> <日志文件> <超时秒>
  local bin=$1 port=$2 log_file=$3 timeout=${4:-60}
  PHASE="启动主控（${bin}）"
  mkdir -p "$DB_DIR"
  PIERWAVE_ADDR="127.0.0.1:${port}" \
  PIERWAVE_DB="sqlite://${DB}?mode=rwc" \
  PIERWAVE_WEB_DIR="$ROOT/web/dist" \
  PIERWAVE_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  PIERWAVE_SECRET_KEY="$PIERWAVE_SECRET_KEY" \
    "$bin" >"$log_file" 2>&1 &
  MASTER_PID=$!
  MASTER_LOG=$log_file
  local elapsed
  if ! elapsed=$(wait_health "http://127.0.0.1:${port}" "$timeout"); then
    die "主控在 ${timeout}s 内没有就绪（端口 ${port}）"
  fi
  LAST_STARTUP_SECS=$elapsed
}

stop_master() {
  PHASE="停止主控"
  if [ -n "$MASTER_PID" ]; then
    kill "$MASTER_PID" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 "$MASTER_PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -9 "$MASTER_PID" 2>/dev/null || true
    wait "$MASTER_PID" 2>/dev/null || true
    MASTER_PID=""
  fi
}

request() {
  # request <base> <method> <path> [请求体文件]
  local base=$1 method=$2 path=$3 body=${4:-}
  local code
  if [ -n "$body" ]; then
    code=$(run_timeout $((CURL_TIMEOUT + 5)) \
      curl -sS --max-time "$CURL_TIMEOUT" -b "$WORK/cookie.txt" -X "$method" "$base$path" \
        -H 'Content-Type: application/json' --data-binary @"$body" \
        -o "$WORK/resp.json" -w '%{http_code}') || code=000
  else
    code=$(run_timeout $((CURL_TIMEOUT + 5)) \
      curl -sS --max-time "$CURL_TIMEOUT" -b "$WORK/cookie.txt" -X "$method" "$base$path" \
        -o "$WORK/resp.json" -w '%{http_code}') || code=000
  fi
  printf '%s' "$code"
}

expect_json() {
  local code=$1 want=$2 what=$3
  if [ "$code" != "$want" ]; then
    die "${what}：期望 HTTP ${want}，实际 ${code}；响应：$(head -c 600 "$WORK/resp.json" 2>/dev/null || true)"
  fi
}

jget() {
  python3 -c 'import sys,json;print(json.load(open(sys.argv[1]))'"$1"')' "$WORK/resp.json"
}


login() {
  local base=$1
  PHASE="登录（${base}）"
  printf '{"username":"admin","password":"%s"}' "$ADMIN_PASSWORD" >"$WORK/login.json"
  local code
  code=$(curl -sS --max-time "$CURL_TIMEOUT" -c "$WORK/cookie.txt" -X POST \
    -H 'Content-Type: application/json' --data-binary @"$WORK/login.json" \
    -o "$WORK/resp.json" -w '%{http_code}' "$base/api/v1/auth/login") || code=000
  expect_json "$code" 200 "登录失败"
}

# 下载备份（GET），保留响应头供格式断言。
download_backup() {
  # download_backup <base> <输出文件> <响应头文件> <说明>
  local base=$1 out=$2 headers=$3 what=$4 code
  PHASE="导出备份（${what}）"
  log "调用 GET ${base}/api/v1/backup（${what}）"
  code=$(run_timeout $((CURL_TIMEOUT + 5)) \
    curl -sS --max-time "$CURL_TIMEOUT" -b "$WORK/cookie.txt" \
      -D "$headers" -o "$out" -w '%{http_code}' "$base/api/v1/backup") || code=000
  [ "$code" = "200" ] || die "${what}：导出失败 HTTP ${code}"
  [ -s "$out" ] || die "${what}：导出文件是空的"
}

# 上传备份（POST /backup/restore），状态码写入 resp.json。
upload_restore() {
  # upload_restore <base> <备份文件> <说明>
  local base=$1 file=$2 what=$3 code
  PHASE="上传备份（${what}）"
  # 函数返回值就是 HTTP 状态码，进度日志必须走 stderr，不能混进 stdout。
  log "调用 POST ${base}/api/v1/backup/restore（${what}，$(wc -c <"$file" | tr -d ' ') B）" >&2
  code=$(run_timeout $((CURL_TIMEOUT + 5)) \
    curl -sS --max-time "$CURL_TIMEOUT" -b "$WORK/cookie.txt" \
      -X POST -H 'Content-Type: application/octet-stream' \
      --data-binary @"$file" -o "$WORK/resp.json" -w '%{http_code}' \
      "$base/api/v1/backup/restore") || code=000
  printf '%s' "$code"
}

# 旧格式（升级前）导出：必须是 gzip → 解压后 SQLite。打印解压后字节数。
assert_legacy_gzip_backup() {
  # assert_legacy_gzip_backup <gz 文件> <解压输出文件> <说明>
  local gz=$1 raw=$2 what=$3 bytes
  bytes=$(python3 - "$gz" "$raw" <<'PY'
import gzip, sys
data = open(sys.argv[1], "rb").read()
if not data.startswith(b"\x1f\x8b"):
    raise SystemExit(f"不是 gzip：{data[:8]!r}")
if data.startswith(b"PWSB"):
    raise SystemExit("旧版本导出却是 PWSB 加密信封")
raw = gzip.decompress(data)
open(sys.argv[2], "wb").write(raw)
if not raw.startswith(b"SQLite format 3\x00"):
    raise SystemExit(f"解压后不是 SQLite：{raw[:16]!r}")
print(len(raw))
PY
  ) || die "${what}：不是可解压的明文 gzip 备份"
  printf '%s' "$bytes"
}

# 新格式（升级后）导出：PWSB 信封，且不是 gzip / 明文 SQLite。
assert_pwsb_backup() {
  local file=$1 what=$2
  python3 - "$file" <<'PY' || die "${what}：新版本导出不是 PWSB 加密信封"
import sys
head = open(sys.argv[1], "rb").read(64)
if len(head) < 5:
    raise SystemExit(f"文件太短：{head!r}")
if head[:2] == b"\x1f\x8b":
    raise SystemExit("新版本导出仍是 gzip 明文")
if head[:16] == b"SQLite format 3\x00":
    raise SystemExit("新版本导出仍是明文 SQLite")
if not head.startswith(b"PWSB"):
    raise SystemExit(f"文件头不是 PWSB：{head[:8]!r}")
if head[4] != 1:
    raise SystemExit(f"信封版本不是 1：{head[4]}")
PY
  ok "${what}：PWSB 加密信封（非 gzip、非明文 SQLite）"
}

# 比对「升级前」与「当前快照」的 7 类关键数据和订阅凭据。
compare_facts() {
  # compare_facts <before.json> <after.json> <creds-before.json> <creds-after.json> <标签>
  local before=$1 after=$2 cred_before=$3 cred_after=$4 label=$5
  PHASE="比对数据（${label}）"
  log "比对升级前 / ${label}的关键数据"
  python3 - "$before" "$after" "$cred_before" "$cred_after" <<'PY'
import json
import sys

before_path, after_path, cred_before_path, cred_after_path = sys.argv[1:5]
before = json.load(open(before_path, encoding="utf-8"))
after = json.load(open(after_path, encoding="utf-8"))
cred_before = json.load(open(cred_before_path, encoding="utf-8"))
cred_after = json.load(open(cred_after_path, encoding="utf-8"))

LABELS = {
    "users": "用户",
    "servers": "服务器",
    "nodes": "节点",
    "packages": "套餐",
    "chains": "转发链",
    "forwards": "转发规则",
    "rule_templates": "规则模板",
}
problems = []
print(f"{'关键数据':<14}{'升级前':>8}{'升级后':>8}  结果")
print("-" * 48)
for key, label in LABELS.items():
    left, right = before.get(key), after.get(key)
    same = left == right
    print(f"{label:<14}{len(left):>8}{len(right):>8}  {'OK' if same else 'DIFF'}")
    if not same:
        problems.append((label, left, right))

print(f"\n订阅节点凭据（name → uuid/password）："
      f"{'OK' if cred_before == cred_after else 'DIFF'}")
if cred_before != cred_after:
    print(f"  升级前：{json.dumps(cred_before, ensure_ascii=False)}", file=sys.stderr)
    print(f"  升级后：{json.dumps(cred_after, ensure_ascii=False)}", file=sys.stderr)
    problems.append(("订阅节点凭据", cred_before, cred_after))

if problems:
    print(f"\nFAIL: {len(problems)} 类数据不一致：", file=sys.stderr)
    for label, left, right in problems:
        print(f"  - {label}: 前={json.dumps(left, ensure_ascii=False)[:400]}", file=sys.stderr)
        print(f"            后={json.dumps(right, ensure_ascii=False)[:400]}", file=sys.stderr)
    raise SystemExit(1)
PY
  ok "${label}：关键数据完全一致（用户 / 服务器 / 节点 / 套餐 / 转发链 / 转发规则 / 规则模板 / 订阅凭据）"
}

# 行数下限：防止「两边都是空」的假绿。
assert_row_counts() {
  # assert_row_counts <facts.json> <标签>
  local facts=$1 label=$2
  python3 - "$facts" <<'PY' || die "${label}：关键表行数与造数不符（见上一行实际/期望）"
import json, sys
facts = json.load(open(sys.argv[1], encoding="utf-8"))
# 迁移 0010 会插入一条默认规则模板，所以 1 条自建模板 + 1 条默认 = 2。
expect = {"users": 3, "servers": 2, "nodes": 3, "packages": 1, "chains": 1,
          "forwards": 1, "rule_templates": 2}
wrong = {key: (len(facts[key]), want) for key, want in expect.items() if len(facts[key]) != want}
if wrong:
    raise SystemExit(f"关键表行数与造数不符（实际, 期望）：{wrong}")
PY
}

# 升级前后共用的快照：只取两个版本都有的字段，避免「新版本多出来的字段」造成假差异。
# 用 python 直接访问 HTTP，字段缺失会明确报出来，而不是静默变成 None。
snapshot() {
  # snapshot <base> <输出文件> <订阅凭据输出文件> <登录 cookie>
  local base=$1 out=$2 cred_out=$3 session=$4
  PHASE="抓取升级前/后数据快照"
  python3 - "$base" "$session" "$out" "$cred_out" <<'PY'
import json
import re
import sys
import urllib.error
import urllib.request

base, session, out_path, cred_path = sys.argv[1:5]
cookie = f"pierwave_session={session}"


def get_bytes(path, with_cookie=True):
    headers = {"Cookie": cookie} if with_cookie else {}
    req = urllib.request.Request(base + path, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read()
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", "replace")[:400]
        raise SystemExit(f"GET {path} 失败：HTTP {error.code} {body}")
    except urllib.error.URLError as error:
        raise SystemExit(f"GET {path} 失败：{error.reason}")


def get_json(path):
    return json.loads(get_bytes(path))


def need(mapping, key, where):
    # 关键字段缺失说明版本 API 与预期不符：直接报出来，别让 None 混进比较结果。
    if key not in mapping:
        raise SystemExit(f"{where} 缺少字段 {key}：{list(mapping)[:20]}")
    return mapping[key]


servers = get_json("/api/v1/servers")["items"]
users = get_json("/api/v1/users")["items"]
packages = get_json("/api/v1/packages")["items"]
chains = get_json("/api/v1/chains")["items"]
templates = get_json("/api/v1/rule-templates")["items"]


def user_facts(user):
    bound = get_json(f"/api/v1/users/{user['id']}/packages")["items"]
    return {
        "username": need(user, "username", "user"),
        "role": need(user, "role", "user"),
        "short_code": need(user, "short_code", "user"),
        "status": need(user, "status", "user"),
        "used_bytes": need(user, "used_bytes", "user"),
        "quota_bytes": need(user, "quota_bytes", "user"),
        "packages": sorted(
            (
                {
                    "package_name": need(item, "package_name", "user package"),
                    "quota_bytes": need(item, "quota_bytes", "user package"),
                    "used_bytes": need(item, "used_bytes", "user package"),
                    "status": need(item, "status", "user package"),
                    "expires_at": need(item, "expires_at", "user package"),
                    "direction": need(item, "direction", "user package"),
                    "node_ratio": need(item, "node_ratio", "user package"),
                }
                for item in bound
            ),
            key=lambda item: item["package_name"],
        ),
    }


nodes = []
forwards = []
for server in servers:
    for node in get_json(f"/api/v1/servers/{server['id']}/nodes")["items"]:
        nodes.append({
            "server": server["name"],
            "tag": need(node, "tag", "node"),
            "name": need(node, "name", "node"),
            "protocol": need(node, "protocol", "node"),
            "transport": need(node, "transport", "node"),
            "security": need(node, "security", "node"),
            "port": need(node, "port", "node"),
            "config": need(node, "config", "node"),
        })
    for fwd in get_json(f"/api/v1/servers/{server['id']}/forwards")["items"]:
        forwards.append({
            "server": server["name"],
            "name": need(fwd, "name", "forward"),
            "listen_port": need(fwd, "listen_port", "forward"),
            "target_host": need(fwd, "target_host", "forward"),
            "target_port": need(fwd, "target_port", "forward"),
            "engine": need(fwd, "engine", "forward"),
            "protocol": need(fwd, "protocol", "forward"),
        })


def chain_facts(chain):
    groups = []
    for group in need(chain, "groups", "chain"):
        groups.append({
            "seq": need(group, "seq", "chain group"),
            "strategy": need(group, "strategy", "chain group"),
            "listen_port": need(group, "listen_port", "chain group"),
            "members": sorted(
                (
                    {
                        "server": need(member, "server_name", "chain member"),
                        "listen_port": need(member, "listen_port", "chain member"),
                        "priority": need(member, "priority", "chain member"),
                        "weight": need(member, "weight", "chain member"),
                    }
                    for member in need(group, "members", "chain group")
                ),
                key=lambda item: (item["server"], item["listen_port"]),
            ),
        })
    return {
        "name": need(chain, "name", "chain"),
        "target_host": need(chain, "target_host", "chain"),
        "target_port": need(chain, "target_port", "chain"),
        "engine": need(chain, "engine", "chain"),
        "protocol": need(chain, "protocol", "chain"),
        "enabled": need(chain, "enabled", "chain"),
        "groups": groups,
    }


facts = {
    "users": sorted((user_facts(user) for user in users), key=lambda item: item["username"]),
    "servers": sorted(
        (
            {
                "name": need(server, "name", "server"),
                "address": need(server, "address", "server"),
                "xray_mode": need(server, "xray_mode", "server"),
            }
            for server in servers
        ),
        key=lambda item: item["name"],
    ),
    "nodes": sorted(nodes, key=lambda item: (item["server"], item["tag"])),
    "packages": sorted(
        (
            {
                "name": need(package, "name", "package"),
                "quota_bytes": need(package, "quota_bytes", "package"),
                "period_days": need(package, "period_days", "package"),
                "direction": need(package, "direction", "package"),
                "node_ratio": need(package, "node_ratio", "package"),
            }
            for package in packages
        ),
        key=lambda item: item["name"],
    ),
    "chains": sorted((chain_facts(chain) for chain in chains), key=lambda item: item["name"]),
    "forwards": sorted(forwards, key=lambda item: (item["server"], item["name"])),
    "rule_templates": sorted(
        (
            {
                "name": need(template, "name", "rule template"),
                "rules": need(template, "rules", "rule template"),
            }
            for template in templates
        ),
        key=lambda item: item["name"],
    ),
}

# 订阅里的节点凭据是用户客户端真正在用的东西：升级不能把它们换掉。
# 只比较 name → uuid/password，不比较整个 YAML（新版本可能新增渲染字段）。
sub_code = next(user["short_code"] for user in users if user["username"] == "alice")
yaml_text = get_bytes(f"/api/v1/sub/{sub_code}", with_cookie=False).decode("utf-8", "replace")
credentials = {}
current = None
for line in yaml_text.splitlines():
    stripped = line.strip()
    match = re.match(r'^- name:\s*"?(.*?)"?\s*$', stripped)
    if match:
        current = match.group(1)
        continue
    match = re.match(r"^(uuid|password):\s*\"?(.*?)\"?\s*$", stripped)
    if match and current:
        credentials[current] = match.group(2)

with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(facts, handle, indent=2, sort_keys=True, ensure_ascii=False)
with open(cred_path, "w", encoding="utf-8") as handle:
    json.dump(credentials, handle, indent=2, sort_keys=True, ensure_ascii=False)

summary = {key: len(value) for key, value in facts.items()}
summary["subscription_credentials"] = len(credentials)
print(json.dumps(summary, ensure_ascii=False))
PY
}

# 读库里的迁移记录（升级脚本可以直读库；备份脚本才需要严格走 HTTP）。
db_migrations() {
  python3 - "$DB" <<'PY'
import sqlite3
import sys

conn = sqlite3.connect(sys.argv[1])
try:
    rows = conn.execute(
        "SELECT version FROM _sqlx_migrations WHERE success = 1 ORDER BY version"
    ).fetchall()
finally:
    conn.close()
versions = [row[0] for row in rows]
print(len(versions))
print(max(versions) if versions else 0)
PY
}

# ------------------------------------------------------------------ 0. 准备两份源码
log "临时目录：$WORK"
git -C "$ROOT" rev-parse --verify "${FROM_TAG}^{commit}" >/dev/null 2>&1 \
  || die "找不到起点版本 ${FROM_TAG}（tag 是否被删了？可用 FROM_TAG=... 指定）"
git -C "$ROOT" rev-parse --verify "${TO_REV}^{commit}" >/dev/null 2>&1 \
  || die "找不到终点版本 ${TO_REV}"

OLD_COMMIT=$(git -C "$ROOT" rev-parse --short "${FROM_TAG}^{commit}")
NEW_COMMIT=$(git -C "$ROOT" rev-parse --short "${TO_REV}^{commit}")
NEW_VERSION=$(git -C "$ROOT" show "${TO_REV}:Cargo.toml" | awk -F'"' '/^version = /{print $2; exit}')
OLD_VERSION=$(git -C "$ROOT" show "${FROM_TAG}:Cargo.toml" | awk -F'"' '/^version = /{print $2; exit}')

PHASE="导出源码"
log "导出源码：${FROM_TAG}（${OLD_COMMIT}）与 ${TO_REV}（${NEW_COMMIT}）"
mkdir -p "$OLD_SRC" "$NEW_SRC"
git -C "$ROOT" archive "$FROM_TAG" | tar -x -C "$OLD_SRC" || die "git archive ${FROM_TAG} 失败"
git -C "$ROOT" archive "$TO_REV" | tar -x -C "$NEW_SRC" || die "git archive ${TO_REV} 失败"
[ -f "$OLD_SRC/Cargo.toml" ] || die "导出的旧源码里没有 Cargo.toml"
[ -f "$NEW_SRC/Cargo.toml" ] || die "导出的新源码里没有 Cargo.toml"

OLD_MIGRATIONS=$(ls "$OLD_SRC/crates/domain/migrations"/*.sql 2>/dev/null | wc -l | tr -d ' ')
NEW_MIGRATIONS=$(ls "$NEW_SRC/crates/domain/migrations"/*.sql 2>/dev/null | wc -l | tr -d ' ')
# 终点是否已经支持备份加密（PWSB）：支持才断言新格式，否则按旧明文格式断言。
NEW_HAS_ENCRYPTION=0
if grep -rq 'backup_encrypt' "$NEW_SRC/crates/master/src/routes" 2>/dev/null; then
  NEW_HAS_ENCRYPTION=1
fi
NEW_ONLY=$(comm -13 \
  <(ls "$OLD_SRC/crates/domain/migrations" | sort) \
  <(ls "$NEW_SRC/crates/domain/migrations" | sort))
SPAN=$(printf '%s\n' "$NEW_ONLY" | grep -c . || true)
[ "$SPAN" -gt 0 ] || die "两个版本之间没有新增迁移，这个验证没有意义"

ok "旧版 ${FROM_TAG}（${OLD_COMMIT}，v${OLD_VERSION}）：${OLD_MIGRATIONS} 个迁移"
ok "新版 ${TO_REV}（${NEW_COMMIT}，v${NEW_VERSION}）：${NEW_MIGRATIONS} 个迁移"
ok "需要跨越 ${SPAN} 个迁移：$(printf '%s' "$NEW_ONLY" | paste -sd ' ' -)"

# ------------------------------------------------------------------ 1. 编译两份
build_master() {
  local dir=$1 label=$2 log_file=$3
  PHASE="编译 ${label}"
  log "编译 ${label}（target=${TARGET}）"
  if ! ( cd "$dir" && CARGO_HOME="${CARGO_HOME:-$ROOT/.cargo-home}" CARGO_TARGET_DIR="$TARGET" \
           cargo build -q -p pierwave-master ) >"$log_file" 2>&1; then
    tail -30 "$log_file" >&2 || true
    die "${label} 编译失败（完整日志：${log_file}）"
  fi
  [ -x "$TARGET/debug/pierwave-master" ] || die "${label} 编译后找不到二进制"
  ok "${label} 编译完成"
}

build_master "$OLD_SRC" "${FROM_TAG} 的 master" "$WORK/build-old.log"
OLD_BIN="$TARGET/debug/pierwave-master"
cp "$OLD_BIN" "$WORK/pierwave-master-old"

build_master "$NEW_SRC" "${TO_REV} 的 master" "$WORK/build-new.log"
NEW_BIN="$TARGET/debug/pierwave-master"
cp "$NEW_BIN" "$WORK/pierwave-master-new"

# ------------------------------------------------------------------ 2. 旧版建库写数据
PORT_OLD=$(pick_port 8871)
BASE_OLD="http://127.0.0.1:${PORT_OLD}"
log "阶段 1/3：用 ${FROM_TAG} 建库并写入数据（端口 ${PORT_OLD}）"
start_master "$WORK/pierwave-master-old" "$PORT_OLD" "$WORK/master-old.log" 60
STARTUP_OLD=$LAST_STARTUP_SECS
ok "${FROM_TAG} 主控就绪（${STARTUP_OLD}s），库：${DB}"
login "$BASE_OLD"
OLD_SESSION=$(awk '$6 == "pierwave_session" { print $7 }' "$WORK/cookie.txt" | tail -1)
[ -n "$OLD_SESSION" ] || die "登录成功但 cookie 里没有 pierwave_session"

printf '{"name":"legacy-hk","address":"10.20.0.1"}' >"$WORK/req.json"
expect_json "$(request "$BASE_OLD" POST /api/v1/servers "$WORK/req.json")" 200 "建服务器 legacy-hk"
SERVER_A=$(jget '["server"]["id"]')

printf '{"name":"legacy-jp","address":"10.20.0.2"}' >"$WORK/req.json"
expect_json "$(request "$BASE_OLD" POST /api/v1/servers "$WORK/req.json")" 200 "建服务器 legacy-jp"
SERVER_B=$(jget '["server"]["id"]')
ok "服务器 2 台"

python3 - "$WORK" <<'PY'
import base64, json, os, sys
work = sys.argv[1]
priv = base64.b64encode(os.urandom(32)).decode()
nodes = {
    "legacy-node-reality.json": {
        "name": "老库-REALITY", "protocol": "vless", "transport": "tcp",
        "security": "reality", "port": 443,
        "config": {
            "settings": {"clients": [], "decryption": "none"},
            "streamSettings": {
                "network": "tcp", "security": "reality",
                "realitySettings": {
                    "dest": "www.microsoft.com:443",
                    "serverNames": ["www.microsoft.com"],
                    "privateKey": priv,
                    "shortIds": ["0123456789abcdef"],
                },
            },
        },
    },
    "legacy-node-ws.json": {
        "name": "老库-WS", "protocol": "trojan", "transport": "ws",
        "security": "none", "port": 8443,
        "config": {"settings": {"clients": [{"password": "legacy-client"}]}},
    },
}
for name, node in nodes.items():
    json.dump(node, open(f"{work}/{name}", "w"))
PY
for file in legacy-node-reality.json legacy-node-ws.json; do
  expect_json "$(request "$BASE_OLD" POST "/api/v1/servers/${SERVER_A}/nodes" "$WORK/$file")" 200 "建节点 ${file}"
done
printf '{"name":"老库-SS","protocol":"shadowsocks","transport":"tcp","security":"none","port":9000,"config":{"settings":{"method":"aes-256-gcm","password":"legacy-server-key","clients":[]}}}' >"$WORK/req.json"
expect_json "$(request "$BASE_OLD" POST "/api/v1/servers/${SERVER_B}/nodes" "$WORK/req.json")" 200 "建节点 老库-SS"
ok "节点 3 个"

printf '{"name":"老库-月卡","quota_bytes":53687091200,"period_days":30,"direction":"both","node_ratio":3.0}' >"$WORK/req.json"
expect_json "$(request "$BASE_OLD" POST /api/v1/packages "$WORK/req.json")" 200 "建套餐"
PACKAGE_ID=$(jget '["package"]["id"]')

printf '{"username":"alice","password":"password123","role":"user"}' >"$WORK/req.json"
expect_json "$(request "$BASE_OLD" POST /api/v1/users "$WORK/req.json")" 200 "建用户 alice"
ALICE_ID=$(jget '["user"]["id"]')

printf '{"username":"bob","password":"password123","role":"user"}' >"$WORK/req.json"
expect_json "$(request "$BASE_OLD" POST /api/v1/users "$WORK/req.json")" 200 "建用户 bob"

printf '{"package_id":"%s"}' "$PACKAGE_ID" >"$WORK/req.json"
expect_json "$(request "$BASE_OLD" POST "/api/v1/users/${ALICE_ID}/packages" "$WORK/req.json")" 200 "alice 绑定套餐"
ok "套餐 1 个、用户 2 个（alice 已绑套餐）"

printf '{"name":"老库-rules","rules":["DOMAIN-SUFFIX,example.com,DIRECT","MATCH,PROXY"]}' >"$WORK/req.json"
expect_json "$(request "$BASE_OLD" POST /api/v1/rule-templates "$WORK/req.json")" 200 "建规则模板"
ok "规则模板 1 个"

printf '{"name":"老库-chain","target_host":"127.0.0.1","target_port":18080,"engine":"native","protocol":"tcp","hops":[{"server_id":"%s","listen_port":20101},{"server_id":"%s","listen_port":20102}]}' \
  "$SERVER_A" "$SERVER_B" >"$WORK/req.json"
expect_json "$(request "$BASE_OLD" POST /api/v1/chains "$WORK/req.json")" 200 "建两跳转发链"
ok "两跳转发链 1 条"

printf '{"name":"老库-fwd","listen_port":20110,"target_host":"127.0.0.1","target_port":19001,"engine":"native","protocol":"tcp"}' >"$WORK/req.json"
expect_json "$(request "$BASE_OLD" POST "/api/v1/servers/${SERVER_A}/forwards" "$WORK/req.json")" 200 "建转发规则"
ok "单跳转发 1 条"

BEFORE_SUMMARY=$(snapshot "$BASE_OLD" "$WORK/facts-before.json" "$WORK/creds-before.json" "$OLD_SESSION")
ok "升级前快照：${BEFORE_SUMMARY}"

# 升级前用旧版本导出一份明文备份：升级后要验证它仍能被新版本恢复。
LEGACY_BACKUP="$WORK/backup-legacy.db.gz"
download_backup "$BASE_OLD" "$LEGACY_BACKUP" "$WORK/export-legacy.headers" "旧版明文备份（${FROM_TAG}）"
grep -qi '^content-type: application/gzip' "$WORK/export-legacy.headers" \
  || die "旧版导出的 Content-Type 不是 application/gzip：$(grep -i '^content-type' "$WORK/export-legacy.headers" || true)"
grep -qi 'content-disposition: attachment; filename="pierwave-backup-.*\.db\.gz"' "$WORK/export-legacy.headers" \
  || die "旧版导出的文件名不是 .db.gz：$(grep -i '^content-disposition' "$WORK/export-legacy.headers" || true)"
LEGACY_RAW_BYTES=$(assert_legacy_gzip_backup "$LEGACY_BACKUP" "$WORK/backup-legacy.db" "旧版明文备份")
ok "旧版导出：$(wc -c <"$LEGACY_BACKUP" | tr -d ' ') B gzip → ${LEGACY_RAW_BYTES} B SQLite（升级后用它验证旧格式兼容）"

close_old_meta=$(db_migrations)
OLD_MIGRATION_ROWS=$(printf '%s\n' "$close_old_meta" | sed -n '1p')
OLD_MIGRATION_MAX=$(printf '%s\n' "$close_old_meta" | sed -n '2p')
stop_master
ok "旧版主控已停止（库迁移记录：${OLD_MIGRATION_ROWS} 条，最新 version=${OLD_MIGRATION_MAX}）"

# ------------------------------------------------------------------ 3. 新版打开同一个库
PORT_NEW=$(pick_port 8891)
BASE_NEW="http://127.0.0.1:${PORT_NEW}"
log "阶段 2/3：用 ${TO_REV} 打开同一个库（端口 ${PORT_NEW}，触发迁移）"
start_master "$WORK/pierwave-master-new" "$PORT_NEW" "$WORK/master-new.log" 120
STARTUP_NEW=$LAST_STARTUP_SECS
ok "${TO_REV} 主控就绪，启动到健康 ${STARTUP_NEW}s"

login "$BASE_NEW"
NEW_SESSION=$(awk '$6 == "pierwave_session" { print $7 }' "$WORK/cookie.txt" | tail -1)
[ -n "$NEW_SESSION" ] || die "升级后登录成功但 cookie 里没有 pierwave_session"

# 新版专有接口：能 200 说明新迁移建的表/路由真的可用，而不是「旧库刚好能打开」。
CODE=$(request "$BASE_NEW" GET /api/v1/chain-templates)
expect_json "$CODE" 200 "新版专有接口 /api/v1/chain-templates 不可用（迁移可能没跑完？）"
ok "新版专有接口 /api/v1/chain-templates → 200"

AFTER_SUMMARY=$(snapshot "$BASE_NEW" "$WORK/facts-after.json" "$WORK/creds-after.json" "$NEW_SESSION")
ok "升级后快照：${AFTER_SUMMARY}"

# 新版本导出：支持加密就必须是 PWSB 信封（升级不只是「库能打开」，备份路径也要切到新格式）；
# 目标版本还没加密时（例如 TO_REV=v0.15.0），按旧明文 gzip 断言。
if [ "$NEW_HAS_ENCRYPTION" = "1" ]; then
  NEW_BACKUP="$WORK/backup-new.db.gz.enc"
  NEW_BACKUP_FORMAT="PWSB 加密"
  download_backup "$BASE_NEW" "$NEW_BACKUP" "$WORK/export-new.headers" "新版加密备份（${TO_REV}）"
  grep -qi '^content-type: application/octet-stream' "$WORK/export-new.headers" \
    || die "新版导出的 Content-Type 不是 application/octet-stream：$(grep -i '^content-type' "$WORK/export-new.headers" || true)"
  grep -qi 'content-disposition: attachment; filename="pierwave-backup-.*\.db\.gz\.enc"' "$WORK/export-new.headers" \
    || die "新版导出的文件名不是 .db.gz.enc：$(grep -i '^content-disposition' "$WORK/export-new.headers" || true)"
  assert_pwsb_backup "$NEW_BACKUP" "新版导出"
else
  NEW_BACKUP="$WORK/backup-new.db.gz"
  NEW_BACKUP_FORMAT="明文 gzip"
  download_backup "$BASE_NEW" "$NEW_BACKUP" "$WORK/export-new.headers" "新版明文备份（${TO_REV}）"
  grep -qi '^content-type: application/gzip' "$WORK/export-new.headers" \
    || die "新版导出的 Content-Type 不是 application/gzip：$(grep -i '^content-type' "$WORK/export-new.headers" || true)"
  grep -qi 'content-disposition: attachment; filename="pierwave-backup-.*\.db\.gz"' "$WORK/export-new.headers" \
    || die "新版导出的文件名不是 .db.gz：$(grep -i '^content-disposition' "$WORK/export-new.headers" || true)"
  assert_legacy_gzip_backup "$NEW_BACKUP" "$WORK/backup-new.db" "新版明文导出" >/dev/null
fi
ok "新版导出：$(wc -c <"$NEW_BACKUP" | tr -d ' ') B（${NEW_BACKUP_FORMAT}）"

stop_master
new_meta=$(db_migrations)
NEW_MIGRATION_ROWS=$(printf '%s\n' "$new_meta" | sed -n '1p')
NEW_MIGRATION_MAX=$(printf '%s\n' "$new_meta" | sed -n '2p')

# ------------------------------------------------------------------ 4. 断言与报告
compare_facts "$WORK/facts-before.json" "$WORK/facts-after.json" \
  "$WORK/creds-before.json" "$WORK/creds-after.json" "升级后"
assert_row_counts "$WORK/facts-after.json" "升级后"

PHASE="校验迁移记录"
if [ "$NEW_MIGRATION_ROWS" != "$NEW_MIGRATIONS" ]; then
  die "迁移未全部应用：库里 ${NEW_MIGRATION_ROWS} 条，源码里有 ${NEW_MIGRATIONS} 个迁移文件"
fi
if [ "$NEW_MIGRATION_MAX" -le "$OLD_MIGRATION_MAX" ]; then
  die "迁移版本没有前进：升级前 ${OLD_MIGRATION_MAX}，升级后 ${NEW_MIGRATION_MAX}"
fi
ok "迁移记录：${OLD_MIGRATION_ROWS} 条 → ${NEW_MIGRATION_ROWS} 条（version ${OLD_MIGRATION_MAX} → ${NEW_MIGRATION_MAX}）"

# ------------------------------------------------------------------ 5. 旧明文备份在新版本恢复
# 升级前用 v0.15.0 导出的 .db.gz 是最容易出问题的跨版本输入：新版本必须能解压、
# 校验、落 pending，并在重启迁移后保持数据不变。
PORT_RESTORE=$(pick_port 8901)
BASE_RESTORE="http://127.0.0.1:${PORT_RESTORE}"
log "阶段 3/3：用 ${TO_REV} 恢复升级前的明文备份（端口 ${PORT_RESTORE}）"
start_master "$WORK/pierwave-master-new" "$PORT_RESTORE" "$WORK/master-restore-1.log" 120
login "$BASE_RESTORE"

RESTORE_CODE=$(upload_restore "$BASE_RESTORE" "$LEGACY_BACKUP" "旧版明文 .db.gz")
expect_json "$RESTORE_CODE" 200 "新版本恢复旧版明文备份失败"
RESTART_REQUIRED=$(jget '["restart_required"]')
PENDING_BYTES=$(jget '["pending"]["bytes"]')
[ "$RESTART_REQUIRED" = "True" ] || die "旧备份导入响应没有要求重启（restart_required=${RESTART_REQUIRED}）"
[ "$PENDING_BYTES" = "$LEGACY_RAW_BYTES" ] \
  || die "旧备份 pending 字节数不一致：pending=${PENDING_BYTES}，解压后=${LEGACY_RAW_BYTES}"
expect_json "$(request "$BASE_RESTORE" GET /api/v1/backup/info)" 200 "读取待恢复状态"
python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));sys.exit(0 if d.get("pending") else 1)' "$WORK/resp.json" \
  || die "旧备份导入成功后 /backup/info 没有 pending"
ok "旧版明文备份已被接受：restart_required=true，pending=${PENDING_BYTES} B"

stop_master
start_master "$WORK/pierwave-master-new" "$PORT_RESTORE" "$WORK/master-restore-2.log" 120
grep -q "已应用待恢复的数据库备份" "$WORK/master-restore-2.log" \
  || die "旧备份恢复后启动日志里没有「已应用待恢复的数据库备份」"
grep -q "pre-restore" "$WORK/master-restore-2.log" \
  || die "旧备份恢复后启动日志里没有 pre-restore 回滚副本"
login "$BASE_RESTORE"
RESTORED_SESSION=$(awk '$6 == "pierwave_session" { print $7 }' "$WORK/cookie.txt" | tail -1)
[ -n "$RESTORED_SESSION" ] || die "旧备份恢复后登录成功但 cookie 里没有 pierwave_session"
RESTORED_SUMMARY=$(snapshot "$BASE_RESTORE" "$WORK/facts-restored.json" "$WORK/creds-restored.json" "$RESTORED_SESSION")
ok "旧备份恢复后快照：${RESTORED_SUMMARY}"

compare_facts "$WORK/facts-before.json" "$WORK/facts-restored.json" \
  "$WORK/creds-before.json" "$WORK/creds-restored.json" "旧明文备份恢复后"
assert_row_counts "$WORK/facts-restored.json" "旧明文备份恢复后"

stop_master
RESTORED_META=$(db_migrations)
RESTORED_MIGRATION_ROWS=$(printf '%s\n' "$RESTORED_META" | sed -n '1p')
RESTORED_MIGRATION_MAX=$(printf '%s\n' "$RESTORED_META" | sed -n '2p')
[ "$RESTORED_MIGRATION_ROWS" = "$NEW_MIGRATIONS" ] \
  || die "旧备份恢复后迁移未全部应用：库里 ${RESTORED_MIGRATION_ROWS} 条，源码里 ${NEW_MIGRATIONS} 个"
[ "$RESTORED_MIGRATION_MAX" -ge "$NEW_MIGRATION_MAX" ] \
  || die "旧备份恢复后迁移版本回退：${RESTORED_MIGRATION_MAX} < ${NEW_MIGRATION_MAX}"
ok "旧备份恢复后迁移仍完整：${RESTORED_MIGRATION_ROWS} 条（version ${RESTORED_MIGRATION_MAX}）"

SCRIPT_END=$(python3 -c 'import time; print(f"{time.time():.3f}")')
TOTAL_SECS=$(awk -v a="$SCRIPT_START" -v b="$SCRIPT_END" 'BEGIN { printf "%.1f", b - a }')

echo
log "==== 升级路径报告 ===="
printf '  起点：%s（v%s，commit %s）\n' "$FROM_TAG" "$OLD_VERSION" "$OLD_COMMIT"
printf '  终点：%s（v%s，commit %s）\n' "$TO_REV" "$NEW_VERSION" "$NEW_COMMIT"
printf '  跨迁移：%s 个（%s → %s，version %s → %s）\n' \
  "$SPAN" "$OLD_MIGRATIONS" "$NEW_MIGRATIONS" "$OLD_MIGRATION_MAX" "$NEW_MIGRATION_MAX"
printf '  新增迁移文件：\n'
printf '%s\n' "$NEW_ONLY" | sed 's/^/    /'
printf '  升级耗时（新版启动到健康，含迁移）：%s s\n' "$STARTUP_NEW"
printf '  旧版启动耗时（对照）：%s s\n' "$STARTUP_OLD"
printf '  备份格式：%s 导出明文 gzip（解压后 %s B）→ %s 导出 %s（%s B）\n' \
  "$FROM_TAG" "$LEGACY_RAW_BYTES" "$TO_REV" "$NEW_BACKUP_FORMAT" "$(wc -c <"$NEW_BACKUP" | tr -d ' ')"
printf '  跨版本备份恢复：旧版明文备份在新版本恢复成功（pending %s B，迁移后 %s 条）\n' \
  "$PENDING_BYTES" "$RESTORED_MIGRATION_ROWS"
printf '  脚本总耗时（含两次编译）：%s s\n' "$TOTAL_SECS"
echo
printf '\033[32mPASS\033[0m 升级路径实测通过（库：%s；临时目录：%s）\n' "$DB" "$WORK"
