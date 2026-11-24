import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function read(relative) {
  return readFileSync(
    fileURLToPath(new URL(`../${relative}`, import.meta.url)),
    "utf8",
  );
}

test("chain sparkline positions points and the last dot by timestamp", () => {
  const source = read("components/overview/ChainLatencyChart.tsx");
  assert.match(source, /chainPointX/);
  assert.match(source, /chainSeriesWindow/);
  // 末点圆点与 active 线都必须用 ts 换算，不能再用 index / (length - 1)。
  assert.match(source, /xOf\(points\[lastIndex\]\.ts\)/);
  assert.doesNotMatch(source, /lastIndex \/ Math\.max\(1, points\.length - 1\)/);
  assert.doesNotMatch(source, /\(index \/ \(points\.length - 1\)\) \* VIEW_WIDTH/);
  // 切时窗后旧 active 下标可能越界，取点时必须容错。
  assert.match(source, /active < points\.length/);
});

test("chain sparkline exposes group + img roles, focus ring and a live tooltip", () => {
  const source = read("components/overview/ChainLatencyChart.tsx");
  assert.match(source, /role="group"/);
  assert.match(source, /role="img"/);
  assert.match(source, /focus-visible:ring-2/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /data-chain-sparkline-tooltip/);
});

test("both recharts views offer an off-by-default, scrollable table view", () => {
  const charts = [
    {
      file: "components/overview/ChainLatencyTrendChart.tsx",
      table: "data-chain-trend-table",
      minWidth: "min-w-[560px]",
    },
    {
      file: "components/overview/ChainSegmentTrendChart.tsx",
      table: "data-chain-segment-table",
      minWidth: "min-w-[520px]",
    },
  ];
  for (const chart of charts) {
    const source = read(chart.file);
    assert.match(source, /useState\(false\)/, `${chart.file} defaults to chart`);
    assert.match(source, /data-chain-table-toggle/);
    assert.match(source, /aria-pressed=\{tableView\}/);
    assert.match(source, new RegExp(chart.table));
    assert.match(source, /overflow-auto/);
    assert.match(source, new RegExp(chart.minWidth.replace(/[[\]]/g, "\\$&")));
    assert.match(source, /<table/);
  }
});

test("legend buttons keep a 24px touch target", () => {
  for (const file of [
    "components/overview/ChainLatencyTrendChart.tsx",
    "components/overview/ChainSegmentTrendChart.tsx",
  ]) {
    assert.match(read(file), /min-h-6/, `${file} legend must be >=24px`);
  }
});

test("chain rows keep the shared KPI tones and a slow badge", () => {
  const source = read("components/overview/ChainLatencyList.tsx");
  assert.match(source, /summaryDeltaTone/);
  assert.match(source, /worstHopTone/);
  assert.match(source, /data-chain-slow-badge/);
  assert.match(source, /chainStatus\(chain\)/);
  assert.doesNotMatch(source, /deltaMs > 0\s*\?/, "positive delta is not warning");
});

test("chain deep-link open uses replace, leaving the view clears the param", () => {
  const view = read("components/overview/ChainLatencyView.tsx");
  const start = view.indexOf("function openChain(");
  assert.ok(start >= 0);
  const end = view.indexOf("function closeChain(", start);
  const body = view.slice(start, end);
  assert.match(body, /\{ replace: true \}/);
  assert.match(read("lib/overviewViews.ts"), /next\.delete\("chain"\)/);
});

test("OverviewChainHealth contract types cover the current backend fields", () => {
  const api = read("lib/api.ts");
  const start = api.indexOf("export interface OverviewChainHealthPoint");
  const end = api.indexOf("export interface OverviewChainHealthResponse");
  assert.ok(start >= 0 && end > start);
  const block = api.slice(start, end);
  for (const field of [
    "loss_pct",
    "loss_partial",
    "loss_samples",
    "series",
    "entry",
    "exit",
    "nodes",
    "attempts",
    "failures",
    "address_source",
  ]) {
    assert.match(block, new RegExp(`\\b${field}\\??:`), `missing ${field}`);
  }
});

test("dead chainLatency i18n keys are gone from both dictionaries", async () => {
  const [{ default: zh }, { default: en }] = await Promise.all([
    import("../i18n/zh-CN.ts"),
    import("../i18n/en.ts"),
  ]);
  const dead = [
    "title",
    "statusNormal",
    "currentP50",
    "notFoundTitle",
    "notFoundDesc",
    "backToList",
    "loss",
    "segmentDelta",
    "contribution",
    "segmentTrendAria",
    "segmentTrendEmpty",
  ];
  for (const key of dead) {
    assert.equal(zh.overview.chainLatency[key], undefined, `zh ${key}`);
    assert.equal(en.overview.chainLatency[key], undefined, `en ${key}`);
  }
  // P1-4 / P1-5 新用到的键必须两边都有。
  for (const key of ["statusSlow", "tableView", "chartView", "colTime"]) {
    assert.equal(typeof zh.overview.chainLatency[key], "string", `zh ${key}`);
    assert.equal(typeof en.overview.chainLatency[key], "string", `en ${key}`);
  }
});

test("chainHealth no longer exports the dead chainLatestP50 alias", () => {
  assert.doesNotMatch(read("lib/chainHealth.ts"), /export function chainLatestP50/);
});

test("topology fills the card and labels latency/loss around a centered line", () => {
  const source = read("components/overview/ChainLatencyDetail.tsx");
  // 节点高度随成员数变化（56 / 72 / 88），所以行用 items-center 让连接线
  // 与每个节点的高度中心对齐，而不是把矮节点顶到行首。
  assert.match(source, /flex w-full min-w-max items-center/);
  assert.match(source, /data-chain-topology-node/);
  assert.match(source, /data-chain-topology-edge/);
  assert.match(source, /data-chain-topology-edge-latency/);
  assert.match(source, /data-chain-topology-edge-loss/);
  assert.match(source, /data-chain-topology-edge-line/);
  assert.match(source, /top-1\/2/);
  assert.match(source, /formatLossPct/);
  assert.match(source, /border-dashed/);
  assert.match(source, /h-14/);
  // 线上时延 / 线下丢包必须贴着连接线并水平居中，而不是落在边块上下缘。
  assert.match(source, /calc\(50% - 3px\)/);
  assert.match(source, /calc\(50% \+ 3px\)/);
  assert.match(source, /left-1\/2 max-w-full -translate-x-1\/2/);
});

test("the diagnosis bar uses primary instead of warning", () => {
  const source = read("components/overview/ChainLatencyDetail.tsx");
  const start = source.indexOf("function DiagnosisBlock");
  const end = source.indexOf("function TopologyNode", start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /border-primary\/30 bg-primary\/10 text-foreground/);
  assert.doesNotMatch(block, /warning/);
});

test("topology nodes carry SOURCE/HOP/TARGET labels and a breathing status dot", () => {
  const source = read("components/overview/ChainLatencyDetail.tsx");
  assert.match(source, /"SOURCE"/);
  assert.match(source, /"TARGET"/);
  assert.match(source, /HOP \$\{index\}/);
  assert.match(source, /data-chain-topology-node-label/);
  assert.match(source, /data-chain-topology-node-dot/);
  // 在线呼吸绿点；其它已知状态静止红点；目标节点不画点。
  assert.match(source, /bg-success status-breathe/);
  assert.match(source, /bg-destructive/);
  assert.match(source, /const showDot = !target && tone !== "unknown"/);
});

test("topology nodes render group members, a +N fold and the member_count label", async () => {
  const source = read("components/overview/ChainLatencyDetail.tsx");
  // 节点 = 组：组名主文本 + 成员列表 + 组级状态点取最差成员。
  assert.match(source, /chainTopologyNodeTone/);
  assert.match(source, /chainTopologyMemberRows/);
  assert.match(source, /chainTopologyNodeTier/);
  assert.match(source, /CHAIN_TOPOLOGY_NODE_HEIGHT_PX/);
  assert.match(source, /data-chain-topology-node-members/);
  assert.match(source, /data-chain-topology-member\b/);
  assert.match(source, /data-chain-topology-member-dot/);
  assert.match(source, /data-chain-topology-member-more/);
  assert.match(source, /data-chain-topology-node-count/);
  // 成员行状态点：绿呼吸 / 红 / 灰（未知），不写死颜色。
  assert.match(source, /bg-muted-foreground/);
  // 多成员组的段在 estimated 时加 ≈ 与 tooltip。
  assert.match(source, /chainTopologyEdgeEstimated/);
  assert.match(source, /multiPathEstimate/);
  assert.match(source, /≈/);

  const [{ default: zh }, { default: en }] = await Promise.all([
    import("../i18n/zh-CN.ts"),
    import("../i18n/en.ts"),
  ]);
  assert.equal(zh.overview.chainLatency.memberCountLabel, "{n} 台");
  assert.equal(zh.overview.chainLatency.memberMore, "+{n}");
  assert.equal(zh.overview.chainLatency.memberGroupTitle, "{name}，共 {n} 台成员");
  assert.equal(zh.overview.chainLatency.multiPathEstimate, "多路径估算");
  assert.equal(en.overview.chainLatency.memberCountLabel, "×{n}");
  assert.equal(en.overview.chainLatency.memberMore, "+{n} more");
  assert.equal(en.overview.chainLatency.memberGroupTitle, "{name}, {n} members");
  assert.equal(en.overview.chainLatency.multiPathEstimate, "Multi-path estimate");
});

test("the estimated badge explains multi-path medians, not missing hops", async () => {
  const detail = read("components/overview/ChainLatencyDetail.tsx");
  // 徽章只在契约 estimated 为 true 时渲染；缺跳提示是另一条文案。
  assert.match(detail, /\{chain\.estimated \? \(/);
  assert.match(detail, /data-chain-estimated-badge/);
  assert.match(detail, /estimatedHint/);
  assert.match(detail, /missingLastHop/);

  const [{ default: zh }, { default: en }] = await Promise.all([
    import("../i18n/zh-CN.ts"),
    import("../i18n/en.ts"),
  ]);
  assert.equal(
    zh.overview.chainLatency.estimatedHint,
    "多路径链路，按各跳中位数求和，为估算值",
  );
  assert.equal(
    en.overview.chainLatency.estimatedHint,
    "Multi-path chain, summed from per-hop medians; approximate",
  );
  // 旧语义「含缺失跳」不能再混进估算徽章。
  assert.doesNotMatch(zh.overview.chainLatency.estimatedHint, /缺失跳/);
  assert.doesNotMatch(en.overview.chainLatency.estimatedHint, /missing hop/i);
  // 缺跳有独立措辞，且不声称整链是估算值。
  assert.match(zh.overview.chainLatency.missingLastHop, /最后一跳/);
  assert.doesNotMatch(zh.overview.chainLatency.missingLastHop, /估算/);
  assert.match(en.overview.chainLatency.missingLastHop, /last hop/i);
  assert.doesNotMatch(en.overview.chainLatency.missingLastHop, /estimat/i);
});

test("overall axis draws time gridlines and ends at the last sample, not Now", () => {
  const detail = read("components/overview/ChainLatencyDetail.tsx");
  const chart = read("components/overview/ChainLatencyChart.tsx");
  assert.match(detail, /chainTimeTicks/);
  assert.match(detail, /data-chain-time-axis/);
  assert.match(detail, /data-chain-time-tick/);
  assert.match(detail, /chainLatestSeriesTs/);
  assert.match(detail, /data-chain-axis-now/);
  assert.match(chart, /data-chain-time-gridline/);
  // 「现在」不再是轴右端的唯一标签。
  assert.doesNotMatch(detail, /<span>\{t\("overview\.chainLatency\.now"\)\}<\/span>/);
});

test("the overall legend and anomaly band use primary only", () => {
  const detail = read("components/overview/ChainLatencyDetail.tsx");
  const chart = read("components/overview/ChainLatencyChart.tsx");
  const start = detail.indexOf("data-chain-overall-legend");
  assert.ok(start >= 0);
  const legend = detail.slice(start, detail.indexOf("</div>", start));
  assert.match(legend, /bg-primary\/15/);
  assert.doesNotMatch(legend, /warning/);
  assert.match(legend, /anomalyWindow/);
  assert.match(chart, /fill="var\(--primary\)"/);
  assert.doesNotMatch(chart, /fill="var\(--warning\)"/);
});

test("the list-level overall trend shares the 4h/1d axis and vertical gridlines", () => {
  const source = read("components/overview/ChainLatencyTrendChart.tsx");
  assert.match(source, /chainLatestSeriesTs/);
  assert.match(source, /chainTimeTicks/);
  assert.match(source, /domain=\{axis \? \[axis\.startTs, axis\.endTs\]/);
  assert.match(source, /vertical/);
});

test("loss tooltips drop the old 'at that time' prefix in both languages", async () => {
  const [{ default: zh }, { default: en }] = await Promise.all([
    import("../i18n/zh-CN.ts"),
    import("../i18n/en.ts"),
  ]);
  assert.equal(zh.overview.chainLatency.lossAtTime, "丢包");
  assert.equal(en.overview.chainLatency.lossAtTime, "Loss");
  assert.doesNotMatch(zh.overview.chainLatency.hoverLossHint, /该时刻/);
  assert.doesNotMatch(
    en.overview.chainLatency.hoverLossHint,
    /at that time/i,
  );
});
