/**
 * 热力图「全程离线」折叠行的纯逻辑测试。
 *
 * 折叠规则只在 `buildHeatmapRows` 里实现，组件只负责渲染，所以这里
 * 覆盖边界：整段离线 / 整段无采样 / 只在部分时间离线 / 全部折叠 /
 * 展开后键盘行号恢复。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHeatmapRows,
  serverHasOnlineSample,
} from "./serverHealth.ts";

const HOUR = 3600;
const COLUMNS = [{ ts: 0 }, { ts: HOUR }, { ts: 2 * HOUR }];

function bucket(ts, onlineRatio, samples = 12) {
  return {
    ts,
    onlineRatio,
    ratioApproximate: false,
    load1: 0.4,
    load1Max: 0.4,
    memRatio: 0.5,
    diskRatio: 0.5,
    samples,
    outageSamples: onlineRatio === 0 ? samples : 0,
  };
}

function server(id, buckets) {
  return {
    id,
    name: `server-${id}`,
    status: "online",
    onlineRatio: null,
    current: {
      load1: 0.4,
      memUsed: 4,
      memTotal: 10,
      diskUsed: 5,
      diskTotal: 10,
      latencyMs: 20,
    },
    buckets,
  };
}

/** 三个桶全程在线。 */
const online = (id) =>
  server(id, COLUMNS.map((column) => bucket(column.ts, 1)));

/** 三个桶全部离线（online_ratio = 0，有采样但不在线）。 */
const offline = (id) =>
  server(id, COLUMNS.map((column) => bucket(column.ts, 0)));

/** 三个桶都没有采样。 */
const noSample = (id) =>
  server(id, []);

/** 只在中间一个桶离线：整行仍有在线样本，必须保持展开。 */
const partial = (id) =>
  server(id, [
    bucket(0, 1),
    bucket(HOUR, 0),
    bucket(2 * HOUR, 1),
  ]);

test("serverHasOnlineSample：只有在线率 > 0 的桶算在线样本", () => {
  assert.equal(serverHasOnlineSample(online("a"), COLUMNS, HOUR), true);
  assert.equal(serverHasOnlineSample(partial("b"), COLUMNS, HOUR), true);
  assert.equal(serverHasOnlineSample(offline("c"), COLUMNS, HOUR), false);
  assert.equal(serverHasOnlineSample(noSample("d"), COLUMNS, HOUR), false);
  // 没有任何时间列时不可能有在线样本。
  assert.equal(serverHasOnlineSample(online("e"), [], HOUR), false);
});

test("折叠：整段离线与无采样合并成一行，部分离线保持独立行", () => {
  const servers = [
    online("a"),
    offline("b"),
    partial("c"),
    noSample("d"),
    online("e"),
  ];
  const rows = buildHeatmapRows(servers, COLUMNS, HOUR);

  assert.deepEqual(
    rows.map((row) => row.kind),
    ["server", "offline-group", "server", "server"],
  );
  const group = rows[1];
  assert.equal(group.kind, "offline-group");
  assert.deepEqual(
    group.servers.map((item) => item.id),
    ["b", "d"],
    "group must keep the original server order and include no-sample rows",
  );
  // 未被折叠的服务器顺序不变；row 序号只给可见服务器行。
  const visible = rows.filter((row) => row.kind === "server");
  assert.deepEqual(
    visible.map((row) => row.server.id),
    ["a", "c", "e"],
  );
  assert.deepEqual(
    visible.map((row) => row.row),
    [0, 1, 2],
    "collapsed rows must not consume keyboard row indexes",
  );
  assert.equal(visible.length + group.servers.length, servers.length);
});

test("展开：聚合行保留，N 台逐行放回，行号连续恢复", () => {
  const servers = [
    online("a"),
    offline("b"),
    partial("c"),
    noSample("d"),
  ];
  const rows = buildHeatmapRows(servers, COLUMNS, HOUR, {
    offlineExpanded: true,
  });

  assert.deepEqual(
    rows.map((row) => row.kind),
    ["server", "offline-group", "server", "server", "server"],
  );
  const visible = rows.filter((row) => row.kind === "server");
  assert.deepEqual(
    visible.map((row) => row.server.id),
    ["a", "b", "d", "c"],
    "expanded servers follow the aggregate row, then the remaining rows",
  );
  assert.deepEqual(
    visible.map((row) => row.row),
    [0, 1, 2, 3],
  );
  // 聚合行本身仍然存在，保证还能收起。
  assert.equal(rows.filter((row) => row.kind === "offline-group").length, 1);
});

test("全部无在线样本：只有一行聚合行，没有可键盘遍历的服务器行", () => {
  const servers = [offline("a"), noSample("b"), offline("c")];
  const collapsed = buildHeatmapRows(servers, COLUMNS, HOUR);
  assert.deepEqual(
    collapsed.map((row) => row.kind),
    ["offline-group"],
  );
  assert.deepEqual(
    collapsed[0].servers.map((item) => item.id),
    ["a", "b", "c"],
  );

  const expanded = buildHeatmapRows(servers, COLUMNS, HOUR, {
    offlineExpanded: true,
  });
  assert.deepEqual(
    expanded.map((row) => row.kind),
    ["offline-group", "server", "server", "server"],
  );
  assert.deepEqual(
    expanded
      .filter((row) => row.kind === "server")
      .map((row) => row.row),
    [0, 1, 2],
  );
});

test("没有需要折叠的行时不凭空生成聚合行", () => {
  const servers = [online("a"), partial("b")];
  const rows = buildHeatmapRows(servers, COLUMNS, HOUR);
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["server", "server"],
  );
  assert.equal(
    rows.some((row) => row.kind === "offline-group"),
    false,
  );
});
