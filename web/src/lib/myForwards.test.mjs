import assert from "node:assert/strict";
import test from "node:test";
import {
  canCreate,
  createGate,
  entryLabel,
  forwardServersReason,
  quotaState,
} from "./myForwards.ts";

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

// ---------------------------------------------------------------------------
// U1：新建入口状态机（配额 × 存量 × 可用服务器/模板）
// ---------------------------------------------------------------------------
test("createGate keeps existing forwards manageable when the package no longer allows new ones", () => {
  // limit = 0 但有 2 条存量：列表必须继续展示，只禁用新建，徽章改成「存量 2 条」。
  const gate = createGate({
    quota: { used: 2, limit: 0 },
    itemCount: 2,
    availableCount: 0,
  });
  assert.equal(gate.blocker, "stock");
  assert.equal(gate.creatable, false);
  assert.equal(gate.showList, true);
  assert.equal(gate.badge, "stock");
});

test("createGate reports unsupported when the package has no quota and nothing exists", () => {
  // limit = 0 且没有存量：隐藏新建按钮，配额徽章不能显示成 `0 / 0`。
  const gate = createGate({
    quota: { used: 0, limit: 0 },
    itemCount: 0,
    availableCount: 0,
  });
  assert.equal(gate.blocker, "unsupported");
  assert.equal(gate.creatable, false);
  assert.equal(gate.showList, false);
  assert.equal(gate.badge, null);
});

test("createGate blocks create when no server is authorized", () => {
  // 配额正常（1 / 5）但 forward_servers = []：禁用新建并给出可解释的原因。
  const gate = createGate({
    quota: { used: 1, limit: 5 },
    itemCount: 1,
    availableCount: 0,
  });
  assert.equal(gate.blocker, "no-availability");
  assert.equal(gate.creatable, false);
  assert.equal(gate.showList, true);
  assert.equal(gate.badge, "ratio");
});

test("createGate allows create when quota and servers are both available", () => {
  const gate = createGate({
    quota: { used: 1, limit: 5 },
    itemCount: 1,
    availableCount: 2,
  });
  assert.equal(gate.blocker, null);
  assert.equal(gate.creatable, true);
  assert.equal(gate.showList, true);
  assert.equal(gate.badge, "ratio");
});

test("createGate treats unknown availability as not blocking", () => {
  // 服务器列表 / 模板还没返回时不能误判成「没有授权」。
  const gate = createGate({ quota: { used: 0, limit: 2 }, itemCount: 0 });
  assert.equal(gate.blocker, null);
  assert.equal(gate.creatable, true);
  assert.equal(
    createGate({
      quota: { used: 0, limit: 2 },
      itemCount: 0,
      availableCount: null,
    }).creatable,
    true,
  );
});

test("createGate gives quota-exhausted precedence over missing availability", () => {
  const gate = createGate({
    quota: { used: 5, limit: 5 },
    itemCount: 5,
    availableCount: 0,
  });
  assert.equal(gate.blocker, "exhausted");
  assert.equal(gate.badge, "ratio");
});

test("createGate tolerates invalid counts", () => {
  const gate = createGate({
    quota: null,
    itemCount: Number.NaN,
    availableCount: 0,
  });
  assert.equal(gate.blocker, "unsupported");
  assert.equal(gate.showList, false);
  assert.equal(gate.badge, null);
});

// ---------------------------------------------------------------------------
// 后端新增的 forward_servers_reason（旧后端缺失时回落 servers.length）
// ---------------------------------------------------------------------------
test("forwardServersReason maps the backend explanation codes", () => {
  assert.equal(
    forwardServersReason("package.forward_servers_empty"),
    "no-servers",
  );
  assert.equal(
    forwardServersReason("package.forward_limit_zero"),
    "no-limit",
  );
  // 旧后端 / 未知码：返回 null，调用方回落到 servers.length。
  assert.equal(forwardServersReason(null), null);
  assert.equal(forwardServersReason(undefined), null);
  assert.equal(forwardServersReason("package.something_else"), null);
  assert.equal(forwardServersReason(""), null);
});
