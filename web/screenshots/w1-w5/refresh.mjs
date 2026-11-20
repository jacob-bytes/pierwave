// 重采一遍 24h 采样，并把服务器保持在线态。
//
// 截图脚本依赖「24h 可用率 = 100/99/96/88/71」；种子数据的时间戳会随着
// 真实时间推移滑出 24h 窗口，所以在每次截图前重新写一遍（只动采样表与
// 状态列，不动服务器 / 用户 / 流量）。
//
// 用法：DB_PATH=/tmp/pw-w15/db.sqlite node web/screenshots/w1-w5/refresh.mjs
import { execFileSync } from "node:child_process";

const DB_PATH = process.env.DB_PATH ?? "/tmp/pw-w15/db.sqlite";
const NOW = Math.floor(Date.now() / 1000);
const SLOT = 300;
const SLOTS_PER_HOUR = 12;

const SERVERS = [
  {
    name: "香港-亚太边缘入口-主节点-超长名称用于移动端截断验证",
    load: 0.82,
    rx: 18_400_000,
    tx: 2_300_000,
    latency: 18,
    offline: Array(24).fill(0),
  },
  {
    name: "东京-中转-备用入口",
    load: 1.36,
    rx: 9_800_000,
    tx: 1_100_000,
    latency: 29,
    offline: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0],
  },
  {
    name: "新加坡-专线-长名称节点-二号",
    load: 2.71,
    rx: 6_200_000,
    tx: 980_000,
    latency: 40,
    offline: [0, 0, 0, 8, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  {
    name: "洛杉矶-美洲-测试节点",
    load: 4.48,
    rx: 3_400_000,
    tx: 410_000,
    latency: 51,
    offline: [0, 0, 3, 5, 7, 8, 6, 4, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  {
    name: "法兰克福-欧洲-备用节点",
    load: 5.92,
    rx: 1_900_000,
    tx: 260_000,
    latency: 62,
    offline: [0, 0, 0, 0, 0, 0, 0, 0, 4, 6, 8, 10, 12, 12, 12, 12, 3, 3, 2, 0, 0, 0, 0, 0],
  },
];

const python = `
import json, sqlite3, sys
data = json.load(sys.stdin)
conn = sqlite3.connect(sys.argv[1])
now = data["now"]
for server in data["servers"]:
    row = conn.execute("SELECT id FROM servers WHERE name = ?", (server["name"],)).fetchone()
    if row is None:
        raise SystemExit(f"server not found: {server['name']}")
    server_id = row[0]
    conn.execute(
        """UPDATE servers SET status='online', xray_running=1, last_seen_at=?,
             health_at=?, load1=?, latency_ms=? WHERE id=?""",
        (now, now, server["load"], server["latency"], server_id),
    )
    conn.execute("DELETE FROM server_samples WHERE server_id = ?", (server_id,))
    for row in server["samples"]:
        conn.execute(
            """INSERT INTO server_samples
                 (server_id, ts, online, load1, mem_used, mem_total, disk_used,
                  disk_total, latency_ms, rx_bps, tx_bps)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (server_id, row["ts"], row["online"], server["load"],
             3 * 1024 ** 3, 8 * 1024 ** 3, 42 * 1024 ** 3, 80 * 1024 ** 3,
             server["latency"], row["rx"], row["tx"]),
        )
conn.commit()
print("refreshed", len(data["servers"]), "servers at", now)
`;

const aligned = NOW - (NOW % SLOT);
const first = aligned - (288 - 1) * SLOT;
const servers = SERVERS.map((def) => {
  const online = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const offline = def.offline[hour] ?? 0;
    const step = SLOTS_PER_HOUR / Math.max(1, offline);
    const chosen = new Set();
    for (let index = 0; index < offline; index += 1) {
      chosen.add(Math.min(SLOTS_PER_HOUR - 1, Math.round(index * step)));
    }
    for (let slot = 0; slot < SLOTS_PER_HOUR; slot += 1) {
      online.push(!chosen.has(slot));
    }
  }

  return {
    name: def.name,
    load: def.load,
    latency: def.latency,
    samples: Array.from({ length: 288 }, (_, index) => {
      const wave = Math.sin(index / 8) * 0.35 + 1;
      return {
        ts: first + index * SLOT,
        online: online[index] ? 1 : 0,
        rx: online[index] ? Math.round(def.rx * wave) : 0,
        tx: online[index] ? Math.round(def.tx * (1.4 - wave * 0.4)) : 0,
      };
    }),
  };
});

execFileSync("python3", ["-c", python, DB_PATH], {
  input: JSON.stringify({ now: NOW, servers }),
  stdio: ["pipe", "inherit", "inherit"],
});
