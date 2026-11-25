import assert from "node:assert/strict";
import test from "node:test";
import {
  TEMPLATE_MEMBER_STATUSES,
  TEMPLATE_STRATEGY_ORDER,
  chainTemplateDetailTotals,
  chainTemplateHotspots,
  chainTemplateNodeHeat,
  aggregateChainTemplateEdges,
  chainTemplateMemberStatus,
  chainTemplateStrategyLabelKey,
  chainTemplateStatus,
  chainTemplateStatusKind,
  chainTemplateUsageHasData,
  chainTemplateUsageSeries,
  chainTemplateUsageUsers,
  isChainTemplateInsightUnsupported,
  normalizeChainTemplateDetail,
  normalizeChainTemplateList,
  strategyShares,
  targetLabel,
} from "./chainTemplateInsight.ts";
import { ApiError } from "./apiError.ts";

const HOUR = 3_600;
const NOW = 1_800_000_000;

function listItem(overrides = {}) {
  return {
    id: "tpl-1",
    name: "香港 → 东京",
    hops: 3,
    enabled: true,
    chains: 5,
    users: 3,
    status: { kind: "ok", cause: null },
    strategies: [{ strategy: "ip_hash", chains: 3 }],
    targets: [{ host: "1.2.3.4", port: 443, chains: 2 }],
    ...overrides,
  };
}

function member(name, chains, users, status = "online") {
  return {
    server_id: name,
    name,
    status,
    chains,
    users,
  };
}

/** 3 跳（source + hop1 + hop2 + target）的最小详情。 */
function detail(overrides = {}) {
  return {
    template: { id: "tpl-1", name: "香港 → 东京", hops: 3, created_at: 1_799_000_000 },
    nodes: [
      {
        seq: 0,
        role: "source",
        name: "香港入口",
        members: [member("香港-01", 5, 3)],
      },
      {
        seq: 1,
        role: "hop",
        name: "东京中转",
        members: [member("东京-01", 4, 2), member("东京-02", 1, 1)],
      },
      {
        seq: 2,
        role: "hop",
        name: "洛杉矶中转",
        members: [member("洛杉矶-01", 5, 3, "offline")],
      },
      {
        seq: 3,
        role: "target",
        name: "目标",
        members: [{ name: "1.2.3.4:443", chains: 2, users: 2 }],
      },
    ],
    edges: [
      {
        seq: 1,
        from: { seq: 0, member: "香港-01" },
        to: { seq: 1, member: "东京-01" },
        chains: 4,
        users: 3,
        p50_ms: 15.5,
        loss_pct: 0.2,
      },
      {
        seq: 1,
        from: { seq: 0, member: "香港-01" },
        to: { seq: 1, member: "东京-02" },
        chains: 1,
        users: 1,
        p50_ms: 18,
        loss_pct: 0,
      },
      {
        seq: 2,
        from: { seq: 1, member: "东京-01" },
        to: { seq: 2, member: "洛杉矶-01" },
        chains: 4,
        users: 3,
        p50_ms: 120.4,
        loss_pct: 1.4,
      },
      {
        seq: 2,
        from: { seq: 1, member: "东京-02" },
        to: { seq: 2, member: "洛杉矶-01" },
        chains: 1,
        users: 1,
        p50_ms: 140,
        loss_pct: null,
      },
      {
        seq: 3,
        from: { seq: 2, member: "洛杉矶-01" },
        to: { seq: 3, member: "1.2.3.4:443" },
        chains: 5,
        users: 3,
        p50_ms: 160.2,
        loss_pct: 0.5,
      },
    ],
    targets: [
      {
        host: "1.2.3.4",
        port: 443,
        chains: 3,
        users: [{ id: "u1", name: "demo" }],
      },
      {
        host: "5.6.7.8",
        port: 8443,
        chains: 2,
        users: [{ id: "u1", name: "demo" }],
      },
    ],
    users: [
      { id: "u1", name: "demo", chains: 2 },
      { id: "u2", name: "alice", chains: 3 },
    ],
    series: Array.from({ length: 12 }, (_, index) => ({
      ts: NOW - (11 - index) * HOUR,
      chains: 3 + (index % 3),
      users: 1 + (index % 2),
    })),
    strategies: [
      { strategy: "ip_hash", chains: 3, users: 2 },
      { strategy: "round_robin", chains: 2, users: 1 },
    ],
    ...overrides,
  };
}

test("列表归一化：缺字段不造数，未知状态降为 unknown", () => {
  assert.deepEqual(normalizeChainTemplateList(null), {
    generatedAt: null,
    items: [],
  });

  const snapshot = normalizeChainTemplateList({
    generated_at: 123,
    items: [
      listItem(),
      {
        id: "tpl-2",
        name: "只有名字",
        status: { kind: "mystery", cause: "boom" },
      },
    ],
  });

  assert.equal(snapshot.generatedAt, 123);
  assert.equal(snapshot.items.length, 2);
  const [first, second] = snapshot.items;
  assert.equal(first.status.kind, "ok");
  assert.equal(first.chains, 5);
  assert.equal(second.hops, 0);
  assert.equal(second.chains, 0);
  assert.equal(second.users, 0);
  assert.equal(second.enabled, true);
  assert.deepEqual(second.status, { kind: "unknown", cause: "boom" });
  assert.deepEqual(second.strategies, []);
  assert.deepEqual(second.targets, []);
});

test("列表兼容直接返回数组，并按 id 去重", () => {
  const snapshot = normalizeChainTemplateList([
    listItem(),
    listItem({ name: "重复 id" }),
    listItem({ id: "tpl-3", name: "另一个" }),
  ]);
  assert.equal(snapshot.items.length, 2);
  assert.equal(snapshot.items[0].name, "香港 → 东京");
  assert.equal(snapshot.generatedAt, null);
});

test("状态归一化：只有三种契约状态，cause 去空白", () => {
  assert.equal(chainTemplateStatusKind("ok"), "ok");
  assert.equal(chainTemplateStatusKind("degraded"), "degraded");
  assert.equal(chainTemplateStatusKind("blocked"), "blocked");
  assert.equal(chainTemplateStatusKind("disabled"), "unknown");
  assert.equal(chainTemplateStatusKind(null), "unknown");
  assert.deepEqual(chainTemplateStatus(undefined), { kind: "unknown", cause: null });
  assert.deepEqual(chainTemplateStatus({ kind: "degraded", cause: "  slow  " }), {
    kind: "degraded",
    cause: "slow",
  });
});

test("策略分布：同类合并、按固定顺序、百分比合计 100、零链不出现", () => {
  const shares = strategyShares([
    { strategy: "round_robin", chains: 2, users: 1 },
    { strategy: "ip_hash", chains: 3, users: 2 },
    { strategy: "ip_hash", chains: 1, users: 0 },
    { strategy: "failover", chains: 0, users: 0 },
    { strategy: "weighted", chains: 4, users: 3 },
  ]);

  assert.deepEqual(
    shares.map((share) => share.strategy),
    TEMPLATE_STRATEGY_ORDER.filter((strategy) =>
      ["ip_hashed", "round_robin", "weighted"].includes(strategy),
    ),
  );
  assert.equal(shares.length, 3);
  // ip_hash 归一为真实枚举 ip_hashed，3 + 1 合并成 4 条链。
  const hashed = shares.find((share) => share.strategy === "ip_hashed");
  assert.equal(hashed.chains, 4);
  assert.equal(hashed.users, 2);
  const total = shares.reduce((sum, share) => sum + share.pct, 0);
  assert.ok(Math.abs(total - 100) < 0.001);
  assert.equal(chainTemplateStrategyLabelKey("ip_hashed"), "chains.strategy.ip_hashed.label");
  assert.equal(chainTemplateStrategyLabelKey("custom"), null);
  assert.deepEqual(
    strategyShares([{ strategy: "custom", chains: 1, users: 0 }]).map(
      (share) => share.strategy,
    ),
    ["custom"],
  );
});

test("使用量序列：24h/7d 过滤、按时间升序、同 ts 去重、毫秒转秒", () => {
  const series = [
    { ts: (NOW - 10 * HOUR) * 1000, chains: 2, users: 1 },
    { ts: NOW - 30 * HOUR, chains: 9, users: 9 },
    { ts: NOW - 2 * HOUR, chains: 3, users: 2 },
    { ts: NOW - 2 * HOUR, chains: 4, users: 3 },
    { ts: NOW + 10 * HOUR, chains: 99, users: 99 },
  ];
  const day = chainTemplateUsageSeries(series, "24h", NOW);
  assert.deepEqual(
    day.points.map((point) => [point.chains, point.users]),
    [
      [3, 2],
      [4, 3],
    ],
  );
  const week = chainTemplateUsageSeries(series, "7d", NOW);
  assert.equal(week.points.length, 3);
  assert.deepEqual(
    week.points.map((point) => point.ts),
    [...week.points.map((point) => point.ts)].sort((a, b) => a - b),
  );
  assert.deepEqual(chainTemplateUsageSeries([], "7d", NOW).points, []);
});

test("使用用户：优先 users，缺失时回退 targets 并去重", () => {
  const fromUsers = chainTemplateUsageUsers(detail());
  assert.equal(fromUsers.current, true);
  assert.deepEqual(
    fromUsers.users.map((user) => user.name),
    ["demo", "alice"],
  );

  const fallback = chainTemplateUsageUsers(
    detail({
      users: [],
      targets: [
        { host: "1.2.3.4", port: 443, chains: 2, users: [{ id: "u1", name: "demo" }] },
        { host: "5.6.7.8", port: 443, chains: 1, users: [{ id: "u1", name: "demo" }] },
      ],
    }),
  );
  assert.deepEqual(
    fallback.users.map((user) => user.name),
    ["demo"],
  );
  assert.deepEqual(chainTemplateUsageUsers(detail({ users: [], targets: [] })), {
    users: [],
    current: true,
  });
});

test("热点排序：按链数降序取 Top 5，按服务器去重，排除目标节点", () => {
  const nodes = [
    { seq: 0, role: "source", name: "a", members: [member("s1", 5, 3), member("s2", 2, 1)] },
    { seq: 1, role: "hop", name: "b", members: [member("s1", 5, 3), member("s3", 9, 4, "offline")] },
    { seq: 2, role: "target", name: "目标", members: [{ name: "1.2.3.4:443", chains: 9, users: 9 }] },
    { seq: 2, role: "hop", name: "c", members: [
      member("s4", 1, 1),
      member("s5", 1, 1),
      member("s6", 1, 1),
      member("s7", 1, 1),
    ] },
  ];
  const rows = chainTemplateHotspots(nodes);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].name, "s3");
  assert.equal(rows[0].chains, 9);
  assert.equal(rows[0].offline, true);
  assert.equal(rows[1].name, "s1");
  assert.equal(rows.filter((row) => row.name === "1.2.3.4:443").length, 0);
});

test("节点热度：Top 5 降序，条宽按最大链数、占比按模板总链数", () => {
  const heat = chainTemplateNodeHeat(
    normalizeChainTemplateDetail({
      template: { id: "tpl-heat", name: "热度", hops: 2 },
      nodes: [
        {
          seq: 0,
          role: "source",
          name: "入口",
          members: [member("s1", 5, 3), member("s2", 10, 2)],
        },
        {
          seq: 1,
          role: "hop",
          name: "中转",
          members: [
            member("s1", 5, 3),
            member("s3", 4, 4, "offline"),
            member("s4", 3, 1, "degraded"),
            member("s5", 2, 1),
            member("s6", 1, 1),
          ],
        },
      ],
    }),
  );
  // Top 5：第 6 名不进入视图；同名成员按 serverId 去重。
  assert.deepEqual(
    heat.rows.map((row) => row.name),
    ["s2", "s1", "s3", "s4", "s5"],
  );
  assert.equal(heat.maxChains, 10);
  // 模板总链数 = 源成员链数之和（5 + 10）。
  assert.equal(heat.totalChains, 15);
  assert.deepEqual(
    heat.rows.map((row) => row.barPct),
    [100, 50, 40, 30, 20],
  );
  const shares = heat.rows.map((row) => Math.round(row.sharePct * 10) / 10);
  assert.deepEqual(shares, [66.7, 33.3, 26.7, 20, 13.3]);
  // 同一服务器在多跳出现时取最大链数，状态按最严重的一档合并。
  assert.equal(heat.rows[1].chains, 5);
  assert.equal(heat.rows[1].status, "online");
  assert.equal(heat.rows[2].status, "offline");
  assert.equal(heat.rows[2].offline, true);
  assert.equal(heat.rows[3].status, "degraded");
});

test("节点热度：没有链使用时给空 rows，目标节点不参与", () => {
  const heat = chainTemplateNodeHeat(
    normalizeChainTemplateDetail({
      template: { id: "tpl-idle", name: "空", hops: 1 },
      nodes: [
        { seq: 0, role: "source", name: "入口", members: [member("s1", 0, 0)] },
        {
          seq: 1,
          role: "target",
          name: "目标",
          members: [{ name: "1.2.3.4:443", chains: 5, users: 5 }],
        },
      ],
    }),
  );
  assert.deepEqual(heat.rows, []);
  assert.equal(heat.maxChains, 0);
  // 目标节点的链不会被算进模板总链数。
  assert.equal(heat.totalChains, 0);
});

test("节点热度：占比夹紧到 0–100，脏数据不越界", () => {
  const heat = chainTemplateNodeHeat(
    normalizeChainTemplateDetail({
      template: { id: "tpl-dirty", name: "脏", hops: 1 },
      nodes: [
        { seq: 0, role: "source", name: "入口", members: [member("s1", 2, 1)] },
        { seq: 1, role: "hop", name: "中转", members: [member("s2", 9, 1)] },
      ],
    }),
  );
  assert.equal(heat.rows[0].name, "s2");
  assert.equal(heat.rows[0].sharePct, 100);
  assert.equal(heat.rows[1].sharePct, 100);
});

test("详情合计：优先源成员汇总，缺失时回退最大值", () => {
  const normalized = normalizeChainTemplateDetail(detail());
  assert.deepEqual(chainTemplateDetailTotals(normalized), {
    hops: 3,
    chains: 5,
    users: 3,
  });

  const noSource = normalizeChainTemplateDetail(
    detail({ nodes: detail().nodes.slice(1) }),
  );
  assert.equal(chainTemplateDetailTotals(noSource).chains, 5);
  assert.equal(chainTemplateDetailTotals(noSource).hops, 3);
});

test("目标文案：host:port 与链数，缺失端口不编造", () => {
  const normalized = normalizeChainTemplateDetail(detail());
  assert.deepEqual(normalized.targets.map(targetLabel), [
    "1.2.3.4:443",
    "5.6.7.8:8443",
  ]);
  const noPort = normalizeChainTemplateDetail(
    detail({ targets: [{ host: "example.com", chains: 1 }] }),
  );
  assert.deepEqual(noPort.targets.map(targetLabel), ["example.com"]);
  assert.equal(
    targetLabel({ host: "2001:db8::1", port: 443, chains: 1, users: [] }),
    "[2001:db8::1]:443",
  );
});

test("404 才降级为旧主控；403 是权限问题，照常走错误态", () => {
  assert.equal(isChainTemplateInsightUnsupported(new ApiError("nf", 404)), true);
  assert.equal(
    isChainTemplateInsightUnsupported(new ApiError("forbidden", 403)),
    false,
  );
  assert.equal(isChainTemplateInsightUnsupported(new ApiError("boom", 500)), false);
  assert.equal(isChainTemplateInsightUnsupported(new Error("network")), false);
  assert.equal(isChainTemplateInsightUnsupported(null), false);
});

/* ------------------------------------------------------------------ */
/* F7 状态口径：online / offline / degraded(abnormal,no_data) / unknown  */
/* ------------------------------------------------------------------ */

test("成员状态四档归一：abnormal / no_data 都是 degraded，不当 unknown", () => {
  assert.deepEqual([...TEMPLATE_MEMBER_STATUSES], [
    "online",
    "offline",
    "degraded",
    "unknown",
  ]);
  const cases = [
    ["online", "online"],
    ["ONLINE ", "online"],
    ["offline", "offline"],
    ["degraded", "degraded"],
    ["abnormal", "degraded"],
    ["no_data", "degraded"],
    ["", "unknown"],
    ["pending", "unknown"],
    [undefined, "unknown"],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(chainTemplateMemberStatus(raw), expected, String(raw));
  }

  const normalized = normalizeChainTemplateDetail(
    detail({
      nodes: [
        {
          seq: 0,
          role: "source",
          name: "入口",
          members: [
            { name: "a", status: "abnormal", chains: 1, users: 0 },
            { name: "b", status: "no_data", chains: 1, users: 0 },
            { name: "c", status: "offline", chains: 1, users: 0 },
            { name: "d", status: "weird", chains: 1, users: 0 },
          ],
        },
        { seq: 1, role: "target", name: "目标", members: [] },
      ],
      edges: [],
      targets: [],
    }),
  );
  assert.deepEqual(
    normalized.nodes[0].members.map((item) => item.status),
    ["degraded", "degraded", "offline", "unknown"],
  );
});

/* ------------------------------------------------------------------ */
/* 新契约：stale / unused_candidates / series_basis                    */
/* ------------------------------------------------------------------ */

test("stale 与 stale_reason 跟随模板摘要，旧契约降级为 false / null", () => {
  const stale = normalizeChainTemplateDetail(
    detail({
      template: {
        id: "tpl-1",
        name: "香港 → 东京",
        hops: 1,
        created_at: 1_799_000_000,
        stale: true,
        stale_reason:
          "链的跳数（3）与模板（1）不一致 / chain hop count (3) differs from the template (1)",
      },
      series_basis: "existing_chains",
    }),
  );
  assert.equal(stale.template.stale, true);
  assert.match(stale.template.staleReason, /链的跳数/);
  assert.match(stale.template.staleReason, /chain hop count/);
  assert.equal(stale.seriesBasis, "existing_chains");

  // 旧主控没有这三个字段：不提示 stale、不加图注、不报错。
  const legacy = normalizeChainTemplateDetail(detail());
  assert.equal(legacy.template.stale, false);
  assert.equal(legacy.template.staleReason, null);
  assert.equal(legacy.seriesBasis, null);
  assert.deepEqual(legacy.unusedCandidates, []);

  // 未知 series_basis 不猜口径。
  assert.equal(
    normalizeChainTemplateDetail(detail({ series_basis: "all_chains" }))
      .seriesBasis,
    null,
  );
});

test("unused_candidates 单独归一化，不混进 nodes", () => {
  const normalized = normalizeChainTemplateDetail(
    detail({
      unused_candidates: [
        { seq: 1, server_id: "srv-9", name: "东京-备用", status: "offline" },
        { seq: 0, server_id: "srv-2", name: "香港-02", status: "online" },
        // 重复候选按 (seq, server_id) 去重。
        { seq: 1, server_id: "srv-9", name: "东京-备用", status: "offline" },
        // 没有名字的脏数据丢弃。
        { seq: 1, server_id: "srv-x" },
        "nope",
      ],
    }),
  );
  assert.deepEqual(
    normalized.unusedCandidates.map((row) => [row.seq, row.name, row.status]),
    [
      [0, "香港-02", "online"],
      [1, "东京-备用", "offline"],
    ],
  );
  // 候选不进入真实拓扑节点。
  const nodeNames = normalized.nodes.flatMap((node) =>
    node.members.map((item) => item.name),
  );
  assert.equal(nodeNames.includes("东京-备用"), false);
  assert.equal(nodeNames.includes("香港-02"), false);
});

/* ------------------------------------------------------------------ */
/* F9 缺 target node：补在 maxSeq+1，不覆盖最后一跳                     */
/* ------------------------------------------------------------------ */

test("缺 target node 时插入 maxSeq+1，最后一跳保持 hop 不被覆盖", () => {
  const normalized = normalizeChainTemplateDetail({
    template: { id: "tpl-no-target", name: "缺目标节点", hops: 2 },
    nodes: [
      { seq: 0, role: "source", name: "入口", members: [member("入口-01", 3, 1)] },
      { seq: 1, role: "hop", name: "第一跳", members: [member("东京-01", 3, 1)] },
      { seq: 2, role: "hop", name: "第二跳", members: [member("洛杉矶-01", 3, 1)] },
    ],
    edges: [
      {
        seq: 1,
        from: { seq: 0, member: "入口-01" },
        to: { seq: 1, member: "东京-01" },
        chains: 3,
        users: 1,
        p50_ms: 10,
        loss_pct: 0,
      },
      {
        seq: 2,
        from: { seq: 1, member: "东京-01" },
        to: { seq: 2, member: "洛杉矶-01" },
        chains: 3,
        users: 1,
        p50_ms: 20,
        loss_pct: 0,
      },
    ],
    targets: [{ host: "1.2.3.4", port: 443, chains: 3, users: [] }],
    users: [],
    series: [],
    strategies: [],
  });
  const bySeq = new Map(normalized.nodes.map((node) => [node.seq, node]));
  // 最后一跳（seq 2）保持 hop 与名字，没有被合成目标覆盖。
  assert.equal(bySeq.get(2).role, "hop");
  assert.equal(bySeq.get(2).name, "第二跳");
  assert.deepEqual(bySeq.get(2).members.map((item) => item.name), ["洛杉矶-01"]);
  // 合成目标插在 maxSeq + 1。
  assert.equal(bySeq.get(3).role, "target");
  assert.deepEqual(
    bySeq.get(3).members.map((item) => item.name),
    ["1.2.3.4:443"],
  );
  assert.equal(normalized.template.hops, 3);
  // 拓扑里目标列是独立的一列，不会跟最后一跳叠在一起。
  const targetSeq = normalized.nodes.find((node) => node.role === "target").seq;
  assert.equal(targetSeq, 3);
});

test("重复路径聚合：链数求和、用户取最大、P50 按链数加权，O(E) 一趟", () => {
  const edges = aggregateChainTemplateEdges([
    {
      seq: 1,
      fromSeq: 0,
      fromMember: "香港-01",
      toSeq: 1,
      toMember: "东京-01",
      chains: 3,
      users: 2,
      p50Ms: 10,
      lossPct: 0,
    },
    {
      seq: 1,
      fromSeq: 0,
      fromMember: "香港-01",
      toSeq: 1,
      toMember: "东京-01",
      chains: 1,
      users: 3,
      p50Ms: 20,
      lossPct: 2,
    },
    {
      seq: 1,
      fromSeq: 0,
      fromMember: "香港-02",
      toSeq: 1,
      toMember: "东京-01",
      chains: 1,
      users: 1,
      p50Ms: null,
      lossPct: null,
    },
  ]);
  assert.equal(edges.length, 2);
  const merged = edges.find((edge) => edge.fromMember === "香港-01");
  assert.deepEqual(
    { chains: merged.chains, users: merged.users, p50: merged.p50Ms, loss: merged.lossPct },
    { chains: 4, users: 3, p50: 12.5, loss: 0.5 },
  );
  assert.equal(edges.find((edge) => edge.fromMember === "香港-02").p50Ms, null);
});


test("全 0 序列视作暂无使用记录，不画贴底假线", () => {
  const points = Array.from({ length: 96 }, (_, index) => ({
    ts: NOW - (95 - index) * 900,
    chains: 0,
    users: 0,
  }));
  const usage = chainTemplateUsageSeries(points, "24h", NOW);
  assert.equal(usage.points.length, 96);
  assert.equal(chainTemplateUsageHasData(usage.points), false);
  assert.equal(
    chainTemplateUsageHasData([{ ts: NOW, chains: 1, users: 0 }]),
    true,
  );
});
