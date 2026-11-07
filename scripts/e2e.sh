#!/usr/bin/env bash
# 端到端冒烟：主控 → 登录 → 建服务器/节点/用户/套餐 → apply → Agent 收敛 → 订阅闭环
# 最后一条断言是本项目的核心不变量：订阅里发给用户的凭据，必须能在服务器 inbound 里找到同一条。
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
PORT=${PORT:-8791}
WORK=${WORK:-/tmp/pierwave-e2e}
BASE="http://127.0.0.1:$PORT"

rm -rf "$WORK"; mkdir -p "$WORK"
CARGO_HOME=$ROOT/.cargo-home cargo build -q -p pierwave-master -p pierwave-agent

PIERWAVE_ADDR="127.0.0.1:$PORT" PIERWAVE_DB="sqlite://$WORK/db.sqlite?mode=rwc" \
PIERWAVE_ADMIN_PASSWORD=devpass ./target/debug/pierwave-master > "$WORK/master.log" 2>&1 &
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
        "streamSettings": {"network": "tcp", "security": "reality",
                   "realitySettings": {"dest": "www.microsoft.com:443",
                                       "serverNames": ["www.microsoft.com"],
                                       "privateKey": priv,
                                       "shortIds": ["0123456789abcdef"]}},
    },
}, open(f"{work}/node1.json", "w"))
json.dump({
    "name": "日本-WS", "protocol": "trojan", "transport": "ws", "security": "none", "port": 8443,
    "config": {"settings": {"clients": [{"password": "manual-client"}]},
               "stream": {"network": "ws", "security": "none", "wsSettings": {"path": "/ws"}}},
}, open(f"{work}/node2.json", "w"))
PY

for f in node1 node2; do
  curl -sf -b "$WORK/cookie" -X POST "$BASE/api/v1/servers/$SERVER_ID/nodes" \
    -H 'Content-Type: application/json' -d @"$WORK/$f.json" >/dev/null
done
NODE_TAG=$(curl -sf -b "$WORK/cookie" "$BASE/api/v1/servers/$SERVER_ID/nodes" | jget '["items"][0]["tag"]')
echo "ok 建 2 个节点（首个 tag：${NODE_TAG}）"

ALICE=$(curl -sf -b "$WORK/cookie" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"password123"}')
ALICE_ID=$(echo "$ALICE" | jget '["user"]["id"]')
ALICE_CODE=$(echo "$ALICE" | jget '["user"]["short_code"]')
PKG_ID=$(curl -sf -b "$WORK/cookie" -X POST "$BASE/api/v1/packages" -H 'Content-Type: application/json' \
  -d '{"name":"月卡","quota_bytes":107374182400,"period_days":30,"node_ratio":2.0}' | jget '["package"]["id"]')
curl -sf -b "$WORK/cookie" -X POST "$BASE/api/v1/users/$ALICE_ID/packages" \
  -H 'Content-Type: application/json' -d "{\"package_id\":\"$PKG_ID\"}" >/dev/null
echo "ok alice 绑定套餐（node_ratio=2.0）"

# 假 stats 命令：第一次 1000/500，之后 3000/1500（模拟 Xray 计数只增不减）。
# 真实 Xray 的 statsquery 输出就是这个结构，Agent 侧解析逻辑完全一致。
cat > "$WORK/fake-stats.sh" <<SH
#!/bin/sh
count=\$(cat "$WORK/stats.count" 2>/dev/null || echo 0)
count=\$((count + 1))
echo "\$count" > "$WORK/stats.count"
if [ "\$count" -le 1 ]; then
  echo '{"stat":[{"name":"user>>>$ALICE_ID@$NODE_TAG>>>traffic>>>uplink","value":"1000"},{"name":"user>>>$ALICE_ID@$NODE_TAG>>>traffic>>>downlink","value":"500"}]}'
else
  echo '{"stat":[{"name":"user>>>$ALICE_ID@$NODE_TAG>>>traffic>>>uplink","value":"3000"},{"name":"user>>>$ALICE_ID@$NODE_TAG>>>traffic>>>downlink","value":"1500"}]}'
fi
SH
chmod 755 "$WORK/fake-stats.sh"

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
stats_query_command = "$WORK/fake-stats.sh"
stats_interval_secs = 1
TOML
./target/debug/pierwave-agent -c "$WORK/agent.toml" > "$WORK/agent.log" 2>&1 &
AGENT_PID=$!

for _ in $(seq 1 60); do [ -f "$WORK/xray/config.json" ] && break; sleep 0.2; done
[ -f "$WORK/xray/config.json" ] || { echo "FAIL: Agent 没有落盘 xray 配置"; tail -20 "$WORK/agent.log"; exit 1; }
echo "ok Agent 重连后补发并落盘"

python3 - "$WORK/xray/config.json" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
tags = [i["tag"] for i in cfg["inbounds"]]
assert len(cfg["inbounds"]) == 3, f"inbounds={len(cfg['inbounds'])}（2 个业务节点 + api）"
assert tags[-1] == "api", tags
assert cfg["inbounds"][0]["port"] == 443 and cfg["inbounds"][0]["protocol"] == "vless"
assert any(o["protocol"] == "freedom" for o in cfg["outbounds"])
# 流量计量依赖这三块：stats、policy 与只监听回环的 api 入站。
# 用户级计数器在 policy.levels."0" 下——放进 system 里 Xray 不报错但也不生效。
assert cfg["stats"] == {}, cfg.get("stats")
for flag in ("statsInboundUplink", "statsInboundDownlink"):
    assert cfg["policy"]["system"][flag] is True, flag
for flag in ("statsUserUplink", "statsUserDownlink"):
    assert cfg["policy"]["levels"]["0"][flag] is True, flag
api = next(i for i in cfg["inbounds"] if i["tag"] == "api")
assert api["listen"] == "127.0.0.1" and api["port"] == 10085, api
assert "StatsService" in cfg["api"]["services"], cfg["api"]
assert {"type": "field", "inboundTag": ["api"], "outboundTag": "api"} in cfg["routing"]["rules"]
print("ok 配置结构:", tags, "stats/API 已开")
PY

echo "--- 闭环断言：订阅凭据 == 服务器 inbound 凭据 ---"
curl -sf "$BASE/api/v1/sub/$ALICE_CODE" -o "$WORK/sub.yaml"
python3 - "$WORK/sub.yaml" "$WORK/xray/config.json" <<'PY'
import json, sys

# 订阅是 YAML，但这里只需要 proxies / proxy-groups 两个列表，
# 用一个极小的行解析器替代 PyYAML——CI 上不一定装了它。
def parse(text):
    proxies, groups, section, cur = [], [], None, None
    for raw in text.splitlines():
        line = raw.strip()
        if raw.startswith("proxies:"):
            section, cur = "proxies", None
        elif raw.startswith("proxy-groups:"):
            section, cur = "groups", None
        elif raw.startswith("rules:"):
            section, cur = None, None
        elif section and line.startswith("- name:"):
            cur = {"name": line[len("- name:"):].strip().strip('"')}
            (proxies if section == "proxies" else groups).append(cur)
        elif section == "proxies" and cur is not None:
            for key in ("uuid", "password"):
                if line.startswith(key + ":"):
                    cur[key] = line[len(key) + 1:].strip().strip('"')
    return proxies, groups


cfg = json.load(open(sys.argv[2], encoding="utf-8"))
proxies, groups = parse(open(sys.argv[1], encoding="utf-8").read())

assert len(proxies) == 2, f"订阅应有 2 个节点，实际 {len(proxies)}"
clients = {c.get("id") or c.get("password"): c
           for i in cfg["inbounds"] for c in i["settings"].get("clients", [])}
for p in proxies:
    cred = p.get("uuid") or p.get("password")
    assert cred in clients, f"{p['name']} 的凭据不在服务器配置里：{cred}"
    assert "@" in clients[cred].get("email", ""), clients[cred]
print("ok 订阅凭据与服务器一致:", [p["name"] for p in proxies])

names = {g["name"] for g in groups}
assert {"PROXY", "AUTO"} <= names, names
print("ok 分组:", sorted(names))
PY

echo "--- 流量计量：假 stats → Agent 增量 → 主控按倍率落库 ---"
# 第一次 1000/500、第二次 3000/1500 → 两轮增量 1000/500 + 2000/1000；
# alice 的套餐 node_ratio=2.0、direction=both，期望 used = (3000+1500)×2 = 9000。
ALICE_USED=0
for _ in $(seq 1 100); do
  ALICE_USED=$(curl -sf -b "$WORK/cookie" "$BASE/api/v1/users?q=alice" 2>/dev/null | jget '["items"][0]["used_bytes"]' 2>/dev/null || echo 0)
  [ "$ALICE_USED" = "9000" ] && break
  sleep 0.2
done
[ "$ALICE_USED" = "9000" ] || { echo "FAIL: alice.used_bytes 期望 9000（(3000+1500)×2.0），实际 $ALICE_USED"; tail -20 "$WORK/agent.log"; exit 1; }
echo "ok alice.used_bytes = 9000（加权后）"

PACKAGE_USED=$(curl -sf -b "$WORK/cookie" "$BASE/api/v1/users?q=alice" | jget '["items"][0]["packages"][0]["used_bytes"]')
[ "$PACKAGE_USED" = "9000" ] || { echo "FAIL: 套餐实例 used_bytes 应为 9000，实际 $PACKAGE_USED"; exit 1; }

python3 - "$WORK/db.sqlite" "$ALICE_ID" <<'PY'
import sqlite3, sys

conn = sqlite3.connect(sys.argv[1])
alice = sys.argv[2]

reports = conn.execute("SELECT COUNT(*) FROM traffic_reports").fetchone()[0]
assert reports == 2, f"期望 2 条 traffic_reports，实际 {reports}"

rows = conn.execute(
    "SELECT uplink, downlink, weighted FROM traffic_daily WHERE subject = ? ORDER BY day",
    (alice,),
).fetchall()
assert rows == [(3000, 1500, 9000)], f"traffic_daily 原始/加权值不对：{rows}"
weighted = conn.execute("SELECT weighted FROM traffic_daily WHERE subject = ?", (alice,)).fetchone()[0]
print(f"ok traffic_reports={reports}，traffic_daily=uplink 3000 / downlink 1500 / weighted {weighted}")
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
assert len(cfg["inbounds"]) == 4, f"期望 4 个入站（3 业务 + api），实际 {len(cfg['inbounds'])}"
assert cfg["inbounds"][-1]["tag"] == "api"
print("ok 在线热更新到 3 个业务入站（+ api）")
PY

echo "--- 幂等：重放已上报的 (boot_id, seq) 不应让数字翻倍 ---"
python3 - "$WORK/db.sqlite" "$BASE" "$TOKEN" "$ALICE_ID" "$NODE_TAG" <<'PY'
import base64, json, os, socket, sqlite3, struct, sys, time

# 用一个极小的裸 WebSocket 客户端重放上报，避免依赖第三方 `websockets` 包
# （CI 的 python 环境里没有它，本地 anaconda 里恰好有——这种差异最难发现）。
db, base, token, alice, tag = sys.argv[1:6]
conn = sqlite3.connect(db)
boot_id, seq = conn.execute(
    "SELECT boot_id, seq FROM traffic_reports ORDER BY seq ASC LIMIT 1"
).fetchone()

host, port = base.split("//", 1)[1].split(":", 1)
port = int(port)


def send_text(sock, text):
    data = text.encode()
    header = bytearray([0x81])
    n = len(data)
    if n < 126:
        header.append(0x80 | n)
    elif n < 65536:
        header.append(0x80 | 126)
        header += struct.pack(">H", n)
    else:
        header.append(0x80 | 127)
        header += struct.pack(">Q", n)
    mask = os.urandom(4)
    header += mask
    sock.sendall(bytes(header) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))


def recv_frame(sock):
    header = sock.recv(2)
    if len(header) < 2:
        return ""
    length = header[1] & 0x7F
    if length == 126:
        length = struct.unpack(">H", sock.recv(2))[0]
    elif length == 127:
        length = struct.unpack(">Q", sock.recv(8))[0]
    chunks, remaining = [], length
    while remaining > 0:
        chunk = sock.recv(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks).decode("utf-8", "replace")


sock = socket.create_connection((host, port), timeout=10)
key = base64.b64encode(os.urandom(16)).decode()
sock.sendall(
    (
        f"GET /api/agent/ws HTTP/1.1\r\nHost: {host}:{port}\r\n"
        "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    ).encode()
)
buf = b""
while b"\r\n\r\n" not in buf:
    chunk = sock.recv(4096)
    if not chunk:
        raise SystemExit("WebSocket 握手失败")
    buf += chunk

send_text(sock, json.dumps({
    "type": "hello", "token": token, "hostname": "e2e-replay",
    "agent_version": "0.1.0", "xray_mode": "external", "capabilities": [],
}))
recv_frame(sock)  # ack

# 用同一个 (boot_id, seq) 重放一条明显更大的上报，主控应把它丢弃。
send_text(sock, json.dumps({
    "type": "traffic",
    "seq": seq,
    "boot_id": boot_id,
    "deltas": [{"email": f"{alice}@{tag}", "uplink": 999999, "downlink": 999999}],
}))
time.sleep(0.8)
sock.close()
print(f"ok 重放 boot_id={boot_id[:8]}… seq={seq}")
PY

REPLAYED_USED=$(curl -sf -b "$WORK/cookie" "$BASE/api/v1/users?q=alice" | jget '["items"][0]["used_bytes"]')
[ "$REPLAYED_USED" = "9000" ] || { echo "FAIL: 重放后 used_bytes 翻倍了（${REPLAYED_USED}）"; exit 1; }
python3 - "$WORK/db.sqlite" <<'PY'
import sqlite3, sys

conn = sqlite3.connect(sys.argv[1])
reports = conn.execute("SELECT COUNT(*) FROM traffic_reports").fetchone()[0]
assert reports == 2, f"重放不应新增 traffic_reports，实际 {reports}"
weighted = conn.execute("SELECT SUM(weighted) FROM traffic_daily").fetchone()[0]
assert weighted == 9000, f"重放不应改动日账本，实际 weighted={weighted}"
print(f"ok 重放被幂等丢弃：reports={reports}, weighted={weighted}")
PY

echo "PASS 全部通过（日志：$WORK/master.log, $WORK/agent.log）"
