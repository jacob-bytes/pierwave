import { normalizeChainHealth } from "@/lib/chainHealth";

/**
 * 多路径时延卡的验收 fixture：真实 `ChainLatencyDetail` + 真实
 * `normalizeChainHealth`，不依赖主控。
 *
 * - `failover`：主备组 3 台，东京-01 离线、东京-02 是当前通路 →
 *   徽章「降级 · 东京-01 离线」，段标题「第 1 段 · 主备 · 3 选 1」；
 * - `roundRobin`：轮询组 3 台、没有当前成员 → 「第 1 段 · 轮询 · 3 台分担」；
 * - `single`：单成员链 → 没有多路径说明，段标题保持「第 1 段」；
 * - `missingMembers`：节点有策略、段没有 `members[]` → 标题仍在，明细降级消失；
 * - `many`：10 台成员 → 明细最多 8 行 + `+2`，当前成员排第一。
 */

const BUCKET = 900;
const BASE_TS = 1_800_000_000;

function point(ts, p50) {
  return {
    ts,
    p50,
    p10: Math.max(0, p50 - 2),
    p90: p50 + 2,
    samples: 4,
    loss_pct: 0.15,
  };
}

/** 8 个 15 分钟桶；同一条链的所有段共用时间轴，tooltip 才能合并成一行。 */
function series(p50) {
  return Array.from({ length: 8 }, (_, index) =>
    point(BASE_TS - (7 - index) * BUCKET, p50 + (index % 3)),
  );
}

function member(serverId, name, { status = "online", p50 = 22, loss = 0.1, active } = {}) {
  return {
    server_id: serverId,
    name,
    status,
    p50_ms: p50,
    loss_pct: loss,
    attempts: 120,
    failures: loss > 0.5 ? 2 : 1,
    ...(active === undefined ? {} : { active }),
  };
}

function members(prefix, count, options = {}) {
  return Array.from({ length: count }, (_, index) =>
    member(`${prefix}-${index + 1}`, `${prefix}-0${index + 1}`, {
      p50: 18 + index * 2,
      ...options,
    }),
  );
}

function segment(seq, from, to, p50, segmentMembers = []) {
  return {
    seq,
    from,
    to,
    p50,
    delta_ms: 1,
    contribution_pct: 50,
    loss_pct: 0.2,
    attempts: 120,
    failures: 1,
    series: series(p50),
    members: segmentMembers,
  };
}

function node(seq, name, role, nodeMembers, options = {}) {
  const list = nodeMembers ?? [];
  return {
    seq,
    name,
    role,
    status: "status" in options ? options.status : "online",
    server_id: options.serverId ?? list[0]?.server_id ?? null,
    member_count: list.length,
    members: list,
    ...(options.strategy === undefined ? {} : { strategy: options.strategy }),
    ...(options.activeServerId === undefined
      ? {}
      : { active_server_id: options.activeServerId }),
  };
}

function chainPayload({ id, name, nodes, segments, status, estimated }) {
  return {
    id,
    name,
    hops: Math.max(1, nodes.length - 1),
    status,
    last_hop: { measurable: true, reason: null },
    entry: null,
    exit: null,
    nodes,
    missing_hops: [],
    estimated,
    series: series(44),
    segments,
    diagnosis: { kind: "overall", seq: null },
    loss_pct: 0.2,
    loss_partial: false,
    loss_samples: { attempts: 240, failures: 2 },
  };
}

function payload(chains) {
  return {
    generated_at: BASE_TS + 60,
    hours: 24,
    bucket: BUCKET,
    summary: {},
    chains,
  };
}

/* ------------------------------------------------------------------ */
/* failover：主备 3 台，一台离线，东京-02 是当前                       */
/* ------------------------------------------------------------------ */

const tokyo = [
  member("s-tk1", "东京-01", { status: "offline", p50: 21.5, loss: 0.4 }),
  member("s-tk2", "东京-02", { p50: 22.1, loss: 0.1, active: true }),
  member("s-tk3", "东京-03", { p50: 30.2, loss: 0.2, active: false }),
];

const failover = payload([
  chainPayload({
    id: "chain-failover",
    name: "香港 → 东京（主备）",
    estimated: true,
    status: {
      kind: "degraded",
      cause: "node_offline",
      node: { seq: 1, name: "东京-01" },
    },
    nodes: [
      node(0, "香港入口", "source", [member("s-hk1", "香港-01", { p50: 8.2 })]),
      node(1, "东京中转（主备）", "hop", tokyo, {
        status: "offline",
        strategy: "failover",
        activeServerId: "s-tk2",
      }),
      node(2, "链目标", "target", [], { status: null }),
    ],
    segments: [
      // `segments[].members` 是段**源组**成员：段 1 的源组是入口（1 台），
      // 段 2 的源组才是东京 3 台（策略也从这一组读）。
      segment(1, "香港-01", "东京-02", 22.4, [
        member("s-hk1", "香港-01", { p50: 8.2, active: false }),
      ]),
      segment(2, "东京-02", "10.0.0.8", 21.1, tokyo),
    ],
  }),
]);

/* ------------------------------------------------------------------ */
/* round_robin：3 台分担、没有「当前」                                 */
/* ------------------------------------------------------------------ */

const hkRoundRobin = members("香港", 3, { active: undefined });
const roundRobin = payload([
  chainPayload({
    id: "chain-round-robin",
    name: "新加坡 → 香港（轮询）",
    estimated: true,
    status: { kind: "ok", cause: null, node: null },
    nodes: [
      node(0, "新加坡入口", "source", [member("s-sg1", "新加坡-01", { p50: 9.4 })]),
      node(1, "香港分流（轮询）", "hop", hkRoundRobin, {
        strategy: "round_robin",
      }),
      node(2, "链目标", "target", [], { status: null }),
    ],
    segments: [
      segment(1, "新加坡-01", "香港-01", 17.2, [
        member("s-sg1", "新加坡-01", { p50: 9.4, active: false }),
      ]),
      segment(2, "香港-01", "10.0.0.8", 18.4, hkRoundRobin),
    ],
  }),
]);

/* ------------------------------------------------------------------ */
/* single：单成员链，没有多路径说明 / 策略                             */
/* ------------------------------------------------------------------ */

const single = payload([
  chainPayload({
    id: "chain-single",
    name: "香港 → 东京（单路径）",
    estimated: false,
    status: { kind: "ok", cause: null, node: null },
    nodes: [
      node(0, "香港入口", "source", [member("s-hk1", "香港-01", { p50: 8.2 })]),
      node(1, "东京出口", "hop", [member("s-tk1", "东京-01", { p50: 18.6 })]),
      node(2, "链目标", "target", [], { status: null }),
    ],
    segments: [
      segment(1, "香港-01", "东京-01", 18.6, [
        member("s-hk1", "香港-01", { p50: 8.2, active: false }),
      ]),
      segment(2, "东京-01", "10.0.0.8", 42.3, [
        member("s-tk1", "东京-01", { p50: 42.3, active: false }),
      ]),
    ],
  }),
]);

/* ------------------------------------------------------------------ */
/* missingMembers：旧段契约（没有 members[]），标题仍在、明细降级       */
/* ------------------------------------------------------------------ */

const missingMembers = payload([
  chainPayload({
    id: "chain-missing-members",
    name: "香港 → 东京（旧段契约）",
    estimated: true,
    status: { kind: "degraded", cause: "node_offline", node: { seq: 1, name: "东京-01" } },
    nodes: [
      node(0, "香港入口", "source", [member("s-hk1", "香港-01")]),
      node(1, "东京中转（主备）", "hop", tokyo, {
        status: "offline",
        strategy: "failover",
        activeServerId: "s-tk2",
      }),
      node(2, "链目标", "target", [], { status: null }),
    ],
    segments: [
      // 故意不带 members 字段：tooltip / 图例明细必须整体消失。
      segment(1, "香港-01", "东京-02", 22.4),
      segment(2, "东京-02", "10.0.0.8", 21.1),
    ],
  }),
]);

/* ------------------------------------------------------------------ */
/* many：10 台成员，超过 8 行折成 +2                                   */
/* ------------------------------------------------------------------ */

const frankfurt = Array.from({ length: 10 }, (_, index) =>
  member(`s-fra${index + 1}`, `法兰克福-${String(index + 1).padStart(2, "0")}`, {
    p50: 41 + index,
    loss: index / 10,
    active: index === 9,
  }),
);

const many = payload([
  chainPayload({
    id: "chain-many",
    name: "香港 → 法兰克福（10 台主备）",
    estimated: true,
    status: { kind: "ok", cause: null, node: null },
    nodes: [
      node(0, "香港入口", "source", [member("s-hk1", "香港-01", { p50: 8.2 })]),
      node(1, "法兰克福分流（主备）", "hop", frankfurt, {
        strategy: "failover",
        activeServerId: "s-fra10",
      }),
      node(2, "链目标", "target", [], { status: null }),
    ],
    segments: [
      segment(1, "香港-01", "法兰克福-10", 52.4, [
        member("s-hk1", "香港-01", { p50: 8.2, active: false }),
      ]),
      segment(2, "法兰克福-10", "10.0.0.8", 49.1, frankfurt),
    ],
  }),
]);

const FIXTURES = { failover, roundRobin, single, missingMembers, many };

export function detailFor(name) {
  const fixture = FIXTURES[name] ?? failover;
  const parsed = normalizeChainHealth(fixture);
  return { chain: parsed.snapshot.chains[0], snapshot: parsed.snapshot };
}
