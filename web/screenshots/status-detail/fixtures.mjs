/**
 * `/status/:id` 截图用的公开状态 fixture。
 *
 * 8 台服务器，第一台是详情目标 `srv-hk`；只使用公开 API 已有的字段，
 * 不引入地址 / 节点 / 用户 / 流量明细。
 */
import { kpiFixture } from "../kpi-audit/fixtures.mjs";

const MB = 1024 * 1024;
const GB = 1024 * MB;
const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3_600;
const UTC8 = 8 * HOUR;

/** 今天 00:00（UTC+8）的 Unix 秒；只用于让最低时段固定落在 03:00–04:00。 */
function midnightUtc8(now = NOW) {
  return Math.floor((now + UTC8) / 86_400) * 86_400 - UTC8;
}

function buckets() {
  const start = midnightUtc8();
  return Array.from({ length: 24 }, (_, index) => ({
    ts: start + index * HOUR,
    // 03:00–04:00 最低；12/13 小时没有采样；其余满格。
    online_ratio: index === 3 ? 0.91 : index === 12 || index === 13 ? null : 1,
  }));
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
    uptime_24h: 0.98,
    uptime_7d: 0.995,
    buckets_24h: buckets(),
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

export const DETAIL_STATES = ["normal", "offline", "nodata"];

export function detailFixture(state) {
  if (state === "offline") {
    return makeFixture({
      online: false,
      xray_running: false,
      last_seen: NOW - 4 * 60,
      uptime_secs: null,
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
