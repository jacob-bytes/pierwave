#!/usr/bin/env bash
# 端到端冒烟：起主控 → 登录 → 建服务器/节点 → apply → 起 Agent → 收到期望态并落盘
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
PORT=${PORT:-8791}
WORK=${WORK:-/tmp/mmrust-e2e}
BASE="http://127.0.0.1:$PORT"

rm -rf "$WORK"; mkdir -p "$WORK"
CARGO_HOME=$ROOT/.cargo-home cargo build -q -p mmrust-master -p mmrust-agent

MMRUST_ADDR="127.0.0.1:$PORT" MMRUST_DB="sqlite://$WORK/db.sqlite?mode=rwc" \
MMRUST_ADMIN_PASSWORD=devpass ./target/debug/mmrust-master > "$WORK/master.log" 2>&1 &
MASTER_PID=$!
AGENT_PID=""
cleanup() { kill $MASTER_PID ${AGENT_PID:-} 2>/dev/null || true; wait 2>/dev/null || true; }
trap cleanup EXIT

for _ in $(seq 1 60); do curl -sf "$BASE/api/v1/health" >/dev/null 2>&1 && break; sleep 0.2; done
curl -sf "$BASE/api/v1/health" >/dev/null || { echo "FAIL: master 未启动"; tail -20 "$WORK/master.log"; exit 1; }

json() { python3 -c 'import sys,json; d=json.load(sys.stdin);
import functools,sys as s
print(eval(sys.argv[1]))' "$1"; }

curl -sf -c "$WORK/cookie" -X POST "$BASE/api/v1/auth/login" \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"devpass"}' >/dev/null
echo "ok 登录"

TOKEN=$(curl -sf -b "$WORK/cookie" -X POST "$BASE/api/v1/servers" -H 'Content-Type: application/json' \
  -d '{"name":"e2e-1","address":"10.0.0.1"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
SERVER_ID=$(curl -sf -b "$WORK/cookie" "$BASE/api/v1/servers" | python3 -c 'import sys,json;print(json.load(sys.stdin)["items"][0]["id"])')
echo "ok 建服务器 ${SERVER_ID}"

add_node() {
  curl -sf -b "$WORK/cookie" -X POST "$BASE/api/v1/servers/$SERVER_ID/nodes" \
    -H 'Content-Type: application/json' -d "$1" >/dev/null
}

add_node '{"name":"vless-reality","protocol":"vless","transport":"tcp","security":"reality","port":443,
  "config":{"settings":{"clients":[{"id":"11111111-1111-1111-1111-111111111111","flow":"xtls-rprx-vision"}],"decryption":"none"},
            "stream":{"network":"tcp","security":"reality","realitySettings":{"dest":"www.microsoft.com:443","serverNames":["www.microsoft.com"],"privateKey":"KEY","shortIds":["0123456789abcdef"]}}}}'
add_node '{"name":"trojan-ws","protocol":"trojan","transport":"ws","security":"tls","port":8443,
  "config":{"settings":{"clients":[{"password":"pw"}]},"stream":{"network":"ws","security":"tls","wsSettings":{"path":"/ws"}}}}'
echo "ok 建 2 个节点"

V=$(curl -sf -b "$WORK/cookie" -X POST "$BASE/api/v1/servers/$SERVER_ID/apply" | python3 -c 'import sys,json;print(json.load(sys.stdin)["config_version"])')
[ "$V" = "1" ] || { echo "FAIL: apply 后版本应为 1，实际 $V"; exit 1; }
echo "ok apply 版本=${V}（此时 Agent 离线，广播丢弃）"

cat > "$WORK/agent.toml" <<TOML
mode = "remote"
master_url = "$BASE"
token = "$TOKEN"
connection_mode = "websocket"
xray_mode = "external"
xray_config_path = "$WORK/xray/config.json"
xray_test_command = "true"
restart_command = "true"
TOML
./target/debug/mmrust-agent -c "$WORK/agent.toml" > "$WORK/agent.log" 2>&1 &
AGENT_PID=$!

for _ in $(seq 1 60); do [ -f "$WORK/xray/config.json" ] && break; sleep 0.2; done
[ -f "$WORK/xray/config.json" ] || { echo "FAIL: Agent 没有落盘 xray 配置"; tail -20 "$WORK/agent.log"; exit 1; }
[ ! -f "$WORK/xray/config.json.new" ] || { echo "FAIL: 校验后残留了 .new 临时文件"; exit 1; }
echo "ok Agent 重连后补发了期望态并落盘"

python3 - "$WORK/xray/config.json" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
tags = [i["tag"] for i in cfg["inbounds"]]
assert len(cfg["inbounds"]) == 2, f"inbounds={len(cfg['inbounds'])}"
assert cfg["inbounds"][0]["port"] == 443 and cfg["inbounds"][0]["protocol"] == "vless"
assert cfg["inbounds"][1]["protocol"] == "trojan"
assert any(o["protocol"] == "freedom" for o in cfg["outbounds"])
assert len(set(tags)) == 2 and all(tags), tags
assert tags[0].startswith("vless") and tags[1].startswith("trojan"), tags
print("ok 配置结构正确:", tags)
PY

grep -q "resynced desired state" "$WORK/master.log" || { echo "FAIL: 主控没有补发日志"; exit 1; }
grep -q "agent applied desired state" "$WORK/master.log" || { echo "FAIL: 主控没收到 ApplyResult"; exit 1; }
echo "ok 主控日志确认补发 + 应用成功"

# 在线改配置：第 3 个节点 → apply → Agent 收到新版本并重建配置
add_node '{"name":"ss","protocol":"shadowsocks","transport":"tcp","security":"none","port":9000,
  "config":{"settings":{"method":"aes-256-gcm","password":"pw"}}}'
V2=$(curl -sf -b "$WORK/cookie" -X POST "$BASE/api/v1/servers/$SERVER_ID/apply" | python3 -c 'import sys,json;print(json.load(sys.stdin)["config_version"])')
sleep 1
python3 - "$WORK/xray/config.json" "$V2" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
assert len(cfg["inbounds"]) == 3, f"期望 3 个入站，实际 {len(cfg['inbounds'])}"
print("ok 在线热更新到版本", sys.argv[2])
PY

[ ! -f "$WORK/xray/config.json.new" ] || { echo "FAIL: 热更新后残留了 .new 临时文件"; exit 1; }
python3 - "$WORK/xray/config.json.bak" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
assert len(cfg["inbounds"]) == 2, f"备份应为上一版 2 个入站，实际 {len(cfg['inbounds'])}"
print("ok 热更新前已备份上一版配置")
PY

echo "PASS 全部通过（日志：$WORK/master.log, $WORK/agent.log）"
