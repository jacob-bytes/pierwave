/**
 * 公开状态页 hero 三个 KPI 的极值 fixture / Extreme-value fixtures for the
 * public status hero KPIs.
 *
 * 形状与 `GET /api/v1/public/status` 一致；由 Playwright 拦截返回，不启动后端、
 * 不写库、不改 `web/src`。每个 fixture 都是 8 台在线机器（除显式说明外），
 * 方便和正常数据对照。
 *
 * 单位统一用 1024 进制（与 `web/src/lib/netRate.ts` 一致）。
 */

const NOW = Math.floor(Date.now() / 1000);
const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;
const TB = 1024 * GB;

/** 最近 24 小时、每小时一个桶；`ratio` 可以给函数做逐桶变化。 */
function buckets24(ratio = 1) {
  return Array.from({ length: 24 }, (_, index) => ({
    ts: NOW - (23 - index) * 3600,
    online_ratio: typeof ratio === "function" ? ratio(index) : ratio,
  }));
}

/** 最近一小时的 12 个 5 分钟采样点。 */
function makeSeries({
  points = 12,
  rx = () => 98.4 * MB,
  tx = () => 16.8 * MB,
  latency = () => 25,
  step = 300,
} = {}) {
  return {
    window_secs: 3600,
    step_secs: step,
    t: Array.from({ length: points }, (_, i) => NOW - (points - 1 - i) * step),
    rate_rx_bps: Array.from({ length: points }, (_, i) => rx(i)),
    rate_tx_bps: Array.from({ length: points }, (_, i) => tx(i)),
    latency_ms: Array.from({ length: points }, (_, i) => latency(i)),
  };
}

function makeServer(index, overrides = {}) {
  return {
    id: `srv-kpi-${index + 1}`,
    name: `节点 ${index + 1} · 亚太`,
    online: true,
    xray_running: true,
    load1: 0.4 + index * 0.11,
    mem_used: 4 * GB,
    mem_total: 16 * GB,
    disk_used: 40 * GB,
    disk_total: 80 * GB,
    uptime_secs: 20 * 86_400,
    last_seen: NOW - 10,
    net_rx_bps: 12.3 * MB,
    net_tx_bps: 2.1 * MB,
    net_rx_bytes: 100 * GB,
    net_tx_bytes: 20 * GB,
    latency_ms: 25,
    country_code: "HK",
    os_name: "Debian GNU/Linux",
    os_version: "12",
    virt: "kvm",
    arch: "x86_64",
    uptime_24h: 1,
    uptime_7d: 1,
    buckets_24h: buckets24(1),
    group_name: null,
    ...overrides,
  };
}

/**
 * 每个 fixture 返回完整响应体。
 *
 * `servers` 可以是函数 `(index, serverIndex) => overrides`；默认 8 台。
 */
const DEFINITIONS = {
  /** 正常数据，作为字号 / 基线 / 对齐的对照组。 */
  baseline: () => ({ servers: () => ({}), series: makeSeries() }),

  /** 单机 999 GB/s（下行），其余机器接近空闲。 */
  "rate-999gb-single": () => ({
    servers: (i) =>
      i === 0
        ? { net_rx_bps: 999 * GB, net_tx_bps: 85 * GB }
        : { net_rx_bps: 0.5 * MB, net_tx_bps: 0.2 * MB },
    series: makeSeries({
      rx: (i) => 999 * GB - i * 2 * GB,
      tx: (i) => 85 * GB - i * 0.4 * GB,
    }),
  }),

  /** 8 台 × 500 GB/s：合计 4000 GB/s，应自动换算成 TB/s。 */
  "rate-8x500gb": () => ({
    servers: () => ({ net_rx_bps: 500 * GB, net_tx_bps: 500 * GB }),
    series: makeSeries({
      rx: () => 4000 * GB,
      tx: () => 4000 * GB,
    }),
  }),

  /** 每秒百万级字节：8 台 × 1,000,000 B/s。 */
  "rate-million": () => ({
    servers: () => ({ net_rx_bps: 1_000_000, net_tx_bps: 1_000_000 }),
    series: makeSeries({ rx: () => 8_000_000, tx: () => 8_000_000 }),
  }),

  /** 合计 1 B/s（其余为真实 0）。 */
  "rate-1bps": () => ({
    servers: (i) =>
      i === 0 ? { net_rx_bps: 1, net_tx_bps: 1 } : { net_rx_bps: 0, net_tx_bps: 0 },
    series: makeSeries({ rx: () => 1, tx: () => 1 }),
  }),

  /** 真实 0：两个方向都是有效读数。 */
  "rate-zero": () => ({
    servers: () => ({ net_rx_bps: 0, net_tx_bps: 0 }),
    series: makeSeries({ rx: () => 0, tx: () => 0 }),
  }),

  /** 只有一个方向缺数据：下行 null、上行正常。 */
  "rate-rx-missing": () => ({
    servers: () => ({ net_rx_bps: null, net_tx_bps: 12.3 * MB }),
    series: makeSeries({ rx: () => null, tx: () => 98.4 * MB }),
  }),

  /** 两个方向都缺数据：整组显示一个 —。 */
  "rate-both-missing": () => ({
    servers: () => ({ net_rx_bps: null, net_tx_bps: null }),
    series: makeSeries({ rx: () => null, tx: () => null }),
  }),

  /** MB/s 与 GB/s 混排：下行 2 GB/s、上行 800 MB/s。 */
  "rate-mixed-units": () => ({
    servers: () => ({ net_rx_bps: 256 * MB, net_tx_bps: 100 * MB }),
    series: makeSeries({ rx: () => 2 * GB, tx: () => 800 * MB }),
  }),

  /**
   * 1024 进制边界：1024^4 - 1 B/s = 1023.9999999999999 GB/s。
   * `rateParts` 会先按 GB 缩放再四舍五入成 1024，于是出现 `1024 GB/s`
   * 而不是 `1 TB/s`（单位不自动进位）。
   */
  "rate-boundary-1024": () => ({
    servers: (i) =>
      i === 0
        ? { net_rx_bps: TB - 1, net_tx_bps: 1 }
        : { net_rx_bps: 0, net_tx_bps: 0 },
    series: makeSeries({ rx: () => TB - 1, tx: () => 1 }),
  }),

  /** 两个方向都卡在 1024 进位边界：都显示 `1024 GB/s`，数字最长。 */
  "rate-1024-both": () => ({
    servers: (i) =>
      i === 0
        ? { net_rx_bps: TB - 1, net_tx_bps: TB - 1 }
        : { net_rx_bps: 0, net_tx_bps: 0 },
    series: makeSeries({ rx: () => TB - 1, tx: () => TB - 1 }),
  }),

  /** 亚字节级：0.001 B/s / 0.4 B/s 都被 Math.round 成 0 B/s。 */
  "rate-tiny": () => ({
    servers: (i) =>
      i === 0 ? { net_rx_bps: 0.001, net_tx_bps: 0.4 } : { net_rx_bps: 0, net_tx_bps: 0 },
    series: makeSeries({ rx: () => 0.001, tx: () => 0.4 }),
  }),

  "uptime-100": () => ({ servers: () => ({ uptime_24h: 1 }) }),
  "uptime-0": () => ({
    servers: () => ({ uptime_24h: 0, buckets_24h: buckets24(0) }),
  }),
  /** 99.99%：`availabilityPercent` 四舍五入成 100%。 */
  "uptime-9999": () => ({
    servers: () => ({ uptime_24h: 0.9999, buckets_24h: buckets24(0.9999) }),
  }),
  /** 99.9%（一位小数）：同样被四舍五入成 100%。 */
  "uptime-999": () => ({
    servers: () => ({ uptime_24h: 0.999, buckets_24h: buckets24(0.999) }),
  }),
  "uptime-null": () => ({
    servers: () => ({ uptime_24h: null, buckets_24h: buckets24(null) }),
  }),
  /** 一半机器无采样、一半 100%：均值只算有采样的。 */
  "uptime-mixed-null": () => ({
    servers: (i) => ({
      uptime_24h: i % 2 === 0 ? null : 1,
      buckets_24h: i % 2 === 0 ? buckets24(null) : buckets24(1),
    }),
  }),

  "latency-1": () => ({
    servers: () => ({ latency_ms: 1 }),
    series: makeSeries({ latency: () => 1 }),
  }),
  "latency-9999": () => ({
    servers: () => ({ latency_ms: 9999 }),
    series: makeSeries({ latency: () => 9999 }),
  }),
  "latency-0": () => ({
    servers: () => ({ latency_ms: 0 }),
    series: makeSeries({ latency: () => 0 }),
  }),
  "latency-null": () => ({
    servers: () => ({ latency_ms: null }),
    series: makeSeries({ latency: () => null }),
  }),
  /** 混合 null：只有一半在线机器有 RTT，均值只算有读数的一半。 */
  "latency-mixed-null": () => ({
    servers: (i) => ({ latency_ms: i % 2 === 0 ? null : 41 + i }),
    series: makeSeries({ latency: (i) => (i % 2 === 0 ? null : 41 + i) }),
  }),
  /** 五位数延迟：检验千分位与长数字。 */
  "latency-12345": () => ({
    servers: () => ({ latency_ms: 12345 }),
    series: makeSeries({ latency: () => 12345 }),
  }),

  /** series 全 null：三张图都应进「数据收集中」，大数字仍用服务器现算。 */
  "series-all-null": () => ({
    servers: () => ({}),
    series: makeSeries({ rx: () => null, tx: () => null, latency: () => null }),
  }),
  /** series 部分 null：折线断笔，x 位置保留。 */
  "series-partial-null": () => ({
    servers: () => ({}),
    series: makeSeries({
      rx: (i) => (i % 3 === 1 ? null : 98.4 * MB),
      tx: (i) => (i % 4 === 2 ? null : 16.8 * MB),
      latency: (i) => (i % 3 === 2 ? null : 25),
    }),
  }),
  /** 少于 12 个点。 */
  "series-5-points": () => ({
    servers: () => ({}),
    series: makeSeries({ points: 5, step: 720 }),
  }),
  /** 多于 12 个点。 */
  "series-40-points": () => ({
    servers: () => ({}),
    series: makeSeries({ points: 40, step: 90 }),
  }),
  /** 负数：几何层应把它们当缺口，而不是把纵轴拉坏。 */
  "series-negative": () => ({
    servers: () => ({}),
    series: makeSeries({
      rx: (i) => (i === 2 || i === 7 ? -5 * MB : 98.4 * MB),
      tx: (i) => (i === 4 ? -1 * MB : 16.8 * MB),
      latency: (i) => (i === 5 ? -20 : 25),
    }),
  }),

  /** 24h 桶只有 5 个：图只画前 5 格，其余是 null 缺口。 */
  "buckets-5": () => ({
    servers: (i) => ({
      uptime_24h: 1,
      buckets_24h: buckets24(1).slice(0, 5 + (i % 3)),
    }),
  }),
  /** 24h 桶有 40 个：多出来的应被忽略。 */
  "buckets-40": () => ({
    servers: () => ({
      uptime_24h: 1,
      buckets_24h: Array.from({ length: 40 }, (_, index) => ({
        ts: NOW - (39 - index) * 3600,
        online_ratio: 1,
      })),
    }),
  }),
  /** 大数字 100%，但 24h 桶全空：图和数字会互相矛盾。 */
  "buckets-null": () => ({
    servers: () => ({ uptime_24h: 1, buckets_24h: buckets24(null) }),
  }),

  // ---- A. 单序列内的量级突变 -------------------------------------------------------

  /** 速率：[2 MB/s × 11, 2000 MB/s]（1000 倍跳变）。 */
  "temporal-spike-rate": () => ({
    servers: (i) =>
      i === 0
        ? { net_rx_bps: 2000 * MB, net_tx_bps: 2 * MB }
        : { net_rx_bps: 0, net_tx_bps: 0 },
    // 上行留空，避免恒定的 2 MB/s 上行线盖住同高度的下行小值；
    // 这一段要看的就是单条序列从 2 MB/s 跳到 2000 MB/s。
    series: makeSeries({
      rx: (i) => (i === 11 ? 2000 * MB : 2 * MB),
      tx: () => null,
    }),
  }),

  /** 延迟：[28 ms × 11, 9000 ms]（约 321 倍）。 */
  "temporal-spike-latency": () => ({
    servers: () => ({ latency_ms: 9000 }),
    series: makeSeries({ latency: (i) => (i === 11 ? 9000 : 28) }),
  }),

  /** 可用率：[1.0 × 23, 0.0]（固定 0–1 域，最后掉到 0）。 */
  "temporal-spike-uptime": () => ({
    servers: () => ({
      uptime_24h: 23 / 24,
      buckets_24h: buckets24((index) => (index === 23 ? 0 : 1)),
    }),
  }),

  // ---- B. 双线量级悬殊（共用同一比例尺） --------------------------------------------

  /** 下行 2000 MB/s、上行 2 MB/s（1000 倍差）。 */
  "dual-gap-rx-high": () => ({
    servers: (i) =>
      i === 0
        ? { net_rx_bps: 2000 * MB, net_tx_bps: 2 * MB }
        : { net_rx_bps: 0, net_tx_bps: 0 },
    series: makeSeries({ rx: () => 2000 * MB, tx: () => 2 * MB }),
  }),

  /** 下行 2 MB/s、上行 2000 MB/s（反过来）。 */
  "dual-gap-tx-high": () => ({
    servers: (i) =>
      i === 0
        ? { net_rx_bps: 2 * MB, net_tx_bps: 2000 * MB }
        : { net_rx_bps: 0, net_tx_bps: 0 },
    series: makeSeries({ rx: () => 2 * MB, tx: () => 2000 * MB }),
  }),

  /** 英文标签 + 五位数延迟 + MB/s 与 GB/s 混排。 */
  "longtext-en": () => ({
    servers: (i) => ({
      latency_ms: 12345,
      net_rx_bps: i < 2 ? 1.5 * GB : 512 * MB,
      net_tx_bps: i < 2 ? 700 * MB : 128 * MB,
      uptime_24h: 0.999,
      buckets_24h: buckets24(0.999),
    }),
    series: makeSeries({
      rx: () => 5 * GB,
      tx: () => 2.8 * GB,
      latency: () => 12345,
    }),
  }),

  /** 与 longtext-en 相同；脚本会把标签替换成更长的英文做压力测试。 */
  "longtext-simulated": () => ({
    servers: (i) => ({
      latency_ms: 12345,
      net_rx_bps: i < 2 ? 1.5 * GB : 512 * MB,
      net_tx_bps: i < 2 ? 700 * MB : 128 * MB,
      uptime_24h: 0.9999,
      buckets_24h: buckets24(0.9999),
    }),
    series: makeSeries({
      rx: () => 5 * GB,
      tx: () => 2.8 * GB,
      latency: () => 12345,
    }),
  }),
};

const DEFAULT_NAMES = [
  "香港-亚太边缘入口",
  "东京-中转备用入口",
  "新加坡-专线长名称节点",
  "首尔-亚太新节点",
  "洛杉矶-美洲测试节点",
  "圣何塞-美洲备用入口",
  "法兰克福-欧洲备用节点",
  "阿姆斯特丹-欧洲入口",
];

function buildFixture(name) {
  const definition = DEFINITIONS[name];
  if (!definition) throw new Error(`unknown fixture: ${name}`);
  const spec = definition();
  const count = spec.count ?? 8;
  const servers = Array.from({ length: count }, (_, index) => {
    const overrides =
      typeof spec.servers === "function" ? spec.servers(index, index) : spec.servers;
    return makeServer(index, {
      name: DEFAULT_NAMES[index % DEFAULT_NAMES.length],
      latency_ms: 25,
      ...overrides,
    });
  });

  return {
    panel_name: "PierWave · 亚太边缘",
    generated_at: NOW,
    summary: {
      servers_total: servers.length,
      servers_online: servers.filter((server) => server.online).length,
      nodes_total: 32,
      traffic_today: 472 * GB,
      traffic_month: 2.92 * TB,
    },
    servers,
    // 没显式给 series 的 fixture 用一份正常趋势，避免三张图都进空态、
    // 把字号 / 对齐的对照污染成「数据收集中」。
    series: spec.series === undefined ? makeSeries() : spec.series,
  };
}

export const FIXTURE_NAMES = Object.keys(DEFINITIONS);

export function kpiFixture(name) {
  return buildFixture(name);
}

/** 英文长标签压力测试：只改 DOM 文本，不改源码。 */
export const SIMULATED_LABELS = [
  "Average latency",
  "24h uptime",
  "Current total rate",
];

export const LABEL_TO_LONG = {
  "Avg latency": "Average latency",
  "24h uptime": "24h uptime",
  "Total rate": "Current total rate",
};
