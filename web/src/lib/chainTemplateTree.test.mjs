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
