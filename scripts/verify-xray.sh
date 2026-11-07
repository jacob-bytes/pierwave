#!/usr/bin/env bash
# 真机验证：用真实 Xray 跑一遍「服务端 + 客户端 + 实际握手」，
# 确认我们生成的配置不是「能过测试、但真机上跑不通」。
#
# 设计原则：
#   1. 不修改系统 —— 所有文件都在 mktemp 目录里，退出时无论成功失败都清干净；
#   2. 不占用常用端口 —— 随机挑空闲高位端口，只监听 127.0.0.1；
#   3. 不留后台进程 —— trap 里统一 kill。
#
# 用法：
#   sudo ./scripts/verify-xray.sh                    # 自动下载或使用系统 xray
#   ./scripts/verify-xray.sh --xray-bin /usr/bin/xray  # 指定已有的 xray
#   ./scripts/verify-xray.sh --test-only cfg.json    # 只校验一份已有配置
set -euo pipefail

WORK=""
SERVER_PID=""
CLIENT_PID=""
DOWNLOADED_XRAY=0
FAILED=0

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILED=1; }

cleanup() {
  local code=$?
  [ -n "$CLIENT_PID" ] && kill "$CLIENT_PID" 2>/dev/null || true
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  if [ -n "$WORK" ] && [ -d "$WORK" ]; then
    rm -rf "$WORK"
  fi
  if [ "$DOWNLOADED_XRAY" = "1" ]; then
    log "已删除临时下载的 Xray 二进制（系统原本没有安装 Xray）"
  fi
  log "清理完成：未修改系统文件、未留下进程、未改动端口配置"
  exit $code
}
trap cleanup EXIT INT TERM

# ---------- 参数 ----------
TEST_ONLY=""
XRAY_BIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --test-only) TEST_ONLY="${2:-}"; shift 2 ;;
    --xray-bin) XRAY_BIN="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/pierwave-verify.XXXXXX")"
log "工作目录：${WORK}（退出时删除）"

# ---------- 找一个可用的本地 Xray ----------
find_xray() {
  if [ -n "$XRAY_BIN" ]; then
    if [ ! -x "$XRAY_BIN" ]; then bad "指定的 xray 不可执行：$XRAY_BIN"; return 1; fi
    XRAY="$XRAY_BIN"
    ok "使用指定的 Xray：$XRAY（$("$XRAY" version 2>/dev/null | head -1)）"
    return 0
  fi
  if command -v xray >/dev/null 2>&1; then
    XRAY="$(command -v xray)"
    ok "使用系统已安装的 Xray：${XRAY}（$("$XRAY" version 2>/dev/null | head -1)）"
    return 0
  fi

  local os arch asset
  os="$(uname -s)"; arch="$(uname -m)"
  case "$os/$arch" in
    Linux/x86_64)   asset="Xray-linux-64.zip" ;;
    Linux/aarch64|Linux/arm64) asset="Xray-linux-arm64-v8a.zip" ;;
    Darwin/arm64)   asset="Xray-macos-arm64-v8a.zip" ;;
    Darwin/x86_64)  asset="Xray-macos-64.zip" ;;
    *) bad "不支持的平台：$os/$arch"; return 1 ;;
  esac

  log "系统没有 Xray，临时下载 ${asset}（退出时删除）"
  local url="https://github.com/XTLS/Xray-core/releases/latest/download/$asset"
  log "下载：$url"
  if ! curl -fsSL --retry 2 --connect-timeout 15 --max-time 300 "$url" -o "$WORK/xray.zip"; then
    bad "下载失败。若这台机器无法访问 GitHub，请先手动安装 Xray 或用 --xray-bin 指定路径"
    return 1
  fi
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "$WORK/xray.zip" -d "$WORK/xray-dist"
  else
    python3 -c "import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" \
      "$WORK/xray.zip" "$WORK/xray-dist"
  fi
  XRAY="$WORK/xray-dist/xray"
  chmod +x "$XRAY"
  DOWNLOADED_XRAY=1
  ok "已下载：$("$XRAY" version 2>/dev/null | head -1)"
}

port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
pick_port() {
  local p
  for _ in $(seq 1 50); do
    p=$(( (RANDOM % 20000) + 30000 ))
    if port_free "$p"; then echo "$p"; return 0; fi
  done
  return 1
}

wait_listen() {
  local port=$1 tries=${2:-60}
  for _ in $(seq 1 "$tries"); do
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then return 0; fi
    sleep 0.2
  done
  return 1
}

# 基本依赖：只需要 bash 与 curl；unzip 缺失时会退回 python3
for tool in bash curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "缺少依赖：$tool" >&2; exit 2; }
done
if ! command -v unzip >/dev/null 2>&1 && ! command -v python3 >/dev/null 2>&1; then
  echo "缺少 unzip（且没有 python3 兜底），无法解压下载的 Xray" >&2
  exit 2
fi

find_xray

# ---------- 只校验一份已有配置 ----------
if [ -n "$TEST_ONLY" ]; then
  log "校验配置：$TEST_ONLY"
  if "$XRAY" run -test -c "$TEST_ONLY" >"$WORK/test.log" 2>&1; then
    ok "xray -test 通过"
  else
    bad "xray -test 失败"; sed -n '1,20p' "$WORK/test.log"
  fi
  exit "$FAILED"
fi

# ---------- 生成密钥对（同时校验我们的反推逻辑） ----------
log "生成 REALITY 密钥对"
KEYS="$("$XRAY" x25519)"
PRIV="$(printf '%s\n' "$KEYS" | awk -F': *' '/[Pp]rivate/{print $2}' | tr -d '[:space:]')"
PUB="$(printf '%s\n' "$KEYS" | awk -F': *' '/[Pp]ublic/{print $2}' | tr -d '[:space:]')"
if [ -z "$PRIV" ] || [ -z "$PUB" ]; then bad "无法解析 x25519 输出"; exit 1; fi
ok "私钥/公钥已生成"

BIN="$(cd "$(dirname "$0")/.." && pwd)/target/release/pierwave-master"
[ -x "$BIN" ] || BIN="$(cd "$(dirname "$0")/.." && pwd)/target/debug/pierwave-master"
if [ -x "$BIN" ]; then
  DERIVED="$("$BIN" --derive-reality-key "$PRIV")"
  if [ "$DERIVED" = "$PUB" ]; then
    ok "PierWave 的 publicKey 反推与 Xray 一致"
  else
    bad "publicKey 反推不一致：pierwave=$DERIVED xray=$PUB"
  fi
else
  bad "找不到 pierwave-master（先跑 make build），跳过反推校验"
fi

UUID="$(python3 -c 'import uuid;print(uuid.uuid4())' 2>/dev/null \
     || tr -dc 'a-f0-9' </dev/urandom | head -c 32 | \
        sed -E 's/(.{8})(.{4})(.{4})(.{4})(.{12})/\1-\2-\3-\4-\5/' \
     || echo "11111111-1111-4111-8111-111111111111")"
SID="$(python3 -c 'import os;print(os.urandom(8).hex())' 2>/dev/null \
     || od -An -tx1 -N8 /dev/urandom | tr -d ' \n')"
PORT_SERVER="$(pick_port)" || { bad "找不到空闲端口"; exit 1; }
PORT_SOCKS="$(pick_port)"  || { bad "找不到空闲端口"; exit 1; }
PORT_API="$(pick_port)"    || { bad "找不到空闲端口"; exit 1; }
log "端口：inbound=$PORT_SERVER socks=$PORT_SOCKS api=${PORT_API}（仅 127.0.0.1）"

# ---------- 服务端配置（字段名与 build_config 的输出保持一致） ----------
cat > "$WORK/server.json" <<JSON
{
  "log": {"loglevel": "warning"},
  "stats": {},
  "policy": {"system": {"statsInboundUplink": true, "statsInboundDownlink": true,
                        "statsUserUplink": true, "statsUserDownlink": true}},
  "api": {"tag": "api", "services": ["StatsService"]},
  "inbounds": [
    {
      "tag": "verify-vless",
      "port": $PORT_SERVER,
      "listen": "127.0.0.1",
      "protocol": "vless",
      "settings": {"clients": [{"id": "$UUID", "flow": "xtls-rprx-vision", "email": "verify@pierwave"}], "decryption": "none"},
      "streamSettings": {
        "network": "tcp",
        "security": "reality",
        "realitySettings": {
          "dest": "www.microsoft.com:443",
          "serverNames": ["www.microsoft.com"],
          "privateKey": "$PRIV",
          "shortIds": ["$SID"]
        }
      }
    },
    {
      "tag": "api",
      "port": $PORT_API,
      "listen": "127.0.0.1",
      "protocol": "dokodemo-door",
      "settings": {"address": "127.0.0.1"}
    }
  ],
  "outbounds": [
    {"tag": "direct", "protocol": "freedom", "settings": {}},
    {"tag": "blocked", "protocol": "blackhole", "settings": {}}
  ],
  "routing": {"domainStrategy": "AsIs",
              "rules": [{"type": "field", "inboundTag": ["api"], "outboundTag": "api"}]}
}
JSON

log "服务端配置 xray -test"
if "$XRAY" run -test -c "$WORK/server.json" >"$WORK/test-server.log" 2>&1; then
  ok "xray -test 通过（streamSettings / realitySettings / stats 字段都被接受）"
else
  bad "xray -test 失败"; sed -n '1,20p' "$WORK/test-server.log"; exit 1
fi

log "启动服务端"
"$XRAY" run -c "$WORK/server.json" >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
if wait_listen "$PORT_SERVER"; then ok "服务端已监听 127.0.0.1:$PORT_SERVER"; else bad "服务端没起来"; sed -n '1,20p' "$WORK/server.log"; exit 1; fi

# ---------- 客户端配置：socks 入站 → vless REALITY 出站 ----------
cat > "$WORK/client.json" <<JSON
{
  "log": {"loglevel": "warning"},
  "inbounds": [{"tag": "socks-in", "port": $PORT_SOCKS, "listen": "127.0.0.1",
                "protocol": "socks", "settings": {"udp": false}}],
  "outbounds": [{
    "tag": "proxy",
    "protocol": "vless",
    "settings": {"vnext": [{"address": "127.0.0.1", "port": $PORT_SERVER,
                            "users": [{"id": "$UUID", "encryption": "none", "flow": "xtls-rprx-vision"}]}]},
    "streamSettings": {"network": "tcp", "security": "reality",
                       "realitySettings": {"serverName": "www.microsoft.com",
                                           "publicKey": "$PUB", "shortId": "$SID",
                                           "fingerprint": "chrome"}}
  }]
}
JSON

log "启动客户端"
"$XRAY" run -c "$WORK/client.json" >"$WORK/client.log" 2>&1 &
CLIENT_PID=$!
if wait_listen "$PORT_SOCKS"; then ok "客户端 socks 已监听 127.0.0.1:$PORT_SOCKS"; else bad "客户端没起来"; sed -n '1,20p' "$WORK/client.log"; exit 1; fi

# ---------- 真握手 ----------
TARGETS="https://www.gstatic.com/generate_204 https://cp.cloudflare.com/generate_204"
PROXIED=0
for target in $TARGETS; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 \
      --socks5-hostname "127.0.0.1:$PORT_SOCKS" "$target" 2>/dev/null || true)"
  if [ "$code" = "204" ] || [ "$code" = "200" ]; then
    ok "通过节点访问 $target → HTTP $code"
    PROXIED=1
    break
  fi
done
[ "$PROXIED" = "1" ] || bad "通过节点访问外网失败（可能这台机器本身没有外网）"

# ---------- 统计计数器 ----------
sleep 1
log "查询 Xray StatsService"
STATS="$("$XRAY" api statsquery --server="127.0.0.1:$PORT_API" -pattern "user>>>" 2>"$WORK/api.log" || true)"
if printf '%s' "$STATS" | grep -q 'traffic>>>uplink'; then
  ok "user 维度计数器已产生（stats / policy / email 配置有效）"
  printf '%s\n' "$STATS" | sed -n '1,12p'
else
  bad "没有看到 user 计数器"; sed -n '1,15p' "$WORK/api.log"
fi

echo
if [ "$FAILED" = "0" ]; then
  printf '\033[32mPASS\033[0m 真实 Xray 全链路验证通过\n'
else
  printf '\033[31mFAIL\033[0m 有检查项未通过，详见上面的输出\n'
fi
exit "$FAILED"
