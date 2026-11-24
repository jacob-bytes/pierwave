import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTreeChartLayout,
  treeCurvePath,
  treeEdgeOpacity,
  treeEdgeWidth,
  treeHighlightPath,
  treeLabelWidth,
  treeNodePathToRoot,
} from "./treeChart.ts";

function fixture() {
  return {
    id: "root",
    name: "入口",
    value: 10,
    children: [
      {
        id: "a",
        name: "甲",
        value: 6,
        children: [
          { id: "a1", name: "甲-1", value: 4 },
          { id: "a2", name: "甲-2", value: 2 },
        ],
      },
      {
        id: "b",
        name: "乙",
        value: 4,
        children: [{ id: "b1", name: "乙-1", value: 3 }],
      },
    ],
  };
}

test("曲线是三次贝塞尔 path：以 M 开头且含 C", () => {
  const path = treeCurvePath(10, 20, 110, 60);
  assert.match(path, /^M 10 20 C /);
  assert.ok(path.includes(" C "));
  const layout = buildTreeChartLayout(fixture());
  for (const edge of layout.edges) {
    assert.match(edge.path, /^M /);
    assert.ok(edge.path.includes(" C "), edge.path);
  }
});

test("层级 x 随深度递增，节点宽固定、标签不缩放", () => {
  const layout = buildTreeChartLayout(fixture());
  const xByDepth = new Map();
  for (const node of layout.nodes) {
    if (!xByDepth.has(node.depth)) xByDepth.set(node.depth, node.x);
  }
  assert.ok(xByDepth.get(0) < xByDepth.get(1));
  assert.ok(xByDepth.get(1) < xByDepth.get(2));
  // 同一层的 x 完全一致；列宽只由标签长度决定，不是百分比。
  const depth1 = layout.nodes.filter((node) => node.depth === 1);
  assert.equal(new Set(depth1.map((node) => node.x)).size, 1);
  assert.ok(layout.width > 3 * 148);
  assert.ok(treeLabelWidth("香港-01", 11) > treeLabelWidth("HK", 11));
});

test("边宽 ∝ 链数：同一份布局里链数大的边更粗，范围 1–6", () => {
  const links = [
    { id: "l1", source: "root", target: "a", value: 8 },
    { id: "l2", source: "root", target: "b", value: 2 },
  ];
  const layout = buildTreeChartLayout(fixture(), { links });
  const thick = layout.edges.find((edge) => edge.id === "l1");
  const thin = layout.edges.find((edge) => edge.id === "l2");
  assert.equal(thick.width, 6);
  assert.ok(thin.width < thick.width);
  assert.equal(treeEdgeWidth(0, 10), 1);
  assert.equal(treeEdgeWidth(10, 10), 6);
  assert.equal(treeEdgeWidth(20, 10), 6);
  assert.ok(treeEdgeOpacity(10, 10) > treeEdgeOpacity(1, 10));
});

test("同一父节点的多条边标签横向/纵向错开，不叠在一个点", () => {
  const layout = buildTreeChartLayout({
    id: "root",
    name: "入口",
    children: [
      { id: "c1", name: "一", value: 3 },
      { id: "c2", name: "二", value: 2 },
      { id: "c3", name: "三", value: 1 },
      { id: "c4", name: "四", value: 1 },
    ],
  });
  const labels = layout.edges.map((edge) => `${edge.labelX}:${edge.labelY}`);
  assert.equal(new Set(labels).size, 4);
});

test("折叠：隐藏子树、父节点记 +N，布局不再包含隐藏节点", () => {
  const layout = buildTreeChartLayout(fixture(), {
    collapsedIds: new Set(["a"]),
  });
  const parent = layout.byId.get("a");
  assert.equal(parent.collapsed, true);
  assert.equal(parent.hiddenCount, 2);
  assert.deepEqual(parent.childIds, []);
  assert.equal(layout.byId.has("a1"), false);
  assert.equal(layout.byId.has("a2"), false);
});

test("hover 路径：节点到根整条路径（含根）与边都被点亮", () => {
  const layout = buildTreeChartLayout(fixture());
  const fromLeaf = treeHighlightPath(layout, { nodeId: "a1" });
  assert.deepEqual(
    [...fromLeaf.nodeIds].sort(),
    ["a", "a1", "root"].sort(),
  );
  assert.equal(fromLeaf.edgeIds.size, 2);
  assert.deepEqual(treeNodePathToRoot(layout, "a1"), ["a1", "a", "root"]);
  const edge = layout.edges.find((item) => item.target === "a1");
  const fromEdge = treeHighlightPath(layout, { edgeId: edge.id });
  assert.equal(fromEdge.nodeIds.size, 3);
  assert.ok(fromEdge.edgeIds.has(edge.id));
});

test("交叉边也能点亮两端到根的整条路径", () => {
  const layout = buildTreeChartLayout(fixture(), {
    links: [{ id: "cross", source: "b", target: "a1", value: 1 }],
  });
  const cross = layout.edges.find((item) => item.id === "cross");
  assert.ok(cross);
  const highlight = treeHighlightPath(layout, { edgeId: "cross" });
  assert.deepEqual(
    [...highlight.nodeIds].sort(),
    ["a", "a1", "b", "root"].sort(),
  );
  assert.ok(highlight.edgeIds.has("cross"));
});

test("大图 O(n)：7 层 × 20 节点全部有有限坐标，边数保持 O(n)", () => {
  let node = { id: "root", name: "入口", value: 20 };
  let parent = node;
  for (let depth = 1; depth <= 6; depth += 1) {
    parent.children = Array.from({ length: 20 }, (_, index) => ({
      id: `n-${depth}-${index}`,
      name: `成员 ${depth}-${index}`,
      value: 20 - index,
    }));
    parent = parent.children[0];
  }
  const layout = buildTreeChartLayout(node);
  assert.equal(layout.nodes.length, 121);
  assert.equal(layout.edges.length, 120);
  assert.ok(layout.width > 7 * 148);
  for (const item of layout.nodes) {
    assert.ok(Number.isFinite(item.x));
    assert.ok(Number.isFinite(item.y));
  }
  for (const edge of layout.edges) {
    assert.ok(Number.isFinite(edge.x1) && Number.isFinite(edge.y2));
    assert.ok(edge.width >= 1 && edge.width <= 6);
  }
});

test("叶子行垂直均匀铺开，父节点居中于首尾子节点之间", () => {
  const layout = buildTreeChartLayout(fixture());
  const a1 = layout.byId.get("a1");
  const a2 = layout.byId.get("a2");
  assert.ok(a2.y - a1.y >= 30);
  const a = layout.byId.get("a");
  assert.equal(a.y, (a1.y + a2.y) / 2);
});
