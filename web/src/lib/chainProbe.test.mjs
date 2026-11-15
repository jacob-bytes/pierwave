import assert from "node:assert/strict";
import test from "node:test";
import {
  availabilityLabel,
  availabilityPercent,
  availabilityTone,
  bucketLoss,
  lossLabel,
  probeAttemptsLabel,
} from "./chainProbe.ts";

test("availabilityLabel shows 100%, one decimal otherwise, and — for unknown", () => {
  assert.equal(availabilityLabel(1), "100%");
  assert.equal(availabilityLabel(0.992), "99.2%");
  assert.equal(availabilityLabel(0), "0%", "全失败是 0%，不是 —");
  assert.equal(availabilityLabel(null), "—");
  assert.equal(availabilityLabel(undefined), "—");
  assert.equal(availabilityLabel(Number.NaN), "—");
  assert.equal(availabilityLabel(-1), "—", "越界脏数据不当成 0%");
  assert.equal(availabilityLabel(1.5), "—");
});

test("lossLabel keeps the probe-loss approximation readable", () => {
  assert.equal(lossLabel(0), "0%");
  assert.equal(lossLabel(0.008), "0.8%");
  assert.equal(lossLabel(null), "—");
});

test("availabilityTone only uses muted/warning/default", () => {
  assert.equal(availabilityTone(null), "muted", "没有数据不能显示成告警");
  assert.equal(availabilityTone(1), "default");
  assert.equal(availabilityTone(0.99), "default", "等于阈值不算低于");
  assert.equal(availabilityTone(0.989), "warning");
  // 阈值可配：98% 的链在阈值 97% 时不告警。
  assert.equal(availabilityTone(0.98, 97), "default");
  assert.equal(availabilityTone(0.98, 99), "warning");
  // 非法阈值回落默认，而不是把整列都标黄。
  assert.equal(availabilityTone(0.995, Number.NaN), "default");
});

test("availabilityPercent rejects out-of-range ratios", () => {
  assert.equal(availabilityPercent(0.5), 50);
  assert.equal(availabilityPercent(null), null);
  assert.equal(availabilityPercent(2), null);
  assert.equal(availabilityPercent(-0.1), null);
});

test("bucketLoss is a plain ratio for trend points", () => {
  assert.equal(bucketLoss(0, 0), null, "没有探测的桶不画点");
  assert.equal(bucketLoss(10, 0), 0);
  assert.equal(bucketLoss(10, 1), 0.1);
  assert.equal(bucketLoss(10, 11), null, "失败数超过次数是脏数据");
  assert.equal(bucketLoss(null, 1), null);
});

test("probeAttemptsLabel compacts large counts", () => {
  assert.equal(probeAttemptsLabel(0), "0");
  assert.equal(probeAttemptsLabel(999), "999");
  assert.equal(probeAttemptsLabel(1_234), "1.2k");
  assert.equal(probeAttemptsLabel(12_345), "12k");
  assert.equal(probeAttemptsLabel(null), "—");
  assert.equal(probeAttemptsLabel(-1), "—");
});
