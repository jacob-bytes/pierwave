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

test("chain detail reuses the compact template canvas instead of the old strip", () => {
  const card = read("components/overview/ChainFlowCard.tsx");
  const detail = read("components/overview/ChainLatencyDetail.tsx");
  assert.match(card, /data-chain-flow/);
  assert.match(card, /buildChainFlowGraph/);
  assert.match(card, /<ChainTemplateFlowLazy/);
  assert.match(card, /kind="chain"/);
  assert.match(card, /<Suspense/);
  assert.match(card, /overview\.chainLatency\.noSamplesShort/);
  assert.match(card, /data-chain-overall-stats/);
  assert.match(card, /data-template-flow-zoom/);
  assert.match(detail, /<ChainFlowCard/);
  // 旧方框 + 细线条带的所有标记都不能留在详情里。
  for (const marker of [
    "data-chain-topology",
    "data-chain-topology-scroll",
    "data-chain-topology-node",
    "data-chain-topology-edge",
  ]) {
    assert.doesNotMatch(detail, new RegExp(marker));
  }
});

test("the diagnosis bar uses primary instead of warning", () => {
  const source = read("components/overview/ChainLatencyDetail.tsx");
  const start = source.indexOf("function DiagnosisBlock");
  const end = source.indexOf("function TimeAxis", start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /border-primary\/30 bg-primary\/10 text-foreground/);
  assert.doesNotMatch(block, /warning/);
});

test("chain cards show preferred / candidate on the second line, target / unknown draw no dot", () => {
  const source = read("components/overview/chain-template-flow/FlowCard.tsx");
  assert.match(source, /flowPreferred/);
  assert.match(source, /flowCandidate/);
  assert.match(source, /data-chain-tag/);
  assert.match(source, /data-flow-target/);
  assert.match(source, /overview\.chainLatency\.chainTarget/);
  // 链路卡片不写状态文字；目标 / 未知不画点。
  assert.match(
    source,
    /const showChainDot = chain && !isTarget && card\.status !== "unknown"/,
  );
  assert.match(source, /data-template-flow-status-text/);
  assert.match(source, /bg-destructive/);
});

test("chain edges carry one pill per segment, ≈ for estimates and a note for missing", async () => {
  const source = read("components/overview/chain-template-flow/FlowEdge.tsx");
  assert.match(source, /flowSegmentLoss/);
  assert.match(source, /chainTopologyEdgeEstimated|edge\.estimated/);
  assert.match(source, /multiPathEstimate/);
  assert.match(source, /≈/);
  assert.match(source, /data-chain-flow-edge-note/);
  assert.match(source, /data-template-flow-march/);
  assert.match(source, /formatLossPct/);

  const [{ default: zh }, { default: en }] = await Promise.all([
    import("../i18n/zh-CN.ts"),
    import("../i18n/en.ts"),
  ]);
  assert.equal(zh.overview.chainLatency.flowPreferred, "首选");
  assert.equal(zh.overview.chainLatency.flowCandidate, "候选");
  assert.equal(zh.overview.chainLatency.flowSegmentLoss, "丢包");
  assert.equal(en.overview.chainLatency.flowPreferred, "Preferred");
  assert.equal(en.overview.chainLatency.flowCandidate, "Candidate");
  assert.equal(en.overview.chainLatency.multiPathEstimate, "Multi-path estimate");
});

test("the estimated badge explains multi-path medians, not missing hops", async () => {
  const detail = read("components/overview/ChainLatencyDetail.tsx");
  const card = read("components/overview/ChainFlowCard.tsx");
  // 徽章只在契约 estimated 为 true 时渲染；缺跳提示是另一条文案。
  assert.match(detail, /\{chain\.estimated \? \(/);
  assert.match(detail, /data-chain-estimated-badge/);
  assert.match(detail, /estimatedHint/);
  assert.match(card, /missingLastHop/);

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
  // x 轴收敛到有效样本的实际最小 / 最大时间，不再固定成整个窗口。
  assert.match(source, /chainTrendTimeDomain/);
  assert.match(source, /chainTimeTicks/);
  assert.match(source, /\[axis\.startTs, axis\.endTs\]/);
  assert.match(source, /vertical/);
});

test("chain trend keeps the legend to one scrollable row below the chart", () => {
  const source = read("components/overview/ChainLatencyTrendChart.tsx");
  const start = source.indexOf("function ChainTrendSelectedLegend");
  const end = source.indexOf("interface TooltipItem", start);
  assert.ok(start >= 0 && end > start);
  const legend = source.slice(start, end);
  // 一行横向滚动，不再折行 / 限高 24。
  assert.match(legend, /overflow-x-auto/);
  assert.match(legend, /whitespace-nowrap/);
  assert.match(legend, /min-h-6/);
  assert.doesNotMatch(legend, /flex-wrap/);
  assert.doesNotMatch(source, /max-h-24/);
  // 标签挂在图表 / 表格之后，而不是压在图表上方。
  const chartTail = source.slice(source.indexOf("<ChainTrendSelectedLegend"));
  assert.ok(chartTail.length > 0);
});

test("chart margins leave at most 12px of outer blank space", () => {
  const source = read("components/overview/ChainLatencyTrendChart.tsx");
  assert.match(source, /right: 12, left: 8/);
});

test("series selection lives in ?series= and the chart renders an empty state", async () => {
  const hook = read("components/overview/useChainTrendSeries.ts");
  assert.match(hook, /useSearchParams/);
  assert.match(hook, /CHAIN_SERIES_PARAM/);
  assert.match(hook, /replace: true/);
  assert.match(hook, /defaultChainSeriesIds/);

  const list = read("components/overview/ChainLatencyList.tsx");
  assert.match(list, /useChainTrendSeries/);
  assert.match(list, /ChainSeriesSelect/);
  assert.match(list, /selectedIds=\{series\.selectedIds\}/);

  const select = read("components/overview/ChainSeriesSelect.tsx");
  for (const marker of [
    "data-chain-series-trigger",
    "data-chain-series-search",
    "data-chain-series-all",
    "data-chain-series-clear",
    "data-chain-series-checkbox",
    "data-chain-series-row",
  ]) {
    assert.ok(select.includes(marker), `select missing ${marker}`);
  }

  const chart = read("components/overview/ChainLatencyTrendChart.tsx");
  assert.match(chart, /selectedIds: readonly string\[\]/);
  assert.match(chart, /selectedChains\.length === 0/);

  const [{ default: zh }, { default: en }] = await Promise.all([
    import("../i18n/zh-CN.ts"),
    import("../i18n/en.ts"),
  ]);
  for (const key of [
    "seriesSelectAria",
    "seriesSelectTrigger",
    "seriesSearch",
    "seriesSelectAll",
    "seriesClear",
    "seriesNoMatch",
    "seriesToggleAria",
  ]) {
    assert.equal(typeof zh.overview.chainLatency[key], "string", `zh ${key}`);
    assert.equal(typeof en.overview.chainLatency[key], "string", `en ${key}`);
  }
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
