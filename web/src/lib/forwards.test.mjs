import assert from "node:assert/strict";
import test from "node:test";
import {
  formatForwardTarget,
  forwardRuntimeError,
  forwardStatus,
} from "./forwards.ts";

const listening = { listening: true, error: "", updated_at: 1_700_000_000 };
const failed = {
  listening: false,
  error: "端口已被占用",
  updated_at: 1_700_000_000,
};

test("forwardStatus reports disabled before looking at runtime", () => {
  assert.equal(forwardStatus(false, null), "disabled");
  assert.equal(forwardStatus(0, null), "disabled");
  // 旧心跳可能还残留 listening，但停用规则不该被当成「监听中」。
  assert.equal(forwardStatus(false, listening), "disabled");
});

test("forwardStatus treats a missing runtime as unknown, not failed", () => {
  assert.equal(forwardStatus(true, null), "unknown");
  assert.equal(forwardStatus(true, undefined), "unknown");
  assert.equal(forwardStatus(1, null), "unknown");
});

test("forwardStatus distinguishes listening from failed", () => {
  assert.equal(forwardStatus(true, listening), "listening");
  assert.equal(forwardStatus(1, listening), "listening");
  assert.equal(forwardStatus(true, failed), "failed");
  assert.equal(forwardStatus(true, { ...failed, error: "" }), "failed");
});

test("forwardRuntimeError trims and drops blank reasons", () => {
  assert.equal(forwardRuntimeError(null), null);
  assert.equal(forwardRuntimeError(undefined), null);
  assert.equal(forwardRuntimeError(listening), null);
  assert.equal(forwardRuntimeError({ ...failed, error: "   " }), null);
  assert.equal(forwardRuntimeError(failed), "端口已被占用");
  assert.equal(
    forwardRuntimeError({ ...failed, error: "  bind failed  " }),
    "bind failed",
  );
});

test("formatForwardTarget brackets bare IPv6 and keeps existing brackets", () => {
  assert.equal(formatForwardTarget("10.0.0.8", 443), "10.0.0.8:443");
  assert.equal(formatForwardTarget(" db.example.com ", 5432), "db.example.com:5432");
  assert.equal(formatForwardTarget("::1", 443), "[::1]:443");
  assert.equal(formatForwardTarget("[::1]", 443), "[::1]:443");
  assert.equal(formatForwardTarget("2001:db8::1", 8443), "[2001:db8::1]:8443");
});
