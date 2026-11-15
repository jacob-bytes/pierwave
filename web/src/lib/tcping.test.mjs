import assert from "node:assert/strict";
import test from "node:test";
import en from "../i18n/en.ts";
import zhCN from "../i18n/zh-CN.ts";
import {
  beginTcping,
  failTcping,
  formatLatency,
  IDLE_TCPING,
  isTcpingLoading,
  normalizeLatency,
  settleTcping,
  tcpingHint,
  tcpingLabel,
} from "./tcping.ts";

function lookup(messages, key) {
  return key
    .split(".")
    .reduce((node, part) => (node == null ? undefined : node[part]), messages);
}

const zhUnreachable = lookup(zhCN, "nodes.tcping.unreachable");
const enUnreachable = lookup(en, "nodes.tcping.unreachable");

test("loading state machine ignores duplicate clicks and can start over", () => {
  const loading = beginTcping(IDLE_TCPING);
  assert.equal(loading.status, "loading");
  assert.equal(isTcpingLoading(loading), true);
  assert.equal(beginTcping(loading), loading, "loading 中重复点击必须无操作");
  assert.equal(isTcpingLoading(IDLE_TCPING), false);

  // 已出结果的行重新探测：回到 loading，旧结果先清掉。
  const again = beginTcping({ status: "success", latencyMs: 42 });
  assert.equal(again.status, "loading");
  assert.equal(again.latencyMs, undefined);
});

test("success formats latency and keeps the probed address as the hint", () => {
  const state = settleTcping({
    reachable: true,
    latency_ms: 42,
    address: "203.0.113.10:443",
    checked_at: 1_730_000_000,
  });

  assert.equal(state.status, "success");
  assert.equal(tcpingLabel(state, zhUnreachable), "42 ms");
  assert.equal(tcpingLabel(state, enUnreachable), "42 ms");
  assert.equal(tcpingHint(state, "fallback"), "203.0.113.10:443");
  assert.equal(state.checkedAt, 1_730_000_000);
});

test("failure shows 不可达 and falls back when the backend gives no reason", () => {
  const state = settleTcping({
    reachable: false,
    error: "连接超时 / Connection timed out",
    address: "203.0.113.10:443",
    checked_at: 1_730_000_000,
  });

  assert.equal(state.status, "failure");
  assert.equal(tcpingLabel(state, zhUnreachable), "不可达");
  assert.equal(tcpingLabel(state, enUnreachable), "Unreachable");
  assert.equal(tcpingHint(state, "fallback"), "连接超时 / Connection timed out");

  const blank = settleTcping({
    reachable: false,
    error: "   ",
    address: "203.0.113.10:443",
    checked_at: 1,
  });
  assert.equal(blank.error, undefined, "空白原因必须归一成空");
  assert.equal(tcpingHint(blank, "探测失败"), "探测失败");
});

test("request-level errors are shown as 不可达, never as success", () => {
  const state = failTcping(" 网络错误 ");
  assert.equal(state.status, "failure");
  assert.equal(state.error, "网络错误");
  assert.equal(tcpingLabel(state, zhUnreachable), "不可达");
  assert.equal(tcpingHint(state, "fallback"), "网络错误");
});

test("latency normalization clamps dirty values instead of printing NaN", () => {
  for (const dirty of [null, undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(normalizeLatency(dirty), 0, `${dirty}`);
    assert.equal(formatLatency(dirty), "0 ms");
  }
  assert.equal(normalizeLatency(41.6), 42);
  assert.equal(formatLatency(0), "0 ms");
  assert.equal(formatLatency(1_234), "1234 ms");
});

test("idle and loading rows render no result and no hint", () => {
  for (const state of [IDLE_TCPING, { status: "loading" }]) {
    assert.equal(tcpingLabel(state, zhUnreachable), null);
    assert.equal(tcpingHint(state, "fallback"), null);
  }
});

test("both locales provide the tcping copy", () => {
  for (const messages of [zhCN, en]) {
    for (const key of [
      "nodes.tcping.probe",
      "nodes.tcping.probeAria",
      "nodes.tcping.probing",
      "nodes.tcping.unreachable",
      "nodes.tcping.failureFallback",
    ]) {
      const value = lookup(messages, key);
      assert.equal(
        typeof value,
        "string",
        `missing translation key: ${key}`,
      );
      assert.ok(value.trim().length > 0, `empty translation: ${key}`);
    }
  }
});
