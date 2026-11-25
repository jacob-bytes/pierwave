#!/usr/bin/env bash
# 端到端冒烟：主控 → 登录 → 建服务器/节点/用户/套餐 → apply → Agent 收敛 → 订阅闭环
# 最后一条断言是本项目的核心不变量：订阅里发给用户的凭据，必须能在服务器 inbound 里找到同一条。
#
# 预期耗时：本地（二进制已编译）约 45–55s；CI 约 4 分钟。变长是有意的——
# 「WS 首帧超时」必须真的等主控的 10s Hello 超时，「加密备份」会重启一次主控
# 来应用待恢复文件。看到这两段停留时不要当成卡住。
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
UDP_ECHO_PID=""
cleanup() { kill $MASTER_PID ${AGENT_PID:-} ${UDP_ECHO_PID:-} 2>/dev/null || true; wait 2>/dev/null || true; }
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

# used_bytes 只能证明累计值到位，不能证明两条报告都已落库：
# 单条 3000/1500 的报告同样算出 9000。等报告条数到位再断言，避免偶发失败。
REPORTS=0
for _ in $(seq 1 100); do
  REPORTS=$(sqlite3 "$WORK/db.sqlite" "SELECT COUNT(*) FROM traffic_reports;" 2>/dev/null || echo 0)
  [ "$REPORTS" = "2" ] && break
  sleep 0.1
done

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
# 旧 AEAD 走多用户：inbound 的 password 只作占位，用户密码由订阅派生；
# 主控会校验它至少 8 个字符，所以这里必须给一个合法值。
json.dump({"name": "新加坡-SS", "protocol": "shadowsocks", "transport": "tcp", "security": "none", "port": 9000,
           "config": {"settings": {"method": "aes-256-gcm", "password": "e2e-server-key", "clients": []}}}, open(sys.argv[1], "w"))
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

# ---------------------------------------------------------------- 规则模板
echo "--- 规则模板：订阅可以按 ?rule= 覆盖分流规则 ---"
TPL_ID=$(curl -sf -b "$WORK/cookie" -X POST "$BASE/api/v1/rule-templates" -H 'Content-Type: application/json' \
  -d '{"name":"e2e-流媒体","rules":["DOMAIN-SUFFIX,example.com,DIRECT","MATCH,PROXY"]}' \
  | jget '["template"]["id"]')

curl -sf "$BASE/api/v1/sub/$ALICE_CODE?rule=$TPL_ID" -o "$WORK/sub-custom.yaml"
grep -q 'DOMAIN-SUFFIX,example.com,DIRECT' "$WORK/sub-custom.yaml" \
  || { echo "FAIL: ?rule= 没有生效，订阅里没有自定义规则"; sed -n '/^rules:/,$p' "$WORK/sub-custom.yaml"; exit 1; }
grep -q 'GEOIP,CN,DIRECT' "$WORK/sub-custom.yaml" \
  && { echo "FAIL: 指定模板后仍带着默认规则"; exit 1; }

# 不带参数时仍是内置规则：升级不能改变已发出去的订阅
curl -sf "$BASE/api/v1/sub/$ALICE_CODE" -o "$WORK/sub-default.yaml"
grep -q 'GEOIP,CN,DIRECT' "$WORK/sub-default.yaml" \
  || { echo "FAIL: 默认订阅丢失了内置规则"; exit 1; }

CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/sub/$ALICE_CODE?rule=00000000-0000-0000-0000-000000000000")
[ "$CODE" = "404" ] || { echo "FAIL: 不存在的模板应 404，实际 $CODE"; exit 1; }

CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$WORK/cookie" -X POST "$BASE/api/v1/rule-templates" \
  -H 'Content-Type: application/json' -d '{"name":"e2e-没有兜底","rules":["GEOIP,CN,DIRECT"]}')
[ "$CODE" = "400" ] || { echo "FAIL: 末条不是 MATCH 应 400，实际 $CODE"; exit 1; }
echo "ok 规则模板：自定义规则生效、默认订阅不变、非法模板被拒（${TPL_ID}）"

# ---------------------------------------------------------------- 出站与路由
echo "--- 出站与路由：下发到 Agent 的配置里要能看到自定义出站与规则 ---"
# 前面的重放测试用一个裸 WS 客户端顶掉了真 Agent 的连接，这里把它重新拉起来，
# 否则 apply 的广播没有接收方，配置不会落盘。
kill "$AGENT_PID" 2>/dev/null || true
wait "$AGENT_PID" 2>/dev/null || true
./target/debug/pierwave-agent -c "$WORK/agent.toml" > "$WORK/agent.log" 2>&1 &
AGENT_PID=$!
for _ in $(seq 1 60); do
  STATUS=$(curl -sf -b "$WORK/cookie" "$BASE/api/v1/servers" | jget '["items"][0]["status"]')
  [ "$STATUS" = "online" ] && break
  sleep 0.2
done
curl -sf -b "$WORK/cookie" -X POST "$BASE/api/v1/servers/$SERVER_ID/outbounds" -H 'Content-Type: application/json' \
  -d '{"tag":"relay","protocol":"socks","config":{"settings":{"servers":[{"address":"10.0.0.2","port":1080}]}}}' >/dev/null
curl -sf -b "$WORK/cookie" -X POST "$BASE/api/v1/servers/$SERVER_ID/routing-rules" -H 'Content-Type: application/json' \
  -d '{"domain":"example.com","outbound_tag":"relay"}' >/dev/null

CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$WORK/cookie" -X POST "$BASE/api/v1/servers/$SERVER_ID/outbounds" \
  -H 'Content-Type: application/json' -d '{"tag":"direct","protocol":"freedom","config":{}}')
[ "$CODE" = "400" ] || { echo "FAIL: 占用保留字 direct 应 400，实际 $CODE"; exit 1; }

CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$WORK/cookie" -X POST "$BASE/api/v1/servers/$SERVER_ID/routing-rules" \
  -H 'Content-Type: application/json' -d '{"outbound_tag":"relay"}')
[ "$CODE" = "400" ] || { echo "FAIL: 没有匹配条件的规则应 400，实际 $CODE"; exit 1; }

PREV_SUM=$(cksum "$WORK/xray/config.json" | awk '{print $1}')
curl -sf -b "$WORK/cookie" -X POST "$BASE/api/v1/servers/$SERVER_ID/apply" >/dev/null
for _ in $(seq 1 60); do
  NOW_SUM=$(cksum "$WORK/xray/config.json" | awk '{print $1}')
  [ "$NOW_SUM" != "$PREV_SUM" ] && break
  sleep 0.2
done
python3 - "$WORK/xray/config.json" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
outbounds = {o["tag"]: o for o in cfg["outbounds"]}
assert "relay" in outbounds, f"自定义出站没下发：{list(outbounds)}"
assert outbounds["relay"]["protocol"] == "socks", outbounds["relay"]
assert outbounds["relay"]["settings"]["servers"][0]["address"] == "10.0.0.2", outbounds["relay"]
rules = cfg["routing"]["rules"]
assert rules[0]["inboundTag"] == ["api"], f"api 规则必须排在第一位：{rules[0]}"
custom = [r for r in rules if r.get("outboundTag") == "relay"]
assert custom, f"路由规则没下发：{rules}"
assert custom[0]["domain"] == ["example.com"], custom[0]
print("ok 出站与路由已下发:", list(outbounds), "| rules =", len(rules))
PY

# ---------------------------------------------------------------- 批量升级
echo "--- 批量升级：遇错即停，剩余任务跳过 ---"
curl -sf -b "$WORK/cookie" -X PATCH "$BASE/api/v1/servers/$SERVER_ID" -H 'Content-Type: application/json' \
  -d '{"allow_agent_upgrade":true}' >/dev/null
SECOND=$(curl -sf -b "$WORK/cookie" -X POST "$BASE/api/v1/servers" -H 'Content-Type: application/json' \
  -d '{"name":"批量-第二台","address":"10.1.1.1"}')
SECOND_ID=$(echo "$SECOND" | jget '["server"]["id"]')
curl -sf -b "$WORK/cookie" -X PATCH "$BASE/api/v1/servers/$SECOND_ID" -H 'Content-Type: application/json' \
  -d '{"allow_agent_upgrade":true}' >/dev/null

# 目标版本比当前旧 → 触发阶段必然失败，正好用来验证「遇错即停」
BATCH_ID=$(curl -sf -b "$WORK/cookie" -X POST "$BASE/api/v1/agent-upgrades/batches" -H 'Content-Type: application/json' \
  -d "{\"server_ids\":[\"$SECOND_ID\",\"$SERVER_ID\"],\"version\":\"v0.0.1\",\"stop_on_failure\":true}" \
  | jget '["batch"]["id"]')
[ -n "$BATCH_ID" ] || { echo "FAIL: 建批次失败"; exit 1; }

BATCH_STATUS=""
for _ in $(seq 1 40); do
  BATCH_STATUS=$(curl -sf -b "$WORK/cookie" "$BASE/api/v1/agent-upgrades/batches/$BATCH_ID" | jget '["batch"]["status"]')
  [ "$BATCH_STATUS" != "running" ] && break
  sleep 1
done
[ "$BATCH_STATUS" = "failed" ] || { echo "FAIL: 批次应 failed，实际 $BATCH_STATUS"; exit 1; }

curl -sf -b "$WORK/cookie" "$BASE/api/v1/agent-upgrades/batches/$BATCH_ID" > "$WORK/batch.json"
python3 - "$WORK/batch.json" "$SECOND_ID" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
second_id = sys.argv[2]
items = {i["server_id"]: i for i in data["items"]}
assert len(items) == 2, items
second = items[second_id]
assert second["status"] == "failed", second
assert second["error"], "失败项必须带原因"
# 另一台（排在后面）必须因为「遇错即停」被跳过
other = [i for sid, i in items.items() if sid != second_id][0]
assert other["status"] == "skipped", other
print("ok 批量升级收敛:", {i["server_name"]: i["status"] for i in items.values()})
PY


# ---- 转发引擎：native 与 realm 的差异必须体现在运行状态上 ----
# native 规则：端口绑定成功 → listening=true；
# realm 规则：realm 二进制不在本机 → listening=false 且 error 指明「未安装」。
# 这一段同时守住两件事：期望态把 engine 透传到 Agent、Agent 按引擎分流且互不影响。
NATIVE_FWD=$(curl -sf -b "$WORK/cookie" -X POST "$BASE/api/v1/servers/$SERVER_ID/forwards" \
  -H 'Content-Type: application/json' \
  -d '{"name":"e2e-native","listen_port":19555,"target_host":"127.0.0.1","target_port":1,"engine":"native"}')
NATIVE_ENGINE=$(echo "$NATIVE_FWD" | jget '["forward"]["engine"]')
[ "$NATIVE_ENGINE" = "native" ] || { echo "FAIL: native 转发 engine=$NATIVE_ENGINE"; exit 1; }

REALM_FWD=$(curl -sf -b "$WORK/cookie" -X POST "$BASE/api/v1/servers/$SERVER_ID/forwards" \
  -H 'Content-Type: application/json' \
  -d '{"name":"e2e-realm","listen_port":19556,"target_host":"127.0.0.1","target_port":2,"engine":"realm"}')
REALM_ENGINE=$(echo "$REALM_FWD" | jget '["forward"]["engine"]')
[ "$REALM_ENGINE" = "realm" ] || { echo "FAIL: realm 转发 engine=$REALM_ENGINE"; exit 1; }

# 非法引擎必须被拒绝
BAD_CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$WORK/cookie" -X POST "$BASE/api/v1/servers/$SERVER_ID/forwards" \
  -H 'Content-Type: application/json' \
  -d '{"name":"e2e-bad","listen_port":19557,"target_host":"127.0.0.1","target_port":3,"engine":"nope"}')
[ "$BAD_CODE" = "400" ] || { echo "FAIL: 非法引擎应 400，实际 $BAD_CODE"; exit 1; }

# 等 Agent 落一轮心跳后再看运行状态（心跳 15s 一轮，这里轮询到出现为止）
FWD_STATE=""
for _ in $(seq 1 20); do
  curl -sf -b "$WORK/cookie" "$BASE/api/v1/servers/$SERVER_ID/forwards" > "$WORK/forwards.json"
  FWD_STATE=$(python3 - "$WORK/forwards.json" <<'PY'
import json, sys
items = {i["name"]: i for i in json.load(open(sys.argv[1]))["items"]}
native = items.get("e2e-native") or {}
realm = items.get("e2e-realm") or {}
if not native.get("runtime"):
    print("pending")
else:
    print(json.dumps({
        "native_listening": native["runtime"]["listening"],
        "realm_listening": (realm.get("runtime") or {}).get("listening"),
        "realm_error": (realm.get("runtime") or {}).get("error") or "",
    }, ensure_ascii=False))
PY
)
  [ "$FWD_STATE" != "pending" ] && break
  sleep 1
done
python3 - "$FWD_STATE" <<'PY'
import json, sys
state = json.loads(sys.argv[1])
assert state["native_listening"] is True, f"native 规则应已监听：{state}"
assert state["realm_listening"] is False, f"realm 缺失时不应监听：{state}"
assert "realm" in state["realm_error"].lower(), f"realm 错误应说明原因：{state}"
print("ok 转发引擎分流:", state)
PY


# ---- UDP 转发：真起一个 UDP echo，客户端发 3 个包必须全部回显 ----
# 这一段打通完整链路：主控接受 udp=true → 期望态带上 udp → Agent 在同一个
# listen_port 上再绑 UDP socket → 会话表把数据报转给目标并把回包写回客户端。
python3 - "$WORK" <<'PY' &
import socket, sys, threading
work = sys.argv[1]
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind(("127.0.0.1", 0))
with open(f"{work}/udp-echo.port", "w") as fh:
    fh.write(str(sock.getsockname()[1]))
def serve():
    while True:
        try:
            data, peer = sock.recvfrom(65535)
        except OSError:
            return
        sock.sendto(b"udp:" + data, peer)
threading.Thread(target=serve, daemon=True).start()
threading.Event().wait()
PY
UDP_ECHO_PID=$!
for _ in $(seq 1 50); do [ -s "$WORK/udp-echo.port" ] && break; sleep 0.1; done
UDP_TARGET_PORT=$(cat "$WORK/udp-echo.port")
[ -n "$UDP_TARGET_PORT" ] || { echo "FAIL: UDP echo 没有起来"; exit 1; }

UDP_FWD=$(curl -sf -b "$WORK/cookie" -X POST "$BASE/api/v1/servers/$SERVER_ID/forwards" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"e2e-udp\",\"listen_port\":19558,\"target_host\":\"127.0.0.1\",\"target_port\":$UDP_TARGET_PORT,\"engine\":\"native\",\"udp\":true}")
UDP_FLAG=$(echo "$UDP_FWD" | jget '["forward"]["udp"]')
[ "$UDP_FLAG" = "True" ] || { echo "FAIL: 转发响应没有回显 udp=true（实际 $UDP_FLAG）"; exit 1; }
echo "ok 建 UDP 转发规则（udp=true）"

UDP_LISTENING=""
for _ in $(seq 1 30); do
  curl -sf -b "$WORK/cookie" "$BASE/api/v1/servers/$SERVER_ID/forwards" > "$WORK/forwards-udp.json"
  UDP_LISTENING=$(python3 - "$WORK/forwards-udp.json" <<'PY'
import json, sys
items = {i["name"]: i for i in json.load(open(sys.argv[1]))["items"]}
rule = items.get("e2e-udp") or {}
print("true" if (rule.get("runtime") or {}).get("listening") is True else "pending")
PY
)
  [ "$UDP_LISTENING" = "true" ] && break
  sleep 1
done
[ "$UDP_LISTENING" = "true" ] || { echo "FAIL: e2e-udp 没有进入 listening"; tail -20 "$WORK/agent.log"; exit 1; }

python3 - <<'PY'
import socket
client = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
client.settimeout(3)
for payload in (b"one", b"two", b"three"):
    client.sendto(payload, ("127.0.0.1", 19558))
    data, _ = client.recvfrom(65535)
    assert data == b"udp:" + payload, (payload, data)
print("ok UDP 转发回环：3 个数据报全部回显")
PY

# ---------------------------------------------------------------- WS 首帧超时
# 主控对 Agent WS 的 Hello 有 10s 硬超时（AGENT_HELLO_TIMEOUT）。这里用裸
# WebSocket 客户端完成握手后**故意不发任何帧**，断言连接在 12s 内被主控关闭。
# 不能只断言「连接断了」：必须先确认升级成功（101），否则测到的是 404/挂在
# 握手阶段，而不是首帧超时；同时加 8s 下界，防止别的原因提前断开冒充超时。
echo "--- WS 首帧超时：握手后不发 Hello，主控应在 10s 内关闭连接 ---"
if ! python3 - "$BASE" <<'PY'
import base64, os, socket, struct, sys, time

base = sys.argv[1]
host, port = base.split("//", 1)[1].split(":", 1)
port = int(port)

sock = socket.create_connection((host, port), timeout=5)
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
        raise SystemExit("FAIL: 还没等首帧，WebSocket 握手阶段连接就被关闭了")
    buf += chunk
status_line = buf.split(b"\r\n", 1)[0].decode("latin-1")
if "101" not in status_line:
    raise SystemExit(f"FAIL: WebSocket 升级失败：{status_line}")

# 握手完成后什么都不发，只等主控按 Hello 超时关闭连接。
sock.settimeout(12)
start = time.monotonic()
closed_by = None
try:
    while True:
        header = sock.recv(2)
        if len(header) < 2:
            closed_by = "EOF"
            break
        opcode = header[0] & 0x0F
        length = header[1] & 0x7F
        if length == 126:
            length = struct.unpack(">H", sock.recv(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", sock.recv(8))[0]
        remaining = length
        while remaining > 0:
            chunk = sock.recv(remaining)
            if not chunk:
                break
            remaining -= len(chunk)
        if opcode == 0x8:
            closed_by = "close 帧"
            break
except socket.timeout:
    closed_by = None
elapsed = time.monotonic() - start
sock.close()

if closed_by is None:
    raise SystemExit(
        f"FAIL: 12s 内没有收到关闭（首帧超时应为 10s；已等 {elapsed:.1f}s）"
    )
if elapsed < 8.0:
    raise SystemExit(
        f"FAIL: 连接在 {elapsed:.1f}s 就被关闭，早于 10s 首帧超时（走的不是超时路径）"
    )
print(f"ok WS 首帧超时：握手后不发消息，{elapsed:.1f}s 内被主控关闭（{closed_by}）")
PY
then
  echo "FAIL: WS 首帧超时断言失败（见上）"
  tail -10 "$WORK/master.log" || true
  exit 1
fi

# ---------------------------------------------------------------- 加密备份
# 覆盖「导出 → PWSB 信封 → 恢复 → 重启生效 → 数据一致」整条链路。
# 快照只取稳定字段：status / last_seen / runtime 这类心跳态在重启后必然变化，
# 拿它们比对会把「恢复成功」误测成失败。
echo "--- 加密备份：导出 PWSB 信封 → 恢复并重启 → 数据一致 ---"
snapshot_facts() {
  python3 - "$BASE" "$WORK/cookie" "$1" "$2" "$ALICE_CODE" <<'PY'
import hashlib, json, sys, urllib.request

base, cookie_file, out_path, sub_path, code = sys.argv[1:6]
session = ""
for line in open(cookie_file, encoding="utf-8"):
    fields = line.rstrip("\n").split("\t")
    if len(fields) >= 7 and fields[5] == "pierwave_session":
        session = fields[6]
if not session:
    raise SystemExit(f"FAIL: 从 {cookie_file} 里找不到 pierwave_session")
cookie = f"pierwave_session={session}"


def get_bytes(path):
    request = urllib.request.Request(base + path, headers={"Cookie": cookie})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read()
    except Exception as error:  # 失败原因必须原样打印，不能只留一个 traceback
        raise SystemExit(f"FAIL: GET {path} 失败：{error}")


def get_json(path):
    return json.loads(get_bytes(path))


servers = get_json("/api/v1/servers")["items"]
nodes, forwards = [], []
for server in servers:
    for node in get_json(f"/api/v1/servers/{server['id']}/nodes")["items"]:
        nodes.append({
            "server": server["id"], "id": node["id"], "tag": node["tag"],
            "protocol": node["protocol"], "port": node["port"],
        })
    for forward in get_json(f"/api/v1/servers/{server['id']}/forwards")["items"]:
        forwards.append({
            "server": server["id"], "id": forward["id"], "name": forward["name"],
            "listen_port": forward["listen_port"], "target_host": forward["target_host"],
            "target_port": forward["target_port"], "engine": forward["engine"],
            "udp": forward["udp"],
        })

users = get_json("/api/v1/users")["items"]
packages = get_json("/api/v1/packages")["items"]
templates = get_json("/api/v1/rule-templates")["items"]

sub = get_bytes(f"/api/v1/sub/{code}")
open(sub_path, "wb").write(sub)

facts = {
    "servers": sorted((s["id"], s["name"], s["address"]) for s in servers),
    "nodes": sorted(nodes, key=lambda item: item["id"]),
    "forwards": sorted(forwards, key=lambda item: item["id"]),
    "users": sorted(
        (u["id"], u["username"], int(u["used_bytes"]), u["short_code"]) for u in users
    ),
    "packages": sorted(
        (p["id"], p["name"], p["quota_bytes"], p["period_days"], p["node_ratio"])
        for p in packages
    ),
    "rule_templates": sorted((t["id"], t["name"]) for t in templates),
    "subscription_sha256": hashlib.sha256(sub).hexdigest(),
}
# 防止「空库对空库」式的假绿：恢复必须真的带回了数据。
assert len(facts["servers"]) >= 2, facts
assert len(facts["nodes"]) >= 3, facts
assert len(facts["users"]) >= 2, facts
assert len(facts["forwards"]) >= 3, facts
# 具体数值不在这里写死：前面已经断言过 9000，这一段只要求「确有计量数据」，
# 避免之后新增上报轮次时把备份测试变成脆弱的数字断言。
assert any(used > 0 for _, _, used, _ in facts["users"]), facts["users"]
json.dump(
    facts, open(out_path, "w", encoding="utf-8"),
    ensure_ascii=False, sort_keys=True, indent=2,
)
print(
    f"ok 快照：servers={len(facts['servers'])} nodes={len(facts['nodes'])} "
    f"users={len(facts['users'])} forwards={len(facts['forwards'])} "
    f"订阅 {facts['subscription_sha256'][:12]}…"
)
PY
}

snapshot_facts "$WORK/facts-before.json" "$WORK/sub-before.yaml" \
  || { echo "FAIL: 导出前的数据快照失败（见上）"; exit 1; }

CODE=$(curl -s -b "$WORK/cookie" -D "$WORK/backup.headers" -o "$WORK/backup.bin" \
  -w '%{http_code}' "$BASE/api/v1/backup")
[ "$CODE" = "200" ] || { echo "FAIL: 导出加密备份应 200，实际 ${CODE}"; exit 1; }
grep -qi '^content-type: application/octet-stream' "$WORK/backup.headers" \
  || { echo "FAIL: 加密备份的 Content-Type 应为 application/octet-stream"; grep -i '^content-type' "$WORK/backup.headers" || true; exit 1; }
grep -qi 'filename="[^"]*\.db\.gz\.enc"' "$WORK/backup.headers" \
  || { echo "FAIL: 加密备份的文件名应以 .db.gz.enc 结尾"; grep -i '^content-disposition' "$WORK/backup.headers" || true; exit 1; }
if ! python3 - "$WORK/backup.bin" <<'PY'
import sys
path = sys.argv[1]
blob = open(path, "rb").read()
head = blob[:64]
if not head.startswith(b"PWSB"):
    raise SystemExit(f"文件头不是 PWSB：{head[:8]!r}")
if head[:2] == b"\x1f\x8b" or head[:16] == b"SQLite format 3\x00":
    raise SystemExit("加密备份不能是 gzip / 明文 SQLite")
print(f"ok 导出是 PWSB 加密信封（信封版本 {head[4]}，{len(blob)} B）")
PY
then
  echo "FAIL: 导出的备份不是 PWSB 加密信封（见上）"
  exit 1
fi

CODE=$(curl -s -b "$WORK/cookie" -X POST "$BASE/api/v1/backup/restore" \
  -H 'Content-Type: application/octet-stream' --data-binary @"$WORK/backup.bin" \
  -o "$WORK/restore.json" -w '%{http_code}')
[ "$CODE" = "200" ] || { echo "FAIL: 上传加密备份应 200，实际 ${CODE}"; head -c 400 "$WORK/restore.json"; echo; exit 1; }
RESTART=$(jget '["restart_required"]' < "$WORK/restore.json")
[ "$RESTART" = "True" ] || { echo "FAIL: 恢复响应 restart_required 应为 true，实际 ${RESTART}"; exit 1; }
PENDING=$(jget '["pending"]["bytes"]' < "$WORK/restore.json")
case "$PENDING" in
  ''|*[!0-9]*) echo "FAIL: 恢复响应的 pending.bytes 非法：${PENDING}"; exit 1 ;;
esac
[ "$PENDING" -gt 0 ] || { echo "FAIL: 恢复响应的 pending.bytes 应大于 0，实际 ${PENDING}"; exit 1; }
echo "ok 加密备份已落盘为待恢复文件（${PENDING} B），按契约重启后生效"

# 恢复只在启动时替换数据库；真 Agent 先停掉，避免它在重启窗口里刷断线日志。
kill "$AGENT_PID" 2>/dev/null || true
wait "$AGENT_PID" 2>/dev/null || true
AGENT_PID=""
kill "$MASTER_PID" 2>/dev/null || true
wait "$MASTER_PID" 2>/dev/null || true
PIERWAVE_ADDR="127.0.0.1:$PORT" PIERWAVE_DB="sqlite://$WORK/db.sqlite?mode=rwc" \
PIERWAVE_ADMIN_PASSWORD=devpass ./target/debug/pierwave-master >> "$WORK/master.log" 2>&1 &
MASTER_PID=$!
for _ in $(seq 1 100); do curl -sf "$BASE/api/v1/health" >/dev/null 2>&1 && break; sleep 0.2; done
curl -sf "$BASE/api/v1/health" >/dev/null \
  || { echo "FAIL: 恢复后主控没有重新就绪"; tail -30 "$WORK/master.log"; exit 1; }
grep -q "已应用待恢复的数据库备份" "$WORK/master.log" \
  || { echo "FAIL: 主控启动日志没有显示已应用恢复"; tail -30 "$WORK/master.log"; exit 1; }
echo "ok 重启后主控应用了待恢复的数据库"

curl -sf -c "$WORK/cookie" -X POST "$BASE/api/v1/auth/login" \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"devpass"}' >/dev/null \
  || { echo "FAIL: 恢复后无法用原管理员密码登录（恢复没有带回账号数据）"; exit 1; }
snapshot_facts "$WORK/facts-after.json" "$WORK/sub-after.yaml" \
  || { echo "FAIL: 恢复后的数据快照失败（见上）"; exit 1; }
if ! python3 - "$WORK/facts-before.json" "$WORK/facts-after.json" <<'PY'
import json, sys
before = json.load(open(sys.argv[1], encoding="utf-8"))
after = json.load(open(sys.argv[2], encoding="utf-8"))
problems = [key for key in before if before[key] != after.get(key)]
if problems:
    for key in problems:
        print(f"DIFF {key}:", file=sys.stderr)
        print(f"  导出前: {json.dumps(before[key], ensure_ascii=False)[:600]}", file=sys.stderr)
        print(f"  恢复后: {json.dumps(after.get(key), ensure_ascii=False)[:600]}", file=sys.stderr)
    raise SystemExit(1)
print("ok 恢复后数据逐项一致：" + ", ".join(sorted(before)))
PY
then
  echo "FAIL: 加密备份恢复后数据不一致（见上）"
  exit 1
fi

# ---------------------------------------------------------------- 认证失败限流
# 主控按 IP 记录认证失败：20 次坏 Bearer 后第 21 次必须 429。
# 同时守住「不连坐」：同一 IP 上已登录的合法 Cookie 会话仍要能访问。
# 放在最后一段跑，避免 10 分钟锁定影响前面所有依赖坏凭据的断言。
echo "--- 限流：20 次坏 Bearer → 第 21 次 429；合法 Cookie 会话不连坐 ---"
BAD_BEARER="pwt_e2e_invalid_token"
for i in $(seq 1 20); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer ${BAD_BEARER}" "$BASE/api/v1/servers")
  [ "$CODE" = "401" ] \
    || { echo "FAIL: 第 ${i} 次坏 Bearer 应为 401（阈值 20 次），实际 ${CODE}"; exit 1; }
done
CODE=$(curl -s -D "$WORK/rate-limit.headers" -o "$WORK/rate-limit.json" -w '%{http_code}' \
  -H "Authorization: Bearer ${BAD_BEARER}" "$BASE/api/v1/servers")
[ "$CODE" = "429" ] \
  || { echo "FAIL: 第 21 次坏 Bearer 应为 429，实际 ${CODE}"; head -c 400 "$WORK/rate-limit.json"; echo; exit 1; }
grep -qi '^retry-after: [0-9][0-9]*' "$WORK/rate-limit.headers" \
  || { echo "FAIL: 429 响应缺少 Retry-After 头"; head -20 "$WORK/rate-limit.headers"; exit 1; }
echo "ok 20 次 401 之后第 21 次返回 429（带 Retry-After）"

CODE=$(curl -s -b "$WORK/cookie" -o /dev/null -w '%{http_code}' "$BASE/api/v1/servers")
[ "$CODE" = "200" ] \
  || { echo "FAIL: IP 被限流后合法 Cookie 会话应仍 200（不连坐），实际 ${CODE}"; exit 1; }
echo "ok 同一 IP 上合法 Cookie 会话仍 200（不连坐）"

echo "PASS 全部通过（日志：$WORK/master.log, $WORK/agent.log）"
