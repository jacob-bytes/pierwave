import assert from "node:assert/strict";
import test from "node:test";
import { normalizeChainTemplateDetail } from "./chainTemplateInsight.ts";
import {
  CHAIN_FLOW_METRICS,
  TEMPLATE_CANVAS_MAX_HEIGHT,
  TEMPLATE_CANVAS_MIN_HEIGHT,
  TEMPLATE_CARD_HEIGHT,
  TEMPLATE_CARD_WIDTH,
  TEMPLATE_COLUMN_GAP,
  TEMPLATE_COLUMN_HEADER_HEIGHT,
  TEMPLATE_COLUMN_TOP,
  TEMPLATE_EDGE_MAX_WIDTH,
  TEMPLATE_EDGE_MIN_WIDTH,
  TEMPLATE_EDGE_RADIUS,
  TEMPLATE_FIT_HINT_ZOOM,
  TEMPLATE_FIT_MAX_ZOOM,
  TEMPLATE_FOLD_LIMIT,
  TEMPLATE_MAX_ZOOM,
  TEMPLATE_MERGED_RAIL_OFFSET,
  TEMPLATE_METRICS,
  TEMPLATE_MIN_ZOOM,
  TEMPLATE_PADDING,
  TEMPLATE_PAN_DURATION_MS,
  TEMPLATE_PILL_DENSE_LIMIT,
  TEMPLATE_PILL_WIDTH,
  TEMPLATE_PULSE_LIMIT,
  TEMPLATE_PULSE_WIDTH_RATIO,
  TEMPLATE_ROW_GAP,
  buildTemplateGraph,
  carrierTemplateEdges,
  clampTemplateZoom,
  densePillRails,
  fitViewport,
  foldTemplateGraph,
  hasHiddenContentBelow,
  hiddenRightColumns,
  highlightTemplateEdgePath,
  highlightTemplatePath,
  initialViewport,
  layoutTemplateGraph,
  preferredTemplatePath,
  showsFitHint,
  spreadPills,
  stepTemplateZoom,
  templateCanvasHeight,
  templateContentBounds,
  templateEdgePath,
  templateEdgeWidth,
  templateFitZoom,
  templatePanDuration,
  templatePulseWidth,
} from "./chainTemplateGraph.ts";

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

function member(name, chains, users, status = "online", serverId = name) {
  return { server_id: serverId, name, status, chains, users };
}

function edge(fromSeq, fromMember, toSeq, toMember, chains, p50 = 20, users = 1) {
  return {
    seq: toSeq,
    from: { seq: fromSeq, member: fromMember },
    to: { seq: toSeq, member: toMember },
    chains,
    users,
    p50_ms: p50,
    loss_pct: 0,
  };
}

/** 3 跳：入口 1 台 → 东京 2 台 + 1 台 0 链 → 洛杉矶（离线）→ 2 个目标。 */
function detail(overrides = {}) {
  return {
    template: { id: "tpl-1", name: "香港 → 东京", hops: 3 },
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
        members: [
          member("东京-01", 4, 2),
          member("东京-02", 1, 1),
          member("东京-备用", 0, 0),
        ],
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
        members: [
          member("1.2.3.4:443", 2, 2, "online"),
          member("5.6.7.8:8443", 0, 0, "unknown"),
        ],
      },
    ],
    edges: [
      edge(0, "香港-01", 1, "东京-01", 4, 15.5, 3),
      edge(0, "香港-01", 1, "东京-02", 1, 18),
      edge(1, "东京-01", 2, "洛杉矶-01", 4, 120.4, 3),
      edge(1, "东京-02", 2, "洛杉矶-01", 1, null),
      edge(2, "洛杉矶-01", 3, "1.2.3.4:443", 5, 160.2, 3),
    ],
    targets: [
      { host: "1.2.3.4", port: 443, chains: 3, users: [{ id: "u1", name: "demo" }] },
      { host: "5.6.7.8", port: 8443, chains: 2, users: [{ id: "u1", name: "demo" }] },
    ],
    users: [],
    series: [],
    strategies: [],
    unused_candidates: [
      { seq: 1, server_id: "东京-备用", name: "东京-备用", status: "online" },
    ],
    ...overrides,
  };
}

/** 尽量多成员：每列 6 台 → 折叠成 4 + 1 张折叠卡。 */
function wideDetail({ hops = 3, perColumn = 6, offlineAt = -1 } = {}) {
  const nodes = [];
  const edges = [];
  for (let seq = 0; seq <= hops; seq += 1) {
    const role = seq === 0 ? "source" : seq === hops ? "target" : "hop";
    nodes.push({
      seq,
      role,
      name: `第 ${seq} 跳`,
      members:
        role === "target"
          ? Array.from({ length: perColumn }, (_, index) => ({
              name: `10.0.0.${index + 1}:443`,
              chains: perColumn - index,
              users: 4,
            }))
          : Array.from({ length: perColumn }, (_, index) =>
              member(
                `s-${seq}-${String(index + 1).padStart(2, "0")}`,
                perColumn - index,
                perColumn - index + 1,
                seq === offlineAt && index === perColumn - 1 ? "offline" : "online",
              ),
            ),
    });
  }
  for (let seq = 1; seq <= hops; seq += 1) {
    for (let index = 0; index < perColumn; index += 1) {
      edges.push(
        edge(
          seq - 1,
          seq === 1 ? `s-0-${pad(index)}` : `s-${seq - 1}-${pad(index)}`,
          seq,
          seq === hops ? `10.0.0.${index + 1}:443` : `s-${seq}-${pad(index)}`,
          perColumn - index,
          10 + seq * 10 + index,
          2,
        ),
      );
    }
  }
  return normalizeChainTemplateDetail({
    template: { id: "tpl-wide", name: "宽模板", hops },
    nodes,
    edges,
    targets: [],
    users: [],
    series: [],
    strategies: [],
    unused_candidates: [],
  });
}

function pad(index) {
  return String(index + 1).padStart(2, "0");
}

function graphOf(payload) {
  return buildTemplateGraph(normalizeChainTemplateDetail(payload));
}

function cardsOf(folded, role) {
  return folded.columns
    .flatMap((column) => column.cards)
    .filter((card) => card.role === role);
}

function columnOf(graph, seq) {
  return graph.columns.find((column) => column.seq === seq);
}

/* ------------------------------------------------------------------ */
/* buildTemplateGraph                                                  */
/* ------------------------------------------------------------------ */

test("buildTemplateGraph: 0 链模板是空图，不画孤立入口", () => {
  const graph = graphOf({
    template: { id: "tpl-0", name: "空闲模板", hops: 2 },
    nodes: [
      { seq: 0, role: "source", name: "入口", members: [member("香港-01", 0, 0)] },
      { seq: 1, role: "hop", name: "东京", members: [member("东京-01", 0, 0)] },
      { seq: 2, role: "target", name: "目标", members: [] },
    ],
    edges: [edge(0, "香港-01", 1, "东京-01", 0, null)],
    targets: [],
    users: [],
    series: [],
    strategies: [],
    unused_candidates: [],
  });
  assert.equal(graph.empty, true);
  assert.equal(graph.edges.length, 0);
  for (const column of graph.columns) assert.equal(column.members.length, 0);
  const folded = foldTemplateGraph(graph);
  assert.equal(folded.empty, true);
  const layout = layoutTemplateGraph(folded);
  assert.equal(layout.cards.length, 0);
  assert.equal(layout.edges.length, 0);
  // 空模板没有列，也就没有列头。
  assert.deepEqual(layout.headers, []);
  // 空图仍然给出合法尺寸 / 视口，组件不必再判空。
  assert.ok(layout.width > 0);
  assert.ok(layout.height > 0);
  const view = initialViewport(layout, { width: 800, height: 400 });
  assert.equal(view.zoom, TEMPLATE_FIT_MAX_ZOOM);
});

test("buildTemplateGraph: 入口列 / 各跳列 / 目标列，0 链成员不进图", () => {
  const graph = graphOf(detail());
  assert.equal(graph.empty, false);
  assert.deepEqual(
    graph.columns.map((column) => column.seq),
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    columnOf(graph, 0).members.map((item) => item.name),
    ["香港-01"],
  );
  assert.deepEqual(
    columnOf(graph, 1).members.map((item) => item.name),
    ["东京-01", "东京-02"],
  );
  assert.deepEqual(
    columnOf(graph, 2).members.map((item) => item.name),
    ["洛杉矶-01"],
  );
  assert.deepEqual(
    columnOf(graph, 3).members.map((item) => item.name),
    ["1.2.3.4:443", "5.6.7.8:8443"],
  );
  assert.equal(graph.usedMemberCount, 4);
  assert.equal(graph.targetCount, 2);
  assert.deepEqual(
    graph.unused.map((item) => item.name),
    ["东京-备用"],
  );
});

test("buildTemplateGraph: 链数降序 → 用户数降序 → 名称", () => {
  const graph = graphOf({
    template: { id: "tpl-sort", name: "排序", hops: 2 },
    nodes: [
      {
        seq: 0,
        role: "source",
        name: "入口",
        members: [
          member("zeta", 2, 1),
          member("alpha", 2, 3),
          member("beta", 2, 1),
          member("gamma", 5, 0),
        ],
      },
      { seq: 1, role: "hop", name: "东京", members: [] },
      { seq: 2, role: "target", name: "目标", members: [] },
    ],
    edges: [
      edge(0, "zeta", 1, "东京", 2, 10),
      edge(0, "alpha", 1, "东京", 2, 10),
      edge(0, "beta", 1, "东京", 2, 10),
      edge(0, "gamma", 1, "东京", 5, 10),
      edge(1, "东京", 2, "1.1.1.1:443", 11, 10),
    ],
    targets: [{ host: "1.1.1.1", port: 443, chains: 11, users: [] }],
    users: [],
    series: [],
    strategies: [],
    unused_candidates: [],
  });
  assert.deepEqual(
    columnOf(graph, 0).members.map((item) => item.name),
    ["gamma", "alpha", "beta", "zeta"],
  );
});

test("buildTemplateGraph: 1 成员 / 多成员 / 别名去重", () => {
  const single = graphOf({
    template: { id: "tpl-1", name: "单跳", hops: 1 },
    nodes: [
      { seq: 0, role: "source", name: "入口", members: [member("香港-01", 2, 1)] },
      { seq: 1, role: "target", name: "目标", members: [] },
    ],
    edges: [edge(0, "香港-01", 1, "1.1.1.1:443", 2, 12)],
    targets: [{ host: "1.1.1.1", port: 443, chains: 2, users: [] }],
    users: [],
    series: [],
    strategies: [],
    unused_candidates: [],
  });
  assert.deepEqual(
    single.columns.map((column) => column.seq),
    [0, 1],
  );
  assert.equal(single.edges.length, 1);

  // 同一台机器的旧名字：成员表里两个名字指同一个 server_id，节点只留一个。
  const alias = graphOf({
    template: { id: "tpl-alias", name: "别名", hops: 2 },
    nodes: [
      {
        seq: 0,
        role: "source",
        name: "入口",
        members: [member("香港-01", 2, 1, "online", "srv-1")],
      },
      {
        seq: 1,
        role: "hop",
        name: "东京",
        members: [
          member("东京-01", 2, 1, "online", "srv-2"),
          member("东京-01-old", 2, 1, "online", "srv-2"),
        ],
      },
      { seq: 2, role: "target", name: "目标", members: [] },
    ],
    edges: [
      edge(0, "香港-01", 1, "东京-01", 2, 10),
      edge(1, "东京-01-old", 2, "9.9.9.9:443", 2, 10),
    ],
    targets: [{ host: "9.9.9.9", port: 443, chains: 2, users: [] }],
    users: [],
    series: [],
    strategies: [],
    unused_candidates: [],
  });
  assert.equal(columnOf(alias, 1).members.length, 1);
  assert.equal(alias.edges.length, 2);
});

/* ------------------------------------------------------------------ */
/* foldTemplateGraph                                                   */
/* ------------------------------------------------------------------ */

test("foldTemplateGraph: 每列最多 4 张成员卡 + 1 张折叠卡", () => {
  const graph = buildTemplateGraph(wideDetail({ hops: 3, perColumn: 6 }));
  const folded = foldTemplateGraph(graph);
  for (const column of folded.columns) {
    if (column.role === "target") continue;
    assert.ok(
      column.cards.length <= TEMPLATE_FOLD_LIMIT + 1,
      `${column.role} 列卡片 ${column.cards.length} 超过上限`,
    );
    assert.equal(column.cards.filter((card) => card.kind === "fold").length, 1);
    assert.equal(column.cards.at(-1).kind, "fold");
  }
  const foldCards = cardsOf(folded, "fold");
  assert.equal(foldCards.length, 3);
  for (const card of foldCards) {
    assert.equal(card.hidden, 2);
    assert.equal(card.topNames.length, 2);
    assert.ok(card.chains > 0);
    assert.equal(card.id.startsWith("fold:"), true);
  }
});

test("foldTemplateGraph: 折叠卡标注最差状态与离线台数，悬停名单只取前 8", () => {
  const graph = buildTemplateGraph(
    normalizeChainTemplateDetail({
      template: { id: "tpl-offline", name: "离线折叠", hops: 2 },
      nodes: [
        {
          seq: 0,
          role: "source",
          name: "入口",
          members: Array.from({ length: 14 }, (_, index) =>
            member(
              `香港-${pad(index)}`,
              14 - index,
              1,
              index >= 11 ? "offline" : index >= 9 ? "degraded" : "online",
            ),
          ),
        },
        { seq: 1, role: "hop", name: "东京", members: [] },
        { seq: 2, role: "target", name: "目标", members: [] },
      ],
      edges: Array.from({ length: 14 }, (_, index) =>
        edge(0, `香港-${pad(index)}`, 1, "东京", 14 - index, 10),
      ),
      targets: [],
      users: [],
      series: [],
      strategies: [],
      unused_candidates: [],
    }),
  );
  const folded = foldTemplateGraph(graph);
  const fold = cardsOf(folded, "fold")[0];
  assert.equal(fold.hidden, 10);
  assert.equal(fold.status, "offline");
  assert.equal(fold.offlineHidden, 3);
  assert.equal(fold.topNames.length, 8);
  assert.deepEqual(fold.topNames[0], "香港-05");
  assert.equal(folded.hiddenMembers, 10);
});

test("foldTemplateGraph: 展开只展开本列，其余列仍然折叠", () => {
  const graph = buildTemplateGraph(wideDetail({ hops: 3, perColumn: 6 }));
  const folded = foldTemplateGraph(graph, { expandedColumns: new Set([1]) });
  const firstHop = folded.columns.find((column) => column.seq === 1);
  assert.equal(firstHop.cards.length, 6);
  assert.equal(firstHop.cards.some((card) => card.kind === "fold"), false);
  for (const column of folded.columns) {
    if (column.role === "target" || column.seq === 1) continue;
    assert.equal(column.cards.filter((card) => card.kind === "fold").length, 1);
  }
  // 展开的列不隐藏成员；折叠列仍记录隐藏数。
  assert.ok(folded.hiddenMembers > 0);

  const restored = foldTemplateGraph(graph);
  assert.equal(cardsOf(restored, "fold").length, 3);
});

test("foldTemplateGraph: 目标列每个上游至少 1 张，其余折成 +N 标签", () => {
  const payload = {
    template: { id: "tpl-targets", name: "多目标", hops: 2 },
    nodes: [
      { seq: 0, role: "source", name: "入口", members: [member("香港-01", 6, 2)] },
      {
        seq: 1,
        role: "hop",
        name: "东京",
        members: [member("东京-01", 4, 2), member("东京-02", 2, 1)],
      },
      { seq: 2, role: "target", name: "目标", members: [] },
    ],
    edges: [
      edge(0, "香港-01", 1, "东京-01", 4, 20),
      edge(0, "香港-01", 1, "东京-02", 2, 25),
      edge(1, "东京-01", 2, "1.1.1.1:443", 2, 30),
      edge(1, "东京-01", 2, "2.2.2.2:443", 2, 31),
      edge(1, "东京-01", 2, "3.3.3.3:443", 1, 32),
      edge(1, "东京-02", 2, "4.4.4.4:443", 1, 33),
      edge(1, "东京-02", 2, "5.5.5.5:443", 1, 34),
    ],
    targets: [
      { host: "1.1.1.1", port: 443, chains: 2, users: [] },
      { host: "2.2.2.2", port: 443, chains: 2, users: [] },
      { host: "3.3.3.3", port: 443, chains: 1, users: [] },
      { host: "4.4.4.4", port: 443, chains: 1, users: [] },
      { host: "5.5.5.5", port: 443, chains: 1, users: [] },
    ],
    users: [],
    series: [],
    strategies: [],
    unused_candidates: [],
  };
  const graph = graphOf(payload);
  const folded = foldTemplateGraph(graph);
  const targetColumn = folded.columns.find((column) => column.role === "target");
  // 两个上游各至少一张，最多 4 张 + 溢出则按上游数兜底。
  assert.ok(targetColumn.cards.length >= 2);
  assert.ok(targetColumn.cards.length <= TEMPLATE_FOLD_LIMIT + 1);
  const upstreams = new Set(targetColumn.cards.map((card) => card.upstreamId));
  assert.equal(upstreams.size, 2);
  const hiddenTargets = targetColumn.cards.reduce(
    (sum, card) => sum + card.hidden,
    0,
  );
  assert.equal(hiddenTargets, 5 - targetColumn.cards.length);
  for (const card of targetColumn.cards) {
    if (card.hidden > 0) {
      assert.ok(card.topNames.length > 0);
      assert.ok(card.chains > 0);
    }
  }
  // 目标列没有独立折叠卡：+N 挂在目标卡上。
  assert.equal(targetColumn.cards.some((card) => card.kind === "fold"), false);

  // 展开某个上游：只这一组的目标全部可见。
  const expanded = foldTemplateGraph(graph, {
    expandedTargets: new Set([targetColumn.cards[0].upstreamId]),
  });
  const expandedColumn = expanded.columns.find((column) => column.role === "target");
  const expandedTargets = expandedColumn.cards.filter(
    (card) => card.upstreamId === targetColumn.cards[0].upstreamId,
  );
  assert.equal(
    expandedTargets.reduce((sum, card) => sum + card.hidden, 0),
    0,
  );
  assert.ok(expandedTargets.length > 1);
});

test("foldTemplateGraph: 上游成员被折叠时，目标 +N 仍能展开该组", () => {
  // 第 1 跳 6 台（折叠成 4 + 1 张折叠卡），每台 3 个目标。
  // 被折成员的目标只能挂在折叠卡上，分组键必须是折叠卡 id，而不是原始成员 id。
  const HOP_COUNT = 6;
  const TARGETS_PER_HOP = 3;
  const hopMembers = Array.from({ length: HOP_COUNT }, (_, index) =>
    member(`东京-0${index + 1}`, 3, 3, "online", `hop-${index + 1}`),
  );
  const edges = [];
  const targets = [];
  for (let hop = 0; hop < HOP_COUNT; hop += 1) {
    edges.push(edge(0, "香港-01", 1, `东京-0${hop + 1}`, 3, 20, 3));
    for (let slot = 0; slot < TARGETS_PER_HOP; slot += 1) {
      const label = `10.0.${hop + 1}.${slot + 1}:443`;
      edges.push(
        edge(1, `东京-0${hop + 1}`, 2, label, TARGETS_PER_HOP - slot, 30, TARGETS_PER_HOP - slot),
      );
      targets.push({ host: `10.0.${hop + 1}.${slot + 1}`, port: 443, chains: 0, users: [] });
    }
  }
  const graph = graphOf({
    template: { id: "tpl-fold-targets", name: "折叠后的目标组", hops: 2 },
    nodes: [
      { seq: 0, role: "source", name: "入口", members: [member("香港-01", 18, 3)] },
      { seq: 1, role: "hop", name: "东京", members: hopMembers },
      { seq: 2, role: "target", name: "目标", members: [] },
    ],
    edges,
    targets,
    users: [],
    series: [],
    strategies: [],
    unused_candidates: [],
  });

  const folded = foldTemplateGraph(graph);
  const targetColumn = folded.columns.find((column) => column.role === "target");
  assert.ok(targetColumn);
  const foldCard = folded.columns
    .flatMap((column) => column.cards)
    .find((card) => card.kind === "fold");
  assert.ok(foldCard, "第 1 跳应有折叠卡");

  const groups = new Map();
  for (const card of targetColumn.cards) {
    assert.notEqual(card.upstreamId, null, "目标卡必须带上可展开的分组键");
    const bucket = groups.get(card.upstreamId) ?? [];
    bucket.push(card);
    groups.set(card.upstreamId, bucket);
  }
  // 4 张可见成员卡 + 1 张折叠卡 = 5 个上游分组。
  assert.equal(groups.size, 5);
  assert.ok(
    groups.has(foldCard.id),
    `被折成员的目标组应挂在 ${foldCard.id} 上，实际 ${[...groups.keys()].join(", ")}`,
  );

  for (const [groupKey, cards] of groups) {
    const first = cards[0];
    // 折叠卡一组收下 2 台被折成员 × 3 个目标；普通组只有 1 台 × 3 个。
    const groupSize =
      groupKey === foldCard.id
        ? (HOP_COUNT - TEMPLATE_FOLD_LIMIT) * TARGETS_PER_HOP
        : TARGETS_PER_HOP;
    assert.equal(first.hidden, groupSize - 1);
    // 折叠目标 tooltip 的合计值：链数求和、用户数取最大值（用户可能重叠）。
    const hiddenMembers = first.topNames.map((name) =>
      graph.columns
        .find((column) => column.role === "target")
        .members.find((item) => item.name === name),
    );
    assert.equal(
      first.hiddenChains,
      hiddenMembers.reduce((sum, item) => sum + item.chains, 0),
    );
    assert.equal(
      first.hiddenUsers,
      hiddenMembers.reduce((max, item) => Math.max(max, item.users), 0),
    );

    const expanded = foldTemplateGraph(graph, {
      expandedTargets: new Set([groupKey]),
    });
    const expandedColumn = expanded.columns.find((column) => column.role === "target");
    const expandedCards = expandedColumn.cards.filter(
      (card) => card.upstreamId === groupKey,
    );
    assert.equal(expandedCards.length, groupSize, `${groupKey} 组应展开全部目标`);
    assert.equal(
      expandedCards.reduce((sum, card) => sum + card.hidden, 0),
      0,
      `${groupKey} 组展开后不应再折叠目标`,
    );
  }
});

test("foldTemplateGraph: 被折成员的连线合并成一条虚线，宽度为链数之和", () => {
  const graph = buildTemplateGraph(wideDetail({ hops: 2, perColumn: 6 }));
  const folded = foldTemplateGraph(graph);
  const foldCard = folded.columns[0].cards.find((card) => card.kind === "fold");
  const fromFold = folded.edges.filter((item) => item.source === foldCard.id);
  // 6 台隐藏入口 → 4 台可见入口；隐藏的 2 台都只连到同一个第 1 跳成员。
  const hops = folded.columns.find((column) => column.role === "hop");
  assert.ok(fromFold.length >= 1);
  for (const item of fromFold) {
    assert.equal(item.merged, true);
    assert.equal(item.p50Ms, null);
    assert.equal(item.lastP50Ms, null);
    assert.ok(item.chains > 0);
  }
  // 隐藏的入口成员连到隐藏的第 1 跳成员：连线合并到两张折叠卡之间。
  const foldHop = hops.cards.find((card) => card.kind === "fold");
  assert.ok(foldHop);
  const merged = fromFold.find((item) => item.target === foldHop.id);
  assert.ok(merged, "隐藏成员之间的边应合并到折叠卡");
  // 隐藏成员是 s-0-05 / s-0-06，分别 2 / 1 条链。
  assert.equal(merged.chains, 3);
  assert.equal(merged.users, 2);
  // 合并虚线要能说清「来自几条路径」。
  assert.equal(merged.paths, 2);

  // 可见成员之间的边不合并、保留时延。
  const normal = folded.edges.filter((item) => item.merged === false);
  assert.ok(normal.length > 0);
  assert.ok(normal.some((item) => item.p50Ms !== null));
});

test("foldTemplateGraph: 不可用路径不给当前 P50，降级路径标黄", () => {
  const graph = graphOf(detail());
  const folded = foldTemplateGraph(graph);
  // 洛杉矶-01 离线：进入它的边不可用，时延挪到 lastP50Ms。
  const intoOffline = folded.edges.filter(
    (item) => item.source === "h:1:东京-01" || item.source === "h:1:东京-02",
  );
  assert.ok(intoOffline.length > 0);
  for (const item of intoOffline) {
    assert.equal(item.unavailable, true);
    assert.equal(item.p50Ms, null);
  }
  // 有历史值的那条边把 P50 挪到 lastP50Ms，不当当前值展示。
  assert.ok(intoOffline.some((item) => item.lastP50Ms !== null));
  const layout = layoutTemplateGraph(folded);
  const offlineEdges = layout.edges.filter((item) => item.unavailable);
  assert.ok(offlineEdges.length > 0);
  for (const item of offlineEdges) {
    assert.equal(item.status, "offline");
    assert.equal(item.dashed, true);
  }
});

/* ------------------------------------------------------------------ */
/* layoutTemplateGraph                                                 */
/* ------------------------------------------------------------------ */

test("layoutTemplateGraph: 列 x 递增、同列同 x、卡片不重叠、连线端点贴卡片边", () => {
  const graph = buildTemplateGraph(wideDetail({ hops: 3, perColumn: 6 }));
  const folded = foldTemplateGraph(graph);
  const layout = layoutTemplateGraph(folded);
  const byColumn = new Map();
  for (const card of layout.cards) {
    const group = byColumn.get(card.column) ?? [];
    group.push(card);
    byColumn.set(card.column, group);
  }
  const columns = [...byColumn.keys()].sort((a, b) => a - b);
  for (let index = 0; index < columns.length; index += 1) {
    const cards = byColumn.get(columns[index]);
    const x = cards[0].x;
    assert.equal(cards[0].width, TEMPLATE_CARD_WIDTH);
    assert.equal(cards[0].height, TEMPLATE_CARD_HEIGHT);
    for (const card of cards) {
      assert.equal(card.x, x);
      assert.equal(card.width, TEMPLATE_CARD_WIDTH);
      assert.equal(card.height, TEMPLATE_CARD_HEIGHT);
    }
    if (index > 0) {
      assert.equal(
        x,
        byColumn.get(columns[index - 1])[0].x +
          TEMPLATE_CARD_WIDTH +
          TEMPLATE_COLUMN_GAP,
      );
    }
    for (let i = 1; i < cards.length; i += 1) {
      assert.ok(
        cards[i].y >= cards[i - 1].y + TEMPLATE_CARD_HEIGHT + TEMPLATE_ROW_GAP,
        "同列卡片必须按行距排开",
      );
    }
    assert.ok(x >= TEMPLATE_PADDING);
  }
  assert.equal(
    layout.width,
    TEMPLATE_PADDING * 2 +
      columns.length * TEMPLATE_CARD_WIDTH +
      (columns.length - 1) * TEMPLATE_COLUMN_GAP,
  );
  assert.ok(layout.height > TEMPLATE_CARD_HEIGHT);

  const cardById = new Map(layout.cards.map((card) => [card.id, card]));
  for (const item of layout.edges) {
    const source = cardById.get(item.source);
    const target = cardById.get(item.target);
    assert.ok(source && target);
    assert.equal(item.x1, source.x + source.width);
    assert.equal(item.y1, source.y + source.height / 2);
    assert.equal(item.x2, target.x);
    assert.equal(item.y2, target.y + target.height / 2);
    assert.ok(item.path.startsWith("M "));
    assert.ok(!item.path.includes("NaN"));
    assert.ok(
      item.width >= TEMPLATE_EDGE_MIN_WIDTH && item.width <= TEMPLATE_EDGE_MAX_WIDTH,
      `连线宽度 ${item.width} 超出 ${TEMPLATE_EDGE_MIN_WIDTH}–${TEMPLATE_EDGE_MAX_WIDTH}`,
    );
  }
  // 动画边上限：同一时刻只有 Top N 条在动。
  assert.ok(layout.edges.filter((item) => item.pulse).length <= TEMPLATE_PULSE_LIMIT);
});

test("layoutTemplateGraph: 每列顶边统一上移到 TEMPLATE_COLUMN_TOP，保持列内行号", () => {
  // 第一张入口卡链数最高，但第 1 跳的第一张卡只接在第二张入口卡上：
  // 旧算法会把后两列整体压低，左上角留下空白。
  const graph = graphOf({
    template: { id: "tpl-sink", name: "逐列下沉", hops: 2 },
    nodes: [
      {
        seq: 0,
        role: "source",
        name: "入口",
        members: [member("香港-01", 6, 6), member("香港-02", 3, 3)],
      },
      {
        seq: 1,
        role: "hop",
        name: "东京",
        members: [member("东京-01", 3, 3), member("东京-02", 1, 1)],
      },
      { seq: 2, role: "target", name: "目标", members: [] },
    ],
    edges: [
      edge(0, "香港-02", 1, "东京-01", 3, 20),
      edge(0, "香港-01", 1, "东京-02", 1, 20),
      edge(1, "东京-01", 2, "1.1.1.1:443", 3, 20),
    ],
    targets: [{ host: "1.1.1.1", port: 443, chains: 3, users: [] }],
    users: [],
    series: [],
    strategies: [],
    unused_candidates: [],
  });
  const layout = layoutTemplateGraph(foldTemplateGraph(graph));
  const byColumn = new Map();
  for (const card of layout.cards) {
    const bucket = byColumn.get(card.column) ?? [];
    bucket.push(card);
    byColumn.set(card.column, bucket);
  }
  assert.equal(byColumn.size, 3);
  for (const cards of byColumn.values()) {
    cards.sort((a, b) => a.y - b.y);
    assert.equal(
      cards[0].y,
      TEMPLATE_COLUMN_TOP,
      "每列第一张卡顶边都应是 TEMPLATE_COLUMN_TOP（列头下方）",
    );
    for (let index = 1; index < cards.length; index += 1) {
      assert.ok(
        cards[index].y >= cards[index - 1].y + TEMPLATE_CARD_HEIGHT + TEMPLATE_ROW_GAP,
        "列内行序与行距必须保持",
      );
    }
  }
  // 列距 80：四列模板在 0.9 缩放下仍能读清 13px 标题。
  assert.equal(TEMPLATE_COLUMN_GAP, 80);
  assert.equal(TEMPLATE_CARD_WIDTH, 192);
  assert.equal(TEMPLATE_CARD_HEIGHT, 64);
});

test("列头：每列一个、y=24、宽 192、高 32，卡片从 56 起", () => {
  const graph = buildTemplateGraph(wideDetail({ hops: 3, perColumn: 6 }));
  const layout = layoutTemplateGraph(foldTemplateGraph(graph));
  assert.equal(layout.headers.length, layout.columns.length);
  const foldedBySeq = new Map(
    foldTemplateGraph(graph).columns.map((column) => [column.seq, column]),
  );
  for (const [index, header] of layout.headers.entries()) {
    const column = layout.columns[index];
    assert.equal(header.seq, column.seq, "列头与列一一对应");
    assert.equal(header.x, column.x, "列头 x = 该列卡片 x");
    assert.equal(header.y, TEMPLATE_PADDING);
    assert.equal(header.width, TEMPLATE_CARD_WIDTH);
    assert.equal(header.height, TEMPLATE_COLUMN_HEADER_HEIGHT);
    assert.equal(header.role, foldedBySeq.get(header.seq).role);
    // 逻辑列头底边正好接上第一张卡（无额外间距）。
    assert.equal(header.y + header.height, TEMPLATE_COLUMN_TOP);
    assert.equal(
      layout.cards.filter((card) => card.column === index)[0].y,
      TEMPLATE_COLUMN_TOP,
    );
  }
  // 折叠列：shown < total，total 是折叠前成员数。
  const entryHeader = layout.headers.find((header) => header.role === "entry");
  assert.equal(entryHeader.total, 6);
  assert.equal(entryHeader.shown, TEMPLATE_FOLD_LIMIT);
  assert.ok(entryHeader.shown < entryHeader.total);
  // 目标列：total = 折叠前目标数，shown = 可见目标卡数。
  const targetHeader = layout.headers.find((header) => header.role === "target");
  assert.equal(targetHeader.total, 6);
  assert.equal(targetHeader.shown, 5);
  assert.ok(targetHeader.shown < targetHeader.total);
});

test("FoldedColumn.total: 入口 / 中间跳 / 目标三类列记录折叠前成员数", () => {
  const folded = foldTemplateGraph(graphOf(detail()));
  const bySeq = new Map(folded.columns.map((column) => [column.seq, column]));
  // detail()：入口 1 台、第 1 跳 2 台（0 链成员不算）、第 2 跳 1 台、目标 2 个。
  assert.equal(bySeq.get(0).role, "entry");
  assert.equal(bySeq.get(0).total, 1);
  assert.equal(bySeq.get(0).cards.length, 1);
  assert.equal(bySeq.get(1).role, "hop");
  assert.equal(bySeq.get(1).total, 2);
  assert.equal(bySeq.get(1).cards.length, 2);
  assert.equal(bySeq.get(2).role, "hop");
  assert.equal(bySeq.get(2).total, 1);
  assert.equal(bySeq.get(3).role, "target");
  assert.equal(bySeq.get(3).total, 2);
  assert.equal(bySeq.get(3).cards.length, 2);

  // 折叠后：入口 / 中间跳的 total 仍是折叠前成员数，shown 只数非折叠卡。
  const wide = foldTemplateGraph(
    buildTemplateGraph(wideDetail({ hops: 2, perColumn: 6 })),
  );
  for (const column of wide.columns) {
    assert.equal(column.total, 6, `${column.role} 列的 total 是折叠前成员数`);
    if (column.role === "target") {
      assert.equal(column.cards.some((card) => card.kind === "fold"), false);
    } else {
      const shown = column.cards.filter((card) => card.kind !== "fold").length;
      assert.equal(shown, TEMPLATE_FOLD_LIMIT);
      assert.ok(shown < column.total);
    }
  }
});

test("layoutTemplateGraph: 高度自然增加 32（列头占位），内容盒含列头", () => {
  // 单列单卡：卡片 64 高，上下各 24 内边距，再加 32 的列头 = 144。
  const graph = graphOf({
    template: { id: "tpl-one", name: "单列", hops: 1 },
    nodes: [
      { seq: 0, role: "source", name: "入口", members: [member("香港-01", 2, 1)] },
      { seq: 1, role: "target", name: "目标", members: [] },
    ],
    edges: [],
    targets: [],
    users: [],
    series: [],
    strategies: [],
    unused_candidates: [],
  });
  const layout = layoutTemplateGraph(foldTemplateGraph(graph));
  assert.equal(layout.cards.length, 1);
  assert.equal(layout.headers.length, 1);
  assert.equal(
    layout.height,
    TEMPLATE_PADDING + TEMPLATE_COLUMN_HEADER_HEIGHT + TEMPLATE_CARD_HEIGHT + TEMPLATE_PADDING,
  );
  // 去掉列头就是旧高度：正是 +32。
  assert.equal(
    layout.height - (TEMPLATE_PADDING + TEMPLATE_CARD_HEIGHT + TEMPLATE_PADDING),
    TEMPLATE_COLUMN_HEADER_HEIGHT,
  );
  // 内容包围盒含列头：顶边留白仍是 24，第一张卡距顶边 56。
  const bounds = templateContentBounds(layout);
  assert.equal(bounds.y, 0);
  assert.equal(bounds.height, layout.height);
  assert.equal(bounds.width, layout.width);
  assert.equal(layout.cards[0].y - bounds.y, TEMPLATE_COLUMN_TOP);
});

test("layoutTemplateGraph: 时延药丸贴竖线，且同一竖线上互不重叠", () => {
  const graph = buildTemplateGraph(wideDetail({ hops: 2, perColumn: 6 }));
  const folded = foldTemplateGraph(graph);
  const layout = layoutTemplateGraph(folded);
  const pills = layout.edges
    .filter((item) => item.pill !== null)
    .map((item) => item.pill);
  assert.ok(pills.length > 0);
  for (const pill of pills) {
    assert.equal(pill.width, TEMPLATE_PILL_WIDTH);
    assert.equal(pill.height, 18);
  }
  // 两两不重叠（同一竖线上的药丸被纯函数摊开）。
  for (let i = 0; i < pills.length; i += 1) {
    for (let j = i + 1; j < pills.length; j += 1) {
      const a = pills[i];
      const b = pills[j];
      const overlapX =
        Math.abs(a.x - b.x) < (a.width + b.width) / 2;
      const overlapY =
        Math.abs(a.y - b.y) < (a.height + b.height) / 2;
      assert.equal(overlapX && overlapY, false, `pill ${i} 与 ${j} 重叠`);
    }
  }
  // 合并虚线没有时延药丸。
  for (const item of layout.edges) {
    if (item.merged) assert.equal(item.pill, null);
  }
});

test("spreadPills: 同一落点的药丸被竖向摊开，互不重叠", () => {  const pills = [
    { id: "a", x: 100, y: 100, width: 40, height: 18 },
    { id: "b", x: 100, y: 100, width: 40, height: 18 },
    { id: "c", x: 100, y: 100, width: 40, height: 18 },
  ];
  const placed = spreadPills(pills);
  assert.equal(placed.length, 3);
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      assert.ok(
        Math.abs(placed[i].y - placed[j].y) >= 18,
        `${placed[i].id} 与 ${placed[j].id} 仍在同一高度`,
      );
    }
  }
  // 输入不被就地修改。
  assert.equal(pills[0].y, 100);
  // 横向错开的药丸不动。
  const apart = spreadPills([
    { id: "l", x: 0, y: 50, width: 40, height: 18 },
    { id: "r", x: 200, y: 50, width: 40, height: 18 },
  ]);
  assert.equal(apart[0].y, 50);
  assert.equal(apart[1].y, 50);
});

test("layoutTemplateGraph: 同一竖线超过 6 个药丸标 pillDense，默认交给组件隐藏", () => {
  const members = Array.from({ length: 7 }, (_, index) =>
    member(`东京-0${index + 1}`, 7 - index, 2),
  );
  const edges = members.flatMap((item, index) => [
    edge(0, "香港-01", 1, item.name, 7 - index, 20),
    edge(1, item.name, 2, `10.0.0.${index + 1}:443`, 7 - index, 30),
  ]);
  const graph = graphOf({
    template: { id: "tpl-dense", name: "密集药丸", hops: 2 },
    nodes: [
      { seq: 0, role: "source", name: "入口", members: [member("香港-01", 7, 7)] },
      { seq: 1, role: "hop", name: "东京", members },
      { seq: 2, role: "target", name: "目标", members: [] },
    ],
    edges,
    targets: [],
    users: [],
    series: [],
    strategies: [],
    unused_candidates: [],
  });
  // 展开第 1 跳：7 条「入口 → 第 1 跳」边落在同一条竖线上。
  const folded = foldTemplateGraph(graph, { expandedColumns: new Set([1]) });
  const layout = layoutTemplateGraph(folded);
  const pills = layout.edges
    .filter((item) => item.pill !== null)
    .map((item) => item.pill);
  const counts = new Map();
  for (const pill of pills) {
    counts.set(pill.x, (counts.get(pill.x) ?? 0) + 1);
  }
  assert.ok(
    [...counts.values()].some((count) => count > TEMPLATE_PILL_DENSE_LIMIT),
    "应有超过 6 个药丸共用一条竖线",
  );
  const denseRails = new Set(densePillRails(pills));
  assert.ok(denseRails.size > 0);
  for (const edge of layout.edges) {
    if (edge.pill === null) {
      assert.equal(edge.pillDense, false);
      continue;
    }
    assert.equal(edge.pillDense, denseRails.has(edge.pill.x));
  }

  // 6 个及以下不隐藏；正好 7 个才隐藏。
  const makePills = (count) =>
    Array.from({ length: count }, (_, index) => ({
      id: `p${index}`,
      x: 120,
      y: 100 + index * 22,
      width: TEMPLATE_PILL_WIDTH,
      height: 18,
    }));
  assert.deepEqual(densePillRails(makePills(TEMPLATE_PILL_DENSE_LIMIT)), []);
  assert.deepEqual(densePillRails(makePills(TEMPLATE_PILL_DENSE_LIMIT + 1)), [120]);
});

test("layoutTemplateGraph: 合并虚线的竖脊与正常连线错开，仍在列间空隙内", () => {
  const graph = buildTemplateGraph(wideDetail({ hops: 2, perColumn: 6 }));
  const folded = foldTemplateGraph(graph);
  const layout = layoutTemplateGraph(folded);
  const merged = layout.edges.filter((item) => item.merged);
  const normal = layout.edges.filter((item) => !item.merged);
  assert.ok(merged.length > 0 && normal.length > 0);
  for (const item of merged) {
    assert.ok(item.sourceName.length > 0, "合并虚线的源端也要有可读名字");
    assert.ok(item.targetName.length > 0, "合并虚线的目标端也要有可读名字");
  }
  const foldCard = folded.columns[0].cards.find((card) => card.kind === "fold");
  const fromFold = merged.filter((item) => item.source === foldCard.id);
  const plain = normal.find(
    (item) => !item.degraded && !item.unavailable && item.source !== foldCard.id,
  );
  assert.ok(plain, "应有普通可用连线");
  for (const item of fromFold) {
    assert.equal(
      Math.round(item.railX - plain.railX),
      TEMPLATE_MERGED_RAIL_OFFSET,
    );
    assert.ok(item.railX <= item.x2);
  }
  // 降级 / 不可用的竖脊也要错开，避免把整条蓝脊染成告警色。
  const degraded = normal.find((item) => item.degraded);
  if (degraded !== undefined) {
    assert.equal(
      Math.round(degraded.railX - plain.railX),
      TEMPLATE_STATUS_RAIL_OFFSET,
    );
  }
  const unavailable = layout.edges.find((item) => item.unavailable);
  if (unavailable !== undefined) {
    assert.equal(
      Math.round(unavailable.railX - plain.railX),
      -TEMPLATE_STATUS_RAIL_OFFSET,
    );
  }
});

test("templateEdgePath: 直角折线带 8px 圆角，直线退化为单段", () => {
  const path = templateEdgePath(0, 0, 100, 80, 50);
  assert.ok(path.startsWith("M 0 0"));
  assert.ok(path.includes("Q 50 0"));
  assert.ok(path.includes("L 100 80"));
  const straight = templateEdgePath(0, 10, 100, 10, 50);
  assert.equal(straight, "M 0 10 L 100 10");
  // 竖向落点很小时圆角被压缩，不出现反向弧。
  const tight = templateEdgePath(0, 0, 100, 2, 50);
  assert.ok(!tight.includes("NaN"));
});

test("templateEdgeWidth: 链数越大越粗，有上下限（最粗 4）", () => {
  assert.equal(TEMPLATE_EDGE_MIN_WIDTH, 1.5);
  assert.equal(TEMPLATE_EDGE_MAX_WIDTH, 4);
  assert.equal(templateEdgeWidth(0, 10), TEMPLATE_EDGE_MIN_WIDTH);
  assert.equal(templateEdgeWidth(10, 10), TEMPLATE_EDGE_MAX_WIDTH);
  assert.equal(templateEdgeWidth(5, 10), 2.75);
  assert.ok(templateEdgeWidth(3, 10) < templateEdgeWidth(8, 10));
  assert.equal(templateEdgeWidth(5, 0), TEMPLATE_EDGE_MIN_WIDTH);
  assert.equal(templateEdgeWidth(Number.NaN, 10), TEMPLATE_EDGE_MIN_WIDTH);
  assert.equal(templateEdgeWidth(10, Number.NaN), TEMPLATE_EDGE_MIN_WIDTH);
});

test("templatePulseWidth: 0.7×线宽、下限 1.5，且永远不粗于线宽", () => {
  assert.equal(TEMPLATE_PULSE_WIDTH_RATIO, 0.7);
  assert.equal(templatePulseWidth(4), 2.8);
  assert.equal(templatePulseWidth(2.8), 1.96);
  assert.equal(templatePulseWidth(10), 7);
  // 下限：1.5 × 0.7 = 1.05 → 1.5。
  assert.equal(templatePulseWidth(TEMPLATE_EDGE_MIN_WIDTH), TEMPLATE_EDGE_MIN_WIDTH);
  assert.equal(templatePulseWidth(0), TEMPLATE_EDGE_MIN_WIDTH);
  // 非有限数退回最细，不把 NaN 写进 SVG。
  assert.equal(templatePulseWidth(Number.NaN), TEMPLATE_EDGE_MIN_WIDTH);
  assert.equal(templatePulseWidth(Number.POSITIVE_INFINITY), TEMPLATE_EDGE_MIN_WIDTH);
  assert.equal(
    templatePulseWidth(Number.NEGATIVE_INFINITY),
    TEMPLATE_EDGE_MIN_WIDTH,
  );
  // 实际线宽区间内（1.5–4）：亮划永远 ≤ 线宽，避免脉冲看起来比线还粗。
  for (
    let width = TEMPLATE_EDGE_MIN_WIDTH;
    width <= TEMPLATE_EDGE_MAX_WIDTH + 1e-9;
    width += 0.05
  ) {
    const pulse = templatePulseWidth(width);
    assert.ok(
      pulse <= width + 1e-9,
      `线宽 ${width.toFixed(2)} 的脉冲 ${pulse} 比线还粗`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* viewport                                                            */
/* ------------------------------------------------------------------ */

const LAYOUT = {
  width: 1000,
  height: 500,
  cards: [],
  edges: [],
  columns: [],
};

test("initialViewport: 首屏 = 适应窗口，缩放不再保底 0.9", () => {
  // 内容 1000×500、视口 800×400：fit 0.8，整图刚好铺满并居中。
  const view = initialViewport(LAYOUT, { width: 800, height: 400 });
  assert.equal(view.zoom, 0.8);
  assert.equal(view.x, 0);
  assert.equal(view.y, 0);
  assert.deepEqual(view, fitViewport(LAYOUT, { width: 800, height: 400 }));
  assert.equal(showsFitHint(view.zoom), true);

  // 内容很小：fit 4 → 封顶 1，居中，不显示「已缩小」提示。
  const small = initialViewport(
    { ...LAYOUT, width: 200, height: 100 },
    { width: 800, height: 400 },
  );
  assert.equal(small.zoom, 1);
  assert.equal(small.x, (800 - 200) / 2);
  assert.equal(small.y, (400 - 100) / 2);
  assert.equal(showsFitHint(small.zoom), false);

  // 缩放值永远落在 0.4–1.6。
  for (const size of [
    { width: 100, height: 100 },
    { width: 2000, height: 2000 },
    { width: 0, height: 0 },
  ]) {
    const view = initialViewport(LAYOUT, size);
    assert.ok(view.zoom >= TEMPLATE_MIN_ZOOM && view.zoom <= TEMPLATE_MAX_ZOOM);
  }
});

test("initialViewport: 3/4/6 跳首屏整图可见、缩放 = fit、居中误差 ≤1px", () => {
  // 1440 弹窗 1040 - 卡片内边距后约 1008；3 跳画布高度约 384，这里取更宽的 520。
  const size = { width: 1008, height: 520 };
  const expectedHops = new Map([
    [3, 4],
    [4, 5],
    [6, 7],
  ]);
  for (const hops of [3, 4, 6]) {
    const graph = buildTemplateGraph(wideDetail({ hops, perColumn: 3 }));
    const layout = layoutTemplateGraph(foldTemplateGraph(graph));
    assert.equal(layout.columns.length, expectedHops.get(hops));
    const bounds = templateContentBounds(layout);
    const fit = templateFitZoom(layout, size);
    const view = initialViewport(layout, size);

    // 缩放 = fit，而且首屏与「适应窗口」按钮完全一致。
    assert.equal(view.zoom, fit);
    assert.deepEqual(view, fitViewport(layout, size));
    // 布局尺寸本身就是「内容包围盒 + 24px 内边距」。
    assert.equal(bounds.width, layout.width);
    assert.equal(bounds.height, layout.height);
    // 这 3 个 fixture 的 fit 都高于 0.4 下限，整图必须放得下。
    assert.ok(fit > TEMPLATE_MIN_ZOOM);

    const left = view.x + bounds.x * view.zoom;
    const top = view.y + bounds.y * view.zoom;
    const scaledWidth = bounds.width * view.zoom;
    const scaledHeight = bounds.height * view.zoom;
    assert.ok(left >= -0.5, `${hops} 跳左边缘被裁 ${left}px`);
    assert.ok(top >= -0.5, `${hops} 跳上边缘被裁 ${top}px`);
    assert.ok(left + scaledWidth <= size.width + 0.5, `${hops} 跳右边缘被裁`);
    assert.ok(top + scaledHeight <= size.height + 0.5, `${hops} 跳下边缘被裁`);
    // 居中：两侧留白误差 ≤1px。
    assert.ok(
      Math.abs(left - (size.width - scaledWidth) / 2) <= 1,
      `${hops} 跳水平居中误差 ${left - (size.width - scaledWidth) / 2}px`,
    );
    assert.ok(
      Math.abs(top - (size.height - scaledHeight) / 2) <= 1,
      `${hops} 跳垂直居中误差 ${top - (size.height - scaledHeight) / 2}px`,
    );
    // 每张卡都落在视口内：没有隐藏列 / 行。
    for (const card of layout.cards) {
      const cardLeft = view.x + card.x * view.zoom;
      const cardTop = view.y + card.y * view.zoom;
      assert.ok(cardLeft >= -0.5, `${hops} 跳 ${card.id} 在视口左侧外`);
      assert.ok(cardTop >= -0.5, `${hops} 跳 ${card.id} 在视口上方外`);
      assert.ok(
        cardLeft + card.width * view.zoom <= size.width + 0.5,
        `${hops} 跳 ${card.id} 在视口右侧外`,
      );
      assert.ok(
        cardTop + card.height * view.zoom <= size.height + 0.5,
        `${hops} 跳 ${card.id} 在视口下方外`,
      );
    }
    assert.equal(hiddenRightColumns(layout, size, view), 0);
    assert.equal(hasHiddenContentBelow(layout, size, view), false);
    // 3 跳 95% ≥ 90% 不提示；4 跳 75% / 6 跳 47% 必须提示。
    assert.equal(showsFitHint(fit), hops !== 3, `${hops} 跳提示阈值不符`);
  }
});

test("fitViewport: 能缩到 0.4，内容小于视口时不放大超过 1", () => {
  const huge = fitViewport({ ...LAYOUT, width: 4000, height: 4000 }, {
    width: 400,
    height: 400,
  });
  assert.equal(huge.zoom, TEMPLATE_MIN_ZOOM);
  // 到下限仍放不下：贴内容起点，入口列可见，由右缘 / 下缘提示平移。
  assert.equal(huge.x, 0);
  assert.equal(huge.y, 0);
  const tiny = fitViewport({ ...LAYOUT, width: 100, height: 50 }, {
    width: 800,
    height: 400,
  });
  assert.equal(tiny.zoom, TEMPLATE_FIT_MAX_ZOOM);
  const medium = fitViewport({ ...LAYOUT, width: 1000, height: 500 }, {
    width: 600,
    height: 300,
  });
  assert.equal(medium.zoom, 0.6);
  assert.equal(medium.x, (600 - 600) / 2);
});

test("fitHint: 自适应缩放 <0.9 才提示", () => {
  assert.equal(TEMPLATE_FIT_HINT_ZOOM, 0.9);
  assert.equal(showsFitHint(0.4), true);
  assert.equal(showsFitHint(0.899), true);
  assert.equal(showsFitHint(0.9), false);
  assert.equal(showsFitHint(0.954), false);
  assert.equal(showsFitHint(Number.NaN), false);
});

test("templateCanvasHeight: 上限 min(640, 视口高度 × 0.52)，下限 320", () => {
  assert.equal(templateCanvasHeight(1000, 1000), 520);
  assert.equal(templateCanvasHeight(1000, 2000), TEMPLATE_CANVAS_MAX_HEIGHT);
  assert.equal(templateCanvasHeight(400, 1000), 400);
  assert.equal(templateCanvasHeight(300, 1000), 320);
  // 极矮视口：上限优先，不强行撑到 320。
  assert.equal(templateCanvasHeight(900, 400), 208);
  assert.equal(templateCanvasHeight(900, 0), 0);
});

test("clampTemplateZoom: 按钮步进落回 0.4–1.6", () => {
  assert.equal(clampTemplateZoom(0.1), TEMPLATE_MIN_ZOOM);
  assert.equal(clampTemplateZoom(9), TEMPLATE_MAX_ZOOM);
  assert.equal(clampTemplateZoom(1.25), 1.25);
  assert.equal(clampTemplateZoom(Number.NaN), 1);
});

/* ------------------------------------------------------------------ */
/* highlight                                                           */
/* ------------------------------------------------------------------ */

test("stepTemplateZoom: 按钮吸附到 25% 整档", () => {
  assert.equal(stepTemplateZoom(0.913, 1), 1);
  assert.equal(stepTemplateZoom(1, 1), 1.25);
  assert.equal(stepTemplateZoom(1.25, 1), 1.5);
  assert.equal(stepTemplateZoom(0.913, -1), 0.75);
  assert.equal(stepTemplateZoom(0.75, -1), 0.5);
  assert.equal(stepTemplateZoom(0.5, -1), 0.4);
  assert.equal(stepTemplateZoom(1.6, 1), 1.6);
  assert.equal(stepTemplateZoom(0.4, -1), 0.4);
});

test("highlightTemplatePath: 点亮到入口的整条路径（含折叠卡）", () => {
  const graph = buildTemplateGraph(wideDetail({ hops: 2, perColumn: 6 }));
  const folded = foldTemplateGraph(graph);
  const target = folded.columns.find((column) => column.role === "target").cards[0];
  const highlight = highlightTemplatePath(folded, target.id);
  assert.ok(highlight.nodes.has(target.id));
  assert.ok(highlight.edges.size > 0);
  // 目标的上游是折叠卡：路径必须穿过它。
  const upstream = folded.edges.find((item) => item.target === target.id).source;
  assert.ok(highlight.nodes.has(upstream));
  // 路径必须一路走到入口列里的某张卡（可见成员或折叠卡）。
  const entryCards = folded.columns[0].cards.map((card) => card.id);
  assert.ok(entryCards.some((id) => highlight.nodes.has(id)));
  // 未知节点 → 空集合，不误点亮。
  const none = highlightTemplatePath(folded, "missing");
  assert.equal(none.nodes.size, 0);
  assert.equal(none.edges.size, 0);
});

/* ------------------------------------------------------------------ */
/* 6 跳大图：规模与确定性                                              */
/* ------------------------------------------------------------------ */

test("6 跳 × 20 成员：每列 ≤5 张卡、布局有界、重复调用结果一致", () => {
  const detailPayload = wideDetail({ hops: 6, perColumn: 20, offlineAt: 4 });
  const graph = buildTemplateGraph(detailPayload);
  const folded = foldTemplateGraph(graph);
  for (const column of folded.columns) {
    assert.ok(
      column.cards.length <= TEMPLATE_FOLD_LIMIT + 1,
      `第 ${column.seq} 列 ${column.cards.length} 张卡`,
    );
  }
  const layout = layoutTemplateGraph(folded);
  // 入口 + 5 个中间跳 + 目标 = 7 列，每列 ≤4 张 + 1 张折叠卡。
  assert.ok(layout.cards.length <= 7 * (TEMPLATE_FOLD_LIMIT + 1));
  assert.ok(layout.width > 0 && layout.height > 0);
  assert.ok(layout.edges.length > 0);
  const again = layoutTemplateGraph(foldTemplateGraph(buildTemplateGraph(detailPayload)));
  assert.deepEqual(again.cards, layout.cards);
  assert.deepEqual(again.edges, layout.edges);
  assert.equal(again.width, layout.width);
  assert.equal(again.height, layout.height);
  // 折叠卡标注最差状态含离线。
  const fold = layout.cards.find((card) => card.card.kind === "fold" && card.card.offlineHidden > 0);
  assert.ok(fold, "第 4 跳有离线的折叠卡");
  assert.equal(fold.card.status, "offline");
});

/* ------------------------------------------------------------------ */
/* 视口提示：右缘按卡片右边缘 / 下缘看卡片底边                          */
/* ------------------------------------------------------------------ */

/** 两列的手工布局：第 1 列卡片右边缘正好落在 x = 488。 */
function twoColumnLayout() {
  return {
    cards: [
      { column: 0, x: 24, y: 24, width: TEMPLATE_CARD_WIDTH, height: 64 },
      { column: 1, x: 296, y: 24, width: TEMPLATE_CARD_WIDTH, height: 64 },
    ],
    edges: [],
    columns: [],
    width: 488,
    height: 112,
  };
}

test("hiddenRightColumns: 半截露出的列计入，右边缘正好等于视口右缘不计", () => {
  const layout = twoColumnLayout();
  const atOrigin = { x: 0, y: 0, zoom: 1 };
  // 视口右缘 420：第 1 列（296–488）只露出半截 → 计入。
  assert.equal(
    hiddenRightColumns(layout, { width: 420, height: 300 }, atOrigin),
    1,
    "半截露出的列必须计入",
  );
  // 右边缘 488 正好等于视口右缘：看全了，不计（含 0.5px 取整容差）。
  assert.equal(
    hiddenRightColumns(layout, { width: 488, height: 300 }, atOrigin),
    0,
    "右边缘等于视口右缘时不计",
  );
  assert.equal(
    hiddenRightColumns(layout, { width: 487, height: 300 }, atOrigin),
    1,
    "真的被裁掉 1px 才提示",
  );
  // 视口比内容宽：没有隐藏列。
  assert.equal(
    hiddenRightColumns(layout, { width: 600, height: 300 }, atOrigin),
    0,
  );
  // 整体向左平移后，右缘换算到流坐标要跟着变。
  assert.equal(
    hiddenRightColumns(
      layout,
      { width: 488, height: 300 },
      { x: -120, y: 0, zoom: 1 },
    ),
    0,
    "平移到最右后不应再有提示",
  );
  // 缩小后内容变窄，右边缘跟着缩进。
  assert.equal(
    hiddenRightColumns(
      layout,
      { width: 400, height: 300 },
      { x: 0, y: 0, zoom: 0.5 },
    ),
    0,
    "缩放后按缩放后的右边缘判断",
  );
});

test("hiddenRightColumns: 真实布局里按半截列计数（旧口径会漏掉）", () => {
  const layout = layoutTemplateGraph(
    foldTemplateGraph(graphOf(wideDetail({ hops: 2, perColumn: 3 }))),
  );
  // 三列 x = 24 / 296 / 568，最后一列右边缘 760。
  assert.equal(layout.columns.length, 3);
  assert.equal(layout.columns[2].x, 568);
  assert.equal(layout.columns[2].x + TEMPLATE_CARD_WIDTH, 760);
  // 视口 700：最后一列只露出 568–700 这半截，必须计入。
  assert.equal(
    hiddenRightColumns(
      layout,
      { width: 700, height: 300 },
      { x: 0, y: 0, zoom: 1 },
    ),
    1,
    "半截露出的最后一列计入",
  );
  // 视口正好 760：右边缘贴住视口右缘，不计。
  assert.equal(
    hiddenRightColumns(
      layout,
      { width: 760, height: 300 },
      { x: 0, y: 0, zoom: 1 },
    ),
    0,
  );
});

test("hasHiddenContentBelow: 看卡片底边，不看布局尾部留白", () => {
  const layout = twoColumnLayout();
  const atOrigin = { x: 0, y: 0, zoom: 1 };
  // 卡片底边 88；视口高 120 → 都在视野内。
  assert.equal(
    hasHiddenContentBelow(layout, { width: 488, height: 120 }, atOrigin),
    false,
  );
  // 视口高 60 → 卡片底边 88 被裁。
  assert.equal(
    hasHiddenContentBelow(layout, { width: 488, height: 60 }, atOrigin),
    true,
  );
  // 底边正好等于画布下缘：算看全了。
  assert.equal(
    hasHiddenContentBelow(layout, { width: 488, height: 88 }, atOrigin),
    false,
  );
  // 平移到最下（y 为负）：底边换算到流坐标 200，卡片全在视野内。
  assert.equal(
    hasHiddenContentBelow(
      layout,
      { width: 488, height: 120 },
      { x: 0, y: -80, zoom: 1 },
    ),
    false,
  );
  // 布局高度含 24px 内边距：只有留白被裁不算「还有内容」。
  const padded = { ...layout, height: 168 };
  assert.equal(
    hasHiddenContentBelow(padded, { width: 488, height: 112 }, atOrigin),
    false,
    "只裁掉内边距时不提示",
  );
});

test("templatePanDuration: 减弱动效下平移瞬时（0ms），否则 220ms", () => {
  assert.equal(TEMPLATE_PAN_DURATION_MS, 220);
  assert.equal(templatePanDuration(false), 220);
  assert.equal(templatePanDuration(true), 0);
});

/* ------------------------------------------------------------------ */
/* 连线高亮：只点亮这一条到入口                                        */
/* ------------------------------------------------------------------ */

/** 目标 1.2.3.4 有两条兄弟入边（东京-01 / 东京-02）。 */
function siblingDetail() {
  return {
    template: { id: "tpl-sib", name: "兄弟入边", hops: 2 },
    nodes: [
      {
        seq: 0,
        role: "source",
        name: "香港入口",
        members: [member("香港-01", 2, 1)],
      },
      {
        seq: 1,
        role: "hop",
        name: "东京中转",
        members: [member("东京-01", 2, 1), member("东京-02", 1, 1)],
      },
      {
        seq: 2,
        role: "target",
        name: "目标",
        members: [
          member("1.2.3.4:443", 2, 1),
          member("5.6.7.8:443", 1, 1),
        ],
      },
    ],
    edges: [
      edge(0, "香港-01", 1, "东京-01", 2),
      edge(0, "香港-01", 1, "东京-02", 1),
      edge(1, "东京-01", 2, "1.2.3.4:443", 1),
      edge(1, "东京-02", 2, "1.2.3.4:443", 1),
      edge(1, "东京-01", 2, "5.6.7.8:443", 1),
    ],
    targets: [],
    users: [],
    series: [],
    strategies: [],
    unused_candidates: [],
  };
}

test("highlightTemplateEdgePath: 点亮该连线到入口，不含兄弟连线", () => {
  const folded = foldTemplateGraph(graphOf(siblingDetail()));
  const target = folded.columns
    .find((column) => column.role === "target")
    .cards.find((card) => card.name === "1.2.3.4:443");
  assert.ok(target, "目标卡存在");
  const incoming = folded.edges.filter((item) => item.target === target.id);
  assert.equal(incoming.length, 2, "目标应有两条兄弟入边");
  const chosen = incoming.find((item) => item.chains === 1);
  assert.ok(chosen, "选一条链数最少的入边");

  const highlight = highlightTemplateEdgePath(folded, chosen.id);
  // 连线自己 + 目标卡片。
  assert.ok(highlight.edges.has(chosen.id), "选中的连线必须点亮");
  assert.ok(highlight.nodes.has(target.id), "目标卡必须点亮");
  // 上游一路走到入口。
  assert.ok(highlight.nodes.has(chosen.source), "上游卡片必须点亮");
  const entry = folded.columns[0].cards[0];
  assert.ok(highlight.nodes.has(entry.id), "入口卡必须点亮");
  // 兄弟入边与另一个目标不点亮。
  const sibling = incoming.find((item) => item.id !== chosen.id);
  assert.equal(highlight.edges.has(sibling.id), false, "兄弟连线不应点亮");
  assert.equal(
    highlight.nodes.has(sibling.source),
    false,
    "兄弟连线的上游不应点亮",
  );
  const otherTarget = folded.columns
    .find((column) => column.role === "target")
    .cards.find((card) => card.id !== target.id);
  assert.equal(
    highlight.nodes.has(otherTarget.id),
    false,
    "另一个目标不应点亮",
  );
  // 未知连线 → 空集合，不误压暗整张图。
  const none = highlightTemplateEdgePath(folded, "missing");
  assert.equal(none.nodes.size, 0);
  assert.equal(none.edges.size, 0);
});

/* ------------------------------------------------------------------ */
/* 尺寸档：链路详情复用画布（紧凑档）                                  */
/* ------------------------------------------------------------------ */

test("TEMPLATE_METRICS 与历史常量逐项相等，模板默认尺寸不变", () => {
  assert.deepEqual(TEMPLATE_METRICS, {
    cardWidth: TEMPLATE_CARD_WIDTH,
    cardHeight: TEMPLATE_CARD_HEIGHT,
    columnGap: TEMPLATE_COLUMN_GAP,
    rowGap: TEMPLATE_ROW_GAP,
    padding: TEMPLATE_PADDING,
    columnHeaderHeight: TEMPLATE_COLUMN_HEADER_HEIGHT,
    pillWidth: TEMPLATE_PILL_WIDTH,
    pillHeight: 18,
    pillGap: 4,
    canvasMinHeight: TEMPLATE_CANVAS_MIN_HEIGHT,
    canvasMaxHeight: TEMPLATE_CANVAS_MAX_HEIGHT,
    canvasViewportRatio: 0.52,
    fitMinZoom: TEMPLATE_MIN_ZOOM,
    fitMaxZoom: TEMPLATE_FIT_MAX_ZOOM,
    edgeRadius: TEMPLATE_EDGE_RADIUS,
    mergedRailOffset: TEMPLATE_MERGED_RAIL_OFFSET,
    statusRailOffset: 10,
    edgeMinWidth: TEMPLATE_EDGE_MIN_WIDTH,
    edgeMaxWidth: TEMPLATE_EDGE_MAX_WIDTH,
    pulseWidthRatio: TEMPLATE_PULSE_WIDTH_RATIO,
  });
  // 不带 metrics 的旧调用必须和带 TEMPLATE_METRICS 完全一致。
  const folded = foldTemplateGraph(graphOf(detail()));
  const legacy = layoutTemplateGraph(folded);
  const explicit = layoutTemplateGraph(folded, { metrics: TEMPLATE_METRICS });
  assert.deepEqual(legacy.cards, explicit.cards);
  assert.deepEqual(legacy.edges, explicit.edges);
  assert.equal(legacy.width, explicit.width);
  assert.equal(legacy.height, explicit.height);
  assert.deepEqual(legacy.metrics, TEMPLATE_METRICS);
});

test("CHAIN_FLOW_METRICS: 卡片 136×60、列距 60、行距 12、padding 16、药丸 56×18", () => {
  assert.equal(CHAIN_FLOW_METRICS.cardWidth, 136);
  assert.equal(CHAIN_FLOW_METRICS.cardHeight, 60);
  assert.equal(CHAIN_FLOW_METRICS.columnGap, 60);
  assert.equal(CHAIN_FLOW_METRICS.rowGap, 12);
  assert.equal(CHAIN_FLOW_METRICS.padding, 16);
  assert.equal(CHAIN_FLOW_METRICS.columnHeaderHeight, 32);
  assert.equal(CHAIN_FLOW_METRICS.pillWidth, 56);
  assert.equal(CHAIN_FLOW_METRICS.pillHeight, 18);
  assert.equal(CHAIN_FLOW_METRICS.canvasMinHeight, 160);
  assert.equal(CHAIN_FLOW_METRICS.fitMinZoom, 0.9);
});

test("layoutTemplateGraph: 紧奏档尺寸全部取自 metrics，并回传 metrics", () => {
  const folded = foldTemplateGraph(graphOf(detail()));
  const layout = layoutTemplateGraph(folded, {
    metrics: CHAIN_FLOW_METRICS,
  });
  assert.deepEqual(layout.metrics, CHAIN_FLOW_METRICS);
  for (const card of layout.cards) {
    assert.equal(card.width, 136);
    assert.equal(card.height, 60);
  }
  // 列头 32px、内边距 16 → 卡片从 48 起；列 x 间距 136 + 60。
  assert.equal(layout.headers[0].y, 16);
  assert.equal(layout.headers[0].height, 32);
  assert.equal(layout.cards[0].y, 48);
  assert.equal(
    layout.cards.find((card) => card.column === 1).x -
      layout.cards.find((card) => card.column === 0).x,
    196,
  );
  assert.equal(
    layout.width,
    16 * 2 + layout.columns.length * 136 + (layout.columns.length - 1) * 60,
  );
  // 药丸碰撞盒跟随 56×18。
  const pill = layout.edges.find((edge) => edge.pill !== null)?.pill;
  assert.ok(pill);
  assert.equal(pill.width, 56);
  assert.equal(pill.height, 18);
});

test("layoutTemplateGraph: pulse / densePillLimit 开关", () => {
  const folded = foldTemplateGraph(graphOf(detail()));
  const pulsing = layoutTemplateGraph(folded);
  assert.ok(pulsing.edges.some((edge) => edge.pulse), "默认仍有模板脉冲");
  const still = layoutTemplateGraph(folded, { pulse: false });
  assert.ok(still.edges.every((edge) => !edge.pulse));

  // limit=0 让每条竖线上的药丸都算密集；null 表示永不隐藏（链路档）。
  const dense = layoutTemplateGraph(folded, { densePillLimit: 0 });
  assert.ok(
    dense.edges
      .filter((edge) => edge.pill !== null)
      .every((edge) => edge.pillDense),
  );
  const none = layoutTemplateGraph(folded, { densePillLimit: null });
  assert.ok(none.edges.every((edge) => !edge.pillDense));
});

test("bounds / canvasHeight / fit 跟随紧凑 metrics，fit 下限 0.9", () => {
  const folded = foldTemplateGraph(graphOf(detail()));
  const layout = layoutTemplateGraph(folded, {
    metrics: CHAIN_FLOW_METRICS,
  });
  const bounds = templateContentBounds(layout);
  assert.equal(bounds.width, layout.width);
  assert.equal(bounds.height, layout.height);
  assert.equal(bounds.x, layout.cards[0].x - 16);
  assert.equal(bounds.y, 0);

  assert.equal(templateCanvasHeight(1000, 1000, CHAIN_FLOW_METRICS), 520);
  assert.equal(templateCanvasHeight(100, 1000, CHAIN_FLOW_METRICS), 160);
  assert.equal(templateCanvasHeight(900, 0, CHAIN_FLOW_METRICS), 0);

  const huge = {
    cards: [],
    edges: [],
    columns: [],
    width: 4000,
    height: 4000,
    metrics: CHAIN_FLOW_METRICS,
  };
  assert.equal(
    templateFitZoom(huge, { width: 400, height: 400 }),
    CHAIN_FLOW_METRICS.fitMinZoom,
  );
  assert.equal(
    fitViewport(huge, { width: 400, height: 400 }).zoom,
    0.9,
  );
  // 内容很小时仍然封顶 100%。
  const tiny = { ...huge, width: 100, height: 50 };
  assert.equal(templateFitZoom(tiny, { width: 800, height: 400 }), 1);
});

/* ------------------------------------------------------------------ */
/* 可选字段透传                                                        */
/* ------------------------------------------------------------------ */

function passthroughGraph() {
  const base = {
    chains: 0,
    users: 0,
    offline: false,
    degraded: false,
    upstreamIds: [],
  };
  return {
    hops: 1,
    targetSeq: 2,
    columns: [
      {
        seq: 0,
        role: "entry",
        title: "香港入口",
        memberCount: 2,
        members: [
          {
            ...base,
            id: "a",
            name: "香港-01",
            seq: 0,
            role: "entry",
            status: "online",
            tag: "preferred",
            group: "香港入口",
            memberCount: 2,
            lossPct: 0.5,
            estimated: true,
            note: "卡说明",
          },
        ],
      },
      {
        seq: 2,
        role: "target",
        title: undefined,
        members: [
          {
            ...base,
            id: "t",
            name: "",
            seq: 2,
            role: "target",
            status: "unknown",
            upstreamIds: ["a"],
          },
        ],
      },
    ],
    edges: [
      {
        id: "e1",
        source: "a",
        target: "t",
        sourceSeq: 0,
        targetSeq: 2,
        chains: 0,
        users: 0,
        p50Ms: 20,
        lastP50Ms: null,
        unavailable: false,
        degraded: false,
        lossPct: 0.5,
        estimated: true,
        note: "段说明",
      },
    ],
    unused: [],
    usedMemberCount: 1,
    targetCount: 1,
    empty: false,
  };
}

test("tag / group / title / memberCount / lossPct / estimated / note 透传到布局", () => {
  const folded = foldTemplateGraph(passthroughGraph());
  assert.equal(folded.columns[0].title, "香港入口");
  const card = folded.columns[0].cards[0];
  assert.equal(card.tag, "preferred");
  assert.equal(card.group, "香港入口");
  assert.equal(card.memberCount, 2);
  assert.equal(card.lossPct, 0.5);
  assert.equal(card.estimated, true);
  assert.equal(card.note, "卡说明");

  const layout = layoutTemplateGraph(folded, {
    metrics: CHAIN_FLOW_METRICS,
  });
  assert.equal(layout.headers[0].title, "香港入口");
  assert.equal(layout.headers[0].memberCount, 2);
  assert.equal(layout.edges[0].lossPct, 0.5);
  assert.equal(layout.edges[0].estimated, true);
  assert.equal(layout.edges[0].note, "段说明");
});

/* ------------------------------------------------------------------ */
/* 首选路径 / 载体边                                                   */
/* ------------------------------------------------------------------ */

function pathGraph({ missingEdge = false, noPreferred = false } = {}) {
  const base = {
    chains: 0,
    users: 0,
    offline: false,
    degraded: false,
    upstreamIds: [],
  };
  const card = (id, tag, name = id) => ({
    ...base,
    id,
    name,
    seq: id === "t" ? 2 : 0,
    role: id === "t" ? "target" : "entry",
    status: "online",
    ...(tag === undefined ? {} : { tag }),
  });
  return {
    hops: 1,
    targetSeq: 2,
    columns: [
      {
        seq: 0,
        role: "entry",
        cards: [card("a", noPreferred ? undefined : "preferred"), card("b", "candidate")],
        total: 2,
      },
      { seq: 2, role: "target", cards: [card("t", undefined)], total: 1 },
    ],
    edges: missingEdge
      ? []
      : [
          {
            id: "e1",
            source: "a",
            target: "t",
            sourceSeq: 0,
            targetSeq: 2,
            chains: 0,
            users: 0,
            p50Ms: 20,
            lastP50Ms: null,
            unavailable: false,
            degraded: false,
            merged: false,
            paths: 1,
          },
        ],
    unused: [],
    empty: false,
    maxChains: 1,
    hiddenMembers: 0,
    hiddenTargets: 0,
    foldColumns: [],
  };
}

test("preferredTemplatePath: 每列单卡或 preferred，逐段相连", () => {
  const path = preferredTemplatePath(pathGraph());
  assert.deepEqual([...path.nodes].sort(), ["a", "t"]);
  assert.deepEqual([...path.edges], ["e1"]);
  // 多卡列没有 preferred：定不出就返回 null，不猜。
  assert.equal(preferredTemplatePath(pathGraph({ noPreferred: true })), null);
  // 首选卡之间没有连线：不点亮一条不存在的路径。
  assert.equal(preferredTemplatePath(pathGraph({ missingEdge: true })), null);
});

test("carrierTemplateEdges: 相邻列第一张非折叠卡之间的连线", () => {
  const folded = {
    hops: 1,
    targetSeq: 2,
    columns: [
      {
        seq: 0,
        role: "entry",
        cards: [
          {
            id: "f0",
            kind: "fold",
            role: "fold",
            name: "",
            seq: 0,
            status: "online",
            chains: 0,
            users: 0,
            hidden: 5,
            offlineHidden: 0,
            hiddenChains: 0,
            hiddenUsers: 0,
            hiddenWorst: null,
            topNames: [],
            upstreamId: null,
          },
          {
            id: "a",
            kind: "member",
            role: "entry",
            name: "A",
            seq: 0,
            status: "online",
            chains: 0,
            users: 0,
            hidden: 0,
            offlineHidden: 0,
            hiddenChains: 0,
            hiddenUsers: 0,
            hiddenWorst: null,
            topNames: [],
            upstreamId: null,
          },
        ],
        total: 6,
      },
      {
        seq: 2,
        role: "target",
        cards: [
          {
            id: "t",
            kind: "target",
            role: "target",
            name: "",
            seq: 2,
            status: "unknown",
            chains: 0,
            users: 0,
            hidden: 0,
            offlineHidden: 0,
            hiddenChains: 0,
            hiddenUsers: 0,
            hiddenWorst: null,
            topNames: [],
            upstreamId: "a",
          },
        ],
        total: 1,
      },
    ],
    edges: [
      {
        id: "fold-edge",
        source: "f0",
        target: "t",
        sourceSeq: 0,
        targetSeq: 2,
        chains: 0,
        users: 0,
        p50Ms: null,
        lastP50Ms: null,
        unavailable: false,
        degraded: false,
        merged: true,
        paths: 5,
      },
      {
        id: "a-t",
        source: "a",
        target: "t",
        sourceSeq: 0,
        targetSeq: 2,
        chains: 0,
        users: 0,
        p50Ms: 20,
        lastP50Ms: null,
        unavailable: false,
        degraded: false,
        merged: false,
        paths: 1,
      },
    ],
    unused: [],
    empty: false,
    maxChains: 1,
    hiddenMembers: 5,
    hiddenTargets: 0,
    foldColumns: [0],
  };
  assert.deepEqual([...carrierTemplateEdges(folded)], ["a-t"]);
});
