import assert from "node:assert/strict";
import test from "node:test";
import { applySummary } from "./applyStatus.ts";

test("ok, null and unknown apply statuses never produce a badge", () => {
  assert.equal(applySummary({}), null);
  assert.equal(applySummary({ apply_status: null }), null);
  assert.equal(applySummary({ apply_status: "ok" }), null);
  assert.equal(applySummary({ apply_status: "future" }), null);
});

test("partial exposes stage, effective paths and the 2/3 count", () => {
  const summary = applySummary({
    apply_status: "partial",
    apply_error: "[agent.apply_files.partial] boom",
    apply_partial: {
      stage: " 提交 rename / commit ",
      effective: [
        "/etc/pierwave/xray/server.crt",
        "/etc/pierwave/xray/server.key",
      ],
      effective_count: 2,
      total: 3,
    },
  });
  assert.deepEqual(summary, {
    status: "partial",
    count: 2,
    total: 3,
    stage: "提交 rename / commit",
    effective: [
      "/etc/pierwave/xray/server.crt",
      "/etc/pierwave/xray/server.key",
    ],
    error: "[agent.apply_files.partial] boom",
  });
});

test("partial falls back to the path list when effective_count is missing", () => {
  const summary = applySummary({
    apply_status: "partial",
    apply_partial: {
      stage: "提交 rename / commit",
      effective: ["/a.pem", "/b.pem"],
      effective_count: Number.NaN,
      total: 0,
    },
  });
  assert.equal(summary.count, 2, "count comes from effective.length");
  assert.equal(summary.total, 2, "total cannot be smaller than count");

  // effective_count 是派生值；它和路径数打架时以路径为准。
  const mismatch = applySummary({
    apply_status: "partial",
    apply_partial: {
      stage: "提交 rename / commit",
      effective: ["/a.pem", "/b.pem"],
      effective_count: 9,
      total: 9,
    },
  });
  assert.equal(mismatch.count, 2);
  assert.equal(mismatch.total, 9);
});

test("partial with corrupt counts still shows without inventing a denominator", () => {
  const summary = applySummary({
    apply_status: "partial",
    apply_partial: {
      stage: "",
      effective: [],
      effective_count: -1,
      total: 3,
    },
  });
  assert.equal(summary.count, 0);
  assert.equal(summary.total, 3);
  assert.equal(summary.stage, null);
  assert.equal(summary.error, null);
});

test("effective paths are trimmed and non-strings are dropped", () => {
  const summary = applySummary({
    apply_status: "partial",
    apply_partial: {
      stage: "x",
      effective: ["  /a.pem  ", "", 42, null, "/b.pem"],
      effective_count: 2,
      total: 5,
    },
  });
  assert.deepEqual(summary.effective, ["/a.pem", "/b.pem"]);
  assert.equal(summary.count, 2);
  assert.equal(summary.total, 5);
});

test("failed keeps apply_error verbatim and has no stage/paths", () => {
  const error = "dial master: connection refused\n(retry later)";
  const summary = applySummary({
    apply_status: "failed",
    apply_error: error,
    apply_partial: {
      stage: "should be ignored",
      effective: ["/a.pem"],
      effective_count: 1,
      total: 1,
    },
  });
  assert.deepEqual(summary, {
    status: "failed",
    count: 0,
    total: 0,
    stage: null,
    effective: [],
    error,
  });
});

test("an empty or non-string apply_error is treated as no error", () => {
  for (const apply_error of ["", "   ", null, 42]) {
    const summary = applySummary({ apply_status: "failed", apply_error });
    assert.equal(summary.status, "failed");
    assert.equal(summary.error, null);
  }
  const spaced = applySummary({
    apply_status: "failed",
    apply_error: "  keep the original  ",
  });
  assert.equal(spaced.error, "  keep the original  ", "error is displayed verbatim");
});

test("partial without the structured object still gives a usable summary", () => {
  const summary = applySummary({
    apply_status: "partial",
    apply_error: "partial marker",
    apply_partial: null,
  });
  assert.equal(summary.status, "partial");
  assert.equal(summary.count, 0);
  assert.equal(summary.total, 0);
  assert.equal(summary.stage, null);
  assert.equal(summary.effective.length, 0);
  assert.equal(summary.error, "partial marker");
});
