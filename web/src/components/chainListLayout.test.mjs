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

const source = read("components/overview/ChainLatencyList.tsx");
const rowStart = source.indexOf("function ChainListRow({");
const rowEnd = source.indexOf("/**\n * 链路时延列表", rowStart);
const row = source.slice(rowStart, rowEnd);

test("eight standard columns include an independent route column", () => {
  assert.match(
    source,
    /minmax\(0,18fr\)_minmax\(0,31fr\)_minmax\(0,25fr\)_56px_72px_80px_80px_24px/,
  );
  assert.match(source, /minmax\(0,18fr\)/);
  assert.match(source, /minmax\(0,31fr\)/);
  assert.match(source, /minmax\(0,25fr\)/);
  assert.match(source, /56px_72px_80px_80px_24px/);
  assert.doesNotMatch(source, /44fr/);
  assert.doesNotMatch(source, /96px/);
});

test("address stays capped, route is its own cell, sample lives under the name", () => {
  const addressStart = row.indexOf("data-chain-row-address");
  const routeStart = row.indexOf("data-chain-row-route");
  const metricsStart = row.indexOf("data-chain-row-metrics");
  assert.ok(addressStart >= 0 && routeStart > addressStart && metricsStart > routeStart);
  const address = row.slice(addressStart, routeStart);
  const route = row.slice(routeStart, metricsStart);
  const lead = row.slice(0, addressStart);

  assert.match(address, /max-w-\[520px\]/);
  assert.match(address, /font-mono text-xs/);
  assert.match(address, /→/);
  assert.doesNotMatch(address, /h-px|flex-1/);

  assert.match(route, /data-chain-endpoint-name/);
  assert.match(route, /text-\[13px\]/);
  assert.match(route, /text-muted-foreground/);
  assert.match(route, /truncate/);
  assert.match(route, /title=\{routeTitle\}/);

  // 样本时间保留在链路名下的小字，不再占第二行路由。
  assert.match(lead, /data-chain-sample/);
  assert.match(lead, /text-\[13px\]/);
  assert.doesNotMatch(row, /data-chain-row-meta/);
});

test("rows do not repeat P50 or window-loss labels", () => {
  assert.doesNotMatch(row, />\s*P50\s*</);
  assert.doesNotMatch(row, />\s*窗口丢包\s*</);
  assert.doesNotMatch(row, /text-xl/);
  assert.match(row, /text-\[15px\]/);
  assert.match(row, /data-chain-p50/);
  assert.match(row, /data-chain-loss/);
});

test("hops, P50 and status share 15px tabular digits", () => {
  const hops = row.slice(
    row.indexOf("data-chain-hops"),
    row.indexOf("data-chain-p50"),
  );
  assert.match(hops, /text-\[15px\]/);
  assert.match(hops, /tabular-nums/);
  const p50 = row.slice(
    row.indexOf("data-chain-p50"),
    row.indexOf("data-chain-loss"),
  );
  assert.match(p50, /text-\[15px\]/);
  assert.match(p50, /tabular-nums/);
  const status = source.slice(
    source.indexOf("function ChainHealthStatusCell"),
    source.indexOf("function ChainListRow"),
  );
  assert.match(status, /text-\[15px\]/);
  assert.match(status, /tabular-nums/);
});

test("all columns are left aligned and rows use bottom separators", () => {
  assert.doesNotMatch(source, /text-right/);
  assert.doesNotMatch(row, /justify-end/);
  assert.match(source, /text-left/);
  assert.match(row, /data-chain-list-row-item/);
  assert.match(row, /border-b border-border\/60 last:border-b-0/);
});

test("mobile stacks link → address → route → metrics", () => {
  const lead = row.indexOf("data-chain-row-lead");
  const address = row.indexOf("data-chain-row-address");
  const route = row.indexOf("data-chain-row-route");
  const metrics = row.indexOf("data-chain-row-metrics");
  assert.ok(lead >= 0 && lead < address && address < route && route < metrics);
  const start = source.indexOf("data-chain-list-row");
  const end = source.indexOf("data-chain-row-lead", start);
  const button = source.slice(start, end);
  assert.match(button, /grid-cols-1/);
  assert.match(button, /w-full/);
  assert.match(row, /overview\.chainLatency\.colHops/);
  assert.match(row, /overview\.chainLatency\.colRoute/);
  assert.match(row, /overview\.chainLatency\.mobileLatency/);
  assert.match(row, /overview\.chainLatency\.mobileLoss/);
  assert.match(row, /lg:hidden/);
  assert.match(row, /truncate/);
});

test("header appears once with route and all numeric columns", () => {
  const start = source.indexOf("data-chain-list-head");
  const end = source.indexOf("<ul", start);
  const head = source.slice(start, end);
  for (const key of [
    "overview.chainLatency.listTitle",
    "overview.chainLatency.colEndpoint",
    "overview.chainLatency.colRoute",
    "overview.chainLatency.colHops",
    "overview.chainLatency.windowLoss",
    "overview.chainLatency.colStatus",
  ]) {
    assert.match(head, new RegExp(key.replace(".", "\\.")));
  }
  assert.match(head, />P50</);
  assert.equal((head.match(/data-chain-list-head/g) ?? []).length, 1);
});
