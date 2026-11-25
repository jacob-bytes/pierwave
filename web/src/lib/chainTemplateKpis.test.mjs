import assert from "node:assert/strict";
import test from "node:test";
import {
  chainTemplateKpis,
  normalizeChainTemplateList,
} from "./chainTemplateInsight.ts";

/** 列表项的最小形状；字段含义见 `ChainTemplateListItem`。 */
function item(overrides = {}) {
  return {
    id: "tpl-1",
    name: "香港 → 东京",
    hops: 2,
    enabled: true,
    chains: 2,
    users: 1,
    status: { kind: "ok", cause: null },
    strategies: [],
    targets: [],
    ...overrides,
  };
}

test("四格 KPI 从列表聚合：总数 / 启用停用 / 在用 / 链数 / 用户", () => {
  const items = [
    item({ id: "a", chains: 4, users: 2, status: { kind: "blocked", cause: "member_offline" } }),
    item({ id: "b", chains: 2, users: 2, status: { kind: "ok", cause: null } }),
    item({
      id: "c",
      enabled: false,
      chains: 1,
      users: 1,
      status: { kind: "blocked", cause: "disabled" },
    }),
  ];

  assert.deepEqual(chainTemplateKpis(items), {
    total: 3,
    enabled: 2,
    disabled: 1,
    // 停用模板仍然有链在用：inUse 只看 chains > 0。
    inUse: 3,
    chains: 7,
    users: 5,
    blocked: 1,
    degraded: 0,
    abnormal: 1,
  });
});

test("停用模板的 blocked/disabled 不算异常，避免把主动停用报成故障", () => {
  const view = chainTemplateKpis([
    item({ id: "off", enabled: false, status: { kind: "blocked", cause: "disabled" } }),
    item({ id: "off-degraded", enabled: false, status: { kind: "degraded", cause: null } }),
  ]);
  assert.equal(view.blocked, 0);
  assert.equal(view.degraded, 0);
  assert.equal(view.abnormal, 0);
  assert.equal(view.disabled, 2);
});

test("启用模板的 blocked 与 degraded 分别计数，unknown 不算异常", () => {
  const view = chainTemplateKpis([
    item({ id: "a", status: { kind: "blocked", cause: "member_offline" } }),
    item({ id: "b", status: { kind: "degraded", cause: null } }),
    item({ id: "c", status: { kind: "degraded", cause: null } }),
    item({ id: "d", status: { kind: "unknown", cause: null } }),
  ]);
  assert.equal(view.blocked, 1);
  assert.equal(view.degraded, 2);
  assert.equal(view.abnormal, 3);
});

test("空列表聚合全 0；界面再把它渲染成 —（不在这里造 0 文案）", () => {
  assert.deepEqual(chainTemplateKpis([]), {
    total: 0,
    enabled: 0,
    disabled: 0,
    inUse: 0,
    chains: 0,
    users: 0,
    blocked: 0,
    degraded: 0,
    abnormal: 0,
  });
});

test("chains = 0 的模板不计入使用中，也不贡献链数；负数防御为 0", () => {
  const view = chainTemplateKpis([
    item({ id: "a", chains: 0, users: 0 }),
    item({ id: "b", chains: -3, users: -2 }),
    item({ id: "c", chains: 1, users: 1 }),
  ]);
  assert.equal(view.inUse, 1);
  assert.equal(view.chains, 1);
  assert.equal(view.users, 1);
});

test("归一化后的真实列表响应同样可聚合（含旧契约缺失字段）", () => {
  const snapshot = normalizeChainTemplateList({
    generated_at: 1_800_000_000,
    items: [
      {
        id: "a",
        name: "港日双路",
        hops: 3,
        enabled: true,
        chains: 4,
        users: 2,
        status: { kind: "blocked", cause: "member_offline" },
      },
      {
        id: "b",
        name: "港新单跳",
        hops: 1,
        enabled: true,
        chains: 2,
        users: 2,
        status: { kind: "ok" },
      },
      {
        id: "c",
        name: "美西备用线",
        hops: 2,
        enabled: false,
        chains: 1,
        users: 1,
        status: { kind: "blocked", cause: "disabled" },
      },
    ],
  });
  assert.deepEqual(chainTemplateKpis(snapshot.items), {
    total: 3,
    enabled: 2,
    disabled: 1,
    inUse: 3,
    chains: 7,
    users: 5,
    blocked: 1,
    degraded: 0,
    abnormal: 1,
  });
});
