/**
 * 公开状态页截图用的假数据 / Fixtures for the public status page screenshots.
 *
 * 形状与 `GET /api/v1/public/status` 完全一致（字段、24 个小时桶、分组），
 * 8 台服务器、3 个分组；不启动后端、不发真实请求，由 Playwright 拦截返回。
 *
 * 四种状态：
 * - all-online   8/8 在线，可用率全部达标
 * - partial      7/8 在线（首尔离线），可用率全部达标
 * - all-offline  0/8 在线，24h 可用率无采样
 * - low          8/8 在线，洛杉矶 80% → 1 台可用率偏低
 */

const NOW = Math.floor(Date.now() / 1000);
const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

function hourlyBuckets(seed) {
  return Array.from({ length: 24 }, (_, index) => ({
    ts: NOW - (23 - index) * 3600,
    // 稀疏的掉线格：让未改动的卡片点阵在截图里仍然有颜色层次。
    online_ratio: (index + seed) % 11 === 0 ? 0.5 : 1,
  }));
}

const NO_BUCKETS = Array.from({ length: 24 }, () => null);

const SERVERS = [
  {
    id: "srv-hk",
    name: "香港-亚太边缘入口",
    country_code: "HK",
    group_name: "亚太",
    load1: 0.44,
    mem_used: 3.2 * GB,
    mem_total: 8 * GB,
    disk_used: 42.6 * GB,
    disk_total: 80 * GB,
    uptime_secs: 14 * 86_400 + 3 * 3_600,
    latency_ms: 18,
    os_name: "Debian GNU/Linux",
    os_version: "12",
    virt: "kvm",
    arch: "x86_64",
    net_rx_bps: 17.5 * MB,
    net_tx_bps: 2.19 * MB,
    net_rx_bytes: 1.24 * 1024 * GB,
    net_tx_bytes: 186 * GB,
    uptime_24h: 1,
    uptime_7d: 1,
    buckets: hourlyBuckets(1),
  },
  {
    id: "srv-tokyo",
    name: "东京-中转备用入口",
    country_code: "JP",
    group_name: "亚太",
    load1: 1.36,
    mem_used: 3.2 * GB,
    mem_total: 8 * GB,
    disk_used: 42.6 * GB,
    disk_total: 80 * GB,
    uptime_secs: 15 * 86_400 + 8 * 3_600,
    latency_ms: 29,
    os_name: "Debian GNU/Linux",
    os_version: "12",
    virt: "kvm",
    arch: "x86_64",
    net_rx_bps: 9.35 * MB,
    net_tx_bps: 1.05 * MB,
    net_rx_bytes: 684 * GB,
    net_tx_bytes: 92 * GB,
    uptime_24h: 1,
    uptime_7d: 0.99,
    buckets: hourlyBuckets(2),
  },
  {
    id: "srv-sg",
    name: "新加坡-专线-长名称节点",
    country_code: "SG",
    group_name: "亚太",
    load1: 2.71,
    mem_used: 3.2 * GB,
    mem_total: 8 * GB,
    disk_used: 42.6 * GB,
    disk_total: 80 * GB,
    uptime_secs: 16 * 86_400 + 2 * 3_600,
    latency_ms: 40,
    os_name: "Debian GNU/Linux",
    os_version: "12",
    virt: "kvm",
    arch: "x86_64",
    net_rx_bps: 5.91 * MB,
    net_tx_bps: 0.957 * MB,
    net_rx_bytes: 412 * GB,
    net_tx_bytes: 74 * GB,
    uptime_24h: 1,
    uptime_7d: 0.96,
    buckets: hourlyBuckets(3),
  },
  {
    id: "srv-seoul",
    name: "首尔-亚太-新节点",
    country_code: "KR",
    group_name: "亚太",
    load1: null,
    mem_used: 1.1 * GB,
    mem_total: 4 * GB,
    disk_used: 12.4 * GB,
    disk_total: 40 * GB,
    uptime_secs: 2 * 86_400,
    latency_ms: 33,
    os_name: "Ubuntu",
    os_version: "24.04",
    virt: "kvm",
    arch: "aarch64",
    net_rx_bps: 0,
    net_tx_bps: 0,
    net_rx_bytes: 186 * GB,
    net_tx_bytes: 21 * GB,
    uptime_24h: 0.98,
    uptime_7d: 0.96,
    buckets: hourlyBuckets(4),
  },
  {
    id: "srv-la",
    name: "洛杉矶-美洲-测试节点",
    country_code: "US",
    group_name: "美洲",
    load1: 5.92,
    mem_used: 6.4 * GB,
    mem_total: 16 * GB,
    disk_used: 42.6 * GB,
    disk_total: 80 * GB,
    uptime_secs: 17 * 86_400 + 6 * 3_600,
    latency_ms: 51,
    os_name: "Debian GNU/Linux",
    os_version: "12",
    virt: "kvm",
    arch: "x86_64",
    net_rx_bps: 3.24 * MB,
    net_tx_bps: 0.4 * MB,
    net_rx_bytes: 96 * GB,
    net_tx_bytes: 12 * GB,
    uptime_24h: 0.99,
    uptime_7d: 0.92,
    buckets: hourlyBuckets(5),
  },
  {
    id: "srv-sj",
    name: "圣何塞-美洲-备用入口",
    country_code: "US",
    group_name: "美洲",
    load1: 0.44,
    mem_used: 3.2 * GB,
    mem_total: 8 * GB,
    disk_used: 42.6 * GB,
    disk_total: 80 * GB,
    uptime_secs: 9 * 86_400 + 4 * 3_600,
    latency_ms: 62,
    os_name: "Ubuntu",
    os_version: "24.04",
    virt: "kvm",
    arch: "x86_64",
    net_rx_bps: 0.812 * MB,
    net_tx_bps: 0.096 * MB,
    net_rx_bytes: 48 * GB,
    net_tx_bytes: 6.2 * GB,
    uptime_24h: 1,
    uptime_7d: 1,
    buckets: hourlyBuckets(6),
  },
  {
    id: "srv-ffm",
    name: "法兰克福-欧洲-备用节点",
    country_code: "DE",
    group_name: "欧洲",
    load1: 4.12,
    mem_used: 5.1 * GB,
    mem_total: 16 * GB,
    disk_used: 76 * GB,
    disk_total: 160 * GB,
    uptime_secs: 18 * 86_400 + 1 * 3_600,
    latency_ms: 62,
    os_name: "Debian GNU/Linux",
    os_version: "12",
    virt: "kvm",
    arch: "x86_64",
    net_rx_bps: 1.81 * MB,
    net_tx_bps: 0.254 * MB,
    net_rx_bytes: 212 * GB,
    net_tx_bytes: 38 * GB,
    uptime_24h: 1,
    uptime_7d: 1,
    buckets: hourlyBuckets(7),
  },
  {
    id: "srv-ams",
    name: "阿姆斯特丹-欧洲-入口",
    country_code: "NL",
    group_name: "欧洲",
    load1: 0.67,
    mem_used: 2.6 * GB,
    mem_total: 8 * GB,
    disk_used: 38 * GB,
    disk_total: 80 * GB,
    uptime_secs: 12 * 86_400 + 9 * 3_600,
    latency_ms: 58,
    os_name: "Debian GNU/Linux",
    os_version: "12",
    virt: "kvm",
    arch: "x86_64",
    net_rx_bps: 2.42 * MB,
    net_tx_bps: 0.31 * MB,
    net_rx_bytes: 132 * GB,
    net_tx_bytes: 19 * GB,
    uptime_24h: 1,
    uptime_7d: 1,
    buckets: hourlyBuckets(8),
  },
];

function toServer(server, state) {
  const offline = state === "all-offline" || (state === "partial" && server.id === "srv-seoul");
  const noSamples = state === "all-offline";
  const low = state === "low" && server.id === "srv-la";

  const uptime24h = noSamples ? null : low ? 0.8 : server.uptime_24h;

  return {
    id: server.id,
    name: server.name,
    online: !offline,
    xray_running: offline ? false : true,
    load1: server.load1,
    mem_used: server.mem_used,
    mem_total: server.mem_total,
    disk_used: server.disk_used,
    disk_total: server.disk_total,
    uptime_secs: offline ? null : server.uptime_secs,
    last_seen: offline ? NOW - 3 * 3_600 : NOW - 12,
    net_rx_bps: server.net_rx_bps,
    net_tx_bps: server.net_tx_bps,
    net_rx_bytes: server.net_rx_bytes,
    net_tx_bytes: server.net_tx_bytes,
    latency_ms: offline ? null : server.latency_ms,
    country_code: server.country_code,
    os_name: server.os_name,
    os_version: server.os_version,
    virt: server.virt,
    arch: server.arch,
    uptime_24h: uptime24h,
    uptime_7d: noSamples ? null : server.uptime_7d,
    buckets_24h: noSamples ? NO_BUCKETS : server.buckets,
    group_name: server.group_name,
  };
}

export function statusFixture(state) {
  const servers = SERVERS.map((server) => toServer(server, state));
  const online = servers.filter((server) => server.online).length;

  return {
    panel_name: "PierWave · 亚太边缘",
    generated_at: Math.floor(Date.now() / 1000),
    summary: {
      servers_total: servers.length,
      servers_online: online,
      nodes_total: 32,
      traffic_today: 472 * GB,
      traffic_month: 2.92 * 1024 * GB,
    },
    servers,
  };
}

export const EXPECTED = {
  "all-online": {
    zh: "全部 8 台服务器在线，服务正常",
    en: "All 8 servers online, service normal",
    online: "8 / 8",
    availability: "100%",
    rateMissing: false,
  },
  partial: {
    zh: "7 / 8 台在线，1 台离线",
    en: "7 / 8 online, 1 offline",
    online: "7 / 8",
    availability: "100%",
    rateMissing: false,
  },
  "all-offline": {
    zh: "当前没有在线服务器",
    en: "No servers online right now",
    online: "0 / 8",
    availability: "—",
    rateMissing: true,
  },
  low: {
    zh: "全部 8 台服务器在线，1 台可用率偏低",
    en: "All 8 servers online, 1 with low availability",
    online: "8 / 8",
    availability: "97%",
    rateMissing: false,
  },
};
