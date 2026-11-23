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

const list = read("components/overview/ChainLatencyList.tsx");
const detail = read("components/overview/ChainLatencyDetail.tsx");
const badge = read("components/overview/ChainStatusBadge.tsx");
const statusText = read("lib/chainStatusText.ts");
const css = read("index.css");

test("list status dot is 8px (was 6px), breathing animation unchanged", () => {
  const start = list.indexOf("function ChainHealthStatusCell");
  const end = list.indexOf("function ChainListRow", start);
  assert.ok(start >= 0 && end > start);
  const cell = list.slice(start, end);
  assert.match(cell, /data-chain-status-dot/);
  assert.match(cell, /size-2/);
  assert.doesNotMatch(cell, /size-1\.5/);
});

test("topology status dot is 7px (was 6px) and keeps green breathing / red fault", () => {
  assert.match(detail, /data-chain-topology-node-dot/);
  assert.match(detail, /size-\[7px\]/);
  assert.doesNotMatch(detail, /size-1\.5/);
  assert.match(detail, /bg-success status-breathe/);
  assert.match(detail, /bg-destructive/);
  // prefers-reduced-motion 仍在全局停掉呼吸动画。
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /\.status-breathe[\s\S]{0,220}animation: none/);
});

test("detail shows the same status badge with its node reason", () => {
  assert.match(detail, /data-chain-detail-status/);
  assert.match(detail, /<ChainStatusBadge/);
  assert.match(badge, /chainHealthState/);
  assert.match(badge, /chainStatusText/);
  assert.match(statusText, /nodeOfflineShort/);
  assert.match(statusText, /nodeUnhealthyShort/);
  assert.match(statusText, /noSamplesReason/);
  assert.match(statusText, /statusWithReason/);
});

test("list suppresses the slow badge while blocked / degraded", () => {
  assert.match(list, /const showSlowBadge = latencyStatus === "slow" && state === "ok"/);
  assert.match(list, /showSlowBadge \?/);
  // 节点原因在行内补一行小字，并同时放进状态列 title。
  assert.match(list, /data-chain-status-reason/);
  assert.match(list, /statusTitle/);
});
