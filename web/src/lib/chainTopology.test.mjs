import assert from "node:assert/strict";
import test from "node:test";
import en from "../i18n/en.ts";
import zhCN from "../i18n/zh-CN.ts";
import {
  hopLatencyLabel,
  hopLatencyTone,
  memberInUse,
  pathModeBadge,
  protocolBadge,
  totalLatencyLabel,
} from "./chainTopology.ts";

function lookup(messages, key) {
  return key
    .split(".")
    .reduce((node, part) => (node == null ? undefined : node[part]), messages);
}

const zhT = (key) => lookup(zhCN, key);
const enT = (key) => lookup(en, key);

test("hopLatencyTone maps <200 / 200-500 / >500 to default / warning / destructive", () => {
  assert.equal(hopLatencyTone(0), "default");
  assert.equal(hopLatencyTone(18), "default");
  assert.equal(hopLatencyTone(199), "default");
  assert.equal(hopLatencyTone(200), "warning");
  assert.equal(hopLatencyTone(350), "warning");
  assert.equal(hopLatencyTone(500), "warning");
  assert.equal(hopLatencyTone(501), "destructive");
  assert.equal(hopLatencyTone(1200), "destructive");
});

test("hopLatencyTone treats null / NaN / negative as missing data, never 0 ms", () => {
  assert.equal(hopLatencyTone(null), "muted");
  assert.equal(hopLatencyTone(undefined), "muted");
  assert.equal(hopLatencyTone(Number.NaN), "muted");
  assert.equal(hopLatencyTone(-1), "muted");
});

test("hopLatencyLabel keeps a placeholder so arrows do not collapse", () => {
  assert.equal(hopLatencyLabel(null), "—");
  assert.equal(hopLatencyLabel(undefined), "—");
  assert.equal(hopLatencyLabel(0), "0 ms");
  assert.equal(hopLatencyLabel(18), "18 ms");
  assert.equal(hopLatencyLabel(72.6), "73 ms");
});

test("protocolBadge renders the three chain protocols", () => {
  assert.equal(protocolBadge("tcp"), "TCP");
  assert.equal(protocolBadge("udp"), "UDP");
  assert.equal(protocolBadge("both"), "TCP + UDP");
  assert.equal(protocolBadge("  UDP  "), "UDP");
});

test("protocolBadge falls back to TCP for unknown values, matching the backend", () => {
  assert.equal(protocolBadge("sctp"), "TCP");
  assert.equal(protocolBadge(null), "TCP");
  assert.equal(protocolBadge(undefined), "TCP");
  assert.equal(protocolBadge(""), "TCP");
});

test("pathModeBadge shows current path for single and source hashing for hash", () => {
  assert.equal(pathModeBadge("single", zhT), "当前路径");
  assert.equal(pathModeBadge("single", enT), "Current path");
  assert.equal(pathModeBadge("hash", zhT), "按来源分流");
  assert.equal(pathModeBadge("hash", enT), "Hashed by source");
  assert.equal(pathModeBadge("single", (key) => key), "chains.detail.currentPath");
});

test("pathModeBadge stays silent for multi and unknown modes", () => {
  assert.equal(pathModeBadge("multi", zhT), null);
  assert.equal(pathModeBadge("weird", zhT), null);
  assert.equal(pathModeBadge(null, zhT), null);
  assert.equal(pathModeBadge(undefined, zhT), null);
});

test("totalLatencyLabel returns null exactly when there is no total", () => {
  assert.equal(totalLatencyLabel(null), null);
  assert.equal(totalLatencyLabel(undefined), null);
  assert.equal(totalLatencyLabel(Number.NaN), null);
  assert.equal(totalLatencyLabel(-5), null);
  assert.equal(totalLatencyLabel(0), "0 ms");
  assert.equal(totalLatencyLabel(73), "73 ms");
});

test("total latency copy exists in both dictionaries", () => {
  assert.equal(lookup(zhCN, "chains.detail.totalLatency"), "链路内合计 {total}");
  assert.equal(lookup(en, "chains.detail.totalLatency"), "Chain total {total}");
  assert.equal(lookup(zhCN, "chains.detail.totalLatencyTitle"), "不含客户端到入口");
  assert.equal(lookup(en, "chains.detail.totalLatencyTitle"), "Excludes client to entry");
});

test("memberInUse only marks multi-member groups in multi mode", () => {
  assert.equal(memberInUse("multi", 2), true);
  assert.equal(memberInUse("multi", 8), true);
  assert.equal(memberInUse("multi", 1), false);
  assert.equal(memberInUse("multi", 0), false);
  assert.equal(memberInUse("single", 3), false);
  assert.equal(memberInUse("hash", 3), false);
  assert.equal(memberInUse("unknown", 3), false);
});
