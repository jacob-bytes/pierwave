#!/usr/bin/env bash
# 备份恢复实测：起临时主控 → 通过真实 HTTP 接口建数据 → 导出备份 →
# 换一个全新的空库 → 通过 HTTP 接口导入 → 重启生效 → 断言关键数据一致。
#
# 默认导出加密备份（`PWSB` 信封 + AES-256-GCM），再关闭 `backup_encrypt`
# 导出一次明文 `.db.gz`：两条路径都要真的恢复成功，数据也都要一致。
#
# 目标：把「备份能下载、恢复能上传」和「恢复后数据真的还在」分开验证。
# 只走 `GET /api/v1/backup` 与 `POST /api/v1/backup/restore`，
# 不复制 SQLite 文件、不直接写库——否则测的就是另一套逻辑。
#
# 为什么必须重启：恢复的设计是「上传阶段只落盘为 <db>.restore-pending，
# 真正替换发生在下次启动、打开连接池之前」（见 crates/domain/src/backup.rs）。
# 脚本严格遵守这个契约，因此每轮恢复都会显式停/起主控。
#
# 为什么必须固定主密钥：加密备份是用**导出端**的主密钥封装的，恢复端必须用
# 同一把密钥才能解开。脚本给所有临时主控注入同一个 `PIERWAVE_SECRET_KEY`
# （32 字节 base64），否则跨实例恢复会得到 backup.restore_decrypt_failed。
#
# 用法：
#   ./scripts/verify-backup.sh
#   KEEP=1 ./scripts/verify-backup.sh     # 保留临时目录（日志、导出文件、三份 DB）
#   BACKUP_WORK=/tmp/x ./scripts/verify-backup.sh
#
# 退出码：0 = 全部断言通过；1 = 有失败（会打印可读原因与 master 日志尾部）。
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$PWD

# 本机沙箱不允许写 ~/.cargo、~/.npm；与 Makefile 保持一致。
if [ -z "${CARGO_HOME:-}" ] && [ -d "$ROOT/.cargo-home" ]; then
  export CARGO_HOME="$ROOT/.cargo-home"
fi
if [ -z "${NPM_CONFIG_CACHE:-}" ] && [ -d "$ROOT/.npm-cache" ]; then
  export NPM_CONFIG_CACHE="$ROOT/.npm-cache"
fi

WORK="${BACKUP_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/pierwave-backup.XXXXXX")}"
mkdir -p "$WORK"
KEEP="${KEEP:-0}"
MASTER_BIN="$ROOT/target/debug/pierwave-master"
ADMIN_PASSWORD="devpass"
CURL_TIMEOUT="${CURL_TIMEOUT:-120}"

# 每轮主控共用同一把测试主密钥；不打印内容。
if [ -z "${PIERWAVE_SECRET_KEY:-}" ]; then
  PIERWAVE_SECRET_KEY=$(python3 -c 'import base64,os;print(base64.b64encode(os.urandom(32)).decode())')
  export PIERWAVE_SECRET_KEY
fi

MASTER_PID=""
PHASE="初始化"
log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m %s\n' "$*"; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$*"; }
die() {
  printf '  \033[31mFAIL\033[0m %s\n' "$*" >&2
  if [ -n "${MASTER_LOG:-}" ] && [ -f "$MASTER_LOG" ]; then
    printf '  --- master 日志尾部（%s）---\n' "$MASTER_LOG" >&2
    tail -25 "$MASTER_LOG" >&2 || true
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
# macOS 默认没有 `timeout`（coreutils 版是 gtimeout）。这里做兜底：
# 有就借用，没有就用「后台跑 + 看门狗 kill」，避免某次 HTTP 卡死让脚本永远挂住。
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
    : >"$flag"                 # 通知看门狗：子进程已结束，别误杀
    wait "$watchdog" 2>/dev/null || true
    rm -f "$flag"
    return "$rc"
  }
fi

now_ms() {
  python3 -c 'import time; print(f"{time.monotonic():.3f}")'
}

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
  local base=$1 timeout=${2:-30}
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
  # start_master <db 路径> <端口> <日志文件>
  local db=$1 port=$2 log_file=$3
  PHASE="启动主控（${db}）"
  ( [[ -d "$(dirname "$db")" ]] || mkdir -p "$(dirname "$db")" )
  PIERWAVE_ADDR="127.0.0.1:${port}" \
  PIERWAVE_DB="sqlite://${db}?mode=rwc" \
  PIERWAVE_WEB_DIR="$ROOT/web/dist" \
  PIERWAVE_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  PIERWAVE_SECRET_KEY="$PIERWAVE_SECRET_KEY" \
    "$MASTER_BIN" >"$log_file" 2>&1 &
  MASTER_PID=$!
  MASTER_LOG=$log_file
  local elapsed
  if ! elapsed=$(wait_health "http://127.0.0.1:${port}" 30); then
    die "主控在 30s 内没有就绪（端口 ${port}）"
  fi
  ok "主控就绪：端口 ${port}，耗时 ${elapsed}s"
}

stop_master() {
  PHASE="停止主控"
  if [ -n "$MASTER_PID" ]; then
    kill "$MASTER_PID" 2>/dev/null || true
    # 最多等 10s 优雅退出，超时才 KILL。
    for _ in $(seq 1 50); do
      kill -0 "$MASTER_PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -9 "$MASTER_PID" 2>/dev/null || true
    wait "$MASTER_PID" 2>/dev/null || true
    MASTER_PID=""
  fi
}

# 发请求，响应体写 $WORK/resp.json，返回 HTTP 状态码；网络错误返回 000。
request() {
  # request <method> <完整 URL> [请求体文件] [Content-Type]
  local method=$1 url=$2 body=${3:-} ctype=${4:-application/json}
  local code
  if [ -n "$body" ]; then
    code=$(run_timeout $((CURL_TIMEOUT + 5)) \
      curl -sS --max-time "$CURL_TIMEOUT" -b "$WORK/cookie.txt" -X "$method" "$url" \
        -H "Content-Type: ${ctype}" --data-binary @"$body" \
        -o "$WORK/resp.json" -w '%{http_code}') || code=000
  else
    code=$(run_timeout $((CURL_TIMEOUT + 5)) \
      curl -sS --max-time "$CURL_TIMEOUT" -b "$WORK/cookie.txt" -X "$method" "$url" \
        -o "$WORK/resp.json" -w '%{http_code}') || code=000
  fi
  printf '%s' "$code"
}

# expect_json <状态码> <期望码> <说明>：失败时把响应体原样打出来（可读原因）。
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
  PHASE="登录"
  printf '{"username":"admin","password":"%s"}' "$ADMIN_PASSWORD" >"$WORK/login.json"
  local code
  code=$(curl -sS --max-time "$CURL_TIMEOUT" -c "$WORK/cookie.txt" -X POST \
    -H 'Content-Type: application/json' --data-binary @"$WORK/login.json" \
    -o "$WORK/resp.json" -w '%{http_code}' "$BASE/api/v1/auth/login") || code=000
  expect_json "$code" 200 "登录失败（备份里的管理员密码是否被改动？）"
  ok "登录成功（admin）"
}

# 导出备份到指定文件，并保存响应头。只走真实 HTTP。
export_backup() {
  # export_backup <输出文件> <请求头文件> <说明>
  local out=$1 headers=$2 what=$3 code
  PHASE="导出备份（${what}）"
  log "调用 GET /api/v1/backup（${what}）"
  code=$(run_timeout $((CURL_TIMEOUT + 5)) \
    curl -sS --max-time "$CURL_TIMEOUT" -b "$WORK/cookie.txt" \
      -D "$headers" -o "$out" \
      -w '%{http_code}' "$BASE/api/v1/backup") || code=000
  [ "$code" = "200" ] || die "导出失败：HTTP ${code}（文件头：$(head -c 200 "$out" 2>/dev/null | od -c | head -3)）"
  [ -s "$out" ] || die "导出文件是空的：${out}"
}

# 加密备份的格式断言：PWSB 信封，且不能是 gzip / 明文 SQLite。
assert_pwsb_backup() {
  local file=$1 what=$2
  python3 - "$file" <<'PY' || die "${what}不是加密信封（PWSB）"
import sys
head = open(sys.argv[1], "rb").read(64)
if len(head) < 5:
    raise SystemExit(f"文件太短：{head!r}")
if head[:2] == b"\x1f\x8b":
    raise SystemExit("文件以 gzip 魔数开头：这是明文备份，不是加密备份")
if head[:16] == b"SQLite format 3\x00":
    raise SystemExit("文件以 SQLite 文件头开头：这是明文数据库，不是加密备份")
if not head.startswith(b"PWSB"):
    raise SystemExit(f"文件头不是 PWSB：{head[:8]!r}")
if head[4] != 1:
    raise SystemExit(f"信封版本不是 1：{head[4]}")
PY
  ok "${what}是 PWSB 加密信封（非 gzip、非明文 SQLite）"
}

# 明文备份的格式断言：gzip 魔数 → 解压后必须是 SQLite 文件头。
assert_gzip_sqlite_backup() {
  # assert_gzip_sqlite_backup <gz 文件> <解压输出文件> <说明>；打印解压后字节数
  local gz=$1 raw=$2 what=$3 bytes
  bytes=$(python3 - "$gz" "$raw" <<'PY'
import gzip, sys
data = open(sys.argv[1], "rb").read()
if not data.startswith(b"\x1f\x8b"):
    raise SystemExit(f"不是 gzip：{data[:8]!r}")
if data.startswith(b"PWSB"):
    raise SystemExit("明文导出却是 PWSB 加密信封")
raw = gzip.decompress(data)
open(sys.argv[2], "wb").write(raw)
if not raw.startswith(b"SQLite format 3\x00"):
    raise SystemExit(f"解压后不是 SQLite：{raw[:16]!r}")
print(len(raw))
PY
  ) || die "${what}不是可解压的明文 gzip 备份"
  printf '%s' "$bytes"
}

# 全新的空库：servers=0，users=1（仅初始 admin）。
assert_empty_db() {
  local what=$1
  expect_json "$(request GET "$BASE/api/v1/servers")" 200 "读取空库服务器列表"
  local servers users
  servers=$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["items"]))' "$WORK/resp.json")
  expect_json "$(request GET "$BASE/api/v1/users")" 200 "读取空库用户列表"
  users=$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["items"]))' "$WORK/resp.json")
  [ "$servers" = "0" ] || die "${what}：新库不应该是空的：servers=${servers}"
  [ "$users" = "1" ] || die "${what}：新库应只有初始 admin，实际 users=${users}"
  ok "${what}：新库确认是空的（servers=0，users=1 仅 admin）"
}

# 比对「导出前」与「本轮恢复后」的关键数据；行数下限单独校验，防止空库对空库。
compare_snapshot() {
  # compare_snapshot <标签> <after.json> <after-sub.yaml> <导出前订阅哈希>
  local label=$1 after=$2 sub_after=$3 sub_before_hash=$4 sub_after_hash counts
  PHASE="比对数据（${label}）"
  log "比对导出前 / ${label}恢复后的关键数据"
  sub_after_hash=$(python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$sub_after")
  python3 - "$WORK/facts/before.json" "$after" "$sub_before_hash" "$sub_after_hash" <<'PY'
import json
import sys

before_path, after_path, sub_before, sub_after = sys.argv[1:5]
before = json.load(open(before_path, encoding="utf-8"))
after = json.load(open(after_path, encoding="utf-8"))

LABELS = {
    "users": "用户",
    "servers": "服务器",
    "nodes": "节点",
    "packages": "套餐",
    "chains": "转发链",
    "forwards": "转发规则",
    "rule_templates": "规则模板",
    "certificates": "证书",
    "settings": "设置项",
}
problems = []
print(f"{'关键数据':<14}{'导出前':>8}{'导入后':>8}  结果")
print("-" * 48)
for key, label in LABELS.items():
    left = before.get(key)
    right = after.get(key)
    left_n = len(left) if isinstance(left, (list, dict)) else 0
    right_n = len(right) if isinstance(right, (list, dict)) else 0
    same = left == right
    print(f"{label:<14}{left_n:>8}{right_n:>8}  {'OK' if same else 'DIFF'}")
    if not same:
        problems.append((label, left, right))

print(f"\n订阅内容 SHA256 导出前 {sub_before[:16]}… / 导入后 {sub_after[:16]}…  "
      f"{'OK' if sub_before == sub_after else 'DIFF'}")

if problems:
    print(f"\nFAIL: {len(problems)} 类关键数据不一致：", file=sys.stderr)
    for label, left, right in problems:
        print(f"  - {label}: 导出前={json.dumps(left, ensure_ascii=False)[:400]}", file=sys.stderr)
        print(f"            导入后={json.dumps(right, ensure_ascii=False)[:400]}", file=sys.stderr)
    raise SystemExit(1)
if sub_before != sub_after:
    print("\nFAIL: 恢复后订阅内容变了（用户客户端的节点凭据会失效）", file=sys.stderr)
    raise SystemExit(1)
PY
  counts=$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(json.dumps({k:(len(v) if isinstance(v,(list,dict)) else 0) for k,v in d.items()},ensure_ascii=False))' "$after")
  ok "${label}：恢复后 ${counts} 与导出前完全一致（含订阅渲染结果）"

  # 行数至少要有内容，防止「空库对空库」这种假绿。
  python3 - "$after" <<'PY' || die "${label}：恢复后的关键表是空的（对空断言没有意义）"
import json, sys
facts = json.load(open(sys.argv[1], encoding="utf-8"))
# 数值是「造数 + 迁移自带的默认行」：迁移 0010 会插入一条默认规则模板，
# 所以 1 条自建模板 + 1 条默认 = 2。其余都是脚本自己造的数量。
expect = {"users": 3, "servers": 2, "nodes": 4, "packages": 1, "chains": 1,
          "forwards": 1, "rule_templates": 2, "certificates": 1, "settings": 6}
wrong = {key: (len(facts[key]), want) for key, want in expect.items() if len(facts[key]) != want}
if wrong:
    raise SystemExit(f"关键表行数与造数不符（实际, 期望）：{wrong}")
PY
}

# JSON 事实快照：只取稳定字段（不含 status / runtime / last_seen 这类心跳态），
# 保证「导出前」和「导入后」可以直接深度比较。
snapshot() {
  # snapshot <输出文件> <订阅文本输出文件>
  local out=$1 sub_out=$2
  PHASE="抓取数据快照"
  mkdir -p "$(dirname "$out")"
  python3 - "$BASE" "$SESSION" "$out" "$sub_out" <<'PY'
import hashlib
import json
import sys
import urllib.error
import urllib.request

base, session, out_path, sub_path = sys.argv[1:5]
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


servers = get_json("/api/v1/servers")["items"]
users = get_json("/api/v1/users")["items"]
packages = get_json("/api/v1/packages")["items"]
chains = get_json("/api/v1/chains")["items"]
templates = get_json("/api/v1/rule-templates")["items"]
certs = get_json("/api/v1/certificates")["items"]
settings = get_json("/api/v1/settings")["items"]

server_name = {server["id"]: server["name"] for server in servers}

nodes = []
forwards = []
for server in servers:
    for node in get_json(f"/api/v1/servers/{server['id']}/nodes")["items"]:
        nodes.append({
            "server": server["name"],
            "tag": node["tag"],
            "name": node["name"],
            "protocol": node["protocol"],
            "transport": node["transport"],
            "security": node["security"],
            "port": node["port"],
            "public_port": node["public_port"],
            "enabled": node["enabled"],
            "cert_name": next(
                (cert["name"] for cert in certs if cert["id"] == node["cert_id"]), None
            ),
            "config": node["config"],
        })
    for fwd in get_json(f"/api/v1/servers/{server['id']}/forwards")["items"]:
        forwards.append({
            "server": server["name"],
            "name": fwd["name"],
            "listen_port": fwd["listen_port"],
            "target_host": fwd["target_host"],
            "target_port": fwd["target_port"],
            "engine": fwd["engine"],
            "protocol": fwd["protocol"],
            "udp": fwd["udp"],
            "enabled": fwd["enabled"],
            "count_traffic": fwd["count_traffic"],
        })


def user_facts(user):
    bound = get_json(f"/api/v1/users/{user['id']}/packages")["items"]
    return {
        "username": user["username"],
        "role": user["role"],
        "short_code": user["short_code"],
        "status": user["status"],
        "quota_bytes": user["quota_bytes"],
        "used_bytes": user["used_bytes"],
        "rule_template_id": user["rule_template_id"],
        "packages": sorted(
            (
                {
                    "package_name": item["package_name"],
                    "quota_bytes": item["quota_bytes"],
                    "quota_override": item["quota_override"],
                    "used_bytes": item["used_bytes"],
                    "status": item["status"],
                    "expires_at": item["expires_at"],
                    "reset_day": item["reset_day"],
                    "direction": item["direction"],
                    "node_ratio": item["node_ratio"],
                }
                for item in bound
            ),
            key=lambda item: item["package_name"],
        ),
    }


def chain_facts(chain):
    return {
        "name": chain["name"],
        "target_host": chain["target_host"],
        "target_port": chain["target_port"],
        "engine": chain["engine"],
        "protocol": chain["protocol"],
        "enabled": chain["enabled"],
        "transport": chain["transport"],
        "tunnel_security": chain["tunnel_security"],
        "groups": [
            {
                "seq": group["seq"],
                "name": group["name"],
                "strategy": group["strategy"],
                "listen_port": group["listen_port"],
                "public_port": group["public_port"],
                "use_internal_address": group["use_internal_address"],
                "members": sorted(
                    (
                        {
                            "server": member["server_name"],
                            "listen_port": member["listen_port"],
                            "priority": member["priority"],
                            "weight": member["weight"],
                            "forward_id": member["forward_id"],
                        }
                        for member in group["members"]
                    ),
                    key=lambda item: (item["server"], item["listen_port"]),
                ),
            }
            for group in chain["groups"]
        ],
    }


facts = {
    "users": sorted((user_facts(user) for user in users), key=lambda item: item["username"]),
    "servers": sorted(
        (
            {
                "name": server["name"],
                "address": server["address"],
                "xray_mode": server["xray_mode"],
                "country_code": server["country_code"],
                "group_name": server["group_name"],
                "port_start": server["port_start"],
                "port_end": server["port_end"],
                "internal_address": server["internal_address"],
            }
            for server in servers
        ),
        key=lambda item: item["name"],
    ),
    "nodes": sorted(nodes, key=lambda item: (item["server"], item["tag"])),
    "packages": sorted(
        (
            {
                "name": package["name"],
                "quota_bytes": package["quota_bytes"],
                "period_days": package["period_days"],
                "direction": package["direction"],
                "node_ratio": package["node_ratio"],
                "node_scope": package["node_scope"],
                "node_count": package["node_count"],
                "speed_limit_kbps": package["speed_limit_kbps"],
                "forward_limit": package["forward_limit"],
                "chain_limit": package["chain_limit"],
                "user_count": package["user_count"],
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
                "name": template["name"],
                "rules": template["rules"],
                "is_default": template["is_default"],
            }
            for template in templates
        ),
        key=lambda item: item["name"],
    ),
    "certificates": sorted(
        (
            {
                "name": cert["name"],
                "domains": cert["domains"],
                "not_before": cert["not_before"],
                "not_after": cert["not_after"],
                "has_key": cert["has_key"],
            }
            for cert in certs
        ),
        key=lambda item: item["name"],
    ),
    "settings": {
        key: settings[key]
        for key in (
            "panel_name",
            "public_status_enabled",
            "session_ttl_hours",
            "agent_upgrade_concurrency",
            "alert_events",
            "login_max_attempts",
        )
    },
}

# 订阅是「用户真正拿到的东西」：节点凭据由用户 id 派生，
# 恢复后必须逐字节一致，否则用户客户端的 UUID 会变、连接直接失效。
sub_code = next(user["short_code"] for user in users if user["username"] == "alice")
sub_text = get_bytes(f"/api/v1/sub/{sub_code}", with_cookie=False)

with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(facts, handle, indent=2, sort_keys=True, ensure_ascii=False)
with open(sub_path, "wb") as handle:
    handle.write(sub_text)
print(hashlib.sha256(sub_text).hexdigest())
print(json.dumps({key: len(value) if isinstance(value, (list, dict)) else 0
                  for key, value in facts.items()}, ensure_ascii=False))
PY
}

log "临时目录：$WORK"

# ------------------------------------------------------------------ 0. 构建
PHASE="构建 pierwave-master"
log "构建主控（debug）"
if ! CARGO_HOME="${CARGO_HOME:-$ROOT/.cargo-home}" cargo build -q -p pierwave-master 2>"$WORK/build.log"; then
  cat "$WORK/build.log" >&2 || true
  die "cargo build 失败"
fi
[ -x "$MASTER_BIN" ] || die "找不到主控二进制：$MASTER_BIN"
ok "构建完成：$MASTER_BIN"

# ------------------------------------------------------------------ 1. 导出端
PORT_A=$(pick_port 8831)
BASE="http://127.0.0.1:${PORT_A}"
DB_A="$WORK/db-source/pierwave.db"
log "阶段 1/3：在临时主控上造数据并导出备份（端口 ${PORT_A}）"
start_master "$DB_A" "$PORT_A" "$WORK/master-a.log"
login
SESSION=$(awk '$6 == "pierwave_session" { print $7 }' "$WORK/cookie.txt" | tail -1)
[ -n "$SESSION" ] || die "登录成功但 cookie 里没有 pierwave_session"

# ---- 服务器 ×2 ----
printf '{"name":"backup-hk","address":"10.10.0.1","country_code":"HK","group_name":"backup"}' >"$WORK/req.json"
expect_json "$(request POST "$BASE/api/v1/servers" "$WORK/req.json")" 200 "建服务器 backup-hk"
SERVER_A=$(jget '["server"]["id"]')

printf '{"name":"backup-jp","address":"10.10.0.2","country_code":"JP"}' >"$WORK/req.json"
expect_json "$(request POST "$BASE/api/v1/servers" "$WORK/req.json")" 200 "建服务器 backup-jp"
SERVER_B=$(jget '["server"]["id"]')
ok "服务器 2 台（backup-hk / backup-jp）"

# ---- 证书（节点 TLS 绑定；证书正文只存在库里，最容易被备份漏掉） ----
python3 - "$ROOT" "$WORK/req.json" <<'PY'
import json, sys
root, out = sys.argv[1:3]
cert = open(f"{root}/crates/domain/tests/fixtures/test-cert.pem", encoding="utf-8").read()
key = open(f"{root}/crates/domain/tests/fixtures/test-key.pem", encoding="utf-8").read()
json.dump({"name": "backup-cert", "cert_pem": cert, "key_pem": key}, open(out, "w"))
PY
expect_json "$(request POST "$BASE/api/v1/certificates" "$WORK/req.json")" 200 "上传证书 backup-cert"
CERT_ID=$(jget '["certificate"]["id"]')
ok "证书 1 张（backup-cert）"

# ---- 节点：reality / trojan-ws / TLS（绑证书） / shadowsocks ----
python3 - "$WORK" "$SERVER_B" "$CERT_ID" <<'PY'
import base64, json, os, sys
work, server_b, cert_id = sys.argv[1:4]
priv = base64.b64encode(os.urandom(32)).decode()
nodes = {
    "node-reality.json": {
        "name": "香港-REALITY", "protocol": "vless", "transport": "tcp",
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
    "node-ws.json": {
        "name": "东京-WS", "protocol": "trojan", "transport": "ws",
        "security": "none", "port": 8443,
        "config": {
            "settings": {"clients": [{"password": "backup-manual-client"}]},
            "stream": {"network": "ws", "security": "none", "wsSettings": {"path": "/ws"}},
        },
    },
    "node-tls.json": {
        "name": "东京-TLS", "protocol": "trojan", "transport": "tcp",
        "security": "tls", "port": 9443, "cert_id": cert_id,
        "config": {"settings": {"clients": []}},
    },
    "node-jp.json": {
        "name": "大阪-SS", "protocol": "shadowsocks", "transport": "tcp",
        "security": "none", "port": 9000,
        "config": {"settings": {"method": "aes-256-gcm", "password": "backup-server-key", "clients": []}},
    },
}
for name, node in nodes.items():
    json.dump(node, open(f"{work}/{name}", "w"))
open(f"{work}/server-b.id", "w").write(server_b)
PY
for spec in "node-reality.json:$SERVER_A" "node-ws.json:$SERVER_A" "node-tls.json:$SERVER_A" "node-jp.json:$SERVER_B"; do
  file=${spec%%:*}
  sid=${spec##*:}
  expect_json "$(request POST "$BASE/api/v1/servers/${sid}/nodes" "$WORK/$file")" 200 "建节点 ${file}"
done
ok "节点 4 个（reality / ws / tls+证书 / shadowsocks）"

# ---- 套餐 + 用户绑定 ----
printf '{"name":"backup-月卡","quota_bytes":107374182400,"period_days":30,"direction":"both","node_ratio":2.5,"speed_limit_kbps":100000,"forward_limit":0,"chain_limit":2}' >"$WORK/req.json"
expect_json "$(request POST "$BASE/api/v1/packages" "$WORK/req.json")" 200 "建套餐 backup-月卡"
PACKAGE_ID=$(jget '["package"]["id"]')

printf '{"username":"alice","password":"password123","role":"user"}' >"$WORK/req.json"
expect_json "$(request POST "$BASE/api/v1/users" "$WORK/req.json")" 200 "建用户 alice"
ALICE_ID=$(jget '["user"]["id"]')

printf '{"username":"bob","password":"password123","role":"user"}' >"$WORK/req.json"
expect_json "$(request POST "$BASE/api/v1/users" "$WORK/req.json")" 200 "建用户 bob"
BOB_ID=$(jget '["user"]["id"]')

printf '{"package_id":"%s"}' "$PACKAGE_ID" >"$WORK/req.json"
expect_json "$(request POST "$BASE/api/v1/users/${ALICE_ID}/packages" "$WORK/req.json")" 200 "alice 绑定套餐"
USER_PACKAGE_ID=$(jget '["item"]["id"]')

# 覆盖 override / reset_day 两个非默认列，恢复后能证明「改过的值」也回来了。
printf '{"quota_override":53687091200,"reset_day":15,"status":"active"}' >"$WORK/req.json"
expect_json "$(request PATCH "$BASE/api/v1/user-packages/${USER_PACKAGE_ID}" "$WORK/req.json")" 200 "改 alice 套餐配额"
ok "套餐 1 个、用户 2 个（alice 已绑套餐并改过配额）"

# ---- 规则模板 ----
printf '{"name":"backup-rules","rules":["DOMAIN-SUFFIX,example.com,DIRECT","MATCH,PROXY"]}' >"$WORK/req.json"
expect_json "$(request POST "$BASE/api/v1/rule-templates" "$WORK/req.json")" 200 "建规则模板"

# ---- 两跳链：backup-hk:20001 → backup-jp:20002 → 127.0.0.1:18080 ----
printf '{"name":"backup-chain","target_host":"127.0.0.1","target_port":18080,"engine":"native","protocol":"tcp","hops":[{"server_id":"%s","listen_port":20001},{"server_id":"%s","listen_port":20002}]}' \
  "$SERVER_A" "$SERVER_B" >"$WORK/req.json"
expect_json "$(request POST "$BASE/api/v1/chains" "$WORK/req.json")" 200 "建两跳链 backup-chain"

# ---- 单跳转发 ----
printf '{"name":"backup-fwd","listen_port":20010,"target_host":"127.0.0.1","target_port":19000,"engine":"native","protocol":"tcp"}' >"$WORK/req.json"
expect_json "$(request POST "$BASE/api/v1/servers/${SERVER_A}/forwards" "$WORK/req.json")" 200 "建转发 backup-fwd"

# ---- 设置：覆盖默认值，证明 settings 表也在备份里 ----
printf '{"panel_name":"BackupProbe","public_status_enabled":0,"session_ttl_hours":48}' >"$WORK/req.json"
expect_json "$(request PATCH "$BASE/api/v1/settings" "$WORK/req.json")" 200 "改设置"
ok "规则模板 / 两跳链 / 转发 / 设置 已就绪"

# ---- 快照 + 订阅文本 ----
SNAP_BEFORE=$(snapshot "$WORK/facts/before.json" "$WORK/facts/sub-before.yaml")
SUB_HASH_BEFORE=$(printf '%s\n' "$SNAP_BEFORE" | sed -n '1p')
COUNTS_BEFORE=$(printf '%s\n' "$SNAP_BEFORE" | sed -n '2p')
ok "导出前快照：${COUNTS_BEFORE}"

# 导入一份备份 → 校验 pending 字节数 → 重启生效 → 重新登录 → 与导出前快照比对。
import_and_compare() {
  # import_and_compare <备份文件> <标签> <期望 pending 字节> <db> <端口> <日志前缀>
  local file=$1 label=$2 want_bytes=$3 db=$4 port=$5 prefix=$6
  local code restart pending start end secs snap after sub_after
  BASE="http://127.0.0.1:${port}"
  PHASE="导入备份（${label}）"
  log "调用 POST /api/v1/backup/restore（上传 $(wc -c <"$file" | tr -d ' ') B，${label}）"
  code=$(request POST "$BASE/api/v1/backup/restore" "$file" "application/octet-stream")
  expect_json "$code" 200 "导入${label}失败"
  restart=$(jget '["restart_required"]')
  pending=$(jget '["pending"]["bytes"]')
  [ "$restart" = "True" ] || die "${label}：导入响应没有要求重启（restart_required=${restart}）"
  if [ "$want_bytes" != "any" ]; then
    [ "$pending" = "$want_bytes" ] \
      || die "${label}：待恢复文件大小与预期不一致：pending=${pending}，预期=${want_bytes}"
  fi
  [ "$pending" -gt 0 ] || die "${label}：pending 字节数为 0"
  [ $((pending % 4096)) -eq 0 ] \
    || die "${label}：pending 字节数不是 SQLite 页大小的整数倍（${pending}）"
  expect_json "$(request GET "$BASE/api/v1/backup/info")" 200 "读取待恢复状态"
  python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));sys.exit(0 if d.get("pending") else 1)' "$WORK/resp.json" \
    || die "${label}：导入成功后 /backup/info 没有 pending"
  ok "${label}导入成功：restart_required=true，pending=${pending} B"

  PHASE="重启恢复（${label}）"
  log "重启主控，让待恢复文件生效（${label}）"
  stop_master
  start=$(now_ms)
  start_master "$db" "$port" "$WORK/${prefix}-2.log"
  end=$(now_ms)
  secs=$(awk -v a="$start" -v b="$end" 'BEGIN { printf "%.1f", b - a }')
  grep -q "已应用待恢复的数据库备份" "$WORK/${prefix}-2.log" \
    || die "${label}：启动日志里没有「已应用待恢复的数据库备份」，恢复可能没有生效"
  grep -q "pre-restore" "$WORK/${prefix}-2.log" \
    || die "${label}：启动日志里没有 pre-restore 回滚副本的记录"
  ok "${label}：恢复已生效（启动到可用 ${secs}s；旧库保留为 pre-restore 文件）"

  # 恢复后会话表也被替换，必须重新登录（这本身就是数据回来了的证据）。
  login
  SESSION=$(awk '$6 == "pierwave_session" { print $7 }' "$WORK/cookie.txt" | tail -1)
  after="$WORK/facts/after-${prefix}.json"
  sub_after="$WORK/facts/sub-after-${prefix}.yaml"
  snap=$(snapshot "$after" "$sub_after")
  compare_snapshot "$label" "$after" "$sub_after" "$SUB_HASH_BEFORE"
}

# ---- 导出（真实 HTTP）----
PHASE="导出加密备份"
log "确认 backup_encrypt 默认开启"
expect_json "$(request GET "$BASE/api/v1/settings")" 200 "读取设置"
python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));sys.exit(0 if d["items"]["backup_encrypt"] is True else 1)' "$WORK/resp.json" \
  || die "backup_encrypt 默认不是 true"
ok "backup_encrypt 默认开启"

expect_json "$(request GET "$BASE/api/v1/backup/info")" 200 "读取备份信息"
INFO_DB_BYTES=$(jget '["db_bytes"]')
export_backup "$WORK/backup-enc.pwsb" "$WORK/export-enc.headers" "加密（默认）"
grep -qi '^content-type: application/octet-stream' "$WORK/export-enc.headers" \
  || die "加密导出的 Content-Type 不是 application/octet-stream：$(grep -i '^content-type' "$WORK/export-enc.headers" || true)"
grep -qi 'content-disposition: attachment; filename="pierwave-backup-.*\.db\.gz\.enc"' "$WORK/export-enc.headers" \
  || die "加密导出的 Content-Disposition 不是 .db.gz.enc：$(grep -i '^content-disposition' "$WORK/export-enc.headers" || true)"
assert_pwsb_backup "$WORK/backup-enc.pwsb" "加密导出"
ENC_FILE_BYTES=$(wc -c <"$WORK/backup-enc.pwsb" | tr -d ' ')
ok "加密导出：${ENC_FILE_BYTES} B（PWSB + AES-256-GCM；/backup/info db_bytes=${INFO_DB_BYTES}）"

# 篡改一个字节（GCM tag）：恢复必须明确拒绝，而不是把损坏文件当备份落盘。
python3 - "$WORK/backup-enc.pwsb" "$WORK/backup-enc-tampered.bin" <<'PY'
import sys
data = bytearray(open(sys.argv[1], "rb").read())
data[-1] ^= 0x01
open(sys.argv[2], "wb").write(data)
PY

# ---- 关闭 backup_encrypt，导出明文 .db.gz ----
PHASE="关闭备份加密并导出明文"
printf '{"backup_encrypt":false}' >"$WORK/req.json"
expect_json "$(request PATCH "$BASE/api/v1/settings" "$WORK/req.json")" 200 "关闭 backup_encrypt"
python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));sys.exit(0 if d["items"]["backup_encrypt"] is False else 1)' "$WORK/resp.json" \
  || die "PATCH backup_encrypt=false 后接口仍返回 true"
ok "已通过 API 关闭 backup_encrypt"

export_backup "$WORK/backup-plain.db.gz" "$WORK/export-plain.headers" "明文（backup_encrypt=0）"
grep -qi '^content-type: application/gzip' "$WORK/export-plain.headers" \
  || die "明文导出的 Content-Type 不是 application/gzip：$(grep -i '^content-type' "$WORK/export-plain.headers" || true)"
grep -qi 'content-disposition: attachment; filename="pierwave-backup-.*\.db\.gz"' "$WORK/export-plain.headers" \
  || die "明文导出的 Content-Disposition 不是 .db.gz：$(grep -i '^content-disposition' "$WORK/export-plain.headers" || true)"
PLAIN_RAW_BYTES=$(assert_gzip_sqlite_backup "$WORK/backup-plain.db.gz" "$WORK/backup-plain.db" "明文导出")
# 注意：不能用 /backup/info 的 db_bytes 断言解压后大小——VACUUM INTO 会压缩空闲页，
# 而 db_bytes 是 page_count × page_size，两者可能差一页；恢复端 pending 用的是实际解压大小。
ok "明文导出：gz $(wc -c <"$WORK/backup-plain.db.gz" | tr -d ' ') B → ${PLAIN_RAW_BYTES} B SQLite"

stop_master
ok "导出端主控已停止（库文件保持原样：${DB_A}）"

# ------------------------------------------------------------------ 2. 加密备份恢复
PORT_B=$(pick_port 8861)
BASE="http://127.0.0.1:${PORT_B}"
DB_B="$WORK/db-target-enc/pierwave.db"
log "阶段 2/3：加密备份 → 全新空库恢复（端口 ${PORT_B}）"
start_master "$DB_B" "$PORT_B" "$WORK/master-enc-1.log"
login
SESSION=$(awk '$6 == "pierwave_session" { print $7 }' "$WORK/cookie.txt" | tail -1)
assert_empty_db "加密备份"

# ---- 坏文件 / 篡改文件都应被拒绝，且不留下 pending ----
PHASE="加密备份的拒绝路径"
printf 'this is definitely not a sqlite database' >"$WORK/broken.bin"
BAD_CODE=$(request POST "$BASE/api/v1/backup/restore" "$WORK/broken.bin" "application/octet-stream")
[ "$BAD_CODE" = "400" ] || die "坏备份应该被拒绝（HTTP 400），实际 ${BAD_CODE}"
BAD_MSG=$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d.get("code",""),"|",d.get("error",""))' "$WORK/resp.json")
case "$BAD_MSG" in
  *backup.restore_bad_header*) ok "坏备份被拒绝且原因可读：${BAD_MSG}" ;;
  *) die "坏备份被拒绝了，但错误码不是 backup.restore_bad_header：${BAD_MSG}" ;;
esac

TAMPER_CODE=$(request POST "$BASE/api/v1/backup/restore" "$WORK/backup-enc-tampered.bin" "application/octet-stream")
[ "$TAMPER_CODE" = "400" ] || die "被篡改的加密备份应该被拒绝（HTTP 400），实际 ${TAMPER_CODE}"
TAMPER_MSG=$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d.get("code",""),"|",d.get("error",""))' "$WORK/resp.json")
case "$TAMPER_MSG" in
  *backup.restore_decrypt_failed*) ok "篡改的加密备份被拒绝且原因可读：${TAMPER_MSG}" ;;
  *) die "篡改的加密备份被拒绝了，但错误码不是 backup.restore_decrypt_failed：${TAMPER_MSG}" ;;
esac

expect_json "$(request GET "$BASE/api/v1/backup/info")" 200 "读取待恢复状态"
python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));sys.exit(0 if d.get("pending") is None else 1)' "$WORK/resp.json" \
  || die "被拒绝的上传不应留下 pending 文件"

import_and_compare "$WORK/backup-enc.pwsb" "加密备份" "any" "$DB_B" "$PORT_B" "enc"
stop_master

# ------------------------------------------------------------------ 3. 明文备份恢复
PORT_C=$(pick_port 8871)
BASE="http://127.0.0.1:${PORT_C}"
DB_C="$WORK/db-target-plain/pierwave.db"
log "阶段 3/3：明文 .db.gz → 全新空库恢复（端口 ${PORT_C}）"
start_master "$DB_C" "$PORT_C" "$WORK/master-plain-1.log"
login
SESSION=$(awk '$6 == "pierwave_session" { print $7 }' "$WORK/cookie.txt" | tail -1)
assert_empty_db "明文备份"

import_and_compare "$WORK/backup-plain.db.gz" "明文备份" "$PLAIN_RAW_BYTES" "$DB_C" "$PORT_C" "plain"
stop_master

echo
printf '\033[32mPASS\033[0m 备份恢复实测通过（加密 + 明文两条路径；临时目录：%s）\n' "$WORK"
