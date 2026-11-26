import assert from "node:assert/strict";
import test from "node:test";
import {
  applyServerListFilters,
  GROUP_FILTER_ALL,
  GROUP_FILTER_UNGROUPED,
  isServiceDown,
  resolveCountryFilter,
  serverMatchesGroup,
} from "./serverListFilters.ts";

function server({
  id,
  group = null,
  country = null,
  status = "online",
  xray = true,
}) {
  return {
    id,
    name: id,
    group_name: group,
    country_code: country,
    status,
    xray_running: xray,
  };
}

const SERVERS = [
  server({ id: "hk-1", group: "香港", country: "HK" }),
  server({ id: "hk-2", group: "香港", country: "hk", xray: false }),
  server({ id: "hk-3", group: "香港", country: "HK", status: "offline" }),
  server({ id: "jp-1", group: "日本", country: "JP" }),
  server({ id: "jp-2", group: "日本", country: "JP", xray: false }),
  server({ id: "sg-1", group: "东南亚", country: "SG", status: "offline" }),
  server({ id: "none-1", country: null }),
];

function ids(rows) {
  return rows.map((row) => row.id);
}

test("?country= 归一：大小写 / 空白 / 非法值", () => {
  assert.equal(resolveCountryFilter("hk"), "HK");
  assert.equal(resolveCountryFilter(" HK "), "HK");
  assert.equal(resolveCountryFilter("jp"), "JP");
  assert.equal(resolveCountryFilter("zz"), null);
  assert.equal(resolveCountryFilter("XK"), null);
  assert.equal(resolveCountryFilter(""), null);
  assert.equal(resolveCountryFilter(null), null);
  assert.equal(resolveCountryFilter(undefined), null);
});

test("只有地区筛选：大小写不敏感，未知国家不出现在结果里", () => {
  const result = applyServerListFilters(SERVERS, { country: "hk" });
  assert.equal(result.country, "HK");
  assert.deepEqual(ids(result.items), ["hk-1", "hk-2", "hk-3"]);
  assert.equal(result.scopedCount, 3);
  assert.equal(result.abnormalCount, 1);
  assert.equal(result.abnormalActive, false);
});

test("分组 + 地区叠加：先分组再地区", () => {
  const result = applyServerListFilters(SERVERS, {
    group: "日本",
    country: "HK",
  });
  assert.deepEqual(ids(result.items), []);
  assert.equal(result.scopedCount, 0);

  const both = applyServerListFilters(SERVERS, {
    group: "香港",
    country: "HK",
  });
  assert.deepEqual(ids(both.items), ["hk-1", "hk-2", "hk-3"]);
});

test("only=abnormal 与地区、分组叠加：异常数只在当前范围内计算", () => {
  const hk = applyServerListFilters(SERVERS, {
    country: "HK",
    onlyAbnormal: true,
  });
  assert.equal(hk.abnormalActive, true);
  assert.equal(hk.abnormalCount, 1);
  assert.deepEqual(ids(hk.items), ["hk-2"]);

  const jp = applyServerListFilters(SERVERS, {
    group: "日本",
    country: "JP",
    onlyAbnormal: true,
  });
  assert.equal(jp.abnormalActive, true);
  assert.deepEqual(ids(jp.items), ["jp-2"]);

  // 该地区没有异常：only 不生效，显示地区内全部。
  const us = applyServerListFilters(SERVERS, {
    country: "US",
    onlyAbnormal: true,
  });
  assert.equal(us.abnormalActive, false);
  assert.equal(us.abnormalCount, 0);
  assert.equal(us.scopedCount, 0);
  assert.deepEqual(ids(us.items), []);

  const sg = applyServerListFilters(SERVERS, {
    country: "SG",
    onlyAbnormal: true,
  });
  assert.equal(sg.abnormalActive, false, "离线不算服务异常");
  assert.deepEqual(ids(sg.items), ["sg-1"]);
});

test("分组筛选：全部 / 未分组 / 具名，空白名称按未分组处理", () => {
  assert.deepEqual(
    ids(applyServerListFilters(SERVERS, { group: GROUP_FILTER_ALL }).items),
    ids(SERVERS),
  );
  assert.deepEqual(
    ids(
      applyServerListFilters(SERVERS, { group: GROUP_FILTER_UNGROUPED }).items,
    ),
    ["none-1"],
  );
  assert.equal(serverMatchesGroup({ group_name: " 香港 " }, "香港"), true);
  assert.equal(serverMatchesGroup({ group_name: "  " }, GROUP_FILTER_UNGROUPED), true);
  assert.equal(serverMatchesGroup({ group_name: null }, "香港"), false);
});

test("非法地区参数按未筛选处理，不产生隐形筛选", () => {
  const result = applyServerListFilters(SERVERS, { country: "ZZ" });
  assert.equal(result.country, null);
  assert.equal(result.items.length, SERVERS.length);
});

test("isServiceDown 只看在线且 Xray 停止，离线不算", () => {
  assert.equal(
    isServiceDown({ status: "online", xray_running: false }),
    true,
  );
  assert.equal(
    isServiceDown({ status: "offline", xray_running: false }),
    false,
  );
  assert.equal(
    isServiceDown({ status: "online", xray_running: true }),
    false,
  );
  assert.equal(isServiceDown({ status: "online" }), false);
});

test("不修改入参数组，空列表也返回稳定结构", () => {
  const input = [server({ id: "hk-1", country: "HK" })];
  const snapshot = [...input];
  applyServerListFilters(input, { country: "HK", onlyAbnormal: true });
  assert.deepEqual(input, snapshot);

  const empty = applyServerListFilters([], {
    group: GROUP_FILTER_ALL,
    country: "HK",
    onlyAbnormal: true,
  });
  assert.deepEqual(empty, {
    items: [],
    scopedCount: 0,
    abnormalCount: 0,
    abnormalActive: false,
    country: "HK",
  });
});
