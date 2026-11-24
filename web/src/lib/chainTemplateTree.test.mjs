import assert from "node:assert/strict";
import test from "node:test";
import { normalizeChainTemplateDetail } from "./chainTemplateInsight.ts";
import {
  CHAIN_TEMPLATE_TARGET_LIMIT,
  chainTemplateTree,
  chainTemplateTreeNodeMeta,
} from "./chainTemplateTree.ts";
import { buildTreeChartLayout, treeHighlightPath } from "./treeChart.ts";

function member(name, chains, users, status = "online") {
  return { server_id: name, name, status, chains, users };
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

/** 3 跳：SOURCE → 东京（两条）→ 洛杉矶（离线）→ 两个目标。 */
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
        members: [{ name: "1.2.3.4:443", chains: 2, users: 2 }],
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
    // 新契约：未被任何链用到的候选只出现在这里，不再混进 nodes。
    unused_candidates: [
      { seq: 1, server_id: "东京-备用", name: "东京-备用", status: "online" },
    ],
    ...overrides,
  };
}

function labels() {
  return {
    root: "入口",
    targets: (count) => `+${count} 个目标`,
  };
}

function flatten(node, out = []) {
  out.push(node);
  for (const child of node.children ?? []) flatten(child, out);
  return out;
}

function kindCounts(model) {
  const counts = { root: 0, member: 0, target: 0, fold: 0 };
  for (const node of flatten(model.data)) {
    const meta = chainTemplateTreeNodeMeta(node);
    if (meta !== null) counts[meta.kind] += 1;
  }
  return counts;
}

test("树结构：入口聚合根 → 真实跳成员 → 目标叶子", () => {
  const model = chainTemplateTree(normalizeChainTemplateDetail(detail()), {
    labels: labels(),
  });
  assert.equal(model.data.id, "root");
  assert.equal(model.data.name, "入口");
  assert.equal(model.usedMemberCount, 3);
  assert.equal(model.targetCount, 2);
  assert.equal(model.visibleTargetCount, 2);
  assert.equal(model.hiddenTargetCount, 0);
  assert.equal(model.foldTargets, false);

  const counts = kindCounts(model);
  assert.equal(counts.root, 1);
  assert.equal(counts.member, 3);
  assert.equal(counts.target, 2, "叶子数 = 目标数（≤8）");
  assert.equal(counts.fold, 0);

  // 未被使用的候选成员不画进树。
  const names = flatten(model.data).map((node) => node.name);
  assert.equal(names.includes("东京-备用"), false);
  assert.equal(model.unusedMembers.length, 1);
  assert.equal(model.unusedMembers[0].name, "东京-备用");

  // 目标叶子挂在最后一跳下面（真实路径里 5.6.7.8 没有边，回退到最后一跳）。
  const rootMeta = chainTemplateTreeNodeMeta(model.data);
  assert.equal(rootMeta.chains, 5);
  assert.equal(rootMeta.status, "online");
});

test("未使用候选只读契约的 unused_candidates；缺失时为空", () => {
  // 旧契约：nodes 里还混着 chains = 0 的候选，但没有 unused_candidates 字段。
  const legacy = detail();
  legacy.unused_candidates = undefined;
  const legacyModel = chainTemplateTree(
    normalizeChainTemplateDetail(legacy),
    { labels: labels() },
  );
  assert.deepEqual(legacyModel.unusedMembers, []);

  const fromContract = detail({
    unused_candidates: [
      { seq: 2, server_id: "srv-7", name: "洛杉矶-02", status: "abnormal" },
    ],
  });
  const model = chainTemplateTree(normalizeChainTemplateDetail(fromContract), {
    labels: labels(),
  });
  assert.deepEqual(
    model.unusedMembers.map((row) => [row.seq, row.name, row.status]),
    [[2, "洛杉矶-02", "degraded"]],
  );
  // 候选不画进树。
  const names = flatten(model.data).map((node) => node.name);
  assert.equal(names.includes("洛杉矶-02"), false);
});

test("只画 chains > 0 的成员与边；边标签 P50 缺失显示 —", () => {
  const payload = detail();
  payload.edges.push(edge(1, "东京-01", 2, "洛杉矶-01", 0, 999));
  const model = chainTemplateTree(normalizeChainTemplateDetail(payload), {
    labels: labels(),
  });
  assert.equal(
    model.links.filter((link) => link.value === 0).length,
    0,
  );
  assert.ok(model.links.some((link) => link.label === "15.5 ms"));
  assert.ok(model.links.some((link) => link.label === "—"));
});

test("边宽随 chains：布局里链数大的路径更粗", () => {
  const model = chainTemplateTree(normalizeChainTemplateDetail(detail()), {
    labels: labels(),
  });
  const layout = buildTreeChartLayout(model.data, { links: model.links });
  const thick = layout.edges.find((item) => item.value === 4);
  const thin = layout.edges.find((item) => item.value === 1);
  assert.ok(thick);
  assert.ok(thin);
  assert.ok(thick.width > thin.width);
});

test("离线成员：红色状态、该路径不可用且无脉冲，可用路径仍脉冲", () => {
  const model = chainTemplateTree(normalizeChainTemplateDetail(detail()), {
    labels: labels(),
  });
  assert.equal(model.hasOffline, true);
  const offline = model.links.filter((link) => link.unavailable);
  assert.ok(offline.length >= 3);
  assert.ok(offline.every((link) => link.pulse === false));
  assert.ok(model.pulseCount >= 1);
  const layout = buildTreeChartLayout(model.data, { links: model.links });
  const offlineNode = layout.nodes.find((node) => node.node.name === "洛杉矶-01");
  assert.equal(offlineNode.node.meta.offline, true);
  assert.equal(offlineNode.hasOutgoing, true);
});

test("hover 高亮路径：离线目标到根仍是整条链", () => {
  const model = chainTemplateTree(normalizeChainTemplateDetail(detail()), {
    labels: labels(),
  });
  const layout = buildTreeChartLayout(model.data, { links: model.links });
  const target = layout.nodes.find((node) => node.node.name === "1.2.3.4:443");
  const highlight = treeHighlightPath(layout, { nodeId: target.id });
  assert.deepEqual(
    [...highlight.nodeIds].sort(),
    ["root", "m:1:东京-01", "m:2:洛杉矶-01", target.id].sort(),
  );
  assert.equal(highlight.edgeIds.size, 3);
});

test("目标 > 8：默认折叠成 +N 个目标，展开后叶子数 = 目标数", () => {
  const payload = detail({ nodes: detail().nodes.filter((node) => node.role !== "target") });
  payload.targets = Array.from({ length: 12 }, (_, index) => ({
    host: `10.0.0.${index + 1}`,
    port: 443,
    chains: 12 - index,
    users: [],
  }));
  payload.edges = payload.edges.filter((item) => item.to.seq !== 3);
  for (let index = 0; index < payload.targets.length; index += 1) {
    payload.edges.push(
      edge(2, "洛杉矶-01", 3, `10.0.0.${index + 1}:443`, 12 - index, 30),
    );
  }
  const collapsed = chainTemplateTree(normalizeChainTemplateDetail(payload), {
    labels: labels(),
  });
  assert.equal(CHAIN_TEMPLATE_TARGET_LIMIT, 8);
  assert.equal(collapsed.foldTargets, true);
  assert.equal(collapsed.visibleTargetCount, 8);
  assert.equal(collapsed.hiddenTargetCount, 4);
  const fold = flatten(collapsed.data).find(
    (node) => chainTemplateTreeNodeMeta(node)?.kind === "fold",
  );
  assert.equal(fold.name, "+4 个目标");
  assert.equal(kindCounts(collapsed).target, 8);

  const expanded = chainTemplateTree(normalizeChainTemplateDetail(payload), {
    labels: labels(),
    targetsExpanded: true,
  });
  assert.equal(expanded.foldTargets, false);
  assert.equal(expanded.visibleTargetCount, 12);
  assert.equal(kindCounts(expanded).target, 12);
});

test("大图 20 成员 × 6 跳：O(n) 布局、无 NaN、目标仍是叶子点", () => {
  const nodes = [];
  const edges = [];
  for (let seq = 0; seq <= 6; seq += 1) {
    const role = seq === 0 ? "source" : seq === 6 ? "target" : "hop";
    nodes.push({
      seq,
      role,
      name: `第 ${seq} 跳`,
      members:
        role === "target"
          ? [{ name: "10.0.0.1:443", chains: 20, users: 20 }]
          : Array.from({ length: 20 }, (_, index) =>
              member(`s-${seq}-${index}`, 20 - index, 10),
            ),
    });
  }
  for (let seq = 1; seq <= 6; seq += 1) {
    for (let index = 0; index < 20; index += 1) {
      edges.push(
        edge(
          seq - 1,
          `s-${seq - 1}-${index}`,
          seq,
          seq === 6 ? "10.0.0.1:443" : `s-${seq}-${index}`,
          20 - index,
          10 + seq,
        ),
      );
    }
  }
  const model = chainTemplateTree(
    normalizeChainTemplateDetail({
      template: { id: "big", name: "大模板", hops: 6 },
      nodes,
      edges,
      targets: [{ host: "10.0.0.1", port: 443, chains: 20 }],
      users: [],
      series: [],
      strategies: [],
    }),
    { labels: labels() },
  );
  assert.equal(model.targetCount, 1);
  assert.equal(model.visibleTargetCount, 1);
  assert.equal(kindCounts(model).target, 1);
  assert.equal(model.links.length, 120);
  const layout = buildTreeChartLayout(model.data, { links: model.links });
  assert.equal(layout.nodes.length, 1 + 20 * 5 + 1);
  assert.ok(layout.width > 6 * 148);
  for (const edgeItem of layout.edges) {
    assert.ok(Number.isFinite(edgeItem.labelX));
    assert.ok(edgeItem.width >= 1 && edgeItem.width <= 6);
  }
});

/* ------------------------------------------------------------------ */
/* F1 折叠按父节点分组：每个父节点各自保留至少 1 个目标                 */
/* ------------------------------------------------------------------ */

/** 两跳：入口 → p1 / p2 → 各自的目标。 */
function multiParentDetail({ p1Targets, p2Targets }) {
  const all = [...p1Targets, ...p2Targets];
  const targets = all.map(([label, chains]) => {
    const [host, port] = label.split(":");
    return { host, port: Number(port), chains, users: [] };
  });
  const edges = [
    edge(0, "入口-01", 1, "p1", 20, 10),
    edge(0, "入口-01", 1, "p2", 20, 10),
  ];
  for (const [label, chains] of p1Targets) {
    edges.push(edge(1, "p1", 2, label, chains, 30));
  }
  for (const [label, chains] of p2Targets) {
    edges.push(edge(1, "p2", 2, label, chains, 30));
  }
  return {
    template: { id: "tpl-multi", name: "多父模板", hops: 2 },
    nodes: [
      { seq: 0, role: "source", name: "入口", members: [member("入口-01", 40, 5)] },
      {
        seq: 1,
        role: "hop",
        name: "第一跳",
        members: [member("p1", 20, 3), member("p2", 20, 2)],
      },
      { seq: 2, role: "target", name: "目标", members: [] },
    ],
    edges,
    targets,
    users: [],
    series: [],
    strategies: [],
  };
}

function childrenOf(model, id) {
  const node = flatten(model.data).find((item) => item.id === id);
  assert.ok(node, `node ${id} exists`);
  return node.children ?? [];
}

function flattenNodes(model) {
  return flatten(model.data);
}

function targetChildrenOf(model, name) {
  const node = flattenNodes(model).find((item) => item.name === name);
  assert.ok(node, `node ${name}`);
  return (node.children ?? []).filter(
    (child) => chainTemplateTreeNodeMeta(child)?.kind === "target",
  );
}

function foldChildrenOf(model, name) {
  const node = flattenNodes(model).find((item) => item.name === name);
  assert.ok(node, `node ${name}`);
  return (node.children ?? []).filter(
    (child) => chainTemplateTreeNodeMeta(child)?.kind === "fold",
  );
}

test("折叠按父节点分组：p1 链数全低也不至于 0 子节点，各家 +N 只连自家", () => {
  // p2 的 9 个目标链数都高于 p1：旧的全局 slice 会把 p1 全折叠，
  // 并让 p1 变成挂着别家目标的死端。
  const p1Targets = Array.from({ length: 9 }, (_, index) => [
    `10.1.0.${index + 1}:443`,
    1,
  ]);
  const p2Targets = Array.from({ length: 9 }, (_, index) => [
    `10.2.0.${index + 1}:443`,
    100 - index,
  ]);
  const model = chainTemplateTree(
    normalizeChainTemplateDetail(multiParentDetail({ p1Targets, p2Targets })),
    { labels: labels() },
  );

  // 每个父节点都保留目标，且各自折叠多余的 1 个。
  assert.equal(targetChildrenOf(model, "p1").length, 8);
  assert.equal(targetChildrenOf(model, "p2").length, 8);
  const p1Fold = foldChildrenOf(model, "p1");
  const p2Fold = foldChildrenOf(model, "p2");
  assert.equal(p1Fold.length, 1);
  assert.equal(p2Fold.length, 1);
  assert.equal(chainTemplateTreeNodeMeta(p1Fold[0]).hiddenTargets, 1);
  assert.equal(chainTemplateTreeNodeMeta(p2Fold[0]).hiddenTargets, 1);
  // 折叠节点记录自己的父节点，展开时可以只展开这一组。
  assert.equal(chainTemplateTreeNodeMeta(p1Fold[0]).foldParent, "m:1:p1");
  assert.equal(chainTemplateTreeNodeMeta(p2Fold[0]).foldParent, "m:1:p2");

  // 折叠节点只连到对应父节点：一条边、source 就是父节点。
  for (const [parent, fold] of [
    ["m:1:p1", p1Fold[0]],
    ["m:1:p2", p2Fold[0]],
  ]) {
    const incoming = model.links.filter((link) => link.target === fold.id);
    assert.equal(incoming.length, 1);
    assert.equal(incoming[0].source, parent);
  }

  // 恒等式：目标总数 = 可见 + 折叠；叶子数 = 可见目标 + 折叠节点。
  assert.equal(model.targetCount, 18);
  assert.equal(
    model.visibleTargetCount + model.hiddenTargetCount,
    model.targetCount,
  );
  const layout = buildTreeChartLayout(model.data, { links: model.links });
  const foldCount = flattenNodes(model).filter(
    (node) => chainTemplateTreeNodeMeta(node)?.kind === "fold",
  ).length;
  assert.equal(foldCount, 2);
  assert.equal(
    layout.nodes.length,
    1 + model.usedMemberCount + model.visibleTargetCount + foldCount,
  );
  assert.equal(
    layout.nodes.filter((node) => node.leaf).length,
    model.visibleTargetCount + foldCount,
  );
  // 树边 = 节点数 - 1（含折叠节点），没有孤儿、没有重复父节点。
  const treeEdges = layout.edges.filter((item) => item.tree);
  assert.equal(treeEdges.length, layout.nodes.length - 1);
  const parents = new Set(treeEdges.map((item) => item.target));
  assert.equal(parents.size, treeEdges.length, "每个非根节点只有一条树边");
});

test("折叠按父节点分组：p1/p2 交错排序时各家的目标不会串门", () => {
  const p1Targets = [];
  const p2Targets = [];
  for (let index = 0; index < 9; index += 1) {
    // 交错：p1 略高、p2 略低，全局 slice 会把两边混在一起。
    p1Targets.push([`10.1.0.${index + 1}:443`, 50 - index]);
    p2Targets.push([`10.2.0.${index + 1}:443`, 49 - index]);
  }
  const model = chainTemplateTree(
    normalizeChainTemplateDetail(multiParentDetail({ p1Targets, p2Targets })),
    { labels: labels() },
  );
  const p1Visible = targetChildrenOf(model, "p1").map((node) => node.name);
  const p2Visible = targetChildrenOf(model, "p2").map((node) => node.name);
  assert.ok(p1Visible.every((name) => name.startsWith("10.1.0.")));
  assert.ok(p2Visible.every((name) => name.startsWith("10.2.0.")));
  assert.equal(p1Visible.length, 8);
  assert.equal(p2Visible.length, 8);
  // 折叠数字也是各家的：各 1 个。
  assert.equal(model.hiddenTargetCount, 2);
  assert.equal(model.foldCount, 2);
});

test("只折叠超限的父节点：另一个父节点目标不多时保持全展开", () => {
  const p1Targets = Array.from({ length: 10 }, (_, index) => [
    `10.1.0.${index + 1}:443`,
    10 - index,
  ]);
  const p2Targets = [["10.2.0.1:443", 5]];
  const model = chainTemplateTree(
    normalizeChainTemplateDetail(multiParentDetail({ p1Targets, p2Targets })),
    { labels: labels() },
  );
  assert.equal(targetChildrenOf(model, "p1").length, 8);
  assert.equal(foldChildrenOf(model, "p1").length, 1);
  assert.equal(targetChildrenOf(model, "p2").length, 1);
  assert.equal(foldChildrenOf(model, "p2").length, 0);
  assert.equal(model.foldTargets, true);
  assert.equal(model.foldCount, 1);
});

test("可以只展开某一组折叠：展开后该组叶子数恢复，其它组仍折叠", () => {
  const p1Targets = Array.from({ length: 10 }, (_, index) => [
    `10.1.0.${index + 1}:443`,
    10 - index,
  ]);
  const p2Targets = Array.from({ length: 10 }, (_, index) => [
    `10.2.0.${index + 1}:443`,
    10 - index,
  ]);
  const detail = normalizeChainTemplateDetail(
    multiParentDetail({ p1Targets, p2Targets }),
  );
  const expanded = chainTemplateTree(detail, {
    labels: labels(),
    expandedParents: new Set(["m:1:p1"]),
  });
  assert.equal(targetChildrenOf(expanded, "p1").length, 10);
  assert.equal(foldChildrenOf(expanded, "p1").length, 0);
  assert.equal(targetChildrenOf(expanded, "p2").length, 8);
  assert.equal(foldChildrenOf(expanded, "p2").length, 1);
  assert.equal(expanded.foldTargets, true);
  assert.equal(expanded.foldCount, 1);

  const all = chainTemplateTree(detail, {
    labels: labels(),
    targetsExpanded: true,
  });
  assert.equal(all.foldCount, 0);
  assert.equal(all.visibleTargetCount, 20);
  assert.equal(all.foldTargets, false);
});

/* ------------------------------------------------------------------ */
/* F2/F7 离线与降级：不可用边标签不再冒充当前 P50                       */
/* ------------------------------------------------------------------ */

test("离线边：标签为 —，最近已知 P50 单独保留，不进 pulse", () => {
  const model = chainTemplateTree(normalizeChainTemplateDetail(detail()), {
    labels: labels(),
  });
  const offline = model.links.filter((link) => link.unavailable);
  assert.ok(offline.length >= 1);
  for (const link of offline) {
    assert.equal(link.label, "—");
    assert.equal(link.pulse, false);
    // 历史 P50 仍然保留，但只作为「最近已知」给 tooltip，不是当前值。
    assert.ok(link.lastP50Ms === null || link.lastP50Ms > 0);
  }
  const withHistory = offline.find((link) => link.lastP50Ms !== null);
  assert.ok(withHistory, "至少有一条离线边保留历史 P50");
  // 在线边不带 lastP50Ms，避免把它当成「历史」。
  const online = model.links.filter((link) => !link.unavailable);
  assert.ok(online.every((link) => link.lastP50Ms === null));
});

test("降级成员（abnormal / no_data）：边标黄不脉冲，状态归一为 degraded", () => {
  const payload = detail();
  payload.nodes = payload.nodes.map((node) => ({
    ...node,
    members: node.members.map((item) =>
      item.name === "洛杉矶-01" ? { ...item, status: "abnormal" } : item,
    ),
  }));
  payload.edges = payload.edges.filter((item) => item.to.member !== "1.2.3.4:443");
  payload.nodes = payload.nodes.filter((node) => node.role !== "target");
  payload.targets = [];
  const model = chainTemplateTree(normalizeChainTemplateDetail(payload), {
    labels: labels(),
  });
  const degraded = model.links.filter((link) => link.degraded);
  assert.ok(degraded.length >= 1);
  assert.ok(degraded.every((link) => link.pulse === false));
  assert.ok(degraded.every((link) => link.unavailable === false));
  // 数值仍然给出：降级不是不可用，只是不当成健康路径脉冲。
  assert.ok(degraded.some((link) => link.label !== "—"));

  const layout = buildTreeChartLayout(model.data, { links: model.links });
  const node = layout.nodes.find((item) => item.node.name === "洛杉矶-01");
  const meta = chainTemplateTreeNodeMeta(node.node);
  assert.equal(meta.status, "degraded");
  assert.equal(meta.offline, false);

  payload.nodes = payload.nodes.map((node) => ({
    ...node,
    members: node.members.map((item) =>
      item.name === "洛杉矶-01" ? { ...item, status: "no_data" } : item,
    ),
  }));
  const noData = chainTemplateTree(normalizeChainTemplateDetail(payload), {
    labels: labels(),
  });
  assert.ok(noData.links.some((link) => link.degraded));
});

/* ------------------------------------------------------------------ */
/* F9 成员去重：serverId 优先，缺失时用名字                             */
/* ------------------------------------------------------------------ */

test("同一台服务器两条成员记录（同名不同 server_id）合并成一个节点", () => {
  const payload = {
    template: { id: "tpl-dup", name: "重复成员", hops: 1 },
    nodes: [
      {
        seq: 0,
        role: "source",
        name: "入口",
        members: [
          { server_id: "srv-1", name: "香港-01", status: "online", chains: 3, users: 2 },
          // 同一台机器换了显示名：去重键用 serverId，只画一个节点。
          { server_id: "srv-1", name: "香港-01-renamed", status: "online", chains: 0, users: 0 },
        ],
      },
      {
        seq: 1,
        role: "target",
        name: "目标",
        members: [{ name: "1.2.3.4:443", chains: 3, users: 2 }],
      },
    ],
    edges: [
      {
        seq: 1,
        from: { seq: 0, member: "香港-01-renamed" },
        to: { seq: 1, member: "1.2.3.4:443" },
        chains: 3,
        users: 2,
        p50_ms: 12,
        loss_pct: 0,
      },
    ],
    targets: [{ host: "1.2.3.4", port: 443, chains: 3, users: [] }],
    users: [],
    series: [],
    strategies: [],
  };
  const model = chainTemplateTree(normalizeChainTemplateDetail(payload), {
    labels: labels(),
  });
  // 源成员只在根节点聚合，第一跳没有成员；目标挂在根下。
  assert.equal(model.targetCount, 1);
  assert.equal(model.visibleTargetCount, 1);
  const names = flattenNodes(model).map((node) => node.name);
  assert.equal(
    names.filter((name) => name.startsWith("香港-01")).length,
    0,
    "源成员不画成中间节点",
  );

  const hopDup = {
    ...payload,
    template: { id: "tpl-dup2", name: "重复跳成员", hops: 2 },
    nodes: [
      {
        seq: 0,
        role: "source",
        name: "入口",
        members: [{ server_id: "srv-0", name: "入口-01", status: "online", chains: 3, users: 2 }],
      },
      {
        seq: 1,
        role: "hop",
        name: "第一跳",
        members: [
          { server_id: "srv-1", name: "东京-01", status: "online", chains: 3, users: 2 },
          { server_id: "srv-1", name: "东京-01-old", status: "online", chains: 0, users: 0 },
          { name: "无ID-01", status: "online", chains: 0, users: 0 },
          { name: "无ID-01", status: "online", chains: 0, users: 0 },
        ],
      },
      {
        seq: 2,
        role: "target",
        name: "目标",
        members: [{ name: "1.2.3.4:443", chains: 3, users: 2 }],
      },
    ],
    edges: [
      {
        seq: 1,
        from: { seq: 0, member: "入口-01" },
        to: { seq: 1, member: "东京-01-old" },
        chains: 3,
        users: 2,
        p50_ms: 12,
        loss_pct: 0,
      },
      {
        seq: 2,
        from: { seq: 1, member: "东京-01" },
        to: { seq: 2, member: "1.2.3.4:443" },
        chains: 3,
        users: 2,
        p50_ms: 20,
        loss_pct: 0,
      },
    ],
    targets: [{ host: "1.2.3.4", port: 443, chains: 3, users: [] }],
    // 候选里同名重复的记录由归一化按名字去重，未使用列表也只出现一次。
    unused_candidates: [
      { seq: 1, name: "无ID-01", status: "online" },
      { seq: 1, name: "无ID-01", status: "online" },
    ],
  };
  const dupModel = chainTemplateTree(normalizeChainTemplateDetail(hopDup), {
    labels: labels(),
  });
  assert.equal(dupModel.usedMemberCount, 1, "srv-1 只画一个节点");
  const hopNames = flattenNodes(dupModel).map((node) => node.name);
  assert.equal(hopNames.filter((name) => name.startsWith("东京-01")).length, 1);
  assert.equal(
    dupModel.unusedMembers.filter((row) => row.name === "无ID-01").length,
    1,
  );
  // 边用旧名字引用同一台机器，仍然连到去重后的节点。
  const ids = new Set(flattenNodes(dupModel).map((node) => node.id));
  assert.ok(dupModel.links.every((link) => ids.has(link.source) && ids.has(link.target)));
  assert.ok(!flattenNodes(dupModel).some((node) => node.name === "东京-01-old"));
});

/* ------------------------------------------------------------------ */
/* F9 0 链拓扑：空态而不是孤立 root                                     */
/* ------------------------------------------------------------------ */

test("0 链模板：模型标记为空，拓扑不画孤立根节点", () => {
  const payload = detail();
  payload.edges = payload.edges.map((item) => ({ ...item, chains: 0 }));
  payload.nodes = payload.nodes.map((node) => ({
    ...node,
    members: node.members.map((item) => ({ ...item, chains: 0 })),
  }));
  payload.targets = [];
  const model = chainTemplateTree(normalizeChainTemplateDetail(payload), {
    labels: labels(),
  });
  assert.equal(model.isEmpty, true);
  assert.equal(model.targetCount, 0);
  assert.equal((model.data.children ?? []).length, 0);
  assert.equal(model.links.length, 0);

  const withTraffic = chainTemplateTree(normalizeChainTemplateDetail(detail()), {
    labels: labels(),
  });
  assert.equal(withTraffic.isEmpty, false);
});
