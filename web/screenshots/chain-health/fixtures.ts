import { normalizeChainHealth } from "@/lib/chainHealth";

const BUCKET = 900;
const BASE_TS = 1_800_000_000;

function point(ts, p50, samples = 4) {
  return {
    ts,
    p50,
    p10: p50 === null ? null : Math.max(0, p50 - 2),
    p90: p50 === null ? null : p50 + 2,
    samples,
    loss_pct: 0.15,
  };
}

/** 8 个 15 分钟桶；中间段有样本，最后一跳不可测。 */
function series(p50 = 32) {
  return Array.from({ length: 8 }, (_, index) =>
    point(BASE_TS - (7 - index) * BUCKET, p50 + (index % 3)),
  );
}

function segment(seq, from, to, p50, seriesPoints = []) {
  return {
    seq,
    from,
    to,
    p50,
    delta_ms: p50 === null ? null : 0,
    contribution_pct: p50 === null ? null : 0,
    attempts: p50 === null ? 0 : 120,
    failures: p50 === null ? 0 : 1,
    loss_pct: p50 === null ? null : 0.83,
    series: seriesPoints,
  };
}

function chain({
  id,
  name,
  status,
  lastHop,
  missingHops = [],
}) {
  return {
    id,
    name,
    hops: 2,
    entry: {
      server_id: "srv-hk",
      server_name: "香港-01",
      ip: "203.0.113.11",
      port: 21001,
      address: "203.0.113.11:21001",
    },
    exit: {
      server_id: "srv-tk",
      server_name: "东京-01",
      ip: "198.51.100.23",
      port: 21002,
      address: "198.51.100.23:21002",
    },
    nodes: [
      {
        seq: 0,
        server_id: "srv-hk",
        name: "香港入口",
        role: "source",
        status: "online",
        member_count: 1,
        members: [{ server_id: "srv-hk", name: "香港-01", status: "online" }],
      },
      {
        seq: 1,
        server_id: "srv-tk",
        name: "东京出口",
        role: "hop",
        status: "online",
        member_count: 1,
        members: [{ server_id: "srv-tk", name: "东京-01", status: "online" }],
      },
      {
        seq: 2,
        server_id: null,
        name: "链目标",
        role: "target",
        status: null,
        member_count: 0,
        members: [],
      },
    ],
    estimated: false,
    missing_hops: missingHops,
    ...(lastHop === undefined ? {} : { last_hop: lastHop }),
    ...(status === undefined ? {} : { status }),
    series: series(),
    segments: [
      segment(
        1,
        "香港-01",
        "东京-01",
        31.5,
        series(31.5),
      ),
      // 最后一跳保留段位，但不可测时没有 p50 / series。
      segment(2, "东京-01", "链目标", null),
    ],
    loss_pct: null,
    loss_partial: false,
    loss_samples: null,
    diagnosis: { kind: "unknown" },
  };
}

const realm = {
  generated_at: BASE_TS + 60,
  hours: 24,
  bucket: BUCKET,
  summary: {},
  chains: [
    chain({
      id: "chain-realm",
      name: "港日 realm 中转",
      status: { kind: "unknown", cause: "unmeasurable", node: null },
      lastHop: { measurable: false, reason: "engine_unsupported" },
    }),
  ],
};

const udp = {
  ...realm,
  chains: [
    chain({
      id: "chain-udp",
      name: "港日 UDP 中转",
      status: { kind: "unknown", cause: "unmeasurable", node: null },
      lastHop: { measurable: false, reason: "protocol_unsupported" },
    }),
  ],
};

/** 旧主控：没有 status / last_hop，最后一跳只是 missing_hops。 */
const legacy = {
  ...realm,
  chains: [
    chain({
      id: "chain-legacy",
      name: "港日旧主控链",
      missingHops: [2],
      // 旧契约没有 last_hop，也没有 unknown status。
    }),
  ],
};

/** 节点异常：与不可测区分（degraded，不是 unknown）。 */
const degraded = {
  ...realm,
  chains: [
    chain({
      id: "chain-degraded",
      name: "港日节点异常",
      status: {
        kind: "degraded",
        cause: "node_unhealthy",
        node: { seq: 1, name: "东京-02" },
      },
      lastHop: { measurable: true, reason: null },
    }),
  ],
};

const FIXTURES = { realm, udp, legacy, degraded };

export function detailFor(name) {
  const payload = FIXTURES[name] ?? realm;
  const parsed = normalizeChainHealth(payload);
  return { chain: parsed.snapshot.chains[0], snapshot: parsed.snapshot };
}
