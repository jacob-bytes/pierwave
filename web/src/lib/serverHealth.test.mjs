import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "./apiError.ts";
import {
  anomalyWindowHours,
  bucketAt,
  buildAnomalyWindows,
  buildHeatmapColumns,
  buildResourceChartData,
  buildUptimeTrend,
  formatHourTick,
  formatOnlineCount,
  formatMonthDayHour,
  formatPercent,
  heatmapCell,
  isServerHealthUnsupported,
  normalizeServerHealth,
  offlineServerNamePreview,
  resourceServerRows,
  uptimeHeatmapStep,
} from "./serverHealth.ts";

const BASE = Date.UTC(2026, 10, 22, 0, 0, 0) / 1000; // 2026-11-22 08:00 UTC+8
const HOUR = 3600;

function bucket(ts, overrides = {}) {
  return {
    ts,
    online_ratio: 1,
    load1_avg: 0.4,
    load1_max: 0.6,
    mem_ratio_max: 0.4,
    disk_ratio_max: 0.5,
    samples: 12,
    outage_samples: 0,
    ...overrides,
  };
}

function server(id, buckets, overrides = {}) {
  return {
    id,
    name: `server-${id}`,
    status: "online",
    current: {
      load1: 0.4,
      mem_used: 4,
      mem_total: 10,
      disk_used: 5,
      disk_total: 10,
      latency_ms: 20,
    },
    buckets,
    ...overrides,
  };
}

function health(servers, summary = {}, window = {}) {
  return {
    window: { hours: 168, bucket_secs: HOUR, generated_at: BASE + 10 * HOUR, ...window },
    servers,
    summary,
  };
}

test("normalizeServerHealth: 缺 servers / 全坏条目 → unsupported", () => {
  assert.equal(normalizeServerHealth(null).status, "unsupported");
  assert.equal(normalizeServerHealth({}).status, "unsupported");
  assert.equal(normalizeServerHealth({ servers: null }).status, "unsupported");
  assert.equal(
    normalizeServerHealth({ servers: [], summary: undefined }).status,
    "unsupported",
  );
  assert.equal(
    normalizeServerHealth({ servers: [{ buckets: [] }] }).status,
    "unsupported",
  );
  assert.equal(
    normalizeServerHealth({
      servers: [{ id: "a", name: "A" }],
      summary: {},
    }).status,
    "unsupported",
  );
  assert.equal(
    normalizeServerHealth({ servers: [{ id: "", name: "x" }] }).status,
    "unsupported",
  );
});

test("normalizeServerHealth: servers: [] → empty，而不是报错", () => {
  const result = normalizeServerHealth({ servers: [], summary: {} });
  assert.equal(result.status, "empty");
  assert.deepEqual(result.snapshot.servers, []);
  assert.equal(result.snapshot.hasSamples, false);
});

test("normalizeServerHealth: 容忍百分比、缺 samples 与旧字段名", () => {
  const result = normalizeServerHealth(
    health([
      server("a", [
        {
          ts: BASE,
          online_ratio: 96.4,
          load1_avg: "0.5",
          load1_max: 0.9,
          mem_ratio: 44,
          disk_ratio_max: 91,
          outage_samples: 0,
        },
      ]),
    ], { uptime_24h: 96.4, disk_max: 91 }),
  );
  assert.equal(result.status, "ok");
  const snapshot = result.snapshot;
  const row = snapshot.servers[0];
  assert.equal(row.buckets[0].onlineRatio.toFixed(3), "0.964");
  assert.equal(row.buckets[0].load1, 0.5);
  assert.equal(row.buckets[0].memRatio.toFixed(2), "0.44");
  assert.equal(row.buckets[0].diskRatio.toFixed(2), "0.91");
  // 没有 samples 但有指标值 → 视为 1 个采样，不能画成空桶
  assert.equal(row.buckets[0].samples, 1);
  assert.equal(snapshot.summary.uptime24h.toFixed(3), "0.964");
  assert.equal(snapshot.summary.diskMax.toFixed(2), "0.91");
});

test("normalizeServerHealth: 24h 在线率按采样数加权，异常台数按服务器去重", () => {
  const result = normalizeServerHealth(
    health([
      server("a", [
        bucket(BASE, { online_ratio: 1 }),
        bucket(BASE + HOUR, { online_ratio: 1 }),
        bucket(BASE + 2 * HOUR, { online_ratio: 0.5 }),
      ]),
      server("b", [
        bucket(BASE, { online_ratio: 1, disk_ratio_max: 0.95 }),
        bucket(BASE + HOUR, { online_ratio: 1, load1_max: 5, load1_avg: 4.5 }),
      ]),
      server("c", []),
    ]),
  );
  assert.equal(result.status, "ok");
  const snapshot = result.snapshot;
  assert.equal(snapshot.servers.length, 3);
  // (1*12 + 1*12 + 0.5*12 + 1*12 + 1*12) / (12*5) = 0.9
  assert.equal(snapshot.summary.uptime24h, 0.9);
  assert.equal(snapshot.summary.offlineServers, 1);
  assert.equal(snapshot.summary.resourceServers, 1);
  assert.equal(snapshot.summary.anomalyServers, 2);
  assert.equal(snapshot.summary.serversWithoutSamples, 1);
  assert.equal(snapshot.summary.maxDiskServer, "server-b");
});

test("heatmapCell: 在线率 0–4 色阶 + 无采样 + 离线", () => {
  const row = normalizeServerHealth(
    health([
      server("a", [
        bucket(BASE, { online_ratio: 1 }),
        bucket(BASE + HOUR, { online_ratio: 0.98 }),
        bucket(BASE + 2 * HOUR, { online_ratio: 0.96 }),
        bucket(BASE + 3 * HOUR, { online_ratio: 0.92 }),
        bucket(BASE + 4 * HOUR, { online_ratio: 0.88 }),
        bucket(BASE + 5 * HOUR, { samples: 0, outage_samples: 0 }),
        bucket(BASE + 6 * HOUR, { online_ratio: 0 }),
      ]),
    ]),
  ).snapshot.servers[0];

  assert.deepEqual(
    [0, 1, 2, 3, 4].map((i) =>
      heatmapCell(row, BASE + i * HOUR, HOUR).step,
    ),
    [4, 3, 2, 1, 0],
  );
  assert.equal(heatmapCell(row, BASE, HOUR).state, "sample");
  assert.equal(
    heatmapCell(row, BASE + 5 * HOUR, HOUR).state,
    "nosample",
  );
  assert.equal(
    heatmapCell(row, BASE + 6 * HOUR, HOUR).state,
    "offline",
  );
});

test("uptimeHeatmapStep: 在线率越高颜色越深（0 最浅 / 4 最深）", () => {
  assert.equal(uptimeHeatmapStep(1), 4);
  assert.equal(uptimeHeatmapStep(0.99), 4);
  assert.equal(uptimeHeatmapStep(0.98), 3);
  assert.equal(uptimeHeatmapStep(0.97), 3);
  assert.equal(uptimeHeatmapStep(0.96), 2);
  assert.equal(uptimeHeatmapStep(0.95), 2);
  assert.equal(uptimeHeatmapStep(0.92), 1);
  assert.equal(uptimeHeatmapStep(0.9), 1);
  assert.equal(uptimeHeatmapStep(0.89), 0);
  assert.equal(uptimeHeatmapStep(0), 0);
  assert.equal(uptimeHeatmapStep(null), null);
});

test("buildHeatmapColumns: 固定 168 / 24 列，最后一列对齐最新桶", () => {
  const snapshot = normalizeServerHealth(
    health([server("a", [bucket(BASE), bucket(BASE + HOUR)])]),
  ).snapshot;

  const desktop = buildHeatmapColumns(snapshot, 168, BASE + 5 * HOUR);
  assert.equal(desktop.length, 168);
  // 用 generated_at（BASE+10h）对齐到桶起点，最后几小时即使没有桶也保留
  assert.equal(desktop.at(-1).ts, BASE + 10 * HOUR);
  assert.equal(desktop.at(-10).ts, BASE + HOUR);

  const mobile = buildHeatmapColumns(snapshot, 24, BASE + 5 * HOUR);
  assert.equal(mobile.length, 24);
  assert.equal(mobile.at(-1).ts, BASE + 10 * HOUR);
});

test("buildHeatmapColumns: 完全没有桶时仍生成网格，时间从 generated_at 回退", () => {
  const snapshot = normalizeServerHealth(
    health([server("a", [])], {}, { generated_at: BASE }),
  ).snapshot;
  const columns = buildHeatmapColumns(snapshot, 24, BASE + 99 * HOUR);
  assert.equal(columns.length, 24);
  assert.equal(columns.at(-1).ts, BASE);
});

test("normalizeServerHealth: 后端实际形状（online 布尔 / 顶层 hours / summary 别名）", () => {
  const result = normalizeServerHealth({
    generated_at: BASE + 5 * HOUR,
    hours: 168,
    bucket: HOUR,
    summary: {
      online_ratio_24h: 0.964,
      abnormal_servers: 3,
      worst_disk_ratio: 0.91,
    },
    servers: [
      {
        id: "a",
        name: "A",
        online_ratio: 0.98,
        buckets: [
          {
            ts: BASE,
            online: true,
            load1: 0.42,
            mem_ratio: 0.42,
            disk_ratio: 0.53,
          },
          null,
          {
            ts: BASE + 2 * HOUR,
            online: false,
            load1: 1.2,
            mem_ratio: 0.5,
            disk_ratio: 0.6,
          },
        ],
      },
    ],
  });

  assert.equal(result.status, "ok");
  const snapshot = result.snapshot;
  assert.equal(snapshot.window.hours, 168);
  assert.equal(snapshot.window.bucketSecs, HOUR);
  assert.equal(snapshot.window.generatedAt, BASE + 5 * HOUR);
  assert.equal(snapshot.summary.uptime24h.toFixed(3), "0.964");
  assert.equal(snapshot.summary.anomalyServers, 3);
  assert.equal(snapshot.summary.diskMax.toFixed(2), "0.91");

  const row = snapshot.servers[0];
  // 最新非空桶离线 → 状态回落到 offline
  assert.equal(row.status, "offline");
  assert.equal(row.buckets.length, 2);
  assert.equal(row.buckets[0].onlineRatio, 1);
  assert.equal(row.buckets[0].samples, 1);
  assert.equal(row.buckets[1].onlineRatio, 0);
  assert.equal(row.buckets[1].outageSamples, 1);
  // null 桶被保留为缺口，热力图显示无采样
  assert.equal(heatmapCell(row, BASE + HOUR, HOUR).state, "nosample");
  assert.equal(heatmapCell(row, BASE, HOUR).state, "sample");
  assert.equal(heatmapCell(row, BASE, HOUR).step, 4);
  assert.equal(
    heatmapCell(row, BASE + 2 * HOUR, HOUR).state,
    "offline",
  );
});

test("buildAnomalyWindows: 相邻桶合并、缺桶断开、进行中排在前面", () => {
  const result = normalizeServerHealth(
    health([
      server("a", [
        bucket(BASE, { online_ratio: 0.9 }),
        bucket(BASE + HOUR, { online_ratio: 0.8 }),
        bucket(BASE + 2 * HOUR, { online_ratio: 1 }),
        bucket(BASE + 4 * HOUR, { online_ratio: 0.7 }),
      ]),
    ]),
  );
  const snapshot = result.snapshot;
  const windows = buildAnomalyWindows(
    snapshot.servers,
    snapshot.window.bucketSecs,
    snapshot.latestTs,
  );

  assert.equal(windows.length, 2);
  assert.equal(windows[0].ongoing, true);
  assert.equal(windows[0].startTs, BASE + 4 * HOUR);
  assert.equal(windows[1].startTs, BASE);
  assert.equal(windows[1].endTs, BASE + HOUR);
  assert.equal(anomalyWindowHours(windows[1], HOUR), 2);
});

test("buildAnomalyWindows: 资源指标也生成窗口（负载 / 内存 / 硬盘）", () => {
  const result = normalizeServerHealth(
    health([
      server("a", [
        bucket(BASE, { load1_max: 5, load1_avg: 4.5 }),
        bucket(BASE + HOUR, { mem_ratio_max: 0.95 }),
        bucket(BASE + 2 * HOUR, { disk_ratio_max: 0.92 }),
      ]),
    ]),
  );
  const snapshot = result.snapshot;
  const windows = buildAnomalyWindows(
    snapshot.servers,
    snapshot.window.bucketSecs,
    snapshot.latestTs,
  );
  assert.deepEqual(
    windows.map((window) => window.metric),
    ["disk", "memory", "load"],
  );
});

test("resourceServerRows: 按当前指标值降序，缺 current 时回落到最后桶", () => {
  const result = normalizeServerHealth(
    health([
      server("a", [], {
        current: null,
        buckets: [
          bucket(BASE, {
            load1_avg: 3,
            load1_max: 4,
            mem_ratio_max: 0.5,
            disk_ratio_max: 0.6,
          }),
        ],
      }),
      server("b", [], {
        current: {
          load1: 0.1,
          mem_used: 9,
          mem_total: 10,
          disk_used: 6,
          disk_total: 10,
          latency_ms: null,
        },
        buckets: [],
      }),
      server("c", [], { current: null, buckets: [] }),
    ]),
  );
  const loadRows = resourceServerRows(result.snapshot, "load");
  assert.deepEqual(
    loadRows.map((row) => row.serverId),
    ["a", "b"],
  );
  assert.equal(loadRows[0].value, 3);

  const memRows = resourceServerRows(result.snapshot, "memory");
  assert.deepEqual(
    memRows.map((row) => row.serverId),
    ["b", "a"],
  );
  assert.equal(memRows[0].value, 0.9);
});

test("buildResourceChartData: 百分比序列、无采样保留 null、空选择无数据", () => {
  const result = normalizeServerHealth(
    health([
      server("a", [
        bucket(BASE, {
          load1_avg: 4,
          load1_max: 4,
          mem_ratio_max: null,
          disk_ratio_max: null,
        }),
      ]),
      server("b", [
        bucket(BASE, {
          load1_avg: 0.8,
          load1_max: 0.8,
          mem_ratio_max: null,
          disk_ratio_max: null,
        }),
      ]),
    ]),
  );
  const columns = [{ ts: BASE }];
  const data = buildResourceChartData(
    result.snapshot,
    "load",
    ["a", "b"],
    columns,
  );
  assert.equal(data.series.length, 2);
  assert.equal(data.hasData, true);
  // 4/8 和 0.8/8
  const last = data.points.at(-1);
  assert.equal(last.a, 50);
  assert.equal(last.b, 10);

  const none = buildResourceChartData(result.snapshot, "memory", ["a"], columns);
  assert.equal(none.hasData, false);
  assert.equal(none.points.at(-1).a, null);

  const empty = buildResourceChartData(result.snapshot, "load", [], columns);
  assert.equal(empty.hasData, false);
  assert.equal(empty.series.length, 0);
});

test("bucketAt: 半个桶容差内匹配，超出返回 null", () => {
  const row = normalizeServerHealth(
    health([server("a", [bucket(BASE)])]),
  ).snapshot.servers[0];
  assert.ok(bucketAt(row, BASE + 60, HOUR));
  assert.equal(bucketAt(row, BASE + 40 * 60, HOUR), null);
});

test("格式化：百分比不把空值写成 0，时间统一 UTC+8", () => {
  assert.equal(formatPercent(null), "—");
  assert.equal(formatPercent(0.964), "96.4%");
  assert.equal(formatPercent(1), "100.0%");
  assert.equal(formatMonthDayHour(BASE), "11/22 08:00");
  assert.equal(formatHourTick(BASE), "08:00");
});

test("isServerHealthUnsupported: 404 / 403 是能力未上线，其它错误仍报错", () => {
  assert.equal(isServerHealthUnsupported(new ApiError("x", 404)), true);
  assert.equal(isServerHealthUnsupported(new ApiError("x", 403)), true);
  assert.equal(isServerHealthUnsupported(new ApiError("x", 500)), false);
  assert.equal(isServerHealthUnsupported(new Error("x")), false);
  assert.equal(isServerHealthUnsupported(null), false);
});

test("后端 summary 直接保留：筛选后的 KPI 不在前端重算", () => {
  const result = normalizeServerHealth({
    generated_at: BASE + 10 * HOUR,
    hours: 168,
    bucket: HOUR,
    summary: {
      online_ratio_24h: 0.8123,
      abnormal_servers: 2,
      worst_disk_ratio: 0.97,
    },
    servers: [
      server("a", [bucket(BASE, { online_ratio: 0.5 })]),
      server("b", [bucket(BASE, { online_ratio: 1 })]),
    ],
  });
  assert.equal(result.status, "ok");
  // 与桶里重算出来的 0.75 / 1 不同，证明用的是后端 summary。
  assert.equal(result.snapshot.summary.uptime24h, 0.8123);
  assert.equal(result.snapshot.summary.anomalyServers, 2);
  assert.equal(result.snapshot.summary.diskMax, 0.97);
});

test("热力图读桶内 online_ratio：0.5833 也是独立色阶，而非布尔近似", () => {
  const result = normalizeServerHealth({
    generated_at: BASE + 2 * HOUR,
    hours: 168,
    bucket: HOUR,
    summary: {},
    servers: [
      server("a", [
        {
          ts: BASE,
          online: true,
          online_ratio: 0.5833,
          samples: 12,
          load1: 0.4,
          mem_ratio: 0.4,
          disk_ratio: 0.4,
        },
        {
          ts: BASE + HOUR,
          online: true,
          online_ratio: 0.98,
          samples: 12,
          load1: 0.4,
          mem_ratio: 0.4,
          disk_ratio: 0.4,
        },
      ]),
    ],
  });
  assert.equal(result.status, "ok");
  const row = result.snapshot.servers[0];
  // 0.5833 < 90% → step 0；0.98 → 97–99% 档 step 3。若被布尔化只会是 4。
  assert.equal(heatmapCell(row, BASE, HOUR).step, 0);
  assert.equal(heatmapCell(row, BASE + HOUR, HOUR).step, 3);
  assert.equal(row.buckets[0].ratioApproximate, false);
  assert.equal(result.snapshot.approximateUptime, false);
});

test("桶只有 online 布尔时标记近似，图例据此注明", () => {
  const result = normalizeServerHealth({
    generated_at: BASE,
    hours: 168,
    bucket: HOUR,
    summary: {},
    servers: [
      server("a", [
        {
          ts: BASE,
          online: true,
          load1: 0.4,
          mem_ratio: 0.4,
          disk_ratio: 0.4,
        },
      ]),
    ],
  });
  assert.equal(result.status, "ok");
  assert.equal(result.snapshot.servers[0].buckets[0].ratioApproximate, true);
  assert.equal(result.snapshot.approximateUptime, true);
  assert.equal(result.snapshot.servers[0].buckets[0].onlineRatio, 1);
});

test("行首状态用后端真实 status；缺失时才回退推断", () => {
  const explicit = normalizeServerHealth({
    generated_at: BASE,
    hours: 168,
    bucket: HOUR,
    summary: {},
    servers: [
      server("online", [bucket(BASE, { online_ratio: 0 })], {
        status: "online",
      }),
      server("offline", [bucket(BASE, { online_ratio: 1 })], {
        status: "offline",
      }),
    ],
  });
  assert.equal(explicit.snapshot.servers[0].status, "online");
  assert.equal(explicit.snapshot.servers[1].status, "offline");

  const inferred = normalizeServerHealth({
    generated_at: BASE,
    hours: 168,
    bucket: HOUR,
    summary: {},
    servers: [
      server("infer-online", [bucket(BASE, { online_ratio: 1 })], {
        status: undefined,
      }),
      server("infer-offline", [bucket(BASE, { online_ratio: 0 })], {
        status: undefined,
      }),
    ],
  });
  assert.equal(inferred.snapshot.servers[0].status, "online");
  assert.equal(inferred.snapshot.servers[1].status, "offline");
});

test("服务器级 online_ratio 在缺 status 且缺桶时也能推断状态", () => {
  const result = normalizeServerHealth({
    generated_at: BASE,
    hours: 168,
    bucket: HOUR,
    summary: {},
    servers: [
      server("a", [], { status: undefined, online_ratio: 0.98 }),
      server("b", [], { status: undefined, online_ratio: 0.2 }),
    ],
  });
  assert.equal(result.snapshot.servers[0].status, "online");
  assert.equal(result.snapshot.servers[1].status, "offline");
  assert.equal(result.snapshot.servers[0].onlineRatio, 0.98);
});

test("buildUptimeTrend: 按采样数加权聚合，与 summary 口径一致", () => {
  const snapshot = normalizeServerHealth(
    health(
      [
        server("a", [
          bucket(BASE, { online_ratio: 1, samples: 6 }),
          bucket(BASE + HOUR, { online_ratio: 0, samples: 12 }),
          bucket(BASE + 2 * HOUR, { online_ratio: 1, samples: 6 }),
        ]),
        server("b", [
          bucket(BASE, { online_ratio: 0.5, samples: 2 }),
          bucket(BASE + HOUR, { online_ratio: 1, samples: 4 }),
          bucket(BASE + 2 * HOUR, { online_ratio: 0.75, samples: 4 }),
        ]),
      ],
      {},
      { generated_at: BASE + 2 * HOUR },
    ),
  ).snapshot;

  const trend = buildUptimeTrend(snapshot, 3);
  assert.equal(trend.hasData, true);
  assert.deepEqual(
    trend.points.map((point) => point.ts),
    [BASE, BASE + HOUR, BASE + 2 * HOUR],
  );

  // (6*1 + 2*0.5) / (6+2) = 87.5%；台数同一口径：87.5% × 2 = 1.75 台。
  assert.equal(trend.points[0].pct, 87.5);
  assert.equal(trend.points[0].samples, 8);
  assert.equal(trend.points[0].totalServers, 2);
  assert.equal(trend.points[0].onlineServers, 1.75);
  assert.deepEqual(trend.points[0].offlineServers, []);

  // (12*0 + 4*1) / (12+4) = 25%；a 桶内 0% 在线 → 离线名单。
  assert.equal(trend.points[1].pct, 25);
  assert.equal(trend.points[1].samples, 16);
  assert.equal(trend.points[1].totalServers, 2);
  assert.equal(trend.points[1].onlineServers, 0.5);
  assert.deepEqual(trend.points[1].offlineServers, ["server-a"]);

  // (6*1 + 4*0.75) / (6+4) = 90%；台数 90% × 2 = 1.8 台。
  assert.equal(trend.points[2].pct, 90);
  assert.equal(trend.points[2].onlineServers, 1.8);
});

test("buildUptimeTrend: 空桶 pct 为 null，不画 0", () => {
  const snapshot = normalizeServerHealth(
    health(
      [server("a", [bucket(BASE, { online_ratio: 1 })])],
      {},
      { generated_at: BASE + 2 * HOUR },
    ),
  ).snapshot;

  const trend = buildUptimeTrend(snapshot, 3);
  assert.equal(trend.points.length, 3);
  assert.equal(trend.points[0].pct, 100);
  // 中间 / 最后两小时没有任何采样：保持 null，折线断开。
  assert.equal(trend.points[1].pct, null);
  assert.equal(trend.points[1].totalServers, 0);
  assert.deepEqual(trend.points[1].offlineServers, []);
  assert.equal(trend.points[2].pct, null);
  // 有采样的小时仍然算「有数据」，空桶不能把整块视图判成空态。
  assert.equal(trend.hasData, true);
});

test("buildUptimeTrend: 全部没有采样时 hasData=false，所有点都是 null", () => {
  const snapshot = normalizeServerHealth(
    health([server("a", [])], {}, { generated_at: BASE }),
  ).snapshot;

  const trend = buildUptimeTrend(snapshot, 4);
  assert.equal(trend.hasData, false);
  assert.equal(trend.points.length, 4);
  assert.ok(trend.points.every((point) => point.pct === null));
});

test("buildUptimeTrend: 离线异常窗口合并成阴影时段，资源窗口不入图", () => {
  const snapshot = normalizeServerHealth(
    health(
      [
        server("a", [
          bucket(BASE, { online_ratio: 0.9 }),
          bucket(BASE + HOUR, { online_ratio: 1 }),
          bucket(BASE + 2 * HOUR, { online_ratio: 1 }),
        ]),
        server("b", [
          bucket(BASE, { online_ratio: 1 }),
          bucket(BASE + HOUR, { online_ratio: 0.8 }),
          bucket(BASE + 2 * HOUR, { online_ratio: 1 }),
        ]),
        // 只有负载异常、在线率 100%：不应给在线率曲线加阴影。
        server("c", [
          bucket(BASE, { online_ratio: 1, load1_max: 5, load1_avg: 4.5 }),
          bucket(BASE + HOUR, { online_ratio: 1 }),
          bucket(BASE + 2 * HOUR, { online_ratio: 1 }),
        ]),
      ],
      {},
      { generated_at: BASE + 2 * HOUR },
    ),
  ).snapshot;

  const trend = buildUptimeTrend(snapshot, 3);
  assert.deepEqual(trend.anomalyRanges, [
    { startTs: BASE, endTs: BASE + HOUR },
  ]);
});

test("offlineServerNamePreview: 最多 3 个名字，其余折成 +N", () => {
  assert.deepEqual(offlineServerNamePreview([]), { names: [], extra: 0 });
  assert.deepEqual(offlineServerNamePreview(["a", "b"]), {
    names: ["a", "b"],
    extra: 0,
  });
  assert.deepEqual(
    offlineServerNamePreview(["a", "b", "c", "d", "e"]),
    { names: ["a", "b", "c"], extra: 2 },
  );
});

test("buildUptimeTrend: 7/12 采样在线的桶是 58.3%，不是多数判定的 100%", () => {
  const snapshot = normalizeServerHealth(
    health(
      [
        server("a", [
          bucket(BASE, { online_ratio: 7 / 12, samples: 12 }),
        ]),
      ],
      {},
      { generated_at: BASE },
    ),
  ).snapshot;

  const trend = buildUptimeTrend(snapshot, 1);
  assert.equal(trend.points.length, 1);
  assert.ok(
    Math.abs(trend.points[0].pct - (7 / 12) * 100) < 1e-9,
    "trend must use online_ratio, not the majority online boolean",
  );
  assert.equal(trend.points[0].pct.toFixed(1), "58.3");
  // 台数同一口径：58.3% × 1 = 0.583 台，而不是 1 台。
  assert.equal(trend.points[0].onlineServers.toFixed(3), "0.583");
  // 部分在线不算「离线服务器」，否则会把 58% 在线说成全离线。
  assert.deepEqual(trend.points[0].offlineServers, []);
});

test("buildUptimeTrend: 24h 加权平均与 summary.online_ratio_24h 对得上", () => {
  const snapshot = normalizeServerHealth(
    health(
      [
        server("a", [
          bucket(BASE, { online_ratio: 0.25, samples: 12 }),
          bucket(BASE + HOUR, { online_ratio: 1, samples: 12 }),
          bucket(BASE + 2 * HOUR, { online_ratio: 0.5, samples: 12 }),
        ]),
        server("b", [
          bucket(BASE, { online_ratio: 0.75, samples: 12 }),
          bucket(BASE + HOUR, { online_ratio: 0.5, samples: 12 }),
          bucket(BASE + 2 * HOUR, { online_ratio: 1, samples: 12 }),
        ]),
      ],
      {},
      { generated_at: BASE + 2 * HOUR },
    ),
  ).snapshot;

  const trend = buildUptimeTrend(snapshot, 3);
  const samples = trend.points.reduce((sum, point) => sum + point.samples, 0);
  const weighted =
    trend.points.reduce(
      (sum, point) => sum + (point.pct ?? 0) * point.samples,
      0,
    ) / samples;

  assert.ok(snapshot.summary.uptime24h !== null);
  assert.ok(
    Math.abs(weighted - snapshot.summary.uptime24h * 100) <= 1,
    `trend ${weighted}% must match KPI ${(snapshot.summary.uptime24h * 100).toFixed(1)}%`,
  );
});

test("buildUptimeTrend: 旧契约只有 online 布尔时回退并保留近似标记", () => {
  const snapshot = normalizeServerHealth({
    generated_at: BASE + HOUR,
    hours: 24,
    bucket: HOUR,
    summary: {},
    servers: [
      {
        id: "legacy",
        name: "旧主控-01",
        buckets: [
          { ts: BASE, online: true, load1: 0.4 },
          { ts: BASE + HOUR, online: false, load1: 0.3 },
        ],
      },
    ],
  }).snapshot;

  // 旧契约没有桶内 online_ratio：热力图 / 趋势都要标记「近似」。
  assert.equal(snapshot.approximateUptime, true);
  const trend = buildUptimeTrend(snapshot, 2);
  assert.equal(trend.points[0].pct, 100);
  assert.equal(trend.points[1].pct, 0);
  assert.equal(trend.points[1].onlineServers, 0);
  assert.deepEqual(trend.points[1].offlineServers, ["旧主控-01"]);
});

test("formatOnlineCount: 整数台直接写，部分采样带 ≈ 和一位小数", () => {
  assert.equal(formatOnlineCount(4), "4");
  assert.equal(formatOnlineCount(0), "0");
  assert.equal(formatOnlineCount(3.583), "≈3.6");
  assert.equal(formatOnlineCount(3.04), "3");
});
