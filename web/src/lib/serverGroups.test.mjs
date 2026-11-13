import assert from "node:assert/strict";
import test from "node:test";
import {
  GROUP_NAME_MAX_LENGTH,
  groupServers,
  groupStatusRows,
  normalizeGroupName,
} from "./serverGroups.ts";

test("normalizeGroupName treats null, undefined and blank strings as no group", () => {
  assert.equal(normalizeGroupName(null), null);
  assert.equal(normalizeGroupName(undefined), null);
  assert.equal(normalizeGroupName(""), null);
  assert.equal(normalizeGroupName("   "), null);
  assert.equal(normalizeGroupName("\t\n"), null);
});

test("normalizeGroupName trims, collapses inner whitespace and keeps case", () => {
  assert.equal(normalizeGroupName("  香港  "), "香港");
  assert.equal(normalizeGroupName("香港   01"), "香港 01");
  assert.equal(normalizeGroupName("  HK\tNode "), "HK Node");
  assert.equal(normalizeGroupName("hk"), "hk");
});

test("normalizeGroupName truncates overlong names without splitting characters", () => {
  const long = "a".repeat(GROUP_NAME_MAX_LENGTH + 8);
  const normalized = normalizeGroupName(long);
  assert.equal(normalized.length, GROUP_NAME_MAX_LENGTH);
  assert.equal(normalized, "a".repeat(GROUP_NAME_MAX_LENGTH));

  // 代理对（emoji）按 code point 截断，不能留下半个字符。
  const emoji = "🇭🇰".repeat(GROUP_NAME_MAX_LENGTH);
  const emojiName = normalizeGroupName(emoji);
  assert.equal(Array.from(emojiName).length, GROUP_NAME_MAX_LENGTH);
  assert.ok(emoji.startsWith(emojiName));
  assert.ok(!normalizeGroupName(`${"a".repeat(GROUP_NAME_MAX_LENGTH)} `).endsWith(" "));
});

test("groupServers groups by normalized name and puts ungrouped last", () => {
  const servers = [
    { id: "1", group_name: " 香港 " },
    { id: "2", group_name: null },
    { id: "3", group_name: "日本" },
    { id: "4", group_name: "   " },
    { id: "5", group_name: "香港" },
  ];
  const groups = groupServers(servers);

  assert.deepEqual(
    groups.map((group) => group.name),
    ["日本", "香港", null],
  );
  assert.deepEqual(
    groups.map((group) => group.servers.map((server) => server.id)),
    [["3"], ["1", "5"], ["2", "4"]],
  );
});

test("groupServers returns [] for an empty list and one null group when all are ungrouped", () => {
  assert.deepEqual(groupServers([]), []);

  const groups = groupServers([
    { id: "1", group_name: undefined },
    { id: "2", group_name: "" },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, null);
  assert.deepEqual(
    groups[0].servers.map((server) => server.id),
    ["1", "2"],
  );
});

test("groupServers merges names that only differ by surrounding whitespace", () => {
  const groups = groupServers([
    { id: "1", group_name: "香港" },
    { id: "2", group_name: " 香港 " },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].servers.length, 2);
});

test("groupServers truncates overlong group names and merges the same prefix", () => {
  const prefix = "x".repeat(GROUP_NAME_MAX_LENGTH);
  const groups = groupServers([
    { id: "1", group_name: `${prefix}-a` },
    { id: "2", group_name: `${prefix}-b` },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, prefix);
  assert.equal(groups[0].servers.length, 2);
});

test("groupStatusRows returns [] for missing, null or empty API data", () => {
  assert.deepEqual(groupStatusRows(undefined), []);
  assert.deepEqual(groupStatusRows(null), []);
  assert.deepEqual(groupStatusRows([]), []);
});

test("groupStatusRows normalizes names, sorts named groups and keeps ungrouped last", () => {
  const rows = groupStatusRows([
    { name: " 香港 ", servers: 2, online: 1, uptime_24h: 0.5 },
    { name: null, servers: 1, online: 0, uptime_24h: null },
    { name: "日本", servers: 3, online: 3, uptime_24h: 1 },
    { name: "   ", servers: 2, online: 2, uptime_24h: 0.25 },
  ]);

  assert.deepEqual(
    rows.map((row) => row.name),
    ["日本", "香港", null],
  );
  assert.deepEqual(rows[0], {
    name: "日本",
    servers: 3,
    online: 3,
    uptime_24h: 1,
  });
});

test("groupStatusRows clamps counters and availability into safe ranges", () => {
  const [row] = groupStatusRows([
    { name: "香港", servers: 2, online: 9, uptime_24h: 1.8 },
  ]);
  assert.equal(row.online, 2);
  assert.equal(row.uptime_24h, 1);

  const [negative] = groupStatusRows([
    { name: "日本", servers: 4, online: -3, uptime_24h: -0.2 },
  ]);
  assert.equal(negative.online, 0);
  assert.equal(negative.uptime_24h, 0);

  const [nan] = groupStatusRows([
    { name: "美国", servers: 1, online: 1, uptime_24h: Number.NaN },
  ]);
  assert.equal(nan.uptime_24h, null);
});

test("groupStatusRows skips empty groups and non-finite server counts", () => {
  const rows = groupStatusRows([
    { name: "空组", servers: 0, online: 0, uptime_24h: null },
    { name: "坏数据", servers: Number.POSITIVE_INFINITY, online: 1, uptime_24h: 1 },
    { name: "正常", servers: 1, online: 1, uptime_24h: 0.75 },
  ]);
  assert.deepEqual(
    rows.map((row) => row.name),
    ["正常"],
  );
});

test("groupStatusRows truncates overlong names and treats missing uptime as null", () => {
  const [row] = groupStatusRows([
    {
      name: "g".repeat(GROUP_NAME_MAX_LENGTH + 10),
      servers: 2,
      online: 1,
    },
  ]);
  assert.equal(row.name.length, GROUP_NAME_MAX_LENGTH);
  assert.equal(row.uptime_24h, null);
});
