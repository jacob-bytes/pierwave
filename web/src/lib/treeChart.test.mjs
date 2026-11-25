import assert from "node:assert/strict";
import test from "node:test";
import {
  TREE_DENSE_FANOUT,
  TREE_LABEL_MAX_CHARS,
  buildTreeChartLayout,
  placeTreeTooltip,
  selectPulseEdgeIds,
  treeBoundsOverlap,
  treeChartContentBounds,
  treeCurvePath,
  treeEdgeOpacity,
  treeEdgeWidth,
  treeHighlightPath,
  treeLabelWidth,
  treeNodeActivation,
  treeNodeDotBounds,
  treeNodeLabelBounds,
  treeNodePathToRoot,
  truncateTreeLabel,
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
  // 列距固定：两层之间至少隔着 minColumnWidth，不随容器缩放。
  assert.ok(xByDepth.get(2) - xByDepth.get(0) >= 2 * 148);
  assert.ok(treeLabelWidth("香港-01", 11) > treeLabelWidth("HK", 11));
});

/* ------------------------------------------------------------------ */
/* 宽度：max(内容, 容器) + 内容居中；标签按侧避让圆点                    */
/* ------------------------------------------------------------------ */

/** 短树：入口 → 1 个中间跳 → 2 个目标（链路模板的 1 跳最小形态）。 */
function shortTree() {
  return {
    id: "root",
    name: "入口",
    value: 3,
    children: [
      {
        id: "hop-1",
        name: "香港-01",
        value: 3,
        children: [
          { id: "t-1", name: "1.2.3.4:443", value: 2 },
          { id: "t-2", name: "5.6.7.8:8443", value: 1 },
        ],
      },
    ],
  };
}

/** 长树：6 跳、每层 3 个成员（18 个叶子，内容比 390 宽得多）。 */
function longTree() {
  const root = { id: "root", name: "入口", value: 3 };
  let parent = root;
  for (let depth = 1; depth <= 6; depth += 1) {
    parent.children = Array.from({ length: 3 }, (_, index) => ({
      id: `n-${depth}-${index}`,
      name: `成员-${depth}-${index}`,
      value: 3 - index,
    }));
    parent = parent.children[0];
  }
  return root;
}

/** 所有标签的包围盒都不与任何圆点相交（含根标签、折叠 +N）。 */
function assertLabelsClearDots(layout) {
  for (const node of layout.nodes) {
    const label = treeNodeLabelBounds(node);
    for (const other of layout.nodes) {
      assert.equal(
        treeBoundsOverlap(label, treeNodeDotBounds(other)),
        false,
        `${node.id} label overlaps ${other.id} dot`,
      );
    }
  }
}

test("短树在可用宽度内居中：左右留白相等，宽度取容器宽", () => {
  const layout = buildTreeChartLayout(shortTree(), { availableWidth: 960 });
  assert.equal(layout.width, 960);
  const bounds = treeChartContentBounds(layout);
  const leftSpace = bounds.left;
  const rightSpace = layout.width - bounds.right;
  assert.ok(
    Math.abs(leftSpace - rightSpace) <= 2,
    `left ${leftSpace} right ${rightSpace}`,
  );
});

test("折叠根的 +N 标签计入包围盒：仍居中且不压圆点", () => {
  const layout = buildTreeChartLayout(shortTree(), {
    collapsedIds: new Set(["root"]),
    availableWidth: 960,
  });
  const bounds = treeChartContentBounds(layout);
  assert.equal(layout.width, 960);
  assert.ok(
    Math.abs(bounds.left - (layout.width - bounds.right)) <= 2,
    `left ${bounds.left} right ${layout.width - bounds.right}`,
  );
  const root = layout.byId.get("root");
  assert.ok(root.labelExtent > root.labelWidth);
  assertLabelsClearDots(layout);
});

test("长树：内容超出容器时保持自然宽度，横向滚动而不是压缩列距", () => {
  const natural = buildTreeChartLayout(longTree());
  const layout = buildTreeChartLayout(longTree(), { availableWidth: 390 });
  assert.equal(layout.width, natural.width);
  assert.ok(layout.width > 390, `natural width ${layout.width}`);
  // 根标签仍从左侧 padding 开始，不会因为居中把根推出首屏。
  const bounds = treeChartContentBounds(layout);
  assert.ok(bounds.left >= 0 && bounds.left < 20, `left ${bounds.left}`);
});

test("容器宽度变化（390 → 1440）后重新居中，390 下首屏有根与第一跳", () => {
  const narrow = buildTreeChartLayout(shortTree(), { availableWidth: 390 });
  const wide = buildTreeChartLayout(shortTree(), { availableWidth: 1440 });
  assert.equal(wide.width, 1440);
  assert.ok(narrow.width > 390, "390 下横向滚动");
  for (const layout of [narrow, wide]) {
    const bounds = treeChartContentBounds(layout);
    assert.ok(
      Math.abs(bounds.left - (layout.width - bounds.right)) <= 2,
      `centered at ${layout.width}`,
    );
  }
  const root = narrow.byId.get("root");
  const firstHop = narrow.nodes.find((node) => node.depth === 1);
  assert.ok(root.x + root.dotRadius < 120, `root x ${root.x}`);
  assert.ok(firstHop.labelX < 390, `first hop label ${firstHop.labelX}`);
});

test("根标签在圆点左侧右对齐，叶子 / 中间层在右侧，间距 8–10px", () => {
  const layout = buildTreeChartLayout(shortTree());
  const root = layout.byId.get("root");
  assert.equal(root.labelAnchor, "end");
  const rootGap = root.x - root.dotRadius - root.labelX;
  assert.ok(rootGap >= 8 && rootGap <= 10, `root gap ${rootGap}`);
  // 标签右边缘严格在圆点左边缘左侧：不压住根圆点。
  assert.ok(root.labelX < root.x - root.dotRadius);

  const middle = layout.byId.get("hop-1");
  assert.equal(middle.labelAnchor, "start");
  const middleGap = middle.labelX - (middle.x + middle.dotRadius);
  assert.ok(middleGap >= 8 && middleGap <= 10, `middle gap ${middleGap}`);

  const leaf = layout.byId.get("t-1");
  assert.equal(leaf.labelAnchor, "start");
  const leafGap = leaf.labelX - (leaf.x + leaf.dotRadius);
  assert.ok(leafGap >= 8 && leafGap <= 10, `leaf gap ${leafGap}`);
});

test("所有标签与圆点的包围盒不相交（短树 / 折叠 +N / 长树 / 居中后）", () => {
  assertLabelsClearDots(buildTreeChartLayout(shortTree()));
  assertLabelsClearDots(buildTreeChartLayout(fixture()));
  assertLabelsClearDots(
    buildTreeChartLayout(shortTree(), { collapsedIds: new Set(["root"]) }),
  );
  assertLabelsClearDots(
    buildTreeChartLayout(fixture(), { collapsedIds: new Set(["a"]) }),
  );
  assertLabelsClearDots(buildTreeChartLayout(longTree()));
  assertLabelsClearDots(
    buildTreeChartLayout(shortTree(), { availableWidth: 1440 }),
  );
});

test("边宽 ∝ 链数：同一份布局里链数大的边更粗，范围 1.5–6", () => {
  const links = [
    { id: "l1", source: "root", target: "a", value: 8 },
    { id: "l2", source: "root", target: "b", value: 2 },
  ];
  const layout = buildTreeChartLayout(fixture(), { links });
  const thick = layout.edges.find((edge) => edge.id === "l1");
  const thin = layout.edges.find((edge) => edge.id === "l2");
  assert.equal(thick.width, 6);
  assert.ok(thin.width < thick.width);
  assert.equal(treeEdgeWidth(0, 10), 1.5);
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
  assert.ok(layout.width > 6 * 148);
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

/* ------------------------------------------------------------------ */
/* F8 对比度：边透明度下限 0.7、最细 1.5px                              */
/* ------------------------------------------------------------------ */

test("边对比度：透明度下限 0.7、宽度下限 1.5，弱化也不隐形", () => {
  for (const value of [0, 0.5, 1, 3, 10]) {
    assert.ok(treeEdgeOpacity(value, 10) >= 0.7, `opacity ${value}`);
    assert.ok(treeEdgeWidth(value, 10) >= 1.5, `width ${value}`);
  }
  assert.ok(treeEdgeOpacity(10, 10) <= 1);
  assert.equal(treeEdgeWidth(10, 10), 6);
  // 缺失 / 非有限值也走同一档，不允许出现 0.1 这种看不见的边。
  assert.ok(treeEdgeOpacity(Number.NaN, 10) >= 0.7);
  assert.ok(treeEdgeWidth(Number.NaN, 10) >= 1.5);
});

/* ------------------------------------------------------------------ */
/* F8 长标签：~24 字符截断 + …，完整名留给 tooltip / aria               */
/* ------------------------------------------------------------------ */

test("长标签截断到 24 字符并带省略号，布局宽度按截断后的文本算", () => {
  assert.equal(TREE_LABEL_MAX_CHARS, 24);
  assert.equal(truncateTreeLabel("香港-01"), "香港-01");
  const long = "这是一个非常非常长的节点标签名字，用来测试截断行为是否正确";
  const truncated = truncateTreeLabel(long);
  assert.equal([...truncated].length, TREE_LABEL_MAX_CHARS + 1);
  assert.ok(truncated.endsWith("…"));
  assert.ok(!truncated.includes(long));
  // 24 个 ASCII 字符正好不被截断。
  const exact = "a".repeat(TREE_LABEL_MAX_CHARS);
  assert.equal(truncateTreeLabel(exact), exact);
  assert.equal(truncateTreeLabel("a".repeat(TREE_LABEL_MAX_CHARS + 1)).length, TREE_LABEL_MAX_CHARS + 1);

  const layout = buildTreeChartLayout({
    id: "root",
    name: "入口",
    children: [{ id: "long", name: long, value: 1 }],
  });
  const node = layout.byId.get("long");
  assert.equal(node.displayName, truncated);
  assert.equal(node.node.name, long, "原始名字不丢，tooltip / aria 用完整名");
  assert.equal(node.labelWidth, treeLabelWidth(truncated, 11));
});

/* ------------------------------------------------------------------ */
/* F5 命中区 ≥44×44：行高抬到 44，命中矩形 44×44 不互相覆盖             */
/* ------------------------------------------------------------------ */

test("节点行高 ≥44，命中区 44×44 时上下两行不重叠", () => {
  const layout = buildTreeChartLayout(fixture());
  const rows = layout.nodes
    .filter((node) => node.leaf)
    .map((node) => node.y)
    .sort((a, b) => a - b);
  for (let index = 1; index < rows.length; index += 1) {
    assert.ok(rows[index] - rows[index - 1] >= 44, `${rows[index]} gap`);
  }
});

/* ------------------------------------------------------------------ */
/* F4 脉冲：只给 Top N 条路径加动画                                     */
/* ------------------------------------------------------------------ */

test("脉冲并发上限：只取 Top 10 条可用路径，按链数降序", () => {
  const edges = Array.from({ length: 18 }, (_, index) => ({
    id: `e-${index}`,
    value: index + 1,
    pulse: true,
    unavailable: false,
    degraded: false,
  }));
  const selected = selectPulseEdgeIds(edges);
  assert.equal(selected.size, 10);
  assert.ok(selected.has("e-17"));
  assert.ok(selected.has("e-8"));
  assert.equal(selected.has("e-7"), false);

  const none = selectPulseEdgeIds([
    { id: "off", value: 9, pulse: true, unavailable: true, degraded: false },
    { id: "deg", value: 8, pulse: true, unavailable: false, degraded: true },
    { id: "quiet", value: 7, pulse: false, unavailable: false, degraded: false },
  ]);
  assert.equal(none.size, 0);
  assert.equal(selectPulseEdgeIds(edges, 3).size, 3);
  assert.equal(selectPulseEdgeIds([], 10).size, 0);
});

/* ------------------------------------------------------------------ */
/* F3 tooltip：实测尺寸 + 视口夹紧，顶部翻到下方                        */
/* ------------------------------------------------------------------ */

test("tooltip 1440 首行节点：上方放不下时翻到锚点下方", () => {
  const placement = placeTreeTooltip({
    anchorX: 60,
    anchorY: 34,
    width: 240,
    height: 92,
    visibleLeft: 0,
    visibleTop: 0,
    visibleWidth: 720,
    visibleHeight: 600,
  });
  assert.equal(placement.below, true);
  assert.equal(placement.y, 42);
  assert.ok(placement.x >= 8, "左侧夹紧，不越过可见区");
  assert.equal(placement.clampedX, true);

  // 节点有 44px 命中区：翻到下方时从命中区下沿让开，不盖住节点本身。
  const withNode = placeTreeTooltip({
    anchorX: 200,
    anchorY: 34,
    anchorHeight: 44,
    width: 240,
    height: 92,
    visibleLeft: 0,
    visibleTop: 0,
    visibleWidth: 720,
    visibleHeight: 600,
  });
  assert.equal(withNode.below, true);
  assert.equal(withNode.y, 34 + 22 + 8);
  assert.ok(withNode.y >= 34 + 44 / 2, "tooltip 不压住节点命中区");
});

test("tooltip 390 滚到末端：横向夹回可见窗口，不压到滚动裁切边", () => {
  const visibleLeft = 300;
  const visibleWidth = 390;
  const placement = placeTreeTooltip({
    anchorX: 690,
    anchorY: 220,
    width: 256,
    height: 96,
    visibleLeft,
    visibleTop: 0,
    visibleWidth,
    visibleHeight: 520,
  });
  assert.equal(placement.clampedX, true);
  assert.ok(placement.x >= visibleLeft + 8);
  assert.ok(placement.x + 256 <= visibleLeft + visibleWidth - 8);
  // 竖直方向上方有空间，保持在上方（锚点 - 间距 - 实测高度）。
  assert.equal(placement.below, false);
  assert.equal(placement.y, 220 - 8 - 96);
});

test("tooltip 键盘 focus 在底部：夹紧到可见区，不越过下边", () => {
  const placement = placeTreeTooltip({
    anchorX: 200,
    anchorY: 380,
    width: 200,
    height: 120,
    visibleLeft: 0,
    visibleTop: 0,
    visibleWidth: 600,
    visibleHeight: 400,
  });
  assert.equal(placement.below, false);
  assert.ok(placement.y >= 8);
  assert.ok(placement.y + 120 <= 400 - 8);

  // 视口比 tooltip 还矮时贴顶，避免负偏移被裁掉。
  const tiny = placeTreeTooltip({
    anchorX: 100,
    anchorY: 300,
    width: 200,
    height: 500,
    visibleLeft: 0,
    visibleTop: 0,
    visibleWidth: 200,
    visibleHeight: 400,
  });
  assert.equal(tiny.y, 8);
  assert.equal(tiny.clampedY, true);
});

/* ------------------------------------------------------------------ */
/* F5 390 首点选中、再点折叠                                            */
/* ------------------------------------------------------------------ */

test("触点设备：首点只选中（显示 tooltip），同节点再点才折叠", () => {
  assert.equal(
    treeNodeActivation({ hoverCapable: true, armedId: null, nodeId: "a" }),
    "toggle",
  );
  assert.equal(
    treeNodeActivation({ hoverCapable: false, armedId: null, nodeId: "a" }),
    "reveal",
  );
  assert.equal(
    treeNodeActivation({ hoverCapable: false, armedId: "a", nodeId: "a" }),
    "toggle",
  );
  assert.equal(
    treeNodeActivation({ hoverCapable: false, armedId: "a", nodeId: "b" }),
    "reveal",
  );
});

/* ------------------------------------------------------------------ */
/* F6 hover：包含所有 incoming 交叉边及其 source 的根路径（防环）        */
/* ------------------------------------------------------------------ */

test("hover 节点：合并所有 incoming 交叉边与 source 的根路径，环路不死循环", () => {
  const layout = buildTreeChartLayout(fixture(), {
    links: [
      { id: "cross-in", source: "b", target: "a1", value: 1 },
      { id: "cross-back", source: "a1", target: "b", value: 1 },
    ],
  });
  const highlight = treeHighlightPath(layout, { nodeId: "a1" });
  assert.ok(highlight.nodeIds.has("b"), "cross-in 的 source 也在路径里");
  assert.ok(highlight.edgeIds.has("cross-in"));
  assert.ok(highlight.edgeIds.has("cross-back") === false, "出向交叉边不反向追");
  // 反向追上来的 a1 → b 不会把 a1 的父链无限展开。
  assert.equal(highlight.nodeIds.has("a"), true);
  assert.ok(highlight.nodeIds.size <= layout.nodes.length);
  assert.ok(highlight.edgeIds.size <= layout.edges.length);
});

/* ------------------------------------------------------------------ */
/* F7 degraded / F2 unavailable 边的元数据传递                          */
/* ------------------------------------------------------------------ */

test("布局边带上 degraded / lastP50Ms，不可用边不再 pulse", () => {
  const layout = buildTreeChartLayout(
    {
      id: "root",
      name: "入口",
      children: [
        { id: "a", name: "甲", value: 3 },
        { id: "b", name: "乙", value: 2 },
      ],
    },
    {
      links: [
        {
          id: "l-a",
          source: "root",
          target: "a",
          value: 3,
          label: "—",
          unavailable: true,
          lastP50Ms: 96,
        },
        {
          id: "l-b",
          source: "root",
          target: "b",
          value: 2,
          degraded: true,
          label: "12 ms",
        },
      ],
    },
  );
  const a = layout.edges.find((edge) => edge.id === "l-a");
  const b = layout.edges.find((edge) => edge.id === "l-b");
  assert.equal(a.unavailable, true);
  assert.equal(a.pulse, false);
  assert.equal(a.lastP50Ms, 96);
  assert.equal(a.label, "—");
  assert.equal(b.degraded, true);
  assert.equal(b.pulse, false);
  assert.equal(b.lastP50Ms, null);
});

/* ------------------------------------------------------------------ */
/* F8 密集扇出：超过 6 条同源边，P50 只在 hover 时显示                  */
/* ------------------------------------------------------------------ */

test("密集扇出标记：同源 >6 条边的标签默认收起，阈值常量固定", () => {
  assert.equal(TREE_DENSE_FANOUT, 6);
  const fanout = (count) =>
    buildTreeChartLayout({
      id: "root",
      name: "入口",
      children: Array.from({ length: count }, (_, index) => ({
        id: `c-${index}`,
        name: `目标 ${index}`,
        value: 1,
      })),
    }).edges;
  assert.equal(fanout(6).every((edge) => edge.dense === false), true);
  assert.equal(fanout(7).every((edge) => edge.dense === true), true);
  // 边标签位置仍然算出来：hover 时直接复用，不需要二次布局。
  assert.ok(fanout(7).every((edge) => Number.isFinite(edge.labelX)));
});
