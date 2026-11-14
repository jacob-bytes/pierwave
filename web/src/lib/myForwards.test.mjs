import assert from "node:assert/strict";
import test from "node:test";
import { canCreate, entryLabel, quotaState } from "./myForwards.ts";

test("quotaState reports none when there is no quota or the limit is zero", () => {
  assert.equal(quotaState(null), "none");
  assert.equal(quotaState(undefined), "none");
  assert.equal(quotaState({}), "none");
  // 0 / 负数 / 非数字都按「当前套餐不支持」处理，不能除零或给出负数可用量。
  assert.equal(quotaState({ used: 0, limit: 0 }), "none");
  assert.equal(quotaState({ used: 2, limit: -1 }), "none");
  assert.equal(quotaState({ used: 0, limit: Number.NaN }), "none");
});

test("quotaState separates available from exhausted at the boundary", () => {
  assert.equal(quotaState({ used: 0, limit: 3 }), "available");
  assert.equal(quotaState({ used: 1, limit: 3 }), "available");
  // 边界：used == limit 必须算用尽，不能允许再新建。
  assert.equal(quotaState({ used: 2, limit: 3 }), "available");
  assert.equal(quotaState({ used: 3, limit: 3 }), "exhausted");
  assert.equal(quotaState({ used: 9, limit: 3 }), "exhausted");
});

test("quotaState treats invalid used values as zero instead of crashing", () => {
  assert.equal(quotaState({ limit: 2 }), "available");
  assert.equal(quotaState({ used: null, limit: 2 }), "available");
  // undefined / NaN / 负数用量都夹到 0，配额仍然可用。
  assert.equal(quotaState({ used: Number.NaN, limit: 2 }), "available");
  assert.equal(quotaState({ used: -5, limit: 2 }), "available");
});

test("canCreate is true only when quotaState is available", () => {
  assert.equal(canCreate({ used: 0, limit: 1 }), true);
  assert.equal(canCreate({ used: 1, limit: 1 }), false);
  assert.equal(canCreate({ used: 0, limit: 0 }), false);
  assert.equal(canCreate(null), false);
});

test("entryLabel trims the backend address and never invents one", () => {
  assert.equal(
    entryLabel({ entry_address: " 203.0.113.10:24123 " }),
    "203.0.113.10:24123",
  );
  // 已带方括号的 IPv6 原样保留。
  assert.equal(entryLabel({ entry_address: "[2001:db8::1]:443" }), "[2001:db8::1]:443");
  // 空串 / 纯空白 / 缺失：给占位符而不是拿 listen_port 拼一个不可复制的地址。
  assert.equal(entryLabel({ entry_address: "   ", listen_port: 24123 }), "—");
  assert.equal(entryLabel({ entry_address: null, listen_port: 24123 }), "—");
  assert.equal(entryLabel({ listen_port: 24123 }), "—");
  assert.equal(entryLabel(null), "—");
});
