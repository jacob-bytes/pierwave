import assert from "node:assert/strict";
import test from "node:test";
import {
  chainHealthRows,
  chainHealthStatus,
  cumulativeAxisUnit,
  cumulativeSeries,
  formatCumulativeTick,
  formatShare,
  protocolTrend,
  sortProtocols,
  topServers,
  topUsers,
  visibleAlerts,
} from "./overview.ts";

const point = (day, downlink, uplink) => ({ day, downlink, uplink });

test("cumulativeSeries sums downlink+uplink as a running prefix", () => {
  const result = cumulativeSeries([
    point("2026-11-05", 100, 20),
    point("2026-11-06", 0, 0),
    point("2026-11-07", 30, 10),
  ]);

  assert.deepEqual(
    result.map((day) => day.cumulative),
    [120, 120, 160],
  );
  // 保留原有字段，供图表继续按 date / downlink / uplink 取数。
  assert.equal(result[0].day, "2026-11-05");
  assert.equal(result[2].uplink, 10);
});

test("cumulativeSeries does not mutate the input series", () => {
  const input = [point("2026-11-05", 1, 2), point("2026-11-06", 3, 4)];
  const snapshot = structuredClone(input);

  const result = cumulativeSeries(input);

  assert.deepEqual(input, snapshot);
  assert.notEqual(result, input);
});

test("cumulativeSeries handles an empty series", () => {
  assert.deepEqual(cumulativeSeries([]), []);
});

test("cumulativeSeries keeps a single point's total (line is hidden by the chart)", () => {
  const result = cumulativeSeries([point("2026-11-05", 512, 256)]);

  assert.equal(result.length, 1);
  assert.equal(result[0].cumulative, 768);
});

test("cumulativeSeries treats zero and missing values as zero contributions", () => {
  const result = cumulativeSeries([
    point("2026-11-05", 0, 0),
    point("2026-11-06", 0, 0),
    { day: "2026-11-07", downlink: 10, uplink: Number.NaN },
  ]);

  assert.deepEqual(
    result.map((day) => day.cumulative),
    [0, 0, 10],
  );
});

test("formatShare returns a percentage and never divides by zero", () => {
  assert.equal(formatShare(50, 100), 50);
  assert.equal(formatShare(1, 3), (1 / 3) * 100);
  assert.equal(formatShare(0, 0), 0);
  assert.equal(formatShare(10, 0), 0);
  assert.equal(formatShare(10, -1), 0);
});

test("formatShare clamps invalid values instead of producing NaN/Infinity", () => {
  assert.equal(formatShare(Number.NaN, 100), 0);
  assert.equal(formatShare(10, Number.NaN), 0);
  assert.equal(formatShare(150, 100), 100);
  assert.equal(formatShare(-5, 100), 0);
});

test("sortProtocols sorts by traffic descending and keeps zero-traffic rows after", () => {
  const sorted = sortProtocols([
    { protocol: "vmess", nodes: 1, traffic_7d: 100 },
    { protocol: "vless", nodes: 2, traffic_7d: 0 },
    { protocol: "trojan", nodes: 1, traffic_7d: 300 },
    { protocol: "socks", nodes: 1, traffic_7d: 0 },
  ]);

  assert.deepEqual(
    sorted.map((row) => row.protocol),
    ["trojan", "vmess", "vless", "socks"],
  );
  // 零流量不能被丢掉，UI 仍要显示 0 B。
  assert.equal(sorted.length, 4);
});

test("sortProtocols places unknown by traffic like any other protocol", () => {
  const sorted = sortProtocols([
    { protocol: "vless", nodes: 1, traffic_7d: 10 },
    { protocol: "unknown", nodes: 2, traffic_7d: 999 },
    { protocol: "trojan", nodes: 1, traffic_7d: 0 },
  ]);

  assert.deepEqual(
    sorted.map((row) => row.protocol),
    ["unknown", "vless", "trojan"],
  );
});

test("sortProtocols is stable for equal traffic and does not mutate input", () => {
  const input = [
    { protocol: "vless", nodes: 1, traffic_7d: 10 },
    { protocol: "vmess", nodes: 1, traffic_7d: 10 },
  ];
  const snapshot = structuredClone(input);

  const sorted = sortProtocols(input);

  assert.deepEqual(sorted, input);
  assert.notEqual(sorted, input);
  assert.deepEqual(input, snapshot);
});

test("sortProtocols handles an empty list", () => {
  assert.deepEqual(sortProtocols([]), []);
});

test("visibleAlerts hides every zero chain counter", () => {
  assert.deepEqual(
    visibleAlerts({
      total: 3,
      degraded: 0,
      blocked: 0,
      forwards_total: 4,
      forwards_failing: 0,
      handshake_failures: 0,
    }),
    [],
  );
  assert.deepEqual(visibleAlerts(undefined), []);
});

test("visibleAlerts returns only non-zero counters, degraded first", () => {
  assert.deepEqual(
    visibleAlerts({
      total: 3,
      degraded: 0,
      blocked: 0,
      forwards_total: 4,
      forwards_failing: 2,
      handshake_failures: 3,
    }),
    [{ kind: "handshake_failures", count: 3 }],
  );

  assert.deepEqual(
    visibleAlerts({
      total: 3,
      degraded: 2,
      blocked: 1,
      forwards_total: 4,
      forwards_failing: 2,
      handshake_failures: 3,
    }),
    [
      { kind: "degraded", count: 2 },
      { kind: "handshake_failures", count: 3 },
    ],
  );
});

test("visibleAlerts ignores negative and non-finite counters", () => {
  assert.deepEqual(
    visibleAlerts({
      total: 0,
      degraded: -1,
      blocked: 0,
      forwards_total: 0,
      forwards_failing: 0,
      handshake_failures: Number.NaN,
    }),
    [],
  );
});

test("topServers filters servers, sorts by 7-day traffic and caps at 5", () => {
  const items = [
    { kind: "server", name: "b", traffic_7d: 20, load1: 1, online: true },
    { kind: "node", name: "n", traffic_7d: 999, load1: 0, online: true },
    { kind: "server", name: "a", traffic_7d: 50, load1: 0.5, online: true },
    { kind: "server", name: "c", traffic_7d: 10, load1: null, online: false },
    { kind: "server", name: "d", traffic_7d: 40, load1: 2, online: true },
    { kind: "server", name: "e", traffic_7d: 30, load1: 2, online: true },
    { kind: "server", name: "f", traffic_7d: 0, load1: 2, online: true },
  ];

  const top = topServers(items);

  assert.deepEqual(
    top.map((item) => item.name),
    ["a", "d", "e", "b", "c"],
  );
  assert.equal(top.length, 5);
});

test("topServers handles missing and empty lists", () => {
  assert.deepEqual(topServers(undefined), []);
  assert.deepEqual(topServers([]), []);
});

test("cumulativeAxisUnit switches to TB only at a full TiB", () => {
  assert.equal(cumulativeAxisUnit(0), "GB");
  assert.equal(cumulativeAxisUnit(1024 ** 3 * 512), "GB");
  assert.equal(cumulativeAxisUnit(1024 ** 4), "TB");
  assert.equal(cumulativeAxisUnit(1024 ** 4 * 3), "TB");
});

test("formatCumulativeTick prints axis numbers in the selected unit", () => {
  assert.equal(formatCumulativeTick(0, "GB"), "0");
  assert.equal(formatCumulativeTick(1024 ** 3 * 2, "GB"), "2");
  assert.equal(formatCumulativeTick(1024 ** 3 * 1.234, "GB"), "1.23");
  assert.equal(formatCumulativeTick(1024 ** 4, "TB"), "1");
  assert.equal(formatCumulativeTick(1024 ** 4 * 1.5, "TB"), "1.5");
  assert.equal(formatCumulativeTick(Number.NaN, "GB"), "—");
});

const protocolSeries = (protocol, entries) => ({
  protocol,
  days: entries.map(([day, bytes]) => ({ day, bytes })),
});

test("protocolTrend turns the series into one row per day and one column per protocol", () => {
  const trend = protocolTrend([
    protocolSeries("vless", [
      ["2026-11-14", 10],
      ["2026-11-15", 0],
    ]),
    protocolSeries("trojan", [
      ["2026-11-14", 5],
      ["2026-11-15", 7],
    ]),
  ]);

  assert.deepEqual(
    trend.lines.map((line) => line.protocol),
    ["trojan", "vless"],
    "按窗口内下行总量降序",
  );
  assert.deepEqual(trend.rows, [
    { day: "2026-11-14", p0: 5, p1: 10 },
    { day: "2026-11-15", p0: 7, p1: 0 },
  ]);
});

test("protocolTrend gives every line its own dash pattern, not just colour", () => {
  const trend = protocolTrend([
    protocolSeries("vless", [["2026-11-15", 3]]),
    protocolSeries("vmess", [["2026-11-15", 2]]),
    protocolSeries("trojan", [["2026-11-15", 1]]),
  ]);

  assert.equal(trend.lines[0].dash, undefined, "第一条是实线");
  assert.equal(trend.lines[1].dash, "6 3");
  assert.equal(trend.lines[2].dash, "2 3");
  assert.ok(
    trend.lines.every((line, index) => line.key === `p${index}`),
    "dataKey 不能直接用协议名",
  );
});

test("protocolTrend sorts by downlink and merges the tail into other", () => {
  const trend = protocolTrend(
    [
      protocolSeries("http", [["2026-11-15", 10]]),
      protocolSeries("vless", [["2026-11-15", 60]]),
      protocolSeries("vmess", [["2026-11-15", 50]]),
      protocolSeries("trojan", [["2026-11-15", 40]]),
      protocolSeries("ss", [["2026-11-15", 30]]),
      protocolSeries("socks", [["2026-11-15", 20]]),
    ],
    4,
  );

  assert.deepEqual(
    trend.lines.map((line) => line.protocol),
    ["vless", "vmess", "trojan", "ss", "other"],
  );
  assert.equal(trend.rows[0].p0, 60);
  assert.equal(trend.rows[0].p4, 30, "other = http 10 + socks 20");
});

test("protocolTrend fills missing days and never draws all-zero lines", () => {
  const trend = protocolTrend([
    protocolSeries("vless", [["2026-11-15", 10]]),
    protocolSeries("trojan", [
      ["2026-11-14", 5],
      ["2026-11-15", 0],
    ]),
    protocolSeries("empty", [
      ["2026-11-14", 0],
      ["2026-11-15", 0],
    ]),
  ]);

  assert.deepEqual(
    trend.lines.map((line) => line.protocol),
    ["vless", "trojan"],
  );
  assert.deepEqual(trend.rows, [
    { day: "2026-11-14", p0: 0, p1: 5 },
    { day: "2026-11-15", p0: 10, p1: 0 },
  ]);
});

test("protocolTrend tolerates empty, missing and malformed input", () => {
  assert.deepEqual(protocolTrend(undefined), { lines: [], rows: [] });
  assert.deepEqual(protocolTrend([]), { lines: [], rows: [] });
  assert.deepEqual(protocolTrend([protocolSeries("", [["2026-11-15", 1]])]), {
    lines: [],
    rows: [],
  });
  assert.deepEqual(
    protocolTrend([
      protocolSeries("vless", [
        ["2026-11-15", Number.NaN],
        ["", 10],
      ]),
    ]),
    { lines: [], rows: [] },
  );
  assert.deepEqual(protocolTrend([protocolSeries("vless", [])], 0), {
    lines: [],
    rows: [],
  });
});

const chain = (overrides = {}) => ({
  id: overrides.id ?? "c1",
  name: overrides.name ?? "港-日",
  enabled: overrides.enabled ?? true,
  degraded: overrides.degraded ?? false,
  blocked_reason: overrides.blocked_reason ?? null,
  groups: overrides.groups ?? [
    {
      seq: 0,
      members: [
        { server_name: "hk-01", listen_port: 443, priority: 0 },
      ],
    },
  ],
});

test("chainHealthStatus prefers disabled, then blocked, then degraded", () => {
  assert.equal(
    chainHealthStatus(chain({ enabled: false, blocked_reason: "x" })),
    "disabled",
  );
  assert.equal(
    chainHealthStatus(chain({ blocked_reason: "证书已过期" })),
    "blocked",
  );
  assert.equal(chainHealthStatus(chain({ degraded: true })), "degraded");
  assert.equal(chainHealthStatus(chain()), "ok");
  assert.equal(chainHealthStatus(chain({ blocked_reason: "   " })), "ok");
});

test("chainHealthRows puts problems first and caps at five", () => {
  const rows = chainHealthRows([
    chain({ id: "ok-1", name: "正常链" }),
    chain({ id: "blocked", name: "阻断链", blocked_reason: "证书已过期" }),
    chain({ id: "disabled", name: "停用链", enabled: false }),
    chain({ id: "degraded", name: "降级链", degraded: true }),
    chain({ id: "ok-2", name: "正常链 2" }),
    chain({ id: "ok-3", name: "正常链 3" }),
  ]);

  assert.deepEqual(
    rows.map((row) => row.id),
    ["blocked", "degraded", "disabled", "ok-1", "ok-2"],
  );
  assert.ok(rows.every((row) => row.hops === 1));
  assert.ok(rows.every((row) => row.entry === "hk-01:443"));
  assert.equal(rows[0].reason, "证书已过期", "阻断原因带在行上供 tooltip 用");
  assert.equal(rows[1].reason, null);
});

test("chainHealthRows reports hops and entry address, with safe fallbacks", () => {
  const rows = chainHealthRows([
    chain({
      id: "two-hop",
      groups: [
        {
          seq: 0,
          members: [{ server_name: "hk-01", listen_port: 8443, priority: 0 }],
        },
        { seq: 1, members: [{ server_name: "jp-01", listen_port: 9001, priority: 0 }] },
      ],
    }),
    chain({ id: "empty", name: "  ", groups: [] }),
  ]);

  assert.equal(rows[0].hops, 2);
  assert.equal(rows[0].entry, "hk-01:8443");
  assert.equal(rows[1].name, "—");
  assert.equal(rows[1].hops, 0);
  assert.equal(rows[1].entry, "—");
  assert.deepEqual(chainHealthRows(undefined), []);
  assert.deepEqual(chainHealthRows([], 5), []);
});

test("topUsers sorts by traffic, drops empty rows and caps at five", () => {
  const users = [
    { user_id: "u1", username: "a", traffic_7d: 20 },
    { user_id: "u2", username: "b", traffic_7d: 50 },
    { user_id: "", username: "broken", traffic_7d: 999 },
    { user_id: "u3", username: "c", traffic_7d: 0 },
    { user_id: "u4", username: "d", traffic_7d: 40 },
    { user_id: "u5", username: "e", traffic_7d: 30 },
    { user_id: "u6", username: "f", traffic_7d: 10 },
  ];

  const top = topUsers(users);

  assert.deepEqual(
    top.map((user) => user.username),
    ["b", "d", "e", "a", "f"],
  );
  assert.equal(top.length, 5);
  assert.deepEqual(topUsers(undefined), []);
  assert.deepEqual(topUsers([], 5), []);
});
