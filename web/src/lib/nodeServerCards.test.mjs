import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PROTOCOL_CHIPS,
  nodeSummary,
  protocolChips,
  sortedServers,
} from "./nodeServerCards.ts";

test("nodeSummary reports the empty state when a server has no nodes", () => {
  assert.deepEqual(nodeSummary({ node_count: 0, node_enabled_count: 0 }), {
    total: 0,
    enabled: 0,
    disabled: 0,
    state: "empty",
  });
  // 旧后端没有这两个字段时不能展示成「全部启用」。
  assert.equal(nodeSummary({}).state, "empty");
  assert.equal(nodeSummary({}).total, 0);
});

test("nodeSummary reports allEnabled only when every node is enabled", () => {
  const summary = nodeSummary({ node_count: 12, node_enabled_count: 12 });
  assert.equal(summary.state, "allEnabled");
  assert.equal(summary.total, 12);
  assert.equal(summary.enabled, 12);
  assert.equal(summary.disabled, 0);
});

test("nodeSummary reports hasDisabled and counts disabled nodes", () => {
  const one = nodeSummary({ node_count: 3, node_enabled_count: 2 });
  assert.equal(one.state, "hasDisabled");
  assert.equal(one.total, 3);
  assert.equal(one.enabled, 2);
  assert.equal(one.disabled, 1);

  const all = nodeSummary({ node_count: 2, node_enabled_count: 0 });
  assert.equal(all.state, "hasDisabled");
  assert.equal(all.disabled, 2, "全部停用时 disabled 等于总数");
});

test("nodeSummary clamps dirty counts instead of producing negative values", () => {
  const over = nodeSummary({ node_count: 2, node_enabled_count: 99 });
  assert.equal(over.enabled, 2, "enabled 不能超过 total");
  assert.equal(over.disabled, 0);
  assert.equal(over.state, "allEnabled");

  const negative = nodeSummary({ node_count: -5, node_enabled_count: -2 });
  assert.deepEqual(negative, {
    total: 0,
    enabled: 0,
    disabled: 0,
    state: "empty",
  });
});

test("sortedServers puts ungrouped servers last", () => {
  const servers = [
    { id: "u1", name: "Zulu", status: "online", group_name: null },
    { id: "g1", name: "Hong Kong 02", status: "offline", group_name: "香港" },
    { id: "u2", name: "Alpha", status: "offline", group_name: "   " },
    { id: "g2", name: "Tokyo 01", status: "online", group_name: "日本" },
  ];
  assert.deepEqual(
    sortedServers(servers).map((server) => server.id),
    ["g2", "g1", "u1", "u2"],
    "具名分组按名称（日本 < 香港），未分组（含全空白）固定最后",
  );
});

test("sortedServers orders online before offline inside each group", () => {
  const servers = [
    { id: "a", name: "A-offline", status: "offline", group_name: "香港" },
    { id: "b", name: "B-online", status: "online", group_name: "香港" },
    { id: "c", name: "C-online", status: "online", group_name: "香港" },
    { id: "d", name: "D-offline", status: "offline", group_name: null },
    { id: "e", name: "E-online", status: "online", group_name: null },
  ];
  assert.deepEqual(
    sortedServers(servers).map((server) => server.id),
    ["b", "c", "a", "e", "d"],
    "组内在线优先，再按名称；未分组也遵循同一规则",
  );
});

test("sortedServers is stable for names, groups and statuses that tie", () => {
  const servers = [
    { id: "first", name: "Same", status: "online", group_name: "G" },
    { id: "second", name: "Same", status: "online", group_name: "G" },
  ];
  assert.deepEqual(
    sortedServers(servers).map((server) => server.id),
    ["first", "second"],
  );
});

test("sortedServers does not mutate the input array and handles empty input", () => {
  const servers = [
    { id: "b", name: "B", status: "offline", group_name: null },
    { id: "a", name: "A", status: "offline", group_name: null },
  ];
  const original = servers.map((server) => server.id);
  const sorted = sortedServers(servers);

  assert.deepEqual(
    servers.map((server) => server.id),
    original,
    "输入数组保持原顺序",
  );
  assert.deepEqual(
    sorted.map((server) => server.id),
    ["a", "b"],
  );
  assert.notEqual(sorted, servers, "返回新数组");
  assert.deepEqual(sortedServers([]), []);
});

test("protocolChips shows up to four protocols and folds the rest", () => {
  const six = protocolChips([
    "vless",
    "vmess",
    "trojan",
    "shadowsocks",
    "socks",
    "http",
  ]);
  assert.equal(MAX_PROTOCOL_CHIPS, 4);
  assert.deepEqual(six.protocols, ["vless", "vmess", "trojan", "shadowsocks"]);
  assert.equal(six.overflow, 2);

  const exact = protocolChips(["vless", "vmess", "trojan", "http"]);
  assert.equal(exact.protocols.length, 4);
  assert.equal(exact.overflow, 0);
});

test("protocolChips deduplicates, normalizes and ignores blank entries", () => {
  const chips = protocolChips([
    " vless ",
    "VLESS",
    "vmess",
    "",
    "   ",
    "vmess",
  ]);
  assert.deepEqual(chips.protocols, ["vless", "vmess"]);
  assert.equal(chips.overflow, 0);
});

test("protocolChips treats missing data as empty and respects a custom max", () => {
  assert.deepEqual(protocolChips(null), { protocols: [], overflow: 0 });
  assert.deepEqual(protocolChips(undefined), { protocols: [], overflow: 0 });

  const none = protocolChips(["vless"], 0);
  assert.deepEqual(none.protocols, []);
  assert.equal(none.overflow, 1);

  const one = protocolChips(["vless", "vmess"], 1);
  assert.deepEqual(one.protocols, ["vless"]);
  assert.equal(one.overflow, 1);
});
