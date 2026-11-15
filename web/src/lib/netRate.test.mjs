import assert from "node:assert/strict";
import test from "node:test";
import {
  formatRate,
  formatRatePairText,
  formatTrafficTotal,
  rateParts,
} from "./netRate.ts";

test("rateParts formats bytes per second with 1024 steps", () => {
  assert.deepEqual(rateParts(0), { value: "0", unit: "B/s" });
  assert.deepEqual(rateParts(512), { value: "512", unit: "B/s" });
  assert.deepEqual(rateParts(1024), { value: "1", unit: "KB/s" });
  assert.deepEqual(rateParts(1_500), { value: "1.46", unit: "KB/s" });
  // 需求示例：12.3 MB/s。
  assert.deepEqual(rateParts(12.3 * 1024 * 1024), {
    value: "12.3",
    unit: "MB/s",
  });
  assert.deepEqual(rateParts(1.2 * 1024 * 1024), {
    value: "1.2",
    unit: "MB/s",
  });
  assert.deepEqual(rateParts(1024 ** 3 * 1.5), { value: "1.5", unit: "GB/s" });
});

test("rateParts treats missing and invalid values as no data", () => {
  assert.equal(rateParts(null), null);
  assert.equal(rateParts(undefined), null);
  assert.equal(rateParts(Number.NaN), null);
  assert.equal(rateParts(Number.POSITIVE_INFINITY), null);
  assert.equal(rateParts(-1), null, "负速率只可能是脏数据");
});

test("formatRate keeps real zero and marks unknown as null", () => {
  assert.equal(formatRate(0), "0 B/s", "0 是有效数据，不能显示成 —");
  assert.equal(formatRate(1.2 * 1024 * 1024), "1.2 MB/s");
  assert.equal(formatRate(null), null, "没有数据由调用方渲染 —");
});

test("formatRatePairText renders both directions and never invents values", () => {
  assert.equal(
    formatRatePairText(1.2 * 1024 * 1024, 1024 * 1024),
    "↓ 1.2 MB/s · ↑ 1 MB/s",
  );
  assert.equal(formatRatePairText(0, null), "↓ 0 B/s · ↑ —");
  assert.equal(
    formatRatePairText(null, null),
    null,
    "两侧都没有数据时不给文案",
  );
});

test("formatTrafficTotal formats cumulative bytes and keeps real zero", () => {
  assert.equal(formatTrafficTotal(0), "0 B", "0 是有效计数，不能显示成 —");
  assert.equal(formatTrafficTotal(1_536), "1.5 KB");
  assert.equal(formatTrafficTotal(1.48 * 1024 ** 3), "1.48 GB");
  assert.equal(formatTrafficTotal(null), null);
  assert.equal(formatTrafficTotal(undefined), null);
  assert.equal(formatTrafficTotal(Number.NaN), null);
  assert.equal(formatTrafficTotal(-1), null, "负字节只可能是脏数据");
});
