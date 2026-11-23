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

test("chain rows use the three-block grid and drop the fixed hops column", () => {
  assert.match(source, /minmax\(180px,1\.2fr\)/);
  assert.match(source, /minmax\(320px,2fr\)/);
  assert.match(source, /_16rem\]/);
  // 旧 6 列布局的固定宽度不能再出现。
  assert.doesNotMatch(source, /3\.25rem/);
  assert.doesNotMatch(source, /sm:grid-cols-\[minmax/);
  assert.doesNotMatch(source, /sm:col-start-/);
});

test("lead block carries 13px hops and the same-size sample time", () => {
  const start = source.indexOf("data-chain-row-lead");
  const end = source.indexOf("data-chain-row-route", start);
  assert.ok(start >= 0 && end > start, "row blocks must be in order");
  const lead = source.slice(start, end);
  assert.match(lead, /data-chain-hops/);
  assert.match(lead, /data-chain-sample/);
  // 跳数和最近样本同字号，且都走 muted 文本。
  const sizes = [...lead.matchAll(/text-\[(\d+)px\]/g)].map((match) =>
    Number(match[1]),
  );
  assert.ok(sizes.length >= 1);
  assert.ok(sizes.every((size) => size >= 13), "hops/sample must be >=13px");
  assert.match(lead, /text-muted-foreground/);
});

test("address is 13px mono and the server route is 12px muted", () => {
  const start = source.indexOf("data-chain-row-route");
  const end = source.indexOf("data-chain-row-metrics", start);
  assert.ok(start >= 0 && end > start);
  const route = source.slice(start, end);
  assert.match(route, /data-chain-endpoint-address/);
  assert.match(route, /font-mono text-\[13px\]/);
  assert.match(route, /data-chain-endpoint-name/);
  assert.match(route, /text-xs/);
  assert.match(route, /text-muted-foreground/);
});

test("metrics block uses 20px P50, 14px loss, status badge and chevron", () => {
  const start = source.indexOf("data-chain-row-metrics");
  assert.ok(start >= 0);
  const metrics = source.slice(start);
  assert.match(metrics, /data-chain-p50/);
  assert.match(metrics, /text-xl/);
  assert.match(metrics, /data-chain-loss/);
  assert.match(metrics, /text-sm/);
  assert.match(metrics, /<ChainHealthStatusCell/);
  assert.match(metrics, /<ChevronRightIcon/);
});

test("mobile stacks name / address / metrics without a fixed min width", () => {
  const start = source.indexOf("data-chain-list-row");
  const end = source.indexOf("data-chain-row-lead", start);
  const button = source.slice(start, end);
  assert.match(button, /grid-cols-1/);
  assert.match(button, /lg:gap-y-0/);
  assert.match(button, /w-full/);
  // 三块自身都允许收缩，长地址/长路由用 truncate 而不是撑破页面。
  assert.ok(source.includes('data-chain-row-lead className="min-w-0"'));
  assert.ok(source.includes('data-chain-endpoints data-chain-row-route className="min-w-0"'));
  assert.ok(source.includes('data-chain-row-metrics'));
  assert.match(source, /truncate/);
});

test("header keeps only the three block labels", () => {
  const start = source.indexOf("data-chain-list-head");
  const end = source.indexOf("<ul", start);
  const head = source.slice(start, end);
  assert.match(head, /overview\.chainLatency\.listTitle/);
  assert.match(head, /overview\.chainLatency\.colEndpoint/);
  assert.match(head, /overview\.chainLatency\.colStatus/);
  assert.doesNotMatch(head, /colHops/);
  assert.doesNotMatch(head, /3\.25rem/);
});
