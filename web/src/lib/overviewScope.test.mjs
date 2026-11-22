import assert from "node:assert/strict";
import test from "node:test";
import {
  chainMatchesScope,
  defaultOverviewSelection,
  filterChainsByScope,
  filterServersByIds,
  isOverviewScopeFiltered,
  overviewSelectionMode,
  parseServerIdsParam,
  resolveOverviewSelection,
  scopeGroupRows,
  selectedOnlineCount,
  selectedScopeGroupKey,
  serializeServerIds,
  serverIdsSelectionParam,
} from "./overviewScope.ts";

function server(id, overrides = {}) {
  return {
    id,
    name: id,
    status: "online",
    group_name: null,
    load1: 0.2,
    mem_used: 2,
    mem_total: 10,
    disk_used: 3,
    disk_total: 10,
    ...overrides,
  };
}

test("?servers= 解析：缺失 / 空串 / 去重与 trim 是三种不同语义", () => {
  assert.equal(parseServerIdsParam(null), null);
  assert.deepEqual(parseServerIdsParam(""), []);
  assert.deepEqual(parseServerIdsParam("  , ,"), []);
  assert.deepEqual(parseServerIdsParam("a, b ,a,,c"), ["a", "b", "c"]);
});

test("写回 URL：保留用户顺序、去重，空集合写成空串", () => {
  assert.equal(serializeServerIds(["b", "a", "b"]), "b,a");
  assert.equal(serializeServerIds([]), "");
  assert.equal(serializeServerIds([" a ", "", "b"]), "a,b");
});

test("默认全选：无论多少台都保持服务器列表顺序", () => {
  for (const count of [0, 1, 10, 12, 250]) {
    const servers = Array.from({ length: count }, (_, index) =>
      server(`s${index}`),
    );
    assert.deepEqual(
      defaultOverviewSelection(servers),
      servers.map((item) => item.id),
    );
  }
});

test(">10 台也默认全选，不再挑「问题优先的 8 台」", () => {
  const servers = [
    server("ok-1", { name: "a" }),
    server("offline", { name: "z", status: "offline" }),
    server("load", { name: "y", load1: 9 }),
    ...Array.from({ length: 20 }, (_, index) =>
      server(`ok-${index + 2}`, { name: `b${index}` }),
    ),
  ];
  const selected = defaultOverviewSelection(servers);
  assert.equal(selected.length, servers.length);
  assert.deepEqual(selected, servers.map((item) => item.id));
});

test("URL 参数：全选删除参数，空选写空串，部分选择写 id 列表", () => {
  const servers = [server("a"), server("b"), server("c")];
  assert.equal(serverIdsSelectionParam(servers, ["c", "a", "b"]), null);
  assert.equal(serverIdsSelectionParam(servers, []), "");
  assert.equal(serverIdsSelectionParam(servers, ["b", "a"]), "b,a");
  // 服务器列表为空时，「全选」同样不写参数。
  assert.equal(serverIdsSelectionParam([], []), null);
});

test("参数缺失用默认；空串就是空选择；失效 id 被剔除", () => {
  const servers = Array.from({ length: 12 }, (_, index) =>
    server(`s${index}`),
  );
  const fallback = servers.map((item) => item.id);
  assert.deepEqual(resolveOverviewSelection(servers, null), fallback);
  assert.deepEqual(resolveOverviewSelection(servers, ""), []);
  assert.deepEqual(resolveOverviewSelection(servers, "s1,deleted,s3"), [
    "s1",
    "s3",
  ]);
  // 全部失效（例如分享链接来自另一套环境）时回落到全选，而不是空态。
  assert.deepEqual(resolveOverviewSelection(servers, "gone,missing"), fallback);
  // 参数里恰好包含全部服务器时也等价于全选。
  assert.deepEqual(resolveOverviewSelection(servers, fallback.join(",")), fallback);
  assert.equal(
    isOverviewScopeFiltered(
      servers,
      resolveOverviewSelection(servers, fallback.join(",")),
    ),
    false,
  );
});

test("分组行按名称排序、未分组最后，并带组内数量", () => {
  const servers = [
    server("a", { group_name: "日本" }),
    server("b", { group_name: "香港" }),
    server("c", { group_name: null }),
    server("d", { group_name: "日本" }),
    server("e", { group_name: "  " }),
  ];
  const groups = scopeGroupRows(servers);
  assert.deepEqual(
    groups.map((group) => [group.key, group.count]),
    [
      ["group:日本", 2],
      ["group:香港", 1],
      ["ungrouped", 2],
    ],
  );
  assert.deepEqual(groups[0].ids, ["a", "d"]);
  assert.equal(groups[2].ungrouped, true);
});

test("范围模式：全选 / 单组 / 自定义", () => {
  const servers = [
    server("a", { group_name: "香港" }),
    server("b", { group_name: "香港" }),
    server("c", { group_name: "日本" }),
  ];
  assert.equal(overviewSelectionMode(servers, ["a", "b", "c"]), "all");
  assert.equal(overviewSelectionMode(servers, ["a", "b"]), "group");
  assert.equal(selectedScopeGroupKey(servers, ["a", "b"]), "group:香港");
  assert.equal(overviewSelectionMode(servers, ["a", "c"]), "custom");
  assert.equal(overviewSelectionMode(servers, []), "custom");
});

test("范围过滤只按选中集合缩小，不影响服务器顺序", () => {
  const servers = [server("a"), server("b"), server("c")];
  assert.deepEqual(
    filterServersByIds(servers, ["c", "a"]).map((item) => item.id),
    ["a", "c"],
  );
  assert.equal(isOverviewScopeFiltered(servers, ["a", "b", "c"]), false);
  assert.equal(isOverviewScopeFiltered(servers, ["a", "b"]), true);
  assert.equal(isOverviewScopeFiltered(servers, []), true);
  assert.equal(selectedOnlineCount(servers, ["a", "b"]), 2);
});

test("链路筛选：任意一跳命中选中服务器即保留", () => {
  const chains = [
    { id: "c1", groups: [{ members: [{ server_id: "a" }] }] },
    {
      id: "c2",
      groups: [
        { members: [{ server_id: "x" }] },
        { members: [{ server_id: "b" }] },
      ],
    },
    { id: "c3", groups: [] },
    { id: "c4" },
  ];
  assert.equal(chainMatchesScope(chains[0], ["a", "b"]), true);
  assert.equal(chainMatchesScope(chains[0], ["b"]), false);
  assert.equal(chainMatchesScope(chains[2], ["a"]), false);
  assert.equal(chainMatchesScope(chains[2], []), false);
  assert.deepEqual(
    filterChainsByScope(chains, ["b"]).map((chain) => chain.id),
    ["c2"],
  );
});

test("旧后端缺少 group_name 时全部落在未分组，仍然可选", () => {
  const servers = [server("a"), server("b")];
  const groups = scopeGroupRows(servers);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, "ungrouped");
  assert.equal(groups[0].count, 2);
  assert.equal(selectedScopeGroupKey(servers, ["a"]), null);
});
