import assert from "node:assert/strict";
import test from "node:test";
import { normalizeChainHealth } from "./chainHealth.ts";
import { buildChainFlowGraph } from "./chainFlowGraph.ts";

const TEXTS = {
  unmeasurableText: "不可测量（引擎不支持探测）",
  missingText: "无历史数据",
};

function member(serverId, name, status = "online") {
  return { server_id: serverId, name, status };
}

function segment(seq, from, to, p50 = 14, lossPct = 0.2) {
  return {
    seq,
    from,
    to,
    p50,
    delta_ms: 1,
    contribution_pct: 100,
    loss_pct: lossPct,
  };
}

function rawChain(overrides = {}) {
  return {
    id: "chain-1",
    name: "香港 → 东京",
    hops: 2,
    series: [],
    segments: [
      segment(1, "香港-01", "东京-01", 14, 0.2),
      segment(2, "东京-01", "10.0.0.8", 30, 0),
    ],
    nodes: [
      {
        seq: 0,
        name: "香港入口",
        role: "source",
        status: "online",
        server_id: "s-hk",
        member_count: 2,
        members: [
          member("s-hk", "香港-01", "online"),
          member("s-hk2", "香港-02", "online"),
        ],
      },
      {
        seq: 1,
        name: "东京中转",
        role: "hop",
        status: "online",
        member_count: 2,
        members: [
          member("s-tk1", "东京-01", "online"),
          member("s-tk2", "东京-02", "degraded"),
        ],
      },
      { seq: 2, name: "链目标", role: "target", status: null },
    ],
    ...overrides,
  };
}

/** 归一化后再建图：契约字段名（snake_case）只在这一层出现。 */
function graphFor(overrides = {}, texts = TEXTS) {
  const result = normalizeChainHealth({ chains: [rawChain(overrides)] });
  assert.equal(result.status, "ok");
  return buildChainFlowGraph(result.snapshot.chains[0], texts);
}

function allCards(graph) {
  return graph.columns.flatMap((column) => column.members);
}

test("旧契约单节点：每列一张组名卡，不伪造成员", () => {
  const graph = graphFor({
    hops: 1,
    nodes: [],
    segments: [segment(1, "香港-01", "10.0.0.8", 20)],
  });
  assert.deepEqual(
    graph.columns.map((column) => [column.role, column.members.length]),
    [
      ["entry", 1],
      ["target", 1],
    ],
  );
  assert.equal(graph.columns[0].members[0].id, "cf:0:__node");
  assert.equal(graph.columns[0].members[0].name, "香港-01");
  assert.equal(graph.columns[1].members[0].id, "cf:1:__target");
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].p50Ms, 20);
});

test("多成员列：server_id 匹配者 preferred，其余 candidate", () => {
  const graph = graphFor();
  const source = graph.columns[0].members;
  assert.deepEqual(
    source.map((card) => [card.id, card.name, card.tag]),
    [
      ["cf:0:s-hk", "香港-01", "preferred"],
      ["cf:0:s-hk2", "香港-02", "candidate"],
    ],
  );
  // 没有 server_id 的第二列：第一张 preferred，第二张 candidate。
  const hop = graph.columns[1].members;
  assert.deepEqual(
    hop.map((card) => [card.id, card.tag]),
    [
      ["cf:1:s-tk1", "preferred"],
      ["cf:1:s-tk2", "candidate"],
    ],
  );
  // 每组最多一张 preferred：默认路径唯一。
  assert.equal(
    allCards(graph).filter((card) => card.tag === "preferred").length,
    2,
  );
  assert.equal(
    allCards(graph).filter((card) => card.tag === "candidate").length,
    2,
  );
  // 链路详情画的是当前这一条链，不聚合链数 / 用户数。
  assert.ok(allCards(graph).every((card) => card.chains === 0 && card.users === 0));
});

test("server_id 指向第二台时把首选卡排到第一张，折叠不会吃掉首选", () => {
  const graph = graphFor({
    nodes: [
      {
        seq: 0,
        name: "香港入口",
        role: "source",
        status: "online",
        server_id: "s-hk2",
        member_count: 2,
        members: [
          member("s-hk", "香港-01", "online"),
          member("s-hk2", "香港-02", "online"),
        ],
      },
      { seq: 1, name: "链目标", role: "target", status: null },
    ],
    hops: 1,
    segments: [segment(1, "香港-02", "10.0.0.8", 20)],
  });
  const cards = graph.columns[0].members;
  assert.equal(cards[0].id, "cf:0:s-hk2");
  assert.equal(cards[0].tag, "preferred");
  assert.equal(cards[1].tag, "candidate");
});

test("只有 member_count 没有 members：整列一张组名卡", () => {
  const graph = graphFor({
    hops: 1,
    segments: [segment(1, "香港入口", "10.0.0.8", 21)],
    nodes: [
      {
        seq: 0,
        name: "香港入口",
        role: "source",
        status: "degraded",
        member_count: 3,
      },
      { seq: 1, name: "链目标", role: "target", status: null },
    ],
  });
  const cards = graph.columns[0].members;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, "cf:0:__node");
  assert.equal(cards[0].name, "香港入口");
  assert.equal(cards[0].status, "degraded");
  assert.equal(cards[0].memberCount, 3);
  assert.equal(cards[0].tag, undefined);
  assert.equal(graph.columns[0].memberCount, 3);
});

test("目标列：一张空名卡，上游是上一列全部卡片", () => {
  const graph = graphFor();
  const target = graph.columns.at(-1);
  assert.equal(target.role, "target");
  assert.equal(target.title, undefined);
  assert.equal(target.members.length, 1);
  assert.equal(target.members[0].id, "cf:2:__target");
  assert.equal(target.members[0].name, "");
  assert.equal(target.members[0].status, "unknown");
  assert.deepEqual(
    target.members[0].upstreamIds,
    graph.columns[1].members.map((card) => card.id),
  );
  assert.equal(graph.targetCount, 1);
  assert.deepEqual(graph.unused, []);
});

test("相邻列全连接，每段一个时延药丸：p50 / 丢包取该段", () => {
  const graph = graphFor();
  assert.equal(graph.edges.length, 6); // 2×2 + 2×1
  const first = graph.edges.filter((edge) => edge.id.startsWith("cfe:1:"));
  assert.equal(first.length, 4);
  for (const edge of first) {
    assert.equal(edge.p50Ms, 14);
    assert.equal(edge.lossPct, 0.2);
    assert.equal(edge.unavailable, false);
    assert.equal(edge.degraded, false);
    assert.equal(edge.chains, 0);
    assert.equal(edge.users, 0);
    assert.match(edge.id, /^cfe:1:cf:0:/);
    assert.ok(edge.id.includes(">cf:1:"));
  }
  const last = graph.edges.filter((edge) => edge.id.startsWith("cfe:2:"));
  assert.equal(last.length, 2);
  for (const edge of last) {
    assert.equal(edge.p50Ms, 30);
    assert.equal(edge.lossPct, 0);
  }
});

test("estimated 只传给多成员组之间的段", () => {
  const graph = graphFor({ estimated: true });
  assert.ok(graph.edges.every((edge) => edge.estimated === true));

  const single = graphFor({
    estimated: true,
    nodes: [
      {
        seq: 0,
        name: "香港入口",
        role: "source",
        status: "online",
        member_count: 1,
        members: [member("s-hk", "香港-01", "online")],
      },
      {
        seq: 1,
        name: "东京中转",
        role: "hop",
        status: "online",
        member_count: 1,
        members: [member("s-tk", "东京-01", "online")],
      },
      { seq: 2, name: "链目标", role: "target", status: null },
    ],
  });
  assert.ok(single.edges.every((edge) => edge.estimated === false));
});

test("missing 段：虚线不可用、无当前 P50、note 是无历史数据", () => {
  const graph = graphFor({
    segments: [
      segment(1, "香港-01", "东京-01", 14, 0.2),
      { seq: 2, from: "东京-01", to: "10.0.0.8", p50: null, loss_pct: null },
    ],
  });
  const targetEdges = graph.edges.filter((edge) => edge.targetSeq === 2);
  assert.equal(targetEdges.length, 2);
  for (const edge of targetEdges) {
    assert.equal(edge.unavailable, true);
    assert.equal(edge.p50Ms, null);
    assert.equal(edge.note, TEXTS.missingText);
    assert.equal(edge.lossPct, null);
  }
  // 前一段仍然可用。
  assert.ok(
    graph.edges
      .filter((edge) => edge.targetSeq === 1)
      .every((edge) => !edge.unavailable),
  );
});

test("最后一跳不可测：按单独文案标注，不说成无历史数据", () => {
  const graph = graphFor({
    last_hop: { measurable: false, reason: "engine_unsupported" },
    segments: [
      segment(1, "香港-01", "东京-01", 14, 0.2),
      { seq: 2, from: "东京-01", to: "10.0.0.8", p50: null, loss_pct: null },
    ],
  });
  const targetEdges = graph.edges.filter((edge) => edge.targetSeq === 2);
  assert.ok(targetEdges.length > 0);
  for (const edge of targetEdges) {
    assert.equal(edge.unavailable, true);
    assert.equal(edge.p50Ms, null);
    assert.equal(edge.note, TEXTS.unmeasurableText);
  }
  // 中间段不受影响。
  assert.ok(
    graph.edges
      .filter((edge) => edge.targetSeq === 1)
      .every((edge) => edge.note === null),
  );
});

test("空链：没有节点就没有列 / 连线，empty=true", () => {
  const graph = graphFor({
    hops: 1,
    nodes: [],
    segments: [],
  });
  assert.equal(graph.empty, true);
  assert.deepEqual(graph.columns, []);
  assert.deepEqual(graph.edges, []);
  assert.equal(graph.usedMemberCount, 0);
});

test("段 id 用目标节点的 seq，targetSeq / hops 跟随拓扑", () => {
  const graph = graphFor();
  assert.equal(graph.hops, 2);
  assert.equal(graph.targetSeq, 2);
  assert.equal(graph.columns[0].seq, 0);
  assert.equal(graph.columns[1].seq, 1);
  assert.ok(graph.edges.some((edge) => edge.id.startsWith("cfe:1:")));
  assert.ok(graph.edges.some((edge) => edge.id.startsWith("cfe:2:")));
});
