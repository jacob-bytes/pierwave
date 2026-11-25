import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAIN_LIST_STATUS_FILTERS,
  DEFAULT_CHAIN_LIST_SORT,
  DEFAULT_CHAIN_LIST_STATUS_FILTER,
  applyChainListFilters,
  chainListSortDefaultDirection,
  chainListStatusCounts,
  chainListStatusOf,
  chainListStatusParam,
  chainMatchesQuery,
  chainSearchHaystack,
  isChainListStatusFilter,
  normalizeChainListQuery,
  resolveChainListStatusFilter,
  sortChainList,
  toggleChainListSort,
  visibleChainListStatuses,
} from "./chainListFilters.ts";
import { chainHealthState } from "./chainHealth.ts";
import { CHAIN_STATE_LABEL_KEYS } from "./chainStatusText.ts";

function point(ts, p50, samples = 2, lossPct = null) {
  return { ts, p50, p10: null, p90: null, samples, lossPct };
}

function chain(overrides = {}) {
  return {
    id: "chain-1",
    name: "港日中转链",
    hops: 2,
    status: null,
    lastHop: null,
    entry: null,
    exit: null,
    nodes: [],
    missingHops: [],
    estimated: false,
    series: [],
    segments: [],
    diagnosis: { kind: "unknown", seq: null },
    latestP50: null,
    deltaMs: null,
    slow: false,
    hasSamples: false,
    lastHopMissing: false,
    lossPct: null,
    lossPartial: false,
    lossSamples: null,
    ...overrides,
  };
}

function config(overrides = {}) {
  return { enabled: true, degraded: false, blocked_reason: null, ...overrides };
}

test("status filter 参数集合与默认值稳定", () => {
  assert.deepEqual(CHAIN_LIST_STATUS_FILTERS, [
    "all",
    "ok",
    "degraded",
    "blocked",
    "unknown",
    "insufficient",
    "disabled",
  ]);
  assert.equal(DEFAULT_CHAIN_LIST_STATUS_FILTER, "all");
  assert.equal(isChainListStatusFilter("blocked"), true);
  for (const value of [null, undefined, "", "Blocked", "slow", "0"]) {
    assert.equal(isChainListStatusFilter(value), false);
    assert.equal(resolveChainListStatusFilter(value), "all");
  }
  for (const status of CHAIN_LIST_STATUS_FILTERS) {
    assert.equal(resolveChainListStatusFilter(status), status);
  }
});

test("默认状态不写 URL，其它状态写 ?status=", () => {
  assert.equal(chainListStatusParam("all"), null);
  assert.equal(chainListStatusParam("ok"), "ok");
  assert.equal(chainListStatusParam("blocked"), "blocked");
  assert.equal(chainListStatusParam("disabled"), "disabled");
});

test("applyChainListFilters 写入 status / q 且保留其它参数", () => {
  const params = new URLSearchParams("view=chain&section=chains&servers=hk-01");
  const next = applyChainListFilters(params, { status: "blocked", q: "港日" });

  assert.equal(next.get("view"), "chain");
  assert.equal(next.get("section"), "chains");
  assert.equal(next.get("servers"), "hk-01");
  assert.equal(next.get("status"), "blocked");
  assert.equal(next.get("q"), "港日");
  // 不改入参
  assert.equal(params.get("status"), null);
  assert.equal(params.get("q"), null);
});

test("默认状态与空关键词会删掉参数，空白关键词按空处理", () => {
  const params = new URLSearchParams("view=chain&status=blocked&q=hk");
  assert.equal(
    applyChainListFilters(params, { status: "all", q: "" }).toString(),
    "view=chain",
  );
  assert.equal(
    applyChainListFilters(params, { status: "all", q: "   " }).get("q"),
    null,
  );
});

test("applyChainListFilters 往返不产生重复参数", () => {
  let params = new URLSearchParams("");
  params = applyChainListFilters(params, { status: "ok", q: "香港" });
  params = applyChainListFilters(params, { status: "all", q: "" });
  params = applyChainListFilters(params, { status: "ok", q: "香港" });

  assert.equal(params.getAll("status").length, 1);
  assert.equal(params.getAll("q").length, 1);
  assert.equal(params.get("status"), "ok");
  assert.equal(params.get("q"), "香港");
});

test("normalizeChainListQuery 只 trim 首尾空白", () => {
  assert.equal(normalizeChainListQuery("  港日  "), "港日");
  assert.equal(normalizeChainListQuery("  "), "");
  assert.equal(normalizeChainListQuery(null), "");
  assert.equal(normalizeChainListQuery(undefined), "");
});

test("状态筛选与列表徽章同口径", () => {
  const cases = [
    [chain({ status: { kind: "blocked", cause: "node_offline", node: null } }), null, "blocked"],
    [chain({ status: { kind: "degraded", cause: "node_unhealthy", node: null } }), null, "degraded"],
    [chain({ status: { kind: "unknown", cause: "unmeasurable", node: null } }), null, "unknown"],
    [
      chain({ status: { kind: "ok", cause: null, node: null }, hasSamples: false, deltaMs: null }),
      null,
      "insufficient",
    ],
    [
      chain({ status: { kind: "ok", cause: null, node: null }, hasSamples: true, deltaMs: 4, latestP50: 20 }),
      null,
      "ok",
    ],
    // kind = ok 但链路配置停用：徽章显示「停用」，筛选也归到停用。
    [chain({ status: { kind: "ok", cause: null, node: null }, hasSamples: true }), config({ enabled: false }), "disabled"],
    // 旧契约没有 status：停用 / blocked_reason / degraded 依次生效。
    [chain(), config({ enabled: false }), "disabled"],
    [chain(), config({ blocked_reason: "证书已过期" }), "blocked"],
    [chain(), config({ degraded: true }), "degraded"],
    // 有样本但变慢：状态列仍是「正常」+「变慢」徽章。
    [chain({ hasSamples: true, deltaMs: 12, slow: true, latestP50: 30 }), config(), "ok"],
  ];

  for (const [item, itemConfig, expected] of cases) {
    assert.equal(chainListStatusOf(item, itemConfig), expected);
    assert.equal(chainHealthState(item, itemConfig), expected);
  }
});

test("各状态计数覆盖所有链，停用单独计数", () => {
  const chains = [
    chain({ id: "a", status: { kind: "ok", cause: null, node: null }, hasSamples: true, deltaMs: 1 }),
    chain({ id: "b", status: { kind: "degraded", cause: "slow", node: null } }),
    chain({ id: "c", status: { kind: "blocked", cause: "node_offline", node: null } }),
    chain({ id: "d", status: { kind: "unknown", cause: "unmeasurable", node: null } }),
    chain({ id: "e", status: { kind: "ok", cause: null, node: null }, hasSamples: false }),
    chain({ id: "f", status: { kind: "ok", cause: null, node: null }, hasSamples: true }),
  ];
  const configById = new Map([["f", config({ enabled: false })]]);

  const counts = chainListStatusCounts(chains, configById);
  assert.deepEqual(counts, {
    all: 6,
    ok: 1,
    degraded: 1,
    blocked: 1,
    unknown: 1,
    insufficient: 1,
    disabled: 1,
  });
  assert.equal(
    counts.ok + counts.degraded + counts.blocked + counts.unknown +
      counts.insufficient + counts.disabled,
    counts.all,
  );
});

test("停用档位只在有停用链时出现在下拉里", () => {
  const base = {
    all: 3,
    ok: 1,
    degraded: 1,
    blocked: 1,
    unknown: 0,
    insufficient: 0,
    disabled: 0,
  };
  assert.deepEqual(visibleChainListStatuses(base), [
    "ok",
    "degraded",
    "blocked",
    "unknown",
    "insufficient",
  ]);
  assert.deepEqual(visibleChainListStatuses({ ...base, disabled: 1 }), [
    "ok",
    "degraded",
    "blocked",
    "unknown",
    "insufficient",
    "disabled",
  ]);
});

function searchableChain() {
  return chain({
    name: "港日中转链",
    entry: {
      ip: "203.0.113.10",
      port: 443,
      address: "203.0.113.10:443",
      serverName: "香港-01",
    },
    exit: {
      ip: "198.51.100.20",
      port: 8443,
      address: "198.51.100.20:8443",
      serverName: "东京-02",
    },
    nodes: [
      {
        seq: 0,
        name: "香港-01",
        role: "source",
        status: "online",
        members: [{ serverId: "hk-01", name: "hk-edge-a", status: "online" }],
        memberCount: 1,
      },
      {
        seq: 1,
        name: "东京-02",
        role: "target",
        status: null,
        members: [],
        memberCount: null,
      },
    ],
    segments: [
      {
        seq: 1,
        from: "香港-01",
        to: "东京-02",
        p50: 42,
        deltaMs: 2,
        contributionPct: 100,
        missing: false,
        lossPct: 0,
        attempts: 100,
        failures: 0,
        series: [],
      },
    ],
  });
}

test("关键词匹配链路名、地址、服务器名、路由与模板名", () => {
  const item = searchableChain();
  const extra = {
    templateName: "东京中转模板",
    entryAddress: "hk.example.com:443",
    groupNames: ["港日入口组"],
    serverNames: ["hk-backup-01"],
  };
  const haystack = chainSearchHaystack(item, extra);
  for (const value of [
    "港日",
    "203.0.113.10",
    "8443",
    "香港-01",
    "东京-02",
    "hk-edge-a",
    "东京中转模板",
    "hk.example.com",
    "港日入口组",
    "hk-backup-01",
  ]) {
    assert.equal(haystack.includes(value.toLowerCase()), true, value);
    assert.equal(chainMatchesQuery(item, value, extra), true, value);
  }
});

test("关键词不区分大小写，空格分隔的多个词按 AND 叠加", () => {
  const item = searchableChain();
  assert.equal(chainMatchesQuery(item, "HK-EDGE-A"), true);
  assert.equal(chainMatchesQuery(item, "港日 东京"), true);
  assert.equal(chainMatchesQuery(item, "港日 大阪"), false);
  assert.equal(chainMatchesQuery(item, "nope"), false);
});

test("空关键词匹配全部，缺失字段不会命中 — / …", () => {
  const item = searchableChain();
  assert.equal(chainMatchesQuery(item, ""), true);
  assert.equal(chainMatchesQuery(item, "   "), true);
  assert.equal(chainMatchesQuery(item, "—"), false);
  assert.equal(chainMatchesQuery(item, "…"), false);
});

test("默认排序保持原有顺序，且不改入参", () => {
  const chains = [chain({ id: "b" }), chain({ id: "a" }), chain({ id: "c" })];
  const sorted = sortChainList(chains, DEFAULT_CHAIN_LIST_SORT);
  assert.deepEqual(sorted.map((item) => item.id), ["b", "a", "c"]);
  assert.deepEqual(chains.map((item) => item.id), ["b", "a", "c"]);
  assert.notEqual(sorted, chains);
});

test("P50 排序：升序 / 降序，没有数据的排最后", () => {
  const chains = [
    chain({ id: "none" }),
    chain({ id: "slow", latestP50: 90 }),
    chain({ id: "fast", latestP50: 12 }),
    chain({ id: "mid", latestP50: 40 }),
  ];
  assert.deepEqual(
    sortChainList(chains, { key: "p50", direction: "asc" }).map((item) => item.id),
    ["fast", "mid", "slow", "none"],
  );
  assert.deepEqual(
    sortChainList(chains, { key: "p50", direction: "desc" }).map((item) => item.id),
    ["slow", "mid", "fast", "none"],
  );
});

test("丢包排序：null 不当作 0，始终排最后", () => {
  const chains = [
    chain({ id: "none", lossPct: null }),
    chain({ id: "zero", lossPct: 0 }),
    chain({ id: "high", lossPct: 4.2 }),
  ];
  assert.deepEqual(
    sortChainList(chains, { key: "loss", direction: "asc" }).map((item) => item.id),
    ["zero", "high", "none"],
  );
  assert.deepEqual(
    sortChainList(chains, { key: "loss", direction: "desc" }).map((item) => item.id),
    ["high", "zero", "none"],
  );
});

test("最近样本排序：默认最新在前，空样本排最后", () => {
  const chains = [
    chain({ id: "none" }),
    chain({ id: "old", series: [point(100, 20)] }),
    chain({ id: "new", series: [point(900, 20)] }),
  ];
  assert.deepEqual(
    sortChainList(chains, { key: "latest", direction: "desc" }).map((item) => item.id),
    ["new", "old", "none"],
  );
  assert.deepEqual(
    sortChainList(chains, { key: "latest", direction: "asc" }).map((item) => item.id),
    ["old", "new", "none"],
  );
});

test("排序切换：同维度翻转方向，换维度用默认方向，默认项复位", () => {
  assert.deepEqual(toggleChainListSort(DEFAULT_CHAIN_LIST_SORT, "p50"), {
    key: "p50",
    direction: "asc",
  });
  assert.deepEqual(
    toggleChainListSort({ key: "p50", direction: "asc" }, "p50"),
    { key: "p50", direction: "desc" },
  );
  assert.deepEqual(
    toggleChainListSort({ key: "p50", direction: "desc" }, "p50"),
    { key: "p50", direction: "asc" },
  );
  assert.deepEqual(toggleChainListSort({ key: "p50", direction: "asc" }, "latest"), {
    key: "latest",
    direction: "desc",
  });
  assert.deepEqual(toggleChainListSort({ key: "loss", direction: "asc" }, "default"), {
    key: "default",
    direction: "asc",
  });
  assert.equal(chainListSortDefaultDirection("p50"), "asc");
  assert.equal(chainListSortDefaultDirection("loss"), "asc");
  assert.equal(chainListSortDefaultDirection("latest"), "desc");
  assert.equal(chainListSortDefaultDirection("default"), "asc");
});

test("筛选档位覆盖徽章的全部 ChainHealthState（停用不是新语义）", () => {
  const badgeStates = [
    "ok",
    "degraded",
    "blocked",
    "unknown",
    "insufficient",
    "disabled",
  ];
  const filterStates = CHAIN_LIST_STATUS_FILTERS.filter(
    (status) => status !== "all",
  );
  assert.deepEqual([...filterStates].sort(), [...badgeStates].sort());
  // 每个档位直接复用徽章的 i18n 键，文案与颜色来源一致。
  for (const state of badgeStates) {
    assert.equal(typeof CHAIN_STATE_LABEL_KEYS[state], "string", state);
  }
  assert.equal(
    CHAIN_STATE_LABEL_KEYS.disabled,
    "chains.status.disabled",
    "停用档与徽章使用同一个标签键",
  );
  assert.equal(
    CHAIN_STATE_LABEL_KEYS.ok,
    "overview.chainLatency.healthHealthy",
  );
});
