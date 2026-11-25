/**
 * 概览 KPI 条统一 / 链路二级下划线子页 / 热力图折叠 / 流量榜负载标注的
 * 源码级回归测试。
 *
 * 这些是跨组件的视觉契约（同一栅格、同一字号、同一位置），单靠纯函数
 * 测不到；这里直接断言组件结构与 CSS，防止下一次改版又分裂成两套。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

function read(relative) {
  return readFileSync(
    fileURLToPath(new URL(`../${relative}`, import.meta.url)),
    "utf8",
  );
}

const kpi = read("components/overview/ChainKpi.tsx");
const server = read("components/overview/ServerHealthView.tsx");
const cost = read("components/overview/CostView.tsx");
const chainList = read("components/overview/ChainLatencyList.tsx");
const templateKpi = read("components/overview/ChainTemplateKpis.tsx");
const chainSectionTabs = read("components/overview/ChainSectionTabs.tsx");
const traffic = read("components/overview/TrafficView.tsx");
const css = read("index.css");
const zh = read("i18n/zh-CN.ts");
const en = read("i18n/en.ts");

function includes(source, patterns, label) {
  for (const pattern of patterns) {
    assert.ok(source.includes(pattern), `${label} missing: ${pattern}`);
  }
}

test("KPI 唯一栅格：390 2×2、桌面 4 列、28px 数字、13px 副行、内容决定高度", () => {
  includes(
    kpi,
    [
      "grid-cols-2",
      "sm:grid-cols-4",
      "gap-px",
      "bg-border",
      "min-w-0",
      "py-3.5",
      "line-clamp-1",
      "text-[28px]",
      "text-[13px]",
      "break-words",
    ],
    "ChainKpi",
  );
  // 不允许再用固定 min-h 凑高度：高度 = 内容 + 固定 padding。
  assert.ok(!kpi.includes("min-h-["), "KPI cell must not set min-h");
  // 共用同一份实现：四个有 KPI 的视图都走 ChainKpi 的栅格 / 单元格。
  assert.match(chainList, /ChainKpiGrid/);
  assert.match(chainList, /ChainKpiCell/);
  assert.match(templateKpi, /ChainKpiGrid/);
  assert.match(templateKpi, /ChainKpiCell/);
  assert.match(server, /<ChainKpiGrid data-server-kpis>/);
  assert.match(server, /<ChainKpiCell/);
  assert.match(cost, /<ChainKpiGrid data-cost-kpis>/);
  assert.match(cost, /<ChainKpiCell/);
  // 旧的「始终三列、24px 数字」组件已经删掉，不允许再长回来。
  assert.equal(
    existsSync(
      fileURLToPath(
        new URL("../components/overview/InsightMetrics.tsx", import.meta.url),
      ),
    ),
    false,
    "InsightMetrics must not come back as a second KPI implementation",
  );
  for (const [label, source] of [
    ["ServerHealthView", server],
    ["CostView", cost],
  ]) {
    assert.ok(
      !source.includes("InsightMetrics"),
      `${label} must not use the old InsightMetrics`,
    );
    assert.ok(
      !source.includes("text-xl"),
      `${label} must not override the KPI value to 20px`,
    );
  }
});

test("三个指标的视图：首格 col-span-2 补满 4 列，390 占满第一行", () => {
  for (const [label, source] of [
    ["ServerHealthView", server],
    ["CostView", cost],
  ]) {
    const start = source.indexOf("<ChainKpiGrid");
    const grid = source.slice(start, source.indexOf("</ChainKpiGrid>", start));
    assert.match(grid, /className="col-span-2"/, label);
    assert.equal(
      (grid.match(/<ChainKpiCell/g) ?? []).length,
      3,
      `${label} must render exactly three KPI cells`,
    );
  }
  // 四指标的链路 / 模板子页不额外跨列，桌面就是四等分。
  assert.ok(!chainList.includes("col-span-2"));
  assert.ok(!templateKpi.includes("col-span-2"));
});

test("链路二级子页：12px 下划线 tab，选中 primary、未选中 muted，位置不变", () => {
  includes(
    chainSectionTabs,
    [
      'variant="line"',
      'className="chain-section-tabs shrink-0"',
      "data-chain-section-tabs",
    ],
    "ChainSectionTabs",
  );
  // 子页仍由 OverviewInsight 渲染在筛选器右侧的同一组里（只在链路 tab）。
  const shell = read("components/overview/OverviewInsight.tsx");
  includes(
    shell,
    ["<ServerFilter", "<ChainSectionTabs", 'view === "chain" ?'],
    "OverviewInsight",
  );
  assert.ok(
    shell.indexOf("<ChainSectionTabs") > shell.indexOf("<ServerFilter"),
    "sub tabs must stay to the right of the server filter",
  );
  // 下划线的样式在 index.css：12px、2px、primary，未选中 muted。
  includes(
    css,
    [
      ".chain-section-tabs {",
      '.chain-section-tabs [data-slot="tabs-trigger"]',
      "font-size: 0.75rem",
      "color: var(--muted-foreground)",
      '.chain-section-tabs [data-slot="tabs-trigger"][data-state="active"]',
      "color: var(--primary)",
      "height: 2px",
      "background: var(--primary)",
    ],
    "index.css",
  );
});

test("热力图：全程无在线样本折叠成一行，可展开 / 收起且名称进 tooltip", () => {
  includes(
    server,
    [
      "buildHeatmapRows",
      "offlineExpanded",
      "data-heatmap-offline-row",
      "data-heatmap-offline-row-name",
      "aria-expanded={offlineExpanded}",
      "overview.serverHealth.offlineGroup",
      "overview.serverHealth.offlineGroupTooltip",
      "offlineServers.map((server) => server.name).join",
      "data-row={rowIndex}",
    ],
    "ServerHealthView heatmap",
  );
  // 聚合行只是折叠开关，本身不参与格子的键盘遍历；展开后的服务器行
  // 才重新拿到 data-heatmap-cell / data-row。
  const groupStart = server.indexOf("data-heatmap-offline-row\n");
  const groupEnd = server.indexOf("data-heatmap-row", groupStart);
  const groupBlock = server.slice(groupStart, groupEnd);
  assert.ok(groupStart > 0 && groupEnd > groupStart);
  assert.ok(
    !groupBlock.includes("data-heatmap-cell"),
    "collapsed aggregate row must not render keyboard cells",
  );
  // 图例 / 筛选逻辑没有被折叠分支改动。
  assert.match(server, /data-heatmap-legend/);
  assert.match(server, /<UptimeLegend approximate=/);
  // 新增文案必须中英成对。
  for (const key of [
    "offlineGroup",
    "offlineGroupTooltip",
    "offlineGroupExpand",
    "offlineGroupCollapse",
  ]) {
    assert.ok(zh.includes(`      ${key}:`), `zh-CN missing ${key}`);
    assert.ok(en.includes(`      ${key}:`), `en missing ${key}`);
  }
});

test("流量榜单：桌面端也标注「负载」，390 现有标注保留", () => {
  includes(
    traffic,
    [
      't("overview.loadLabel")',
      "<span className=\"md:hidden\">{loadLabel}</span>",
      'hidden font-sans text-[11px] text-muted-foreground md:inline',
      '<span className="hidden md:inline">{load}</span>',
    ],
    "TrafficView leaderboard",
  );
  // 新文案必须双语齐全。
  assert.ok(zh.includes('loadLabel: "负载"'), "zh-CN loadLabel missing");
  assert.ok(en.includes('loadLabel: "Load"'), "en loadLabel missing");
});
