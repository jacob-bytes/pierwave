import assert from "node:assert/strict";
import test from "node:test";
import en from "../i18n/en.ts";
import zh from "../i18n/zh-CN.ts";
import {
  availabilityPercent,
  availabilityTone,
  DEFAULT_STATUS_VIEW,
  filterPublicServers,
  hasSamples,
  isPublicStatusPath,
  loadStatusView,
  matchesServerQuery,
  matchesStatusFilter,
  parseStatusView,
  persistStatusView,
  publicServerCounts,
  resourcePercent,
  serverState,
  STATUS_VIEW_STORAGE_KEY,
  statusLabelKey,
} from "./publicStatus.ts";

test("serverState distinguishes offline, abnormal and online", () => {
  assert.equal(serverState({ online: false, xray_running: false }), "offline");
  assert.equal(serverState({ online: false, xray_running: null }), "offline");
  assert.equal(serverState({ online: true, xray_running: false }), "abnormal");
  assert.equal(serverState({ online: true, xray_running: true }), "online");
  // 在线但没有 Xray 上报：不能断言异常，按在线处理。
  assert.equal(serverState({ online: true, xray_running: null }), "online");
});

test("statusLabelKey maps every state to its translated label", () => {
  assert.equal(statusLabelKey("online"), "publicStatus.server.online");
  assert.equal(statusLabelKey("offline"), "publicStatus.server.offline");
  assert.equal(statusLabelKey("abnormal"), "publicStatus.server.abnormal");
});

test("availabilityTone keeps missing samples grey and bands the rest", () => {
  assert.equal(availabilityTone(null), "unknown");
  assert.equal(availabilityTone(undefined), "unknown");
  assert.equal(availabilityTone(Number.NaN), "unknown");
  assert.equal(availabilityTone(1), "ok");
  assert.equal(availabilityTone(0.99), "ok");
  assert.equal(availabilityTone(0.989), "warn");
  assert.equal(availabilityTone(0.5), "warn");
  assert.equal(availabilityTone(0.49), "down");
  assert.equal(availabilityTone(0), "down");
});

test("availabilityPercent rounds and clamps, null stays null", () => {
  assert.equal(availabilityPercent(null), null);
  assert.equal(availabilityPercent(undefined), null);
  assert.equal(availabilityPercent(Number.NaN), null);
  assert.equal(availabilityPercent(1), 100);
  assert.equal(availabilityPercent(0.996), 100);
  assert.equal(availabilityPercent(0.5), 50);
  assert.equal(availabilityPercent(0.004), 0);
  assert.equal(availabilityPercent(-1), 0);
  assert.equal(availabilityPercent(2), 100);
});

test("hasSamples only reports true for at least one real bucket", () => {
  assert.equal(hasSamples([]), false);
  assert.equal(hasSamples([null, null, undefined]), false);
  assert.equal(hasSamples([null, { ts: 1, online_ratio: 1 }]), true);
});

test("resourcePercent guards missing and zero totals", () => {
  assert.equal(resourcePercent(null, 100), null);
  assert.equal(resourcePercent(10, null), null);
  assert.equal(resourcePercent(10, 0), null);
  assert.equal(resourcePercent(Number.NaN, 100), null);
  assert.equal(resourcePercent(10, 100), 10);
  assert.equal(resourcePercent(150, 100), 100);
  assert.equal(resourcePercent(-5, 100), 0);
});

test("isPublicStatusPath only allows the exact public route", () => {
  assert.equal(isPublicStatusPath("/status"), true);
  assert.equal(isPublicStatusPath("/status/"), true);
  assert.equal(isPublicStatusPath("/status/servers"), false);
  assert.equal(isPublicStatusPath("/statuses"), false);
  assert.equal(isPublicStatusPath("/"), false);
  assert.equal(isPublicStatusPath("/login"), false);
});

const SERVER = (overrides = {}) => ({
  id: "srv-1",
  name: "Hong Kong 01",
  online: true,
  xray_running: true,
  ...overrides,
});

test("matchesStatusFilter agrees with the card's own state mapping", () => {
  assert.equal(matchesStatusFilter(SERVER(), "all"), true);
  assert.equal(matchesStatusFilter(SERVER(), "online"), true);
  assert.equal(matchesStatusFilter(SERVER(), "offline"), false);
  assert.equal(matchesStatusFilter(SERVER({ xray_running: false }), "abnormal"), true);
  // 离线优先：online=false 时 Xray 字段不再决定状态。
  assert.equal(
    matchesStatusFilter(SERVER({ online: false, xray_running: false }), "offline"),
    true,
  );
  assert.equal(
    matchesStatusFilter(SERVER({ online: false, xray_running: false }), "abnormal"),
    false,
  );
  // 在线但 Xray 没上报：保持在线，不臆测异常。
  assert.equal(
    matchesStatusFilter(SERVER({ online: true, xray_running: null }), "online"),
    true,
  );
});

test("matchesServerQuery trims, ignores case and treats blank as all", () => {
  assert.equal(matchesServerQuery(SERVER(), ""), true);
  assert.equal(matchesServerQuery(SERVER(), "   "), true);
  assert.equal(matchesServerQuery(SERVER(), "hong"), true);
  assert.equal(matchesServerQuery(SERVER(), "KONG"), true);
  assert.equal(matchesServerQuery(SERVER(), "  kong  "), true);
  assert.equal(matchesServerQuery(SERVER(), "tokyo"), false);
});

test("filterPublicServers applies search and status together", () => {
  const servers = [
    SERVER({ id: "a", name: "Hong Kong 01" }),
    SERVER({ id: "b", name: "Hong Kong 02", online: false }),
    SERVER({ id: "c", name: "Tokyo 01", xray_running: false }),
  ];

  assert.deepEqual(
    filterPublicServers(servers, "all", "hong").map((s) => s.id),
    ["a", "b"],
  );
  assert.deepEqual(
    filterPublicServers(servers, "online", "hong").map((s) => s.id),
    ["a"],
  );
  assert.deepEqual(
    filterPublicServers(servers, "offline", "").map((s) => s.id),
    ["b"],
  );
  assert.deepEqual(
    filterPublicServers(servers, "abnormal", "").map((s) => s.id),
    ["c"],
  );
  assert.deepEqual(filterPublicServers(servers, "abnormal", "hong"), []);
});

test("publicServerCounts counts every tab from the same list", () => {
  const servers = [
    SERVER(),
    SERVER({ online: false }),
    SERVER({ xray_running: false }),
    SERVER({ online: true, xray_running: null }),
  ];
  assert.deepEqual(publicServerCounts(servers), {
    all: 4,
    online: 2,
    offline: 1,
    abnormal: 1,
  });
  assert.deepEqual(publicServerCounts([]), {
    all: 0,
    online: 0,
    offline: 0,
    abnormal: 0,
  });
});

test("parseStatusView only accepts the two known layouts", () => {
  assert.equal(parseStatusView("grid"), "grid");
  assert.equal(parseStatusView("list"), "list");
  assert.equal(parseStatusView("table"), null);
  assert.equal(parseStatusView(""), null);
  assert.equal(parseStatusView(null), null);
  assert.equal(parseStatusView(undefined), null);
});

test("loadStatusView falls back to grid for missing, invalid or throwing storage", () => {
  const memory = (value) => ({
    getItem: (key) => {
      assert.equal(key, STATUS_VIEW_STORAGE_KEY);
      return value;
    },
  });
  assert.equal(loadStatusView(memory("list")), "list");
  assert.equal(loadStatusView(memory("grid")), "grid");
  assert.equal(loadStatusView(memory("nope")), DEFAULT_STATUS_VIEW);
  assert.equal(loadStatusView(memory(null)), DEFAULT_STATUS_VIEW);
  assert.equal(loadStatusView(null), DEFAULT_STATUS_VIEW);
  assert.equal(loadStatusView(undefined), DEFAULT_STATUS_VIEW);
  assert.equal(
    loadStatusView({
      getItem() {
        throw new Error("storage disabled");
      },
    }),
    DEFAULT_STATUS_VIEW,
  );
});

test("persistStatusView writes the view and swallows storage errors", () => {
  const keys = [];
  const values = [];
  persistStatusView(
    {
      setItem(key, value) {
        keys.push(key);
        values.push(value);
      },
    },
    "list",
  );
  assert.deepEqual(keys, [STATUS_VIEW_STORAGE_KEY]);
  assert.deepEqual(values, ["list"]);

  assert.doesNotThrow(() =>
    persistStatusView(
      {
        setItem() {
          throw new Error("quota exceeded");
        },
      },
      "grid",
    ),
  );
  assert.doesNotThrow(() => persistStatusView(null, "grid"));
});

test("status page dynamic i18n keys exist in both locales", () => {
  const keys = [
    "server.online",
    "server.offline",
    "server.abnormal",
    "availability.ok",
    "availability.warn",
    "availability.down",
    "availability.unknown",
  ];
  const pick = (dictionary, path) =>
    path.split(".").reduce((node, part) => node?.[part], dictionary);

  for (const key of keys) {
    assert.equal(typeof pick(zh.publicStatus, key), "string", `zh ${key}`);
    assert.equal(typeof pick(en.publicStatus, key), "string", `en ${key}`);
  }
});
