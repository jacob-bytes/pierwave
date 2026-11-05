#!/usr/bin/env bash
# 端到端冒烟：主控 → 登录 → 建服务器/节点/用户/套餐 → apply → Agent 收敛 → 订阅闭环
# 最后一条断言是本项目的核心不变量：订阅里发给用户的凭据，必须能在服务器 inbound 里找到同一条。
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

jget() { python3 -c 'import sys,json;print(json.load(sys.stdin)'"$1"')'; }

curl -sf -c "$WORK/cookie" -X POST "$BASE/api/v1/auth/login" \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"devpass"}' >/dev/null
echo "ok 登录"

TOKEN=$(curl -sf -b "$WORK/cookie" -X POST "$BASE/api/v1/servers" -H 'Content-Type: application/json' \
  -d '{"name":"e2e-1","address":"10.0.0.1"}' | jget '["token"]')
SERVER_ID=$(curl -sf -b "$WORK/cookie" "$BASE/api/v1/servers" | jget '["items"][0]["id"]')
echo "ok 建服务器"

# 节点 JSON 由 python 生成：REALITY 私钥必须是合法的 32 字节，否则订阅会跳过该节点
python3 - "$WORK" <<'PY'
import base64, json, os, sys
work = sys.argv[1]
priv = base64.b64encode(os.urandom(32)).decode()
json.dump({
    "name": "香港-REALITY", "protocol": "vless", "transport": "tcp", "security": "reality", "port": 443,
    "config": {
        "settings": {"clients": [], "decryption": "none"},
        "stream": {"network": "tcp", "security": "reality",
                   "realitySettings": {"dest": "www.microsoft.com:443",
                                       "serverNames": ["www.microsoft.com"],
                                       "privateKey": priv,
                                       "shortIds": ["0123456789abcdef"]}},
    },
}, open(f"{work}/node1.json", "w"))
json.dump({
    "name": "日本-WS-TLS", "protocol": "trojan", "transport": "ws", "security": "tls", "port": 8443,
    "config": {"settings": {"clients": [{"password": "manual-client"}]},
               "stream": {"network": "ws", "security": "tls", "wsSettings": {"path": "/ws"}}},
}, open(f"{work}/node2.json", "w"))
PY

for f in node1 node2; do
  curl -sf -b "$WORK/cookie" -X POST "$BASE/api/v1/servers/$SERVER_ID/nodes" \
    -H 'Content-Type: application/json' -d @"$WORK/$f.json" >/dev/null
done
echo "ok 建 2 个节点"

ALICE=$(curl -sf -b "$WORK/cookie" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"password123"}')
ALICE_ID=$(echo "$ALICE" | jget '["user"]["id"]')
ALICE_CODE=$(echo "$ALICE" | jget '["user"]["short_code"]')
PKG_ID=$(curl -sf -b "$WORK/cookie" -X POST "$BASE/api/v1/packages" -H 'Content-Type: application/json' \
  -d '{"name":"月卡","quota_bytes":107374182400,"period_days":30}' | jget '["package"]["id"]')
curl -sf -b "$WORK/cookie" -X POST "$BASE/api/v1/users/$ALICE_ID/packages" \
  -H 'Content-Type: application/json' -d "{\"package_id\":\"$PKG_ID\"}" >/dev/null
echo "ok alice 绑定套餐"

V=$(curl -sf -b "$WORK/cookie" -X POST "$BASE/api/v1/servers/$SERVER_ID/apply" | jget '["config_version"]')
[ "$V" = "1" ] || { echo "FAIL: apply 后版本应为 1，实际 $V"; exit 1; }
echo "ok apply v1（Agent 离线，广播丢弃）"

cat > "$WORK/agent.toml" <<TOML
mode = "remote"
master_url = "$BASE"
token = "$TOKEN"
connection_mode = "websocket"
xray_mode = "external"
xray_config_path = "$WORK/xray/config.json"
restart_command = "true"
xray_test_command = "true"
TOML
./target/debug/mmrust-agent -c "$WORK/agent.toml" > "$WORK/agent.log" 2>&1 &
AGENT_PID=$!

for _ in $(seq 1 60); do [ -f "$WORK/xray/config.json" ] && break; sleep 0.2; done
[ -f "$WORK/xray/config.json" ] || { echo "FAIL: Agent 没有落盘 xray 配置"; tail -20 "$WORK/agent.log"; exit 1; }
echo "ok Agent 重连后补发并落盘"

python3 - "$WORK/xray/config.json" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
tags = [i["tag"] for i in cfg["inbounds"]]
assert len(cfg["inbounds"]) == 2, f"inbounds={len(cfg['inbounds'])}"
assert cfg["inbounds"][0]["port"] == 443 and cfg["inbounds"][0]["protocol"] == "vless"
assert any(o["protocol"] == "freedom" for o in cfg["outbounds"])
print("ok 配置结构:", tags)
PY

echo "--- 闭环断言：订阅凭据 == 服务器 inbound 凭据 ---"
curl -sf "$BASE/api/v1/sub/$ALICE_CODE" -o "$WORK/sub.yaml"
python3 - "$WORK/sub.yaml" "$WORK/xray/config.json" <<'PY'
import json, sys, yaml

sub = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
cfg = json.load(open(sys.argv[2], encoding="utf-8"))

proxies = sub.get("proxies") or []
assert len(proxies) == 2, f"订阅应有 2 个节点，实际 {len(proxies)}"

clients = {c.get("id") or c.get("password"): c
           for i in cfg["inbounds"] for c in i["settings"].get("clients", [])}
for p in proxies:
    cred = p.get("uuid") or p.get("password")
    assert cred in clients, f"{p['name']} 的凭据不在服务器配置里：{cred}"
    assert "@" in clients[cred].get("email", ""), clients[cred]
print("ok 订阅凭据与服务器一致:", [p["name"] for p in proxies])

groups = {g["name"] for g in sub["proxy-groups"]}
assert {"PROXY", "AUTO"} <= groups, groups
print("ok 分组:", sorted(groups))
PY

grep -q "resynced desired state" "$WORK/master.log" || { echo "FAIL: 主控没有补发日志"; exit 1; }
grep -q "agent applied desired state" "$WORK/master.log" || { echo "FAIL: 主控没收到 ApplyResult"; exit 1; }

# 在线加第三个节点 → apply v2 → Agent 热更新
python3 - "$WORK/node3.json" <<'PY'
import json, sys
json.dump({"name": "新加坡-SS", "protocol": "shadowsocks", "transport": "tcp", "security": "none", "port": 9000,
           "config": {"settings": {"method": "aes-256-gcm", "clients": []}}}, open(sys.argv[1], "w"))
PY
curl -sf -b "$WORK/cookie" -X POST "$BASE/api/v1/servers/$SERVER_ID/nodes" \
  -H 'Content-Type: application/json' -d @"$WORK/node3.json" >/dev/null
V2=$(curl -sf -b "$WORK/cookie" -X POST "$BASE/api/v1/servers/$SERVER_ID/apply" | jget '["config_version"]')
sleep 1
python3 - "$WORK/xray/config.json" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
assert len(cfg["inbounds"]) == 3, f"期望 3 个入站，实际 {len(cfg['inbounds'])}"
print("ok 在线热更新到 3 个入站")
PY

echo "PASS 全部通过（日志：$WORK/master.log, $WORK/agent.log）"
