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

/** 概览页全部 recharts 图表：网格线 / tooltip 都走共享实现。 */
const RECHARTS_CHARTS = [
  "components/overview/ServerUptimeTrendChart.tsx",
  "components/overview/ResourceLineChart.tsx",
  "components/overview/ChainLatencyTrendChart.tsx",
  "components/overview/ChainSegmentTrendChart.tsx",
  "components/overview/TrafficChart.tsx",
  "components/overview/ProtocolTrendChart.tsx",
];

test("所有图表共用 ChartGrid：横向点线，只有链路时延趋势保留竖线", () => {
  for (const file of RECHARTS_CHARTS) {
    const source = read(file);
    assert.ok(source.includes("<ChartGrid"), `${file} must use ChartGrid`);
    assert.ok(
      !source.includes("<CartesianGrid"),
      `${file} must not hand-roll CartesianGrid`,
    );
    assert.ok(
      !source.includes('strokeDasharray="2 4"'),
      `${file} must take the dash pattern from chartTheme`,
    );
    if (file.endsWith("ChainLatencyTrendChart.tsx")) {
      assert.match(source, /<ChartGrid vertical \/>/, "chain trend keeps verticals");
    } else {
      assert.ok(
        !/<ChartGrid[^>]*vertical/.test(source),
        `${file} should not draw vertical grid lines`,
      );
    }
  }
  const grid = read("components/overview/ChartGrid.tsx");
  assert.match(grid, /CHART_GRID_DASH/);
  assert.match(grid, /CHART_GRID_OPACITY/);
  assert.match(grid, /vertical=\{vertical\}/);
});

test("tooltip 外壳只有一个实现，图表不再各写一套 bg-popover", () => {
  for (const file of [...RECHARTS_CHARTS, "components/overview/ChainLatencyChart.tsx"]) {
    const source = read(file);
    assert.match(source, /ChartTooltipShell/, `${file} must use the shell`);
    assert.ok(
      !source.includes("bg-popover"),
      `${file} must not re-implement the tooltip surface`,
    );
  }
  const shell = read("components/overview/ChartTooltipShell.tsx");
  for (const token of [
    "bg-popover",
    "border-border",
    "rounded-md",
    "shadow-lg/40",
    "p-3",
    "text-xs",
    "text-[11px]",
    "tabular-nums",
  ]) {
    assert.ok(shell.includes(token), `shell missing ${token}`);
  }
});

test("在线率 / 资源趋势的 x 轴不再截断成重复日期", () => {
  for (const file of [
    "components/overview/ServerUptimeTrendChart.tsx",
    "components/overview/ResourceLineChart.tsx",
  ]) {
    const source = read(file);
    assert.match(source, /timeAxisTicks/, `${file} must use the shared ticks`);
    assert.ok(
      !source.includes("formatMonthDayHour(value).slice(0, 5)"),
      `${file} must not slice MM/DD HH:00 down to MM/DD`,
    );
  }
});

test("流量 / 协议图的 y 轴走整齐的 1024 步长", () => {
  for (const file of [
    "components/overview/TrafficChart.tsx",
    "components/overview/ProtocolTrendChart.tsx",
  ]) {
    const source = read(file);
    assert.match(source, /byteAxisScale/);
    assert.match(source, /formatByteAxisTick/);
    assert.match(source, /ticks=\{scale\.ticks\}/);
    assert.ok(!source.includes("tickCount={4}"), `${file} keeps default ticks`);
  }
});

test("资源图 y 轴上界跟随数据，0 基线保留", () => {
  const source = read("components/overview/ResourceLineChart.tsx");
  assert.match(source, /resourceYMax/);
  assert.match(source, /resourceYTicks/);
  assert.match(source, /domain=\{\[0, yMax\]\}/);
  assert.ok(!source.includes("domain={[0, 100]}"), "no fixed 0-100 axis");
});

test("链路趋势图例默认收起无样本链", () => {
  const source = read("components/overview/ChainLatencyTrendChart.tsx");
  assert.match(source, /chainLegendGroups/);
  assert.match(source, /useState\(false\)/);
  assert.match(source, /data-chain-legend-unsampled-toggle/);
  assert.match(source, /noSamplesGroup/);
});
