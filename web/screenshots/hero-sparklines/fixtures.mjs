/**
 * hero 迷你图的截图假数据 / Fixtures for the hero sparkline screenshots.
 *
 * 复用公开状态页的 8 台服务器，只改三处：
 * - `buckets_24h`：每台各掉一个小时（0.5），让 24h 可用率折线有真的起伏，
 *   并把 `uptime_24h` 按同一份桶算出来，图与 KPI 数字不会互相打脸；
 * - `series`：最近一小时、5 分钟一个点（12 个点）；
 * - `latency_ms` / 当前速率：`zero` 状态下全部为 0，用来证明「0 是数据」。
 *
 * 四种状态：
 * - `empty`   全新部署：没有 `series`，所有 `buckets_24h` 为 null → 三张图全部空态；
 * - `legacy`  旧后端：没有 `series`，但 24h 桶完整 → 延迟 / 速率空态，可用率仍画线；
 * - `partial` series 有断点、24h 桶中间 3 小时全缺 → 三张图都断线；
 * - `full`    series 完整、24h 桶完整 → 三张图都是完整折线；
 * - `zero`    series 与桶全是 0（不是 null）→ 三张图都画线，速率贴底。
 */

import { statusFixture } from "../status-hero/fixtures.mjs";

const MB = 1024 * 1024;
const POINTS = 12;
const STEP = 300;

const STATES = ["empty", "legacy", "partial", "full", "zero"];

function bucketsFor(state) {
  if (state === "empty") {
    return Array.from({ length: 24 }, () => null);
  }
  if (state === "zero") {
    return Array.from({ length: 24 }, (_, index) => ({
      ts: 0,
      online_ratio: 0,
    }));
  }
  return Array.from({ length: 24 }, (_, index) => ({
    ts: 1_700_000_000 + index * 3_600,
    // 一次两小时的小事故（所有机器都掉一半），其余时间满格。
    ...(index === 10 || index === 11
      ? { online_ratio: 0.5 }
      : // partial：16–18 点所有机器都没有采样，折线必须真的断开。
        state === "partial" && index >= 16 && index <= 18
        ? { online_ratio: null }
        : { online_ratio: 1 }),
  }));
}

/** 按同一份桶算 24h 可用率，KPI 与折线同源。 */
function uptimeFromBuckets(buckets) {
  const values = buckets
    .map((bucket) => bucket?.online_ratio)
    .filter((ratio) => typeof ratio === "number");
  if (values.length === 0) return null;
  return values.reduce((sum, ratio) => sum + ratio, 0) / values.length;
}

function seriesFor(state) {
  // 旧后端 / 全新部署都没有 series；legacy 仍由 buckets 画出可用率。
  if (state === "empty" || state === "legacy") return undefined;

  const now = Math.floor(Date.now() / 1000);
  const t = Array.from({ length: POINTS }, (_, index) =>
    now - (POINTS - 1 - index) * STEP,
  );

  if (state === "zero") {
    return {
      window_secs: 3600,
      step_secs: STEP,
      t,
      rate_rx_bps: t.map(() => 0),
      rate_tx_bps: t.map(() => 0),
      latency_ms: t.map(() => 0),
    };
  }

  // 下行为主、上行为辅：46 MB/s 量级，和 hero 的「当前总速率」对得上。
  const wave = (index) => Math.sin(index / 2.4);
  const rate_rx_bps = t.map((_, index) =>
    Math.round((26 + index * 0.9 + wave(index) * 6) * MB),
  );
  const rate_tx_bps = t.map((_, index) =>
    Math.round((4.2 + wave(index + 1) * 1.2 + index * 0.12) * MB),
  );
  const latency_ms = t.map((_, index) =>
    Math.round(44 + Math.sin(index / 1.8) * 11),
  );

  if (state === "partial") {
    // 速率断 2 个点、延迟断一段，且开头就没有采样（新部署最常见的形状）。
    rate_rx_bps[3] = null;
    rate_rx_bps[4] = null;
    rate_tx_bps[7] = null;
    latency_ms[0] = null;
    latency_ms[1] = null;
    latency_ms[7] = null;
    latency_ms[8] = null;
  }

  return {
    window_secs: 3600,
    step_secs: STEP,
    t,
    rate_rx_bps,
    rate_tx_bps,
    latency_ms,
  };
}

export function heroFixture(state) {
  if (!STATES.includes(state)) {
    throw new Error(`unknown hero screenshot state: ${state}`);
  }

  const data = statusFixture("all-online");
  const servers = data.servers.map((server) => {
    const buckets = bucketsFor(state);
    const zero = state === "zero";
    return {
      ...server,
      buckets_24h: buckets,
      uptime_24h: uptimeFromBuckets(buckets),
      uptime_7d: state === "empty" ? null : uptimeFromBuckets(buckets),
      latency_ms: zero ? 0 : server.latency_ms,
      net_rx_bps: zero ? 0 : server.net_rx_bps,
      net_tx_bps: zero ? 0 : server.net_tx_bps,
      ...(state === "empty"
        ? {
            net_rx_bps: null,
            net_tx_bps: null,
            latency_ms: null,
            uptime_secs: null,
          }
        : {}),
    };
  });

  // 全部离线才是「旧后端无数据」的可信场景：没有在线机器、没有采样。
  const offline = state === "empty";
  const finalServers = servers.map((server) =>
    offline
      ? {
          ...server,
          online: false,
          xray_running: false,
          last_seen: null,
        }
      : server,
  );

  const series = seriesFor(state);
  return {
    ...data,
    generated_at: Math.floor(Date.now() / 1000),
    summary: {
      ...data.summary,
      servers_online: offline ? 0 : finalServers.length,
    },
    servers: finalServers,
    ...(series ? { series } : {}),
  };
}
