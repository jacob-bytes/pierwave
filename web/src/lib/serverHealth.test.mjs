import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "./apiError.ts";
import {
  anomalyWindowHours,
  bucketAt,
  buildAnomalyWindows,
  buildHeatmapColumns,
  buildResourceChartData,
  formatHourTick,
  formatMonthDayHour,
  formatPercent,
  defaultServerSelection,
  heatmapCell,
  isServerHealthUnsupported,
  normalizeServerHealth,
  resourceServerRows,
  scopeServerHealthSnapshot,
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

test("defaultServerSelection: 离线/资源问题优先，按名称补足，最多 8 台", () => {
  const result = normalizeServerHealth(
    health([
      server("a", [bucket(BASE)], { name: "a" }),
      server(
        "b",
        [bucket(BASE, { online_ratio: 0 }), bucket(BASE + HOUR, { online_ratio: 1 })],
        { name: "b" },
      ),
      server("c", [bucket(BASE, { disk_ratio_max: 0.95 })], { name: "c" }),
      server("d", [bucket(BASE, { mem_ratio_max: 0.91 })], { name: "d" }),
      server("e", [bucket(BASE)], { name: "e" }),
      server("f", [bucket(BASE)], { name: "f" }),
      server("g", [bucket(BASE)], { name: "g" }),
      server("h", [bucket(BASE)], { name: "h" }),
      server("i", [bucket(BASE)], { name: "i" }),
      server("j", [bucket(BASE)], { name: "j" }),
    ]),
  ).snapshot;

  const ids = defaultServerSelection(result);
  assert.equal(ids.length, 8);
  assert.deepEqual(ids.slice(0, 3), ["b", "c", "d"]);
  assert.ok(ids.includes("a"));
  assert.ok(!ids.includes("i"));
  assert.ok(!ids.includes("j"));

  assert.deepEqual(defaultServerSelection(result, 2), ["b", "c"]);
  assert.deepEqual(defaultServerSelection(result, 0), []);
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

test("scopeServerHealthSnapshot：只保留选中服务器并重算 KPI", () => {
  const result = normalizeServerHealth(
    health(
      [
        server("a", [bucket(BASE, { online_ratio: 0.5 })]),
        server("b", [bucket(BASE, { online_ratio: 1, disk_ratio_max: 0.95 })], {
          current: {
            load1: 0.4,
            mem_used: 2,
            mem_total: 10,
            disk_used: 9.5,
            disk_total: 10,
            latency_ms: 20,
          },
        }),
        server("c", []),
      ],
      // 全量 summary 故意给出与选中集合无关的数字，确认不会被沿用。
      { online_ratio_24h: 1, abnormal_servers: 99, worst_disk_ratio: 0.1 },
    ),
  );

  const scoped = scopeServerHealthSnapshot(result.snapshot, ["a"]);
  assert.deepEqual(
    scoped.servers.map((item) => item.id),
    ["a"],
  );
  assert.equal(scoped.summary.uptime24h, 0.5);
  assert.equal(scoped.summary.uptime7d, 0.5);
  assert.equal(scoped.summary.diskMax, 0.5);
  assert.equal(scoped.summary.anomalyServers, 1);

  const empty = scopeServerHealthSnapshot(result.snapshot, []);
  assert.equal(empty.servers.length, 0);
  assert.equal(empty.summary.uptime24h, null);
  assert.equal(empty.summary.diskMax, null);
  assert.equal(empty.hasSamples, false);

  // 全选时原样返回，避免重算破坏后端提供的精确 summary。
  assert.equal(
    scopeServerHealthSnapshot(result.snapshot, ["a", "b", "c"]),
    result.snapshot,
  );
});
