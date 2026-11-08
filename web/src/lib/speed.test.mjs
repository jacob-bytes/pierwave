import assert from "node:assert/strict";
import test from "node:test";
import {
  formatMbps,
  isSpeedLimited,
  isValidSpeedLimitMbpsInput,
  kbpsToMbps,
  kbpsToMbpsInput,
  mbpsInputToKbps,
  SPEED_LIMIT_MAX_MBPS,
} from "./speed.ts";

test("isSpeedLimited treats 0, null and undefined as unlimited", () => {
  assert.equal(isSpeedLimited(0), false);
  assert.equal(isSpeedLimited(null), false);
  assert.equal(isSpeedLimited(undefined), false);
  assert.equal(isSpeedLimited(Number.NaN), false);
  assert.equal(isSpeedLimited(-1), false);
  assert.equal(isSpeedLimited(1), true);
  assert.equal(isSpeedLimited(100_000), true);
});

test("kbpsToMbps uses 1000 kbps = 1 Mbps", () => {
  assert.equal(kbpsToMbps(1_000), 1);
  assert.equal(kbpsToMbps(100_000), 100);
  assert.equal(kbpsToMbps(1_234), 1.234);
});

test("formatMbps trims trailing zeroes and returns empty for unlimited", () => {
  assert.equal(formatMbps(100_000), "100");
  assert.equal(formatMbps(50_000), "50");
  assert.equal(formatMbps(1_500), "1.5");
  assert.equal(formatMbps(1_234), "1.234");
  assert.equal(formatMbps(0), "");
  assert.equal(formatMbps(null), "");
  assert.equal(formatMbps(undefined), "");
});

test("kbpsToMbpsInput round-trips through mbpsInputToKbps", () => {
  assert.equal(kbpsToMbpsInput(0), "");
  assert.equal(kbpsToMbpsInput(null), "");
  assert.equal(kbpsToMbpsInput(100_000), "100");
  assert.equal(kbpsToMbpsInput(500), "0.5");
  assert.equal(kbpsToMbpsInput(1_234), "1.234");
  assert.equal(kbpsToMbpsInput(SPEED_LIMIT_MAX_MBPS * 1_000), "10000");

  for (const kbps of [1, 500, 1_234, 50_000, 100_000, 10_000_000]) {
    assert.equal(mbpsInputToKbps(kbpsToMbpsInput(kbps)), kbps);
  }
});

test("mbpsInputToKbps treats blank and zero as unlimited", () => {
  assert.equal(mbpsInputToKbps(""), 0);
  assert.equal(mbpsInputToKbps("   "), 0);
  assert.equal(mbpsInputToKbps("0"), 0);
  assert.equal(mbpsInputToKbps("0.000"), 0);
  assert.equal(mbpsInputToKbps("100"), 100_000);
  assert.equal(mbpsInputToKbps(" 0.5 "), 500);
  assert.equal(mbpsInputToKbps("1.234"), 1_234);
});

test("isValidSpeedLimitMbpsInput accepts 0-10000 with up to 3 decimals", () => {
  assert.equal(isValidSpeedLimitMbpsInput(""), true);
  assert.equal(isValidSpeedLimitMbpsInput("   "), true);
  assert.equal(isValidSpeedLimitMbpsInput("0"), true);
  assert.equal(isValidSpeedLimitMbpsInput("0.001"), true);
  assert.equal(isValidSpeedLimitMbpsInput("1.234"), true);
  assert.equal(isValidSpeedLimitMbpsInput("10000"), true);
  assert.equal(isValidSpeedLimitMbpsInput("10000.000"), true);
  assert.equal(isValidSpeedLimitMbpsInput(" 250 "), true);

  assert.equal(isValidSpeedLimitMbpsInput("10000.001"), false);
  assert.equal(isValidSpeedLimitMbpsInput("1.2345"), false);
  assert.equal(isValidSpeedLimitMbpsInput("-1"), false);
  assert.equal(isValidSpeedLimitMbpsInput("abc"), false);
  assert.equal(isValidSpeedLimitMbpsInput("1,5"), false);
  assert.equal(isValidSpeedLimitMbpsInput(".5"), false);
});
