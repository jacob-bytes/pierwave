import assert from "node:assert/strict";
import test from "node:test";
import { normalizeChainTemplateDetail } from "./chainTemplateInsight.ts";
import {
  TEMPLATE_CARD_HEIGHT,
  TEMPLATE_CARD_WIDTH,
  TEMPLATE_COLUMN_GAP,
  TEMPLATE_FOLD_LIMIT,
  TEMPLATE_INITIAL_MAX_ZOOM,
  TEMPLATE_INITIAL_MIN_ZOOM,
  TEMPLATE_MAX_ZOOM,
  TEMPLATE_MERGED_RAIL_OFFSET,
  TEMPLATE_MIN_ZOOM,
  TEMPLATE_STATUS_RAIL_OFFSET,
  TEMPLATE_PADDING,
  TEMPLATE_PULSE_LIMIT,
  TEMPLATE_ROW_GAP,
  buildTemplateGraph,
  clampTemplateZoom,
  fitViewport,
  foldTemplateGraph,
  highlightTemplatePath,
  initialViewport,
  layoutTemplateGraph,
  spreadPills,
  stepTemplateZoom,
  templateEdgePath,
  templateEdgeWidth,
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
  // 空图仍然给出合法尺寸 / 视口，组件不必再判空。
  assert.ok(layout.width > 0);
  assert.ok(layout.height > 0);
  const view = initialViewport(layout, { width: 800, height: 400 });
  assert.equal(view.zoom, TEMPLATE_INITIAL_MAX_ZOOM);
  assert.ok(view.zoom >= TEMPLATE_INITIAL_MIN_ZOOM);
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
    assert.ok(item.width >= 1.5 && item.width <= 6);
  }
  // 动画边上限：同一时刻只有 Top N 条在动。
  assert.ok(layout.edges.filter((item) => item.pulse).length <= TEMPLATE_PULSE_LIMIT);
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
    assert.equal(pill.width, 40);
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

test("spreadPills: 同一落点的药丸被竖向摊开，互不重叠", () => {
  const pills = [
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

test("layoutTemplateGraph: 合并虚线的竖脊与正常连线错开，仍在列间空隙内", () => {
  const graph = buildTemplateGraph(wideDetail({ hops: 2, perColumn: 6 }));
  const folded = foldTemplateGraph(graph);
  const layout = layoutTemplateGraph(folded);
  const merged = layout.edges.filter((item) => item.merged);
  const normal = layout.edges.filter((item) => !item.merged);
  assert.ok(merged.length > 0 && normal.length > 0);
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

test("templateEdgeWidth: 链数越大越粗，有上下限", () => {
  assert.equal(templateEdgeWidth(0, 10), 1.5);
  assert.equal(templateEdgeWidth(10, 10), 6);
  assert.equal(templateEdgeWidth(5, 10), 3.75);
  assert.ok(templateEdgeWidth(3, 10) < templateEdgeWidth(8, 10));
  assert.equal(templateEdgeWidth(5, 0), 1.5);
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

test("initialViewport: 0.4–1.6 内，首屏缩放 max(0.9, fit) 且不超过 1", () => {
  // 内容很大：fit 很小 → 保底 0.9，入口列仍在左上。
  const big = initialViewport(LAYOUT, { width: 800, height: 400 });
  assert.equal(big.zoom, 0.9);
  assert.ok(big.zoom >= 0.9 && big.zoom <= 1);
  assert.equal(big.x, 0);
  assert.equal(big.y, 0);

  // 内容刚好放得下：fit 0.8 → 0.9。
  const snug = initialViewport(
    { ...LAYOUT, width: 1000, height: 500 },
    { width: 800, height: 400 },
  );
  assert.equal(snug.zoom, 0.9);

  // 内容很小：fit 4 → 封顶 1，居中。
  const small = initialViewport(
    { ...LAYOUT, width: 200, height: 100 },
    { width: 800, height: 400 },
  );
  assert.equal(small.zoom, 1);
  assert.equal(small.x, (800 - 200) / 2);
  assert.equal(small.y, (400 - 100) / 2);

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

test("fitViewport: 能低于 0.9，最低 0.4，内容小于视口时不放大超过 1", () => {
  const huge = fitViewport({ ...LAYOUT, width: 4000, height: 4000 }, {
    width: 400,
    height: 400,
  });
  assert.equal(huge.zoom, TEMPLATE_MIN_ZOOM);
  const tiny = fitViewport({ ...LAYOUT, width: 100, height: 50 }, {
    width: 800,
    height: 400,
  });
  assert.equal(tiny.zoom, 1);
  const medium = fitViewport({ ...LAYOUT, width: 1000, height: 500 }, {
    width: 600,
    height: 300,
  });
  assert.equal(medium.zoom, 0.6);
  assert.equal(medium.x, (600 - 600) / 2);
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
