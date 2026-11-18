import assert from "node:assert/strict";
import test from "node:test";
import { subscriptionUsage } from "./subscriptionUsage.ts";

const MiB = 1024 ** 2;

test("有套餐时优先使用套餐实例合计（与 /users 同口径）", () => {
  assert.deepEqual(
    subscriptionUsage({
      used_bytes: 0,
      quota_bytes: null,
      package_count: 1,
      package_used_bytes: 23 * 1024 * MiB,
      package_quota_bytes: 100 * 1024 * MiB,
    }),
    { usedBytes: 23 * 1024 * MiB, quotaBytes: 100 * 1024 * MiB },
  );
});

test("多张套餐实例使用后端聚合后的合计", () => {
  assert.deepEqual(
    subscriptionUsage({
      used_bytes: 0,
      quota_bytes: null,
      package_count: 2,
      package_used_bytes: 42 * MiB,
      package_quota_bytes: 300 * MiB,
    }),
    { usedBytes: 42 * MiB, quotaBytes: 300 * MiB },
  );
});

test("无套餐时回落到账户级用量与额度", () => {
  assert.deepEqual(
    subscriptionUsage({
      used_bytes: 7 * MiB,
      quota_bytes: 20 * MiB,
      package_count: 0,
      package_used_bytes: 0,
      package_quota_bytes: null,
    }),
    { usedBytes: 7 * MiB, quotaBytes: 20 * MiB },
  );
});

test("旧版后端没有聚合字段时回落到账户级", () => {
  assert.deepEqual(
    subscriptionUsage({
      used_bytes: 5 * MiB,
      quota_bytes: null,
      package_count: 1,
    }),
    { usedBytes: 5 * MiB, quotaBytes: null },
  );
});

test("套餐里有一张不限量时额度为 null（显示不限）", () => {
  assert.deepEqual(
    subscriptionUsage({
      used_bytes: 0,
      quota_bytes: 0,
      package_count: 1,
      package_used_bytes: 12 * MiB,
      package_quota_bytes: null,
    }),
    { usedBytes: 12 * MiB, quotaBytes: null },
  );
});
