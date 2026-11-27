import assert from "node:assert/strict";
import test from "node:test";
import {
  WORLD_NODE_MARKER_RADII,
  worldNodeMarkerRadius,
  worldNodeStats,
  worldNodeStatus,
  worldNodeTier,
} from "./worldNodeStats.ts";

function server(country, status, name = `${country}-node`) {
  return {
    id: `${country}-${name}`,
    name,
    country_code: country,
    status,
  };
}

test("没有服务器时返回空数组", () => {
  assert.deepEqual(worldNodeStats([]), []);
});

test("单台服务器：计数、最差状态、档位与前 3 名字", () => {
  const stats = worldNodeStats([server("JP", "online", "东京-01")]);
  assert.deepEqual(stats, [
    {
      country: "JP",
      total: 1,
      online: 1,
      offline: 0,
      abnormal: 0,
      worst: "online",
      topNames: ["东京-01"],
      tier: 0,
    },
  ]);
});

test("档位边界：1 / 2–3 / 4–6 / 7+", () => {
  assert.equal(worldNodeTier(0), 0);
  assert.equal(worldNodeTier(1), 0);
  assert.equal(worldNodeTier(2), 1);
  assert.equal(worldNodeTier(3), 1);
  assert.equal(worldNodeTier(4), 2);
  assert.equal(worldNodeTier(6), 2);
  assert.equal(worldNodeTier(7), 3);
  assert.equal(worldNodeTier(99), 3);
});

test("地图圆点半径：四档 3 / 4 / 5 / 6px，越小的地区也至少 3px", () => {
  assert.deepEqual(WORLD_NODE_MARKER_RADII, [3, 4, 5, 6]);
  assert.deepEqual(
    [0, 1, 2, 3].map((tier) => worldNodeMarkerRadius(tier)),
    [3, 4, 5, 6],
  );
});

test("多台同国：在线 / 离线 / 异常分别计数，最差状态优先 offline", () => {
  const stats = worldNodeStats([
    server("JP", "online", "东京-01"),
    server("JP", "abnormal", "东京-02"),
    server("JP", "offline", "大阪-01"),
    server("JP", "online", "大阪-02"),
    server("JP", "online", "东京-03"),
    server("JP", "online", "东京-04"),
    server("JP", "online", "东京-05"),
  ]);
  assert.equal(stats.length, 1);
  const [jp] = stats;
  assert.equal(jp.country, "JP");
  assert.equal(jp.total, 7);
  assert.equal(jp.online, 5);
  assert.equal(jp.offline, 1);
  assert.equal(jp.abnormal, 1);
  assert.equal(jp.worst, "offline");
  assert.equal(jp.tier, 3);
  // 异常优先，其次按名称排序；最多 3 个。
  assert.deepEqual(jp.topNames, ["大阪-01", "东京-02", "东京-01"]);
});

test("只有 abnormal 时最差状态是 abnormal，档位仍按台数", () => {
  const stats = worldNodeStats([
    server("HK", "abnormal", "香港-01"),
    server("HK", "online", "香港-02"),
    server("HK", "online", "香港-03"),
    server("HK", "online", "香港-04"),
  ]);
  const [hk] = stats;
  assert.equal(hk.worst, "abnormal");
  assert.equal(hk.abnormal, 1);
  assert.equal(hk.total, 4);
  assert.equal(hk.tier, 2);
});

test("未知 / 空 / 非法国家代码跳过，ISO2 大小写与空白归一", () => {
  const stats = worldNodeStats([
    server(null, "online", "无地区-01"),
    server(undefined, "online", "无地区-02"),
    server("", "online", "无地区-03"),
    server("ZZ", "online", "非法-01"),
    server("XK", "online", "非法-02"),
    server(" jp ", "online", "东京-01"),
    server("jp", "abnormal", "东京-02"),
  ]);
  assert.equal(stats.length, 1);
  assert.equal(stats[0].country, "JP");
  assert.equal(stats[0].total, 2);
});

test("国家按 ISO2 升序，topNames 最多 3 个且重复执行稳定", () => {
  const input = [
    server("US", "online", "us-2"),
    server("JP", "online", "jp-2"),
    server("US", "offline", "us-1"),
    server("JP", "online", "jp-1"),
    server("DE", "abnormal", "de-1"),
    server("JP", "online", "jp-3"),
    server("JP", "online", "jp-4"),
    server("JP", "online", "jp-5"),
  ];
  const first = worldNodeStats(input);
  const second = worldNodeStats([...input].reverse());
  assert.deepEqual(
    first.map((row) => row.country),
    ["DE", "JP", "US"],
  );
  assert.equal(first[1].topNames.length, 3);
  // 同一个集合无论输入顺序如何，聚合结果一致（国家内按状态 + 名称排序）。
  assert.deepEqual(
    first.map(({ country, total, worst, topNames }) => ({
      country,
      total,
      worst,
      topNames,
    })),
    second
      .map(({ country, total, worst, topNames }) => ({
        country,
        total,
        worst,
        topNames,
      }))
      .sort((a, b) => a.country.localeCompare(b.country)),
  );
});

test("worldNodeStatus：离线优先，在线但 Xray 停止算 abnormal", () => {
  assert.equal(worldNodeStatus({ status: "offline" }), "offline");
  assert.equal(
    worldNodeStatus({ status: "offline", xray_running: false }),
    "offline",
  );
  assert.equal(
    worldNodeStatus({ status: "online", xray_running: false }),
    "abnormal",
  );
  assert.equal(
    worldNodeStatus({ status: "online", xray_running: true }),
    "online",
  );
  assert.equal(worldNodeStatus({ status: "online" }), "online");
  assert.equal(worldNodeStatus({ status: "abnormal" }), "abnormal");
});
