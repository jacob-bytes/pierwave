import assert from "node:assert/strict";
import test from "node:test";
import {
  formatRate,
  formatRateExact,
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

test("rateParts carries a rounded 1024 into the next unit", () => {
  // 1024^4 - 1 B/s 先缩放到 GB 再四舍五入会得到 1024 GB/s；必须进位。
  assert.deepEqual(rateParts(1024 ** 4 - 1), { value: "1", unit: "TB/s" });
  assert.deepEqual(rateParts(1024 ** 5 - 1), { value: "1", unit: "PB/s" });
  // 真正的 1024 GB/s 同样应显示 1 TB/s。
  assert.deepEqual(rateParts(1024 ** 4), { value: "1", unit: "TB/s" });
  // 没有超过阈值时不能乱进位。
  assert.deepEqual(rateParts(1023 * 1024 ** 3), {
    value: "1023",
    unit: "GB/s",
  });
});

test("rateParts distinguishes sub-byte nonzero from real zero", () => {
  assert.equal(formatRate(0), "0 B/s", "真实 0 仍显示 0");
  assert.equal(formatRate(0.4), "<1 B/s", "非零不能四舍五入成 0");
  assert.equal(formatRate(0.001), "<1 B/s");
  assert.deepEqual(rateParts(0.4), { value: "<1", unit: "B/s" });
  // tooltip / 读屏读数保留非零小数，不跟着大数字写成 <1。
  assert.equal(formatRateExact(0.4), "0.4 B/s");
  assert.equal(formatRateExact(0.001), "0.001 B/s");
  assert.equal(formatRateExact(0.0004), "0.0004 B/s");
  assert.equal(
    formatRateExact(0.9999),
    "0.9999 B/s",
    "tooltip 不能把 0.9999 四舍五入成 1 B/s",
  );
  assert.equal(formatRateExact(0), "0 B/s");
  assert.equal(formatRateExact(null), null);
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
