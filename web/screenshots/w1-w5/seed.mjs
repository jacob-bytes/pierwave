// W1–W5 截图用的种子数据：五台不同可用率的服务器、概览榜单、审计日志，
// 以及一个已写入的订阅派生 secret（供 W5 的「解不开」状态使用）。
//
// 只写本机预览库；用法：
//   PREVIEW_BASE=http://127.0.0.1:8798 DB_PATH=/tmp/pw-w15/db.sqlite \
//     node web/screenshots/w1-w5/seed.mjs
//
// 五台服务器的 24h 采样会精确落在 100% / 99% / 96% / 88% / 71%，
// 其中 96% 与 71% 用于 W1 的三档对照。
import { execFileSync } from "node:child_process";

const BASE = process.env.PREVIEW_BASE ?? "http://127.0.0.1:8787";
const DB_PATH = process.env.DB_PATH ?? "/tmp/pw-w15/db.sqlite";
const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3600;
const SLOT = 300;
const SLOTS_PER_HOUR = 12;

// 每台服务器的每小时离线槽数（0–12），24 个数；总和决定 24h 可用率。
// 目标：100%（288/288）、99.3%（286/288）、95.8%（276/288）、
// 87.8%（253/288）、70.8%（204/288）。
const SERVERS = [
  {
    name: "香港-亚太边缘入口-主节点-超长名称用于移动端截断验证",
    address: "edge-hk-01.asia-southeast1.prod.example.internal",
    group: "香港",
    country: "HK",
    load: 0.82,
    rx: 18_400_000,
    tx: 2_300_000,
    trafficGb: 118,
    offline: Array(24).fill(0),
  },
  {
    name: "东京-中转-备用入口",
    address: "edge-jp-02.ap-northeast-1.prod.example.internal",
    group: "日本",
    country: "JP",
    load: 1.36,
    rx: 9_800_000,
    tx: 1_100_000,
    trafficGb: 96,
    offline: [
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1,
      0,
    ],
  },
  {
    name: "新加坡-专线-长名称节点-二号",
    address: "sg-03.ap-southeast-1.example.internal",
    group: "新加坡",
    country: "SG",
    load: 2.71,
    rx: 6_200_000,
    tx: 980_000,
    trafficGb: 74,
    offline: [
      0, 0, 0, 8, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0,
    ],
  },
  {
    name: "洛杉矶-美洲-测试节点",
    address: "lax-05.us-west-2.example.internal",
    group: "美洲",
    country: "US",
    load: 4.48,
    rx: 3_400_000,
    tx: 410_000,
    trafficGb: 52,
    offline: [
      0, 0, 3, 5, 7, 8, 6, 4, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0,
    ],
  },
  {
    name: "法兰克福-欧洲-备用节点",
    address: "fra-04.eu-central-1.example.internal",
    group: "欧洲",
    country: "DE",
    load: 5.92,
    rx: 1_900_000,
    tx: 260_000,
    trafficGb: 41,
    offline: [
      0, 0, 0, 0, 0, 0, 0, 0, 4, 6, 8, 10, 12, 12, 12, 12, 3, 3, 2, 0, 0, 0,
      0, 0,
    ],
  },
];

const NODES = [
  { name: "hk-reality", tag: "hk-reality", protocol: "vless", transport: "tcp", security: "reality", region: "HK" },
  { name: "jp-ws", tag: "jp-ws", protocol: "trojan", transport: "ws", security: "none", region: "JP" },
  { name: "sg-trojan", tag: "sg-trojan", protocol: "trojan", transport: "tcp", security: "none", region: "SG" },
  { name: "us-vmess", tag: "us-vmess", protocol: "vmess", transport: "tcp", security: "none", region: "US" },
  { name: "de-vless", tag: "de-vless", protocol: "vless", transport: "tcp", security: "none", region: "DE" },
];

const USERS = ["alice", "bob", "carol", "dave", "erin"];
const PACKAGES = [
  ["月卡", 100 * 1024 ** 3, 30],
  ["季卡", 300 * 1024 ** 3, 90],
  ["年卡", 1024 ** 4, 365],
];

async function login() {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "devpass" }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  const cookie = res.headers
    .getSetCookie()
    .map((item) => item.split(";")[0])
    .find((item) => item.startsWith("pierwave_session="));
  if (!cookie) throw new Error("no session cookie");
  return cookie;
}

async function api(cookie, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Cookie: cookie,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const value = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return value;
}

async function seed() {
  const cookie = await login();

  const servers = [];
  for (const def of SERVERS) {
    const created = await api(cookie, "POST", "/api/v1/servers", {
      name: def.name,
      address: def.address,
      xray_mode: "external",
      country_code: def.country,
      group_name: def.group,
      internal_address: `10.20.${servers.length + 1}.10`,
    });
    servers.push(created.server);
  }

  const nodes = [];
  for (let index = 0; index < servers.length; index += 1) {
    const created = await api(
      cookie,
      "POST",
      `/api/v1/servers/${servers[index].id}/nodes`,
      {
        ...NODES[index],
        port: 20000 + index * 10,
        region: NODES[index].region,
        tags: [NODES[index].region],
        config: {},
      },
    );
    nodes.push(created.node);
  }

  const users = [];
  for (const username of USERS) {
    const created = await api(cookie, "POST", "/api/v1/users", {
      username,
      password: "password123",
    });
    users.push(created.user);
  }

  const packages = [];
  for (const [name, quota, days] of PACKAGES) {
    const created = await api(cookie, "POST", "/api/v1/packages", {
      name,
      quota_bytes: quota,
      period_days: days,
    });
    packages.push(created.package);
  }

  for (let index = 0; index < users.length; index += 1) {
    await api(cookie, "POST", `/api/v1/users/${users[index].id}/packages`, {
      package_id: packages[index % packages.length].id,
    });
  }

  // 概览 / 审计 / 设置页都需要至少一条链与一条系统设置变更。
  await api(cookie, "POST", "/api/v1/chains", {
    name: "港日中转链",
    target_host: "1.1.1.1",
    target_port: 443,
    enabled: true,
    engine: "native",
    protocol: "tcp",
    groups: [
      {
        strategy: "round_robin",
        members: [{ server_id: servers[0].id, listen_port: 19011, priority: 0 }],
      },
      {
        strategy: "round_robin",
        members: [{ server_id: servers[1].id, priority: 0 }],
      },
    ],
  });

  await api(cookie, "PATCH", "/api/v1/settings", {
    panel_name: "PierWave · 亚太边缘",
    telegram_bot_token: "123456789:AA-broken-token-for-screenshots",
    backup_webdav_password: "webdav-password-to-break",
  });

  // 触发 hmac_secret_v1 的首次生成：订阅渲染会调用 master_secret。
  const sub = await fetch(`${BASE}/api/v1/sub/${users[0].short_code}?target=uri`);
  if (!sub.ok) {
    throw new Error(`subscribe failed: ${sub.status} ${await sub.text()}`);
  }

  return { cookie, servers, users, packages, nodes };
}

/** 直接写采样、网速与 7 天流量：公开页和概览榜单都从这几张表读。 */
function seedTelemetry({ servers, users }) {
  const rows = [];
  const samples = [];

  // 288 个 5 分钟槽，最后一个对齐到当前 5 分钟，确保全部落在 24h 窗口内。
  const aligned = NOW - (NOW % SLOT);
  const first = aligned - (288 - 1) * SLOT;
  // 槽位从旧到新；每个小时 12 个槽。为了让小时桶有形状，把离线槽按
  // 「每小时离线数」摊在这个小时里，而不是全部堆在整点。
  const perHourOffline = [];
  for (const def of SERVERS) {
    const flat = [];
    for (let hour = 0; hour < 24; hour += 1) {
      const offline = def.offline[hour] ?? 0;
      const step = SLOTS_PER_HOUR / Math.max(1, offline);
      const chosen = new Set();
      for (let index = 0; index < offline; index += 1) {
        chosen.add(Math.min(SLOTS_PER_HOUR - 1, Math.round(index * step)));
      }
      for (let slot = 0; slot < SLOTS_PER_HOUR; slot += 1) {
        flat.push(!chosen.has(slot));
      }
    }
    perHourOffline.push(flat);
  }

  servers.forEach((server, serverIndex) => {
    const def = SERVERS[serverIndex];
    const online = perHourOffline[serverIndex];
    for (let index = 0; index < 288; index += 1) {
      const ts = first + index * SLOT;
      const wave = Math.sin(index / 8) * 0.35 + 1;
      const rx = online[index] ? Math.round(def.rx * wave) : 0;
      const tx = online[index] ? Math.round(def.tx * (1.4 - wave * 0.4)) : 0;
      samples.push({
        server_id: server.id,
        ts,
        online: online[index] ? 1 : 0,
        load1: def.load,
        mem_used: Math.round(3.2 * 1024 ** 3),
        mem_total: 8 * 1024 ** 3,
        disk_used: Math.round(42.6 * 1024 ** 3),
        disk_total: 80 * 1024 ** 3,
        rx_bps: rx,
        tx_bps: tx,
        latency_ms: 18 + serverIndex * 11,
      });
    }

    // 7 天服务器流量：概览榜单的排序依据；每个服务器再按用户拆几行。
    for (let day = 6; day >= 0; day -= 1) {
      const date = new Date((NOW - day * 86_400) * 1_000);
      const dayString = date.toISOString().slice(0, 10);
      const total = def.trafficGb * 1024 ** 3 * (1 + (6 - day) * 0.04);
      users.forEach((user, userIndex) => {
        const share = [0.42, 0.27, 0.16, 0.1, 0.05][userIndex];
        const downlink = Math.round(total * share * 0.8);
        const uplink = Math.round(total * share * 0.2);
        rows.push({
          day: dayString,
          server_id: server.id,
          subject: user.id,
          uplink,
          downlink,
          weighted: uplink + downlink,
        });
      });
    }
  });

  const python = `
import json, sqlite3, sys
data = json.load(sys.stdin)
conn = sqlite3.connect(sys.argv[1])
now = data["now"]
for server in data["servers"]:
    conn.execute(
        """UPDATE servers SET status='online', xray_running=1, nginx_running=1,
             last_seen_at=?, health_at=?, load1=?, mem_used=?, mem_total=?,
             disk_used=?, disk_total=?, uptime_secs=?, os_name=?, os_version=?,
             virt=?, arch=?, net_rx_bytes=?, net_tx_bytes=?, net_at=?,
             net_rx_bps=?, net_tx_bps=?, latency_ms=? WHERE id=?""",
        (now, now, server["load"], server["mem_used"], server["mem_total"],
         server["disk_used"], server["disk_total"], server["uptime_secs"],
         "Debian GNU/Linux", "12", "kvm", "x86_64",
         server["net_rx_bytes"], server["net_tx_bytes"], now,
         server["net_rx_bps"], server["net_tx_bps"], server["latency_ms"],
         server["id"]),
    )
for row in data["samples"]:
    conn.execute(
        """INSERT INTO server_samples
             (server_id, ts, online, load1, mem_used, mem_total, disk_used,
              disk_total, latency_ms, rx_bps, tx_bps)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(server_id, ts) DO UPDATE SET
             online=excluded.online, load1=excluded.load1,
             mem_used=excluded.mem_used, mem_total=excluded.mem_total,
             disk_used=excluded.disk_used, disk_total=excluded.disk_total,
             latency_ms=excluded.latency_ms, rx_bps=excluded.rx_bps,
             tx_bps=excluded.tx_bps""",
        (row["server_id"], row["ts"], row["online"], row["load1"],
         row["mem_used"], row["mem_total"], row["disk_used"],
         row["disk_total"], row["latency_ms"], row["rx_bps"], row["tx_bps"]),
    )
for row in data["traffic"]:
    conn.execute(
        """INSERT INTO traffic_daily
             (day, server_id, subject, uplink, downlink, weighted)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(day, server_id, subject) DO UPDATE SET
             uplink=excluded.uplink, downlink=excluded.downlink,
             weighted=excluded.weighted""",
        (row["day"], row["server_id"], row["subject"], row["uplink"],
         row["downlink"], row["weighted"]),
    )
conn.commit()
print("seeded", len(data["samples"]), "samples,", len(data["traffic"]), "traffic rows")
`;

  execFileSync("python3", ["-c", python, DB_PATH], {
    input: JSON.stringify({
      now: NOW,
      servers: servers.map((server, index) => {
        const def = SERVERS[index];
        return {
          id: server.id,
          load: def.load,
          mem_used: Math.round(3.2 * 1024 ** 3),
          mem_total: 8 * 1024 ** 3,
          disk_used: Math.round(42.6 * 1024 ** 3),
          disk_total: 80 * 1024 ** 3,
          uptime_secs: 60 * 60 * 24 * (14 + index),
          net_rx_bytes: 42 * 1024 ** 3,
          net_tx_bytes: 6 * 1024 ** 3,
          net_rx_bps: def.rx,
          net_tx_bps: def.tx,
          latency_ms: 18 + index * 11,
        };
      }),
      samples,
      traffic: rows,
    }),
    stdio: ["pipe", "inherit", "inherit"],
  });
}

const seeded = await seed();
seedTelemetry(seeded);
console.log(
  "seeded",
  seeded.servers.length,
  "servers /",
  seeded.users.length,
  "users /",
  seeded.nodes.length,
  "nodes",
);
