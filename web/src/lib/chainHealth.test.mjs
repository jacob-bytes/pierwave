import assert from "node:assert/strict";
import test from "node:test";
import {
  ANOMALY_MIN_DELTA_MS,
  CHAIN_HEALTH_POLL_MS,
  SLOW_CHAIN_DELTA_MS,
  chainAnomalyWindows,
  chainDiagnosis,
  chainDiagnosisReason,
  chainLatestSampleTs,
  chainLatencyWindow,
  chainLossTone,
  chainSeriesMax,
  buildChainTrendData,
  chainHasTrend,
  chainStatus,
  chainTopology,
  formatChainTime,
  formatLossPct,
  formatLossProbes,
  formatMs,
  formatPercentValue,
  formatSignedMs,
  isChainHealthUnsupported,
  normalizeChainHealth,
  resolveChainLatencyRange,
  segmentSeries,
  segmentTrends,
} from "./chainHealth.ts";
import { ApiError } from "./apiError.ts";

function point(ts, p50, p10 = null, p90 = null, samples = 3) {
  return { ts, p50, p10, p90, samples };
}

function chain(overrides = {}) {
  return {
    id: "chain-1",
    name: "香港 → 东京",
    hops: 2,
    missing_hops: [],
    estimated: false,
    series: [
      point(1_800_000_000, 20, 18, 22),
      point(1_800_000_900, 21, 19, 23),
    ],
    segments: [
      {
        seq: 1,
        from: "香港-01",
        to: "东京-01",
        p50: 20,
        delta_ms: 1,
        contribution_pct: 100,
      },
      {
        seq: 2,
        from: "东京-01",
        to: "10.0.0.8",
        p50: 1,
        delta_ms: 0,
        contribution_pct: 0,
      },
    ],
    diagnosis: { kind: "single_hop", seq: 1 },
    ...overrides,
  };
}

function payload(chains, summary = undefined) {
  return {
    generated_at: 1_800_001_000,
    hours: 24,
    bucket: 900,
    chains,
    ...(summary === undefined
      ? {}
      : { summary }),
  };
}

test("range switches between 24h/15m and 7d/1h, defaulting to 24h", () => {
  assert.deepEqual(chainLatencyWindow("24h"), { hours: 24, bucket: 900 });
  assert.deepEqual(chainLatencyWindow("7d"), { hours: 168, bucket: 3600 });
  assert.equal(resolveChainLatencyRange("7d"), "7d");
  assert.equal(resolveChainLatencyRange("6h"), "24h");
  assert.equal(resolveChainLatencyRange(null), "24h");
  assert.equal(CHAIN_HEALTH_POLL_MS, 30_000);
});

test("missing chains array is unsupported; empty chains is empty", () => {
  assert.deepEqual(normalizeChainHealth(null), { status: "unsupported" });
  assert.deepEqual(normalizeChainHealth({}), { status: "unsupported" });
  assert.deepEqual(normalizeChainHealth({ chains: "nope" }), {
    status: "unsupported",
  });

  const empty = normalizeChainHealth({ chains: [] });
  assert.equal(empty.status, "empty");
  assert.equal(empty.snapshot.chains.length, 0);
  assert.equal(empty.snapshot.hasSamples, false);
});

test("a non-empty array of invalid chains is unsupported, not empty", () => {
  const result = normalizeChainHealth({ chains: [{ name: "no id" }] });
  assert.equal(result.status, "unsupported");
});

test("summary numbers are read from the backend contract", () => {
  const result = normalizeChainHealth(
    payload(
      [chain()],
      {
        hop_p50_ms: 67,
        delta_ms: 15,
        slow_chains: 1,
        total_chains: 4,
        worst_hop: {
          chain_id: "chain-9",
          chain_name: "三跳单线",
          seq: 2,
          p50_ms: 43,
        },
      },
    ),
  );
  assert.equal(result.status, "ok");
  const { summary, generatedAt, hours, bucket } = result.snapshot;
  assert.equal(generatedAt, 1_800_001_000);
  assert.equal(hours, 24);
  assert.equal(bucket, 900);
  assert.equal(summary.hopP50, 67);
  assert.equal(summary.deltaMs, 15);
  assert.equal(summary.slowChains, 1);
  assert.equal(summary.totalChains, 4);
  assert.deepEqual(summary.worstHop, {
    chainId: "chain-9",
    chainName: "三跳单线",
    seq: 2,
    p50Ms: 43,
  });
});

test("summary falls back to segments without inventing zeros", () => {
  const result = normalizeChainHealth(payload([chain()]));
  assert.equal(result.status, "ok");
  const { summary } = result.snapshot;
  assert.equal(summary.hopP50, 10.5);
  assert.equal(summary.deltaMs, 0.5);
  assert.equal(summary.slowChains, 0);
  assert.equal(summary.totalChains, 1);
  assert.deepEqual(summary.worstHop, {
    chainId: "chain-1",
    chainName: "香港 → 东京",
    seq: 1,
    p50Ms: 20,
  });
});

test("last hop missing is called out and excluded from the hop sum", () => {
  const result = normalizeChainHealth(
    payload([
      chain({
        hops: 2,
        missing_hops: [2],
        estimated: true,
        segments: [
          {
            seq: 1,
            from: "香港-01",
            to: "东京-01",
            p50: 14.1,
            delta_ms: 0,
            contribution_pct: 0,
          },
        ],
      }),
    ]),
  );
  assert.equal(result.status, "ok");
  const item = result.snapshot.chains[0];
  assert.equal(item.hops, 2);
  assert.deepEqual(item.missingHops, [2]);
  assert.equal(item.lastHopMissing, true);
  assert.equal(item.estimated, true);
  assert.equal(item.segments.length, 2);
  assert.equal(item.segments[1].missing, true);
  assert.equal(item.latestP50, 21); // series is still the chain-level curve
  assert.equal(item.hasSamples, true);
});

test("a chain with a declared missing hop but no segments still has a row per hop", () => {
  const result = normalizeChainHealth(
    payload([
      chain({
        hops: 3,
        missing_hops: [2, 3],
        estimated: true,
        segments: [],
        series: [],
      }),
    ]),
  );
  const item = result.snapshot.chains[0];
  assert.equal(item.segments.length, 3);
  assert.deepEqual(item.missingHops, [1, 2, 3]);
  assert.equal(item.lastHopMissing, true);
  assert.equal(item.hasSamples, false);
  assert.equal(item.estimated, true);
});

test("series is sorted, de-duplicated and never fills gaps with zero", () => {
  const result = normalizeChainHealth(
    payload([
      chain({
        series: [
          point(300, 30, 40, 20),
          point(100, 10),
          { ts: 200, p50: 20, samples: 0 },
          null,
          point(100, 11),
        ],
      }),
    ]),
  );
  const series = result.snapshot.chains[0].series;
  assert.deepEqual(
    series.map((item) => item.ts),
    [100, 200, 300],
  );
  assert.equal(series[0].p50, 11);
  assert.equal(series[1].p50, null);
  assert.equal(series[1].samples, 0);
  // P10 / P90 swapped for display.
  assert.equal(series[2].p10, 20);
  assert.equal(series[2].p90, 40);
});

test("slow chain is derived from segment deltas when summary is absent", () => {
  const result = normalizeChainHealth(
    payload([
      chain({
        segments: [
          {
            seq: 1,
            from: "A",
            to: "B",
            p50: 20,
            delta_ms: SLOW_CHAIN_DELTA_MS,
            contribution_pct: 100,
          },
        ],
      }),
    ]),
  );
  assert.equal(result.snapshot.chains[0].slow, true);
  assert.equal(result.snapshot.summary.slowChains, 1);
});

test("a measurable segment without samples is a row, not a missing hop", () => {
  const result = normalizeChainHealth(
    payload([
      chain({
        hops: 3,
        missing_hops: [3],
        estimated: false,
        series: [],
        segments: [
          {
            seq: 1,
            from: "香港-01",
            to: "日本-02",
            p50: null,
            delta_ms: null,
            contribution_pct: 0,
          },
          {
            seq: 2,
            from: "日本-02",
            to: "美国-04",
            p50: null,
            delta_ms: null,
            contribution_pct: 0,
          },
        ],
      }),
    ]),
  );
  const item = result.snapshot.chains[0];
  assert.equal(item.segments[0].missing, false);
  assert.equal(item.segments[0].p50, null);
  assert.equal(item.segments[2].missing, true);
  assert.deepEqual(item.missingHops, [3]);
  assert.equal(item.hasSamples, false);
  assert.equal(chainDiagnosis(item).kind, "unknown");
});

test("diagnosis single_hop carries delta and contribution", () => {
  const result = normalizeChainHealth(
    payload([
      chain({
        diagnosis: { kind: "single_hop", seq: 1 },
        segments: [
          {
            seq: 1,
            from: "香港-01",
            to: "东京-01",
            p50: 29,
            delta_ms: 15,
            contribution_pct: 95,
          },
        ],
      }),
    ]),
  );
  const view = chainDiagnosis(result.snapshot.chains[0]);
  assert.equal(view.kind, "single_hop");
  assert.equal(view.seq, 1);
  assert.equal(view.overallDeltaMs, 15);
  assert.equal(view.segmentDeltaMs, 15);
  assert.equal(view.contributionPct, 95);
});

test("diagnosis falls back to unknown when the named hop has no sample", () => {
  const result = normalizeChainHealth(
    payload([
      chain({
        diagnosis: { kind: "single_hop", seq: 2 },
        segments: [
          {
            seq: 1,
            from: "香港-01",
            to: "东京-01",
            p50: 29,
            delta_ms: 15,
            contribution_pct: 95,
          },
        ],
      }),
    ]),
  );
  assert.equal(chainDiagnosis(result.snapshot.chains[0]).kind, "unknown");
});

test("diagnosis overall is kept; no samples is always unknown", () => {
  const overall = normalizeChainHealth(
    payload([
      chain({
        diagnosis: { kind: "overall" },
        segments: [
          {
            seq: 1,
            from: "A",
            to: "B",
            p50: 20,
            delta_ms: 5,
            contribution_pct: 50,
          },
          {
            seq: 2,
            from: "B",
            to: "C",
            p50: 20,
            delta_ms: 5,
            contribution_pct: 50,
          },
        ],
      }),
    ]),
  );
  assert.equal(chainDiagnosis(overall.snapshot.chains[0]).kind, "overall");

  const empty = normalizeChainHealth(
    payload([chain({ series: [], segments: [] })]),
  );
  assert.equal(chainDiagnosis(empty.snapshot.chains[0]).kind, "unknown");
});

test("multi-series trend keeps only chains with samples and unions timestamps", () => {
  const result = normalizeChainHealth(
    payload([
      chain({
        id: "a",
        name: "A",
        series: [
          point(300, 30),
          point(100, 10),
          point(200, 20),
        ],
      }),
      chain({
        id: "b",
        name: "B",
        series: [point(100, 5), point(300, null, null, null, 0)],
      }),
      chain({ id: "c", name: "C", series: [] }),
    ]),
  );
  const { rows, series } = buildChainTrendData(result.snapshot.chains);
  assert.deepEqual(
    series.map((item) => item.id),
    ["a", "b"],
  );
  assert.equal(chainHasTrend(result.snapshot.chains[2]), false);
  assert.deepEqual(rows, [
    { ts: 100, a: 10, b: 5 },
    { ts: 200, a: 20, b: null },
    { ts: 300, a: 30, b: null },
  ]);
});

test("multi-series trend is empty when no chain has a curve", () => {
  const result = normalizeChainHealth(
    payload([chain({ series: [] }), chain({ id: "b", series: [] })]),
  );
  assert.deepEqual(buildChainTrendData(result.snapshot.chains), {
    rows: [],
    series: [],
  });
});

test("list status is normal / slow / insufficient", () => {
  const base = normalizeChainHealth(payload([chain()])).snapshot.chains[0];
  assert.equal(chainStatus(base), "normal");
  assert.equal(
    chainStatus({ ...base, hasSamples: false, deltaMs: 10 }),
    "insufficient",
  );
  assert.equal(chainStatus({ ...base, deltaMs: null }), "insufficient");
  assert.equal(chainStatus({ ...base, slow: true, deltaMs: 8 }), "slow");
});

test("topology stitches segment from/to and flags the missing target hop", () => {
  const item = normalizeChainHealth(
    payload([
      chain({
        hops: 4,
        missing_hops: [4],
        series: [],
        segments: [
          {
            seq: 1,
            from: "香港-01",
            to: "东京-01",
            p50: 14,
            delta_ms: 0,
            contribution_pct: 0,
          },
          {
            seq: 2,
            from: "东京-01",
            to: "新加坡-01",
            p50: 28.5,
            delta_ms: 1,
            contribution_pct: 0,
          },
          {
            seq: 3,
            from: "新加坡-01",
            to: "大阪-01",
            p50: 43.2,
            delta_ms: 2,
            contribution_pct: 100,
          },
        ],
      }),
    ]),
  ).snapshot.chains[0];
  const topology = chainTopology(item);
  assert.deepEqual(topology.nodes, [
    "香港-01",
    "东京-01",
    "新加坡-01",
    "大阪-01",
  ]);
  assert.deepEqual(topology.edges, [
    { seq: 1, p50: 14, missing: false },
    { seq: 2, p50: 28.5, missing: false },
    { seq: 3, p50: 43.2, missing: false },
  ]);
  assert.equal(topology.targetMissing, true);
});

test("topology keeps nodes for a segment with no samples", () => {
  const item = normalizeChainHealth(
    payload([
      chain({
        hops: 2,
        missing_hops: [2],
        series: [],
        segments: [
          {
            seq: 1,
            from: "香港-01",
            to: "东京-01",
            p50: null,
            delta_ms: null,
            contribution_pct: 0,
          },
        ],
      }),
    ]),
  ).snapshot.chains[0];
  const topology = chainTopology(item);
  assert.deepEqual(topology.nodes, ["香港-01", "东京-01"]);
  assert.deepEqual(topology.edges, [{ seq: 1, p50: null, missing: true }]);
  assert.equal(topology.targetMissing, true);
});

test("diagnosis reason separates stable chains from missing samples", () => {
  const view = {
    kind: "unknown",
    overallDeltaMs: 0,
    seq: null,
    segmentDeltaMs: null,
    contributionPct: null,
  };
  assert.equal(chainDiagnosisReason(view, true), "stable");
  assert.equal(chainDiagnosisReason(view, false), "unknown");
  assert.equal(
    chainDiagnosisReason({ ...view, overallDeltaMs: null }, true),
    "unknown",
  );
  assert.equal(
    chainDiagnosisReason({ ...view, kind: "single_hop" }, true),
    "single_hop",
  );
  assert.equal(
    chainDiagnosisReason({ ...view, kind: "overall" }, true),
    "overall",
  );
});

test("anomaly windows merge adjacent spikes and break on gaps", () => {
  const series = [
    point(0, 20),
    point(900, 21),
    point(1800, 20),
    point(2700, 21),
    point(3600, 20),
    point(4500, 21),
    point(5400, 45),
    point(6300, 46),
    point(7200, 20),
    point(8100, 21),
    point(9000, 20),
    point(9900, 44),
  ];
  const windows = chainAnomalyWindows(series, 900);
  assert.deepEqual(windows, [
    { startTs: 5400, endTs: 6300, peakMs: 46 },
    { startTs: 9900, endTs: 9900, peakMs: 44 },
  ]);
});

test("short or flat series never produce anomaly windows", () => {
  assert.deepEqual(chainAnomalyWindows([point(0, 20), point(900, 45)], 900), []);
  const flat = [point(0, 20), point(900, 20), point(1800, 20)];
  assert.deepEqual(chainAnomalyWindows(flat, 900), []);
  // A mild bump below the +8ms floor is not an anomaly.
  const mild = [
    point(0, 20),
    point(900, 20),
    point(1800, 20 + ANOMALY_MIN_DELTA_MS - 1),
  ];
  assert.deepEqual(chainAnomalyWindows(mild, 900), []);
});

test("segment trends aggregate raw 5-minute points into the requested bucket", () => {
  const points = [
    { ts: 0, seq: 1, latency_ms: 10 },
    { ts: 60, seq: 1, latency_ms: 20 },
    { ts: 120, seq: 1, latency_ms: 30 },
    { ts: 900, seq: 1, latency_ms: 40 },
    { ts: 0, seq: 2, latency_ms: 5 },
  ];
  const trends = segmentTrends(points, 900);
  assert.deepEqual(trends.get(1), [
    { ts: 0, p50: 20, p10: null, p90: null, samples: 3 },
    { ts: 900, p50: 40, p10: null, p90: null, samples: 1 },
  ]);
  assert.deepEqual(trends.get(2), [
    { ts: 0, p50: 5, p10: null, p90: null, samples: 1 },
  ]);

  const result = normalizeChainHealth(payload([chain()]));
  const segment = result.snapshot.chains[0].segments[0];
  assert.deepEqual(segmentSeries(segment, trends), trends.get(1));
});

test("segmentSeries prefers contract-provided per-segment history", () => {
  const result = normalizeChainHealth(
    payload([
      chain({
        segments: [
          {
            seq: 1,
            from: "A",
            to: "B",
            p50: 20,
            delta_ms: 0,
            contribution_pct: 0,
            series: [point(1_800_000_000, 12)],
          },
        ],
      }),
    ]),
  );
  const segment = result.snapshot.chains[0].segments[0];
  assert.deepEqual(segmentSeries(segment, new Map()), [point(1_800_000_000, 12)]);
});

test("formatting keeps units and uses an em dash for missing samples", () => {
  assert.equal(formatMs(43), "43 ms");
  assert.equal(formatMs(43.24), "43.2 ms");
  assert.equal(formatMs(null), "—");
  assert.equal(formatSignedMs(15), "+15 ms");
  assert.equal(formatSignedMs(-3), "-3 ms");
  assert.equal(formatSignedMs(0), "0 ms");
  assert.equal(formatSignedMs(null), "—");
  assert.equal(formatPercentValue(95.4), "95");
  assert.equal(formatPercentValue(null), "—");
  assert.equal(chainSeriesMax([point(0, 10, 5, 30)]), 30);
  assert.equal(formatChainTime(0, 900), "01/01 08:00");
  assert.equal(formatChainTime(0, 3600), "01/01 08:00");
});

test("unsupported detection only covers 404/403", () => {
  assert.equal(
    isChainHealthUnsupported(new ApiError("missing", 404)),
    true,
  );
  assert.equal(
    isChainHealthUnsupported(new ApiError("forbidden", 403)),
    true,
  );
  assert.equal(
    isChainHealthUnsupported(new ApiError("boom", 500)),
    false,
  );
  assert.equal(isChainHealthUnsupported(new Error("network")), false);
});

test("loss fields normalize from the incremental contract", () => {
  const result = normalizeChainHealth(
    payload(
      [
        chain({
          loss_pct: 1.2,
          loss_partial: true,
          loss_samples: { attempts: 720, failures: 9 },
          segments: [
            {
              seq: 1,
              from: "香港-01",
              to: "东京-01",
              p50: 20,
              delta_ms: 1,
              contribution_pct: 100,
              loss_pct: 0.83,
              attempts: 240,
              failures: 2,
            },
            {
              seq: 2,
              from: "东京-01",
              to: "10.0.0.8",
              p50: 1,
              delta_ms: 0,
              contribution_pct: 0,
            },
          ],
        }),
      ],
      {
        loss_pct: 1.2,
        worst_loss: {
          chain_id: "chain-1",
          chain_name: "香港 → 东京",
          loss_pct: 1.2,
        },
      },
    ),
  );
  const snapshot = result.snapshot;
  const item = snapshot.chains[0];
  assert.equal(item.lossPct, 1.2);
  assert.equal(item.lossPartial, true);
  assert.deepEqual(item.lossSamples, { attempts: 720, failures: 9 });
  assert.equal(item.segments[0].lossPct, 0.83);
  assert.equal(item.segments[0].attempts, 240);
  assert.equal(item.segments[0].failures, 2);
  assert.equal(item.segments[1].lossPct, null);
  assert.equal(item.segments[1].attempts, null);
  assert.equal(snapshot.summary.lossPct, 1.2);
  assert.deepEqual(snapshot.summary.worstLoss, {
    chainId: "chain-1",
    chainName: "香港 → 东京",
    lossPct: 1.2,
  });
});

test("an older payload without loss fields stays null, never 0%", () => {
  const result = normalizeChainHealth(payload([chain()]));
  const snapshot = result.snapshot;
  const item = snapshot.chains[0];
  assert.equal(item.lossPct, null);
  assert.equal(item.lossPartial, false);
  assert.equal(item.lossSamples, null);
  assert.equal(item.segments[0].lossPct, null);
  assert.equal(item.segments[0].attempts, null);
  assert.equal(item.segments[0].failures, null);
  assert.equal(snapshot.summary.lossPct, null);
  assert.equal(snapshot.summary.worstLoss, null);
});

test("out-of-range loss percentages are treated as missing", () => {
  const result = normalizeChainHealth(
    payload([
      chain({
        loss_pct: 120,
        loss_partial: "yes",
        loss_samples: { attempts: "nope", failures: "nope" },
        segments: [
          {
            seq: 1,
            from: "A",
            to: "B",
            p50: 20,
            delta_ms: 1,
            contribution_pct: 100,
            loss_pct: -0.5,
            attempts: 0,
            failures: 0,
          },
        ],
      }),
    ]),
  );
  const item = result.snapshot.chains[0];
  assert.equal(item.lossPct, null);
  assert.equal(item.lossPartial, false);
  assert.equal(item.lossSamples, null);
  assert.equal(item.segments[0].lossPct, null);
  assert.equal(item.segments[0].attempts, null);
  assert.equal(formatLossPct(item.segments[0].lossPct), "—");
});

test("worst_loss falls back to the chain with the highest loss", () => {
  const result = normalizeChainHealth(
    payload([
      chain({ loss_pct: 0.3 }),
      chain({ id: "chain-2", name: "大阪 → 洛杉矶", loss_pct: 3.4 }),
      chain({ id: "chain-3", name: "无探测" }),
    ]),
  );
  assert.equal(result.snapshot.summary.lossPct, null);
  assert.deepEqual(result.snapshot.summary.worstLoss, {
    chainId: "chain-2",
    chainName: "大阪 → 洛杉矶",
    lossPct: 3.4,
  });
});

test("loss tone uses only three existing semantic tones", () => {
  assert.equal(chainLossTone(null), null);
  assert.equal(chainLossTone(0), "normal");
  assert.equal(chainLossTone(0.49), "normal");
  assert.equal(chainLossTone(0.5), "warning");
  assert.equal(chainLossTone(1.2), "warning");
  assert.equal(chainLossTone(2), "warning");
  assert.equal(chainLossTone(2.01), "destructive");
  assert.equal(chainLossTone(100), "destructive");
});

test("loss formatting keeps one decimal and an em dash for missing probes", () => {
  assert.equal(formatLossPct(null), "—");
  assert.equal(formatLossPct(0), "0%");
  assert.equal(formatLossPct(0.25), "0.3%");
  assert.equal(formatLossPct(1.2), "1.2%");
  assert.equal(formatLossPct(2), "2%");
  assert.equal(formatLossPct(100), "100%");
  assert.equal(formatLossPct(0.04), "<0.1%");
  assert.equal(formatLossProbes(240, 2), "2 / 240");
  assert.equal(formatLossProbes(null, 2), "—");
  assert.equal(formatLossProbes(240, null), "—");
  assert.equal(formatLossProbes(0, 0), "—");
});

test("chainLatestSampleTs uses the newest valid hop or overall sample", () => {
  const value = chainLatestSampleTs({
    series: [point(1_800_000_000, 20), point(1_800_003_600, null, null, null, 0)],
    segments: [
      {
        seq: 1,
        from: "A",
        to: "B",
        p50: 20,
        deltaMs: 1,
        contributionPct: 100,
        missing: false,
        lossPct: null,
        attempts: null,
        failures: null,
        series: [point(1_800_007_200, 21)],
      },
    ],
  });
  assert.equal(value, 1_800_007_200);
  assert.equal(chainLatestSampleTs({ series: [], segments: [] }), null);
});

test("zero-attempt probe samples stay missing instead of becoming 0%", () => {
  const result = normalizeChainHealth(
    payload(
      [
        chain({
          loss_pct: null,
          loss_partial: true,
          loss_samples: { attempts: 0, failures: 0 },
          segments: [
            {
              seq: 1,
              from: "A",
              to: "B",
              p50: 20,
              delta_ms: 1,
              contribution_pct: 100,
              loss_pct: null,
              attempts: 0,
              failures: 0,
            },
          ],
        }),
      ],
      { loss_pct: null, worst_loss: null },
    ),
  );
  const item = result.snapshot.chains[0];
  assert.equal(item.lossPct, null);
  assert.equal(item.lossSamples, null);
  assert.equal(item.lossPartial, true);
  assert.equal(item.segments[0].attempts, null);
  assert.equal(formatLossPct(item.lossPct), "—");
  assert.equal(formatLossProbes(0, 0), "—");
  assert.equal(result.snapshot.summary.worstLoss, null);
});
