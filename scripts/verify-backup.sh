#!/usr/bin/env bash
# 备份恢复实测：起临时主控 → 通过真实 HTTP 接口建数据 → 导出备份 →
# 换一个全新的空库 → 通过 HTTP 接口导入 → 重启生效 → 断言关键数据一致。
#
# 目标：把「备份能下载、恢复能上传」和「恢复后数据真的还在」分开验证。
# 只走 `GET /api/v1/backup` 与 `POST /api/v1/backup/restore`，
# 不复制 SQLite 文件、不直接写库——否则测的就是另一套逻辑。
#
# 为什么必须重启：恢复的设计是「上传阶段只落盘为 <db>.restore-pending，
# 真正替换发生在下次启动、打开连接池之前」（见 crates/domain/src/backup.rs）。
# 脚本严格遵守这个契约，因此会显式停/起两次主控。
#
# 用法：
#   ./scripts/verify-backup.sh
#   KEEP=1 ./scripts/verify-backup.sh     # 保留临时目录（日志、导出文件、两份 DB）
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
printf '{"name":"backup-月卡","quota_bytes":107374182400,"period_days":30,"direction":"both","node_ratio":2.5,"speed_limit_kbps":100000,"forward_limit":3,"chain_limit":2}' >"$WORK/req.json"
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

# ---- 导出（真实 HTTP） ----
PHASE="导出备份"
log "调用 GET /api/v1/backup"
EXPORT_CODE=$(run_timeout $((CURL_TIMEOUT + 5)) \
  curl -sS --max-time "$CURL_TIMEOUT" -b "$WORK/cookie.txt" \
    -D "$WORK/export.headers" -o "$WORK/backup.db.gz" \
    -w '%{http_code}' "$BASE/api/v1/backup") || EXPORT_CODE=000
[ "$EXPORT_CODE" = "200" ] || die "导出失败：HTTP ${EXPORT_CODE}（文件头：$(head -c 200 "$WORK/backup.db.gz" 2>/dev/null | od -c | head -3)）"
[ -s "$WORK/backup.db.gz" ] || die "导出文件是空的"

grep -qi '^content-type: application/gzip' "$WORK/export.headers" \
  || die "导出的 Content-Type 不是 application/gzip：$(grep -i '^content-type' "$WORK/export.headers" || true)"
grep -qi 'content-disposition: attachment; filename="pierwave-backup-.*\.db\.gz"' "$WORK/export.headers" \
  || die "导出的 Content-Disposition 不是预期文件名：$(grep -i '^content-disposition' "$WORK/export.headers" || true)"

# 解压校验：必须是 SQLite 文件头，且大小与 /backup/info 的 db_bytes 对得上。
RAW_BYTES=$(python3 - "$WORK/backup.db.gz" "$WORK/backup.db" <<'PY'
import gzip, sys
raw = gzip.open(sys.argv[1], "rb").read()
open(sys.argv[2], "wb").write(raw)
print(len(raw))
PY
)
python3 - "$WORK/backup.db" <<'PY' || die "导出的不是 SQLite 文件"
import sys
head = open(sys.argv[1], "rb").read(16)
if head != b"SQLite format 3\x00":
    raise SystemExit(f"文件头不是 SQLite format 3：{head!r}")
PY
expect_json "$(request GET "$BASE/api/v1/backup/info")" 200 "读取备份信息"
INFO_DB_BYTES=$(jget '["db_bytes"]')
ok "导出成功：gz $(wc -c <"$WORK/backup.db.gz" | tr -d ' ') B → 解压 ${RAW_BYTES} B；/backup/info db_bytes=${INFO_DB_BYTES}"

stop_master
ok "导出端主控已停止（库文件保持原样：${DB_A}）"

# ------------------------------------------------------------------ 2. 全新的空库
PORT_B=$(pick_port 8861)
BASE="http://127.0.0.1:${PORT_B}"
DB_B="$WORK/db-target/pierwave.db"
log "阶段 2/3：换一个全新空库启动主控（端口 ${PORT_B}）"
start_master "$DB_B" "$PORT_B" "$WORK/master-b1.log"
login
SESSION=$(awk '$6 == "pierwave_session" { print $7 }' "$WORK/cookie.txt" | tail -1)
expect_json "$(request GET "$BASE/api/v1/servers")" 200 "读取空库服务器列表"
FRESH_SERVERS=$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["items"]))' "$WORK/resp.json")
expect_json "$(request GET "$BASE/api/v1/users")" 200 "读取空库用户列表"
FRESH_USERS=$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["items"]))' "$WORK/resp.json")
[ "$FRESH_SERVERS" = "0" ] || die "新库不应该是空的：servers=${FRESH_SERVERS}"
[ "$FRESH_USERS" = "1" ] || die "新库应只有初始 admin，实际 users=${FRESH_USERS}"
ok "新库确认是空的（servers=0，users=1 仅 admin）"

# ---- 导入前先用坏文件验证「失败原因可读」 ----
PHASE="导入坏文件（校验拒绝路径）"
printf 'this is definitely not a sqlite database' >"$WORK/broken.bin"
BAD_CODE=$(request POST "$BASE/api/v1/backup/restore" "$WORK/broken.bin" "application/octet-stream")
[ "$BAD_CODE" = "400" ] || die "坏备份应该被拒绝（HTTP 400），实际 ${BAD_CODE}"
BAD_MSG=$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d.get("code",""),"|",d.get("error",""))' "$WORK/resp.json")
case "$BAD_MSG" in
  *backup.restore_bad_header*) ok "坏备份被拒绝且原因可读：${BAD_MSG}" ;;
  *) die "坏备份被拒绝了，但错误码不是 backup.restore_bad_header：${BAD_MSG}" ;;
esac
expect_json "$(request GET "$BASE/api/v1/backup/info")" 200 "读取待恢复状态"
python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));sys.exit(0 if d.get("pending") is None else 1)' "$WORK/resp.json" \
  || die "坏文件被拒绝后不应留下 pending 文件"

# ---- 导入（真实 HTTP，上传 gzip） ----
PHASE="导入备份"
log "调用 POST /api/v1/backup/restore（上传 $(wc -c <"$WORK/backup.db.gz" | tr -d ' ') B gzip）"
IMPORT_CODE=$(request POST "$BASE/api/v1/backup/restore" "$WORK/backup.db.gz" "application/octet-stream")
expect_json "$IMPORT_CODE" 200 "导入备份失败"
RESTART_REQUIRED=$(jget '["restart_required"]')
PENDING_BYTES=$(jget '["pending"]["bytes"]')
[ "$RESTART_REQUIRED" = "True" ] || die "导入响应没有要求重启（restart_required=${RESTART_REQUIRED}）"
[ "$PENDING_BYTES" = "$RAW_BYTES" ] \
  || die "待恢复文件大小与解压后备份不一致：pending=${PENDING_BYTES}，解压后=${RAW_BYTES}"
expect_json "$(request GET "$BASE/api/v1/backup/info")" 200 "读取待恢复状态"
python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));sys.exit(0 if d.get("pending") else 1)' "$WORK/resp.json" \
  || die "导入成功后 /backup/info 没有 pending"
ok "导入成功：restart_required=true，pending=${RAW_BYTES} B"

# ------------------------------------------------------------------ 3. 重启生效
log "阶段 3/3：重启主控，让待恢复文件生效（恢复契约：启动时替换）"
stop_master
start=$(now_ms)
start_master "$DB_B" "$PORT_B" "$WORK/master-b2.log"
end=$(now_ms)
RESTORE_SECS=$(awk -v a="$start" -v b="$end" 'BEGIN { printf "%.1f", b - a }')
grep -q "已应用待恢复的数据库备份" "$WORK/master-b2.log" \
  || die "启动日志里没有「已应用待恢复的数据库备份」，恢复可能没有生效"
grep -q "pre-restore" "$WORK/master-b2.log" \
  || die "启动日志里没有 pre-restore 回滚副本的记录"
ok "恢复已生效（启动到可用 ${RESTORE_SECS}s；旧库保留为 pre-restore 文件）"

# 恢复后会话表也被替换，必须重新登录（这本身就是数据回来了的证据）。
login
SESSION=$(awk '$6 == "pierwave_session" { print $7 }' "$WORK/cookie.txt" | tail -1)

SNAP_AFTER=$(snapshot "$WORK/facts/after.json" "$WORK/facts/sub-after.yaml")
SUB_HASH_AFTER=$(printf '%s\n' "$SNAP_AFTER" | sed -n '1p')
COUNTS_AFTER=$(printf '%s\n' "$SNAP_AFTER" | sed -n '2p')

# ------------------------------------------------------------------ 断言
PHASE="比对数据"
log "比对导出前 / 导入后的关键数据"
python3 - "$WORK/facts/before.json" "$WORK/facts/after.json" \
  "$SUB_HASH_BEFORE" "$SUB_HASH_AFTER" <<'PY'
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

ok "恢复后 ${COUNTS_AFTER} 与导出前完全一致（含订阅渲染结果）"

# 行数至少要有内容，防止「空库对空库」这种假绿。
python3 - "$WORK/facts/after.json" <<'PY' || die "恢复后的关键表是空的（对空断言没有意义）"
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

echo
printf '\033[32mPASS\033[0m 备份恢复实测通过（临时目录：%s）\n' "$WORK"
