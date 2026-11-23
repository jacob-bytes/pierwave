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

test("standard table columns replace the previous three-block grid", () => {
  assert.match(
    source,
    /22fr\)\s*_minmax\(0,44fr\)_64px_88px_96px_96px_24px/,
  );
  assert.match(source, /minmax\(0,22fr\)/);
  assert.match(source, /minmax\(0,44fr\)/);
  assert.match(source, /64px_88px_96px_96px_24px/);
  assert.doesNotMatch(source, /minmax\(180px,1\.2fr\)/);
  assert.doesNotMatch(source, /16rem/);
});

test("address is capped at 520px and has only a small muted arrow", () => {
  const start = row.indexOf("data-chain-row-address");
  const end = row.indexOf("data-chain-row-meta", start);
  const address = row.slice(start, end);
  assert.match(address, /data-chain-endpoint-address/);
  assert.match(address, /max-w-\[520px\]/);
  assert.match(address, /font-mono text-\[13px\]/);
  assert.match(address, /→/);
  // 连接线 / 大箭头 / 拉伸填充都不允许再出现。
  assert.doesNotMatch(address, /h-px/);
  assert.doesNotMatch(address, /flex-1/);
  assert.doesNotMatch(address, /data-chain-connector/);
});

test("rows do not repeat P50 or window-loss labels", () => {
  // 行内只留数值；标签只出现在表头一次。
  assert.doesNotMatch(row, />\s*P50\s*</);
  assert.doesNotMatch(row, />\s*窗口丢包\s*</);
  assert.doesNotMatch(row, /text-xl/);
  assert.match(row, /text-\[17px\]/);
  assert.match(row, /data-chain-p50/);
  assert.match(row, /data-chain-loss/);
});

test("hops are 13px and the secondary line is 12px muted", () => {
  const hops = row.slice(
    row.indexOf("data-chain-hops"),
    row.indexOf("data-chain-p50"),
  );
  assert.match(hops, /text-\[13px\]/);
  assert.match(hops, /text-muted-foreground/);
  const meta = row.slice(
    row.indexOf("data-chain-row-meta"),
    row.indexOf("data-chain-row-metrics"),
  );
  assert.match(meta, /text-xs/);
  assert.match(meta, /text-muted-foreground/);
  assert.match(meta, /data-chain-endpoint-name/);
  assert.match(meta, /data-chain-sample/);
});

test("mobile keeps inline labels and stacks without horizontal stretch", () => {
  const start = source.indexOf("data-chain-list-row");
  const end = source.indexOf("data-chain-row-lead", start);
  const button = source.slice(start, end);
  assert.match(button, /grid-cols-1/);
  assert.match(button, /w-full/);
  assert.match(row, /overview\.chainLatency\.colHops/);
  assert.match(row, /overview\.chainLatency\.mobileLatency/);
  assert.match(row, /overview\.chainLatency\.mobileLoss/);
  // 移动端标签只在 lg 以下显示，桌面端不重复表头。
  assert.match(row, /lg:hidden/);
  assert.match(row, /truncate/);
});

test("header appears once with all seven column labels", () => {
  const start = source.indexOf("data-chain-list-head");
  const end = source.indexOf("<ul", start);
  const head = source.slice(start, end);
  for (const key of [
    "overview.chainLatency.listTitle",
    "overview.chainLatency.colEndpoint",
    "overview.chainLatency.colHops",
    "overview.chainLatency.windowLoss",
    "overview.chainLatency.colStatus",
  ]) {
    assert.match(head, new RegExp(key.replace(".", "\\.")));
  }
  assert.match(head, />P50</);
  assert.equal((head.match(/data-chain-list-head/g) ?? []).length, 1);
});
