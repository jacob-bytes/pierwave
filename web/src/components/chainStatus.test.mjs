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
const chainFlow = read("components/overview/ChainFlowCard.tsx");
const flowCard = read(
  "components/overview/chain-template-flow/FlowCard.tsx",
);
const flowEdge = read(
  "components/overview/chain-template-flow/FlowEdge.tsx",
);
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

test("chain flow keeps a status dot, but target / unknown draw none", () => {
  assert.match(flowCard, /data-template-flow-status-dot/);
  assert.match(flowCard, /size-1\.5/);
  assert.match(
    flowCard,
    /const showChainDot = chain && !isTarget && card\.status !== "unknown"/,
  );
  assert.match(flowCard, /bg-destructive/);
  assert.match(flowCard, /bg-warning/);
  assert.match(flowCard, /bg-primary/);
  // 链路卡片不再渲染状态文字，只留点。
  assert.match(flowCard, /data-template-flow-status-text/);
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

test("last hop unmeasurable uses its own wording, never 无历史数据", () => {
  // 拓扑最后一跳与逐段列表最后一段都按 last_hop 标注原因。
  assert.match(chainFlow, /chainLastHopUnmeasurable/);
  assert.match(chainFlow, /chainLastHopReasonText/);
  assert.match(chainFlow, /topology\.targetMissing && !lastHopUnmeasurable/);
  assert.match(chainFlow, /missingLastHop/);
  assert.match(flowEdge, /edge\.note/);
  assert.match(flowEdge, /data-chain-flow-edge-note/);
  assert.match(flowEdge, /data-unavailable=/);
  assert.match(detail, /data-segment-unmeasurable/);
  // unknown 是独立徽章，色不影响 blocked / degraded。
  assert.match(badge, /unknown: \{/);
  assert.match(badge, /CHAIN_STATE_LABEL_KEYS\.unknown/);
});

test("list suppresses the slow badge while blocked / degraded", () => {
  assert.match(list, /const showSlowBadge = latencyStatus === "slow" && state === "ok"/);
  assert.match(list, /showSlowBadge \?/);
  // 节点原因在行内补一行小字，并同时放进状态列 title。
  assert.match(list, /data-chain-status-reason/);
  assert.match(list, /statusTitle/);
});
