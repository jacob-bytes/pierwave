/**
 * `/status/:id` 方案 B 截图用的公开状态 fixture。
 *
 * 8 台服务器，第一台是详情目标 `srv-hk`；只使用公开 API 已有的字段。
 * 三种目标数据：
 * - healthy：24 个桶全部 100%，用来检查健康态是否安静；
 * - incident：包含 0%（中断）、91%（下降）与 null（无采样）小时；
 * - nodata：所有数值与桶都是 null，检查 `—` / 斜线空桶。
 */
import { kpiFixture } from "../kpi-audit/fixtures.mjs";

const MB = 1024 * 1024;
const GB = 1024 * MB;
const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3_600;
const UTC8 = 8 * HOUR;

/** 今天 00:00（UTC+8）的 Unix 秒，桶从 00:00 开始，最低点可落在 03:00。 */
function midnightUtc8(now = NOW) {
  return Math.floor((now + UTC8) / 86_400) * 86_400 - UTC8;
}

function healthyBuckets() {
  const start = midnightUtc8();
  return Array.from({ length: 24 }, (_, index) => ({
    ts: start + index * HOUR,
    online_ratio: 1,
  }));
}

function incidentBuckets() {
  const start = midnightUtc8();
  return Array.from({ length: 24 }, (_, index) => {
    const ts = start + index * HOUR;
    if (index === 2 || index === 3) return null; // 缺口
    if (index === 3) return null;
    if (index >= 8 && index <= 10) {
      return { ts, online_ratio: 0 }; // 三小时中断，0% 落在基线
    }
    if (index === 14) return { ts, online_ratio: 0.91 }; // 下降
    if (index === 18) return null; // 第二个缺口
    return { ts, online_ratio: 1 };
  });
}

/** UTC+8 业务日 + N 天，`YYYY-MM-DD`。 */
function utc8DayAfter(days) {
  const date = new Date((NOW + UTC8 + days * 86_400) * 1_000);
  return date.toISOString().slice(0, 10);
}

function target(overrides) {
  return {
    id: "srv-hk",
    name: "香港-亚太边缘入口",
    online: true,
    xray_running: true,
    load1: 0.44,
    mem_used: 3.2 * GB,
    mem_total: 8 * GB,
    disk_used: 42.6 * GB,
    disk_total: 80 * GB,
    uptime_secs: 14 * 86_400 + 3 * HOUR,
    last_seen: NOW - 12,
    net_rx_bps: 17.5 * MB,
    net_tx_bps: 2.19 * MB,
    net_rx_bytes: 1.24 * 1024 * GB,
    net_tx_bytes: 186 * GB,
    latency_ms: 18,
    country_code: "HK",
    os_name: "Debian GNU/Linux",
    os_version: "12",
    virt: "kvm",
    arch: "x86_64",
    uptime_24h: 1,
    uptime_7d: 1,
    buckets_24h: healthyBuckets(),
    group_name: "亚太",
    paid_until: utc8DayAfter(27),
    price_cents: 26_800,
    currency: "CNY",
    billing_cycle: "monthly",
    ...overrides,
  };
}

function makeFixture(targetOverrides) {
  const data = kpiFixture("baseline");
  const servers = data.servers.map((server, index) =>
    index === 0 ? { ...server, ...target(targetOverrides) } : server,
  );
  return {
    ...data,
    panel_name: "PierWave · 亚太边缘",
    generated_at: NOW,
    servers,
  };
}

export function detailFixture(state) {
  if (state === "incident") {
    return makeFixture({
      uptime_24h: 0.86,
      uptime_7d: 0.987,
      buckets_24h: incidentBuckets(),
    });
  }
  if (state === "offline") {
    return makeFixture({
      online: false,
      xray_running: false,
      last_seen: NOW - 4 * 60,
      uptime_secs: null,
      uptime_24h: 0.86,
      uptime_7d: 0.987,
      buckets_24h: incidentBuckets(),
    });
  }
  if (state === "nodata") {
    return makeFixture({
      online: true,
      xray_running: null,
      load1: null,
      mem_used: null,
      mem_total: null,
      disk_used: null,
      disk_total: null,
      uptime_secs: null,
      last_seen: null,
      net_rx_bps: null,
      net_tx_bps: null,
      net_rx_bytes: null,
      net_tx_bytes: null,
      latency_ms: null,
      os_name: null,
      os_version: null,
      virt: null,
      arch: "",
      uptime_24h: null,
      uptime_7d: null,
      buckets_24h: Array.from({ length: 24 }, () => null),
      paid_until: null,
      price_cents: null,
      currency: null,
      billing_cycle: null,
    });
  }
  return makeFixture({});
}
