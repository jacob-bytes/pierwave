import assert from "node:assert/strict";
import test from "node:test";
import { normalizeChainHealth } from "./chainHealth.ts";
import { buildChainFlowGraph } from "./chainFlowGraph.ts";
import {
  CHAIN_FLOW_METRICS,
  foldTemplateGraph,
  layoutTemplateGraph,
} from "./chainTemplateGraph.ts";

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

function taggedCards(graph, columnIndex) {
  return graph.columns[columnIndex].members.map((card) => [
    card.name,
    card.tag ?? null,
  ]);
}

test("failover：active 命中成员标「当前」，其余候选，且 active 排第一", () => {
  const graph = graphFor({
    nodes: [
      {
        seq: 0,
        name: "香港入口",
        role: "source",
        status: "online",
        server_id: "s-hk",
        member_count: 1,
        members: [member("s-hk", "香港-01", "online")],
      },
      {
        seq: 1,
        name: "东京中转（主备）",
        role: "hop",
        status: "offline",
        server_id: "s-tk2",
        member_count: 2,
        strategy: "failover",
        active_server_id: "s-tk3",
        members: [
          member("s-tk2", "东京-02", "offline"),
          member("s-tk3", "东京-03", "online"),
        ],
      },
      {
        seq: 2,
        name: "新加坡出口",
        role: "hop",
        status: "online",
        server_id: "s-sg",
        member_count: 1,
        strategy: "failover",
        active_server_id: "s-sg",
        members: [member("s-sg", "新加坡-01", "online")],
      },
      { seq: 3, name: "链目标", role: "target", status: null },
    ],
    hops: 3,
    segments: [
      segment(1, "香港-01", "东京-03", 14),
      segment(2, "东京-03", "新加坡-01", 30),
      segment(3, "新加坡-01", "10.0.0.8", 60),
    ],
  });
  assert.deepEqual(taggedCards(graph, 1), [
    ["东京-03", "active"],
    ["东京-02", "candidate"],
  ]);
  assert.equal(graph.columns[1].strategy, "failover");
  assert.equal(graph.columns[1].memberCount, 2);
  // 单成员中继列不标 tag；入口列即使有 strategy 也不标「当前」。
  assert.deepEqual(taggedCards(graph, 2), [["新加坡-01", null]]);
  assert.deepEqual(taggedCards(graph, 0), [["香港-01", null]]);
  assert.equal(graph.columns[0].strategy, null);
});

test("lowest_latency：三台里 active 是东京-01，其余候选", () => {
  const graph = graphFor({
    nodes: [
      {
        seq: 0,
        name: "香港入口",
        role: "source",
        status: "online",
        server_id: "s-hk",
        member_count: 1,
        members: [member("s-hk", "香港-02", "online")],
      },
      {
        seq: 1,
        name: "东京出口",
        role: "hop",
        status: "online",
        server_id: "s-tk1",
        member_count: 3,
        strategy: "lowest_latency",
        active_server_id: "s-tk1",
        members: [
          member("s-tk1", "东京-01", "online"),
          member("s-tk3", "东京-03", "online"),
          member("s-se1", "首尔-01", "online"),
        ],
      },
      { seq: 2, name: "链目标", role: "target", status: null },
    ],
    hops: 2,
    segments: [
      segment(1, "香港-02", "东京-01", 11),
      segment(2, "东京-01", "10.0.0.8", 20),
    ],
  });
  assert.deepEqual(taggedCards(graph, 1), [
    ["东京-01", "active"],
    ["东京-03", "candidate"],
    ["首尔-01", "candidate"],
  ]);
  assert.equal(graph.columns[1].strategy, "lowest_latency");
});

test("round_robin / 多成员分担：不出现首选 / 候选，列头拿得到 N", () => {
  const graph = graphFor({
    nodes: [
      {
        seq: 0,
        name: "香港入口",
        role: "source",
        status: "online",
        server_id: "s-hk",
        member_count: 1,
        members: [member("s-hk", "香港-01", "online")],
      },
      {
        seq: 1,
        name: "东京中转",
        role: "hop",
        status: "online",
        member_count: 3,
        strategy: "round_robin",
        members: [
          member("s-tk1", "东京-01", "online"),
          member("s-tk2", "东京-02", "online"),
          member("s-tk3", "东京-03", "online"),
        ],
      },
      { seq: 2, name: "链目标", role: "target", status: null },
    ],
    hops: 2,
    segments: [
      segment(1, "香港-01", "东京-01", 14),
      segment(2, "东京-01", "10.0.0.8", 20),
    ],
  });
  assert.deepEqual(taggedCards(graph, 1), [
    ["东京-01", null],
    ["东京-02", null],
    ["东京-03", null],
  ]);
  assert.equal(
    allCards(graph).filter(
      (card) => card.tag === "preferred" || card.tag === "candidate",
    ).length,
    0,
  );
  assert.equal(graph.columns[1].strategy, "round_robin");
  assert.equal(graph.columns[1].memberCount, 3);
});

test("折叠 / 布局透传列策略：active 卡排第一，折叠不会吃掉当前通路", () => {
  const members6 = Array.from({ length: 6 }, (_, index) =>
    member(`s-tk${index + 1}`, `东京-0${index + 1}`, "online"),
  );
  const graph = graphFor({
    nodes: [
      {
        seq: 0,
        name: "香港入口",
        role: "source",
        status: "online",
        server_id: "s-hk",
        member_count: 1,
        members: [member("s-hk", "香港-01", "online")],
      },
      {
        seq: 1,
        name: "东京中转",
        role: "hop",
        status: "online",
        server_id: "s-tk1",
        member_count: 6,
        strategy: "failover",
        active_server_id: "s-tk6",
        members: members6,
      },
      { seq: 2, name: "链目标", role: "target", status: null },
    ],
    hops: 2,
    segments: [
      segment(1, "香港-01", "东京-06", 14),
      segment(2, "东京-06", "10.0.0.8", 20),
    ],
  });
  assert.equal(graph.columns[1].members[0].id, "cf:1:s-tk6");
  assert.equal(graph.columns[1].members[0].tag, "active");
  const folded = foldTemplateGraph(graph);
  const foldedColumn = folded.columns.find((column) => column.seq === 1);
  assert.ok(foldedColumn);
  assert.equal(foldedColumn.cards[0].id, "cf:1:s-tk6");
  assert.equal(foldedColumn.cards[0].tag, "active");
  assert.equal(foldedColumn.cards.at(-1).kind, "fold");
  const layout = layoutTemplateGraph(folded, { metrics: CHAIN_FLOW_METRICS });
  const header = layout.headers.find((item) => item.seq === 1);
  assert.ok(header);
  assert.equal(header.strategy, "failover");
  assert.equal(header.memberCount, 6);
  assert.equal(header.total, 6);
});

test("active_server_id 不在成员里：不标「当前」，回退首选 / 候选", () => {
  const graph = graphFor({
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
        server_id: "s-tk1",
        member_count: 2,
        strategy: "failover",
        active_server_id: "s-missing",
        members: [
          member("s-tk1", "东京-01", "online"),
          member("s-tk2", "东京-02", "online"),
        ],
      },
      { seq: 2, name: "链目标", role: "target", status: null },
    ],
    hops: 2,
    segments: [
      segment(1, "香港-01", "东京-01", 14),
      segment(2, "东京-01", "10.0.0.8", 20),
    ],
  });
  assert.deepEqual(taggedCards(graph, 1), [
    ["东京-01", "preferred"],
    ["东京-02", "candidate"],
  ]);
  assert.equal(
    allCards(graph).filter((card) => card.tag === "active").length,
    0,
  );
});

test("入口多成员保留既有首选 / 候选；脏 active_server_id 也不标「当前」", () => {
  const graph = graphFor({
    nodes: [
      {
        seq: 0,
        name: "香港入口",
        role: "source",
        status: "online",
        server_id: "s-hk1",
        member_count: 2,
        strategy: "round_robin",
        active_server_id: "s-hk2",
        members: [
          member("s-hk1", "香港-01", "online"),
          member("s-hk2", "香港-02", "online"),
        ],
      },
      { seq: 1, name: "链目标", role: "target", status: null },
    ],
    hops: 1,
    segments: [segment(1, "香港-01", "10.0.0.8", 20)],
  });
  assert.deepEqual(taggedCards(graph, 0), [
    ["香港-01", "preferred"],
    ["香港-02", "candidate"],
  ]);
  assert.equal(graph.columns[0].strategy, null);
});

test("旧主控缺 strategy / active_server_id：回退首选 / 候选，不报错", () => {
  const graph = graphFor();
  for (const column of graph.columns) {
    assert.equal(column.strategy ?? null, null);
  }
  assert.equal(graph.columns[1].members[0].tag, "preferred");
  assert.equal(graph.columns[1].members[1].tag, "candidate");
  assert.equal(
    allCards(graph).filter((card) => card.tag === "active").length,
    0,
  );
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
