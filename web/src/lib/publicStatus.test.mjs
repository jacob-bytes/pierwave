import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import en from "../i18n/en.ts";
import zh from "../i18n/zh-CN.ts";
import {
  availabilityConclusion,
  availabilityFill,
  availabilityPercent,
  availabilityPercentText,
  availabilityTone,
  averageUptime24h,
  billingCycleKey,
  busiestServer,
  expiryDays,
  expiryLabel,
  formatPrice,
  formatPriceCents,
  normalizeCurrency,
  onlineRateByDirection,
  publicBilling,
  statusHeadline,
  statusHeadlineKey,
  totalOnlineRate,
  DEFAULT_STATUS_VIEW,
  filterPublicServers,
  hasSamples,
  isPublicStatusPath,
  isStatusStale,
  lowestAvailabilityBucket,
  summarizeAvailability,
  publicStatusServerId,
  loadStatusView,
  matchesGroupFilter,
  matchesServerQuery,
  matchesStatusFilter,
  parseStatusView,
  persistStatusView,
  PUBLIC_STATUS_POLL_MS,
  publicServerCounts,
  reportedLatency,
  resourcePercent,
  serverSpecLine,
  serverState,
  STATUS_STALE_SECONDS,
  STATUS_VIEW_STORAGE_KEY,
  statusGroupTabs,
  statusLabelKey,
  UNGROUPED_GROUP_KEY,
  uptimeLabelKey,
  uptimeParts,
} from "./publicStatus.ts";

function read(relative) {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

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

test("serverSpecLine joins os, virt and arch, skipping missing parts", () => {
  assert.equal(
    serverSpecLine({
      os_name: "Debian GNU/Linux",
      os_version: "12",
      virt: "kvm",
      arch: "x86_64",
    }),
    "Debian GNU/Linux 12 · kvm · x86_64",
    "参考卡的信息层次：OS · 虚拟化 · 架构",
  );
  assert.equal(
    serverSpecLine({
      os_name: "Debian GNU/Linux",
      os_version: "12",
      virt: null,
      arch: "x86_64",
    }),
    "Debian GNU/Linux 12 · x86_64",
    "缺虚拟化时跳过，不留空段",
  );
  assert.equal(
    serverSpecLine({
      os_name: null,
      os_version: null,
      virt: "vmware",
      arch: "aarch64",
    }),
    "vmware · aarch64",
    "缺 OS 时仍显示虚拟化与架构",
  );
  assert.equal(
    serverSpecLine({
      os_name: "Alpine Linux",
      os_version: null,
      virt: "none",
      arch: null,
    }),
    "Alpine Linux",
    "virt = none（裸机）不显示；版本缺失不留空洞",
  );
  assert.equal(
    serverSpecLine({
      os_name: " ",
      os_version: "",
      virt: null,
      arch: "  ",
    }),
    null,
    "全缺必须返回 null，卡片据此不渲染整行",
  );
});

test("availabilityTone keeps missing samples grey and bands the rest", () => {
  assert.equal(availabilityTone(null), "unknown");
  assert.equal(availabilityTone(undefined), "unknown");
  assert.equal(availabilityTone(Number.NaN), "unknown");
  assert.equal(availabilityTone(1), "ok");
  assert.equal(availabilityTone(0.99), "ok");
  // 三档边界：99 / 95。96% 是 warning，71% 是 destructive。
  assert.equal(availabilityTone(0.989), "warn");
  assert.equal(availabilityTone(0.96), "warn");
  assert.equal(availabilityTone(0.95), "warn");
  assert.equal(availabilityTone(0.949), "down");
  assert.equal(availabilityTone(0.71), "down");
  assert.equal(availabilityTone(0.5), "down");
  assert.equal(availabilityTone(0.49), "down");
  assert.equal(availabilityTone(0), "down");
});

test("availabilityFill is the clamped percentage, same source as the tone", () => {
  assert.equal(availabilityFill(null), 0);
  assert.equal(availabilityFill(Number.NaN), 0);
  assert.equal(availabilityFill(1), 100);
  assert.equal(availabilityFill(0.96), 96);
  assert.equal(availabilityFill(0.71), 71);
  assert.equal(availabilityFill(-0.2), 0);
  assert.equal(availabilityFill(2), 100);
});

test("availabilityPercentText keeps sub-100 values honest", () => {
  assert.equal(availabilityPercentText(null), null);
  assert.equal(availabilityPercentText(undefined), null);
  assert.equal(availabilityPercentText(Number.NaN), null);
  assert.equal(availabilityPercentText(1), "100", "只有精确 100% 才显示 100");
  assert.equal(availabilityPercentText(0.9999), "99.99");
  assert.equal(availabilityPercentText(0.999), "99.9");
  // 四舍五入会让 99.9999 变成 100；这里用截断守住。
  assert.equal(availabilityPercentText(0.99999), "99.99");
  assert.equal(availabilityPercentText(0.9583), "95.83");
  assert.equal(availabilityPercentText(0.5), "50");
  assert.equal(availabilityPercentText(0.004), "0.4");
  assert.equal(availabilityPercentText(0.00004), "<0.01");
  assert.equal(availabilityPercentText(0), "0", "0% 仍然显示 0，颜色由 tone 决定");
  assert.equal(availabilityPercentText(2), "100", "越界脏数据按 100 处理");
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

test("reportedLatency hides missing values instead of showing 0 ms", () => {
  assert.equal(reportedLatency(null), null);
  assert.equal(reportedLatency(undefined), null);
  assert.equal(reportedLatency(Number.NaN), null);
  assert.equal(reportedLatency(Number.POSITIVE_INFINITY), null);
  assert.equal(reportedLatency(-1), null);
  assert.equal(reportedLatency(0), 0);
  assert.equal(reportedLatency(23), 23);
  assert.equal(reportedLatency(23.4), 23);
  assert.equal(reportedLatency(23.6), 24);
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

test("uptimeLabelKey keeps the highest meaningful unit and its next one", () => {
  const key = (days, hours, minutes) =>
    uptimeLabelKey({ days, hours, minutes });
  assert.equal(key(141, 1, 2), "publicStatus.server.uptimeDaysHours");
  assert.equal(key(2, 0, 5), "publicStatus.server.uptimeDays");
  assert.equal(key(0, 5, 10), "publicStatus.server.uptimeHoursMinutes");
  assert.equal(key(0, 5, 0), "publicStatus.server.uptimeHours");
  assert.equal(key(0, 0, 7), "publicStatus.server.uptimeMinutes");
  assert.equal(key(0, 0, 0), "publicStatus.server.uptimeJustNow");
});

test("uptimeParts floors to whole minutes and rejects unusable input", () => {
  assert.deepEqual(uptimeParts(0), { days: 0, hours: 0, minutes: 0 });
  // 不足一分钟按 0 分钟算，不四舍五入成「1 分钟」。
  assert.deepEqual(uptimeParts(59), { days: 0, hours: 0, minutes: 0 });
  assert.deepEqual(uptimeParts(60), { days: 0, hours: 0, minutes: 1 });
  assert.deepEqual(uptimeParts(3_599), { days: 0, hours: 0, minutes: 59 });
  assert.deepEqual(uptimeParts(3_600), { days: 0, hours: 1, minutes: 0 });
  assert.deepEqual(uptimeParts(86_400), { days: 1, hours: 0, minutes: 0 });
  // 参考截图里的「141 天 1 小时」：125 秒的零头被丢掉。
  assert.deepEqual(uptimeParts(141 * 86_400 + 3_600 + 125), {
    days: 141,
    hours: 1,
    minutes: 2,
  });

  assert.equal(uptimeParts(null), null);
  assert.equal(uptimeParts(undefined), null);
  assert.equal(uptimeParts(Number.NaN), null);
  assert.equal(uptimeParts(Number.POSITIVE_INFINITY), null);
  assert.equal(uptimeParts(-1), null);
});

const LOAD_SERVER = (id, online, load1) => ({ id, name: id, online, load1 });

test("busiestServer ignores offline and unreported loads, ties keep the first", () => {
  assert.equal(busiestServer([]), null);
  assert.equal(busiestServer([LOAD_SERVER("a", true, null)]), null);
  // 离线服务器的历史负载不能参与「最忙」的评选。
  assert.equal(busiestServer([LOAD_SERVER("a", false, 99)]), null);
  assert.equal(
    busiestServer([
      LOAD_SERVER("a", true, null),
      LOAD_SERVER("b", false, 99),
      LOAD_SERVER("c", true, Number.NaN),
    ]),
    null,
  );

  const top = busiestServer([
    LOAD_SERVER("a", true, 1.25),
    LOAD_SERVER("b", true, 3.5),
    LOAD_SERVER("c", true, 2),
  ]);
  assert.equal(top.id, "b");

  // 相同负载时保留列表里先出现的那台，结果稳定、不随排序抖动。
  const tie = busiestServer([
    LOAD_SERVER("first", true, 2),
    LOAD_SERVER("second", true, 2),
  ]);
  assert.equal(tie.id, "first");
});

test("averageUptime24h averages real samples only, clamping dirty ratios", () => {
  assert.equal(averageUptime24h([]), null);
  assert.equal(
    averageUptime24h([{ uptime_24h: null }, { uptime_24h: undefined }]),
    null,
  );
  assert.equal(
    averageUptime24h([
      { uptime_24h: Number.NaN },
      { uptime_24h: Number.POSITIVE_INFINITY },
    ]),
    null,
  );

  assert.equal(
    averageUptime24h([{ uptime_24h: 1 }, { uptime_24h: 0.5 }]),
    0.75,
  );
  // 没有采样的服务器不参与分母，否则会把它算成 0%。
  assert.equal(
    averageUptime24h([{ uptime_24h: 0.9 }, { uptime_24h: null }]),
    0.9,
  );
  // 越界的比例先夹到 0..1 再求均值。
  assert.equal(
    averageUptime24h([{ uptime_24h: 2 }, { uptime_24h: -1 }]),
    0.5,
  );
});

const HEADLINE_SERVER = (online, uptime_24h = 1) => ({
  online,
  uptime_24h,
});

test("statusHeadline picks one verdict from the online count", () => {
  assert.deepEqual(statusHeadline([]), {
    kind: "empty",
    total: 0,
    online: 0,
    offline: 0,
    lowAvailability: 0,
  });

  const allOnline = statusHeadline(
    Array.from({ length: 8 }, () => HEADLINE_SERVER(true)),
  );
  assert.deepEqual(allOnline, {
    kind: "all-online",
    total: 8,
    online: 8,
    offline: 0,
    lowAvailability: 0,
  });

  const partial = statusHeadline([
    ...Array.from({ length: 7 }, () => HEADLINE_SERVER(true)),
    HEADLINE_SERVER(false),
  ]);
  assert.equal(partial.kind, "partial");
  assert.equal(partial.online, 7);
  assert.equal(partial.total, 8);
  assert.equal(partial.offline, 1);

  const allOffline = statusHeadline(
    Array.from({ length: 8 }, () => HEADLINE_SERVER(false)),
  );
  assert.deepEqual(allOffline, {
    kind: "all-offline",
    total: 8,
    online: 0,
    offline: 8,
    lowAvailability: 0,
  });
});

test("statusHeadline counts abnormal agents as online and low uptime separately", () => {
  // 心跳还在 = 在线；xray_running 不影响头部结论（卡片上另有「异常」）。
  const headline = statusHeadline([
    HEADLINE_SERVER(true, 0.8),
    ...Array.from({ length: 7 }, () => HEADLINE_SERVER(true, 1)),
  ]);
  assert.equal(headline.kind, "all-online");
  assert.equal(headline.online, 8);
  assert.equal(headline.lowAvailability, 1, "低于 95% 的机器单独计数");
});

test("statusHeadline treats 95% as the low-availability boundary", () => {
  const headline = statusHeadline([
    HEADLINE_SERVER(true, 0.95),
    HEADLINE_SERVER(true, 0.949),
    HEADLINE_SERVER(true, null),
    HEADLINE_SERVER(true, undefined),
    HEADLINE_SERVER(true, Number.NaN),
    HEADLINE_SERVER(true, Number.POSITIVE_INFINITY),
  ]);
  // 0.95 仍算达标；null / NaN / 无穷大都没有采样，不参与「偏低」计数。
  assert.equal(headline.lowAvailability, 1);
  assert.equal(headline.total, 6);
  assert.equal(headline.online, 6);
});

test("statusHeadlineKey maps every verdict to a bilingual sentence", () => {
  const pick = (dictionary, path) =>
    path.split(".").reduce((node, part) => node?.[part], dictionary);
  const interpolate = (text, values = {}) =>
    text.replace(/\{(\w+)\}/g, (match, name) =>
      values[name] === undefined ? match : String(values[name]),
    );
  const render = (dictionary, headline) => {
    const { key, values } = statusHeadlineKey(headline);
    return interpolate(
      pick(dictionary, key.replace(/^publicStatus\./, "")),
      values,
    );
  };

  const allOnline = statusHeadline(
    Array.from({ length: 8 }, () => HEADLINE_SERVER(true)),
  );
  const partial = statusHeadline([
    ...Array.from({ length: 7 }, () => HEADLINE_SERVER(true)),
    HEADLINE_SERVER(false),
  ]);
  const allOffline = statusHeadline(
    Array.from({ length: 8 }, () => HEADLINE_SERVER(false)),
  );
  const low = statusHeadline([
    HEADLINE_SERVER(true, 0.92),
    ...Array.from({ length: 7 }, () => HEADLINE_SERVER(true, 1)),
  ]);

  assert.deepEqual(statusHeadlineKey(statusHeadline([])), {
    key: "publicStatus.summary.noServers",
  });
  assert.deepEqual(statusHeadlineKey(allOnline), {
    key: "publicStatus.hero.allOnline",
    values: { total: 8 },
  });
  assert.deepEqual(statusHeadlineKey(partial), {
    key: "publicStatus.hero.partial",
    values: { total: 8, online: 7, offline: 1 },
  });
  assert.deepEqual(statusHeadlineKey(allOffline), {
    key: "publicStatus.hero.allOffline",
  });
  assert.deepEqual(statusHeadlineKey(low), {
    key: "publicStatus.hero.allOnlineLow",
    values: { total: 8, low: 1 },
  });

  assert.equal(render(zh.publicStatus, allOnline), "全部 8 台在线，服务正常");
  assert.equal(
    render(en.publicStatus, allOnline),
    "All 8 nodes online, service normal",
  );
  assert.equal(render(zh.publicStatus, partial), "7 / 8 台在线，1 台离线");
  assert.equal(render(en.publicStatus, partial), "7 / 8 online, 1 offline");
  assert.equal(render(zh.publicStatus, allOffline), "当前没有在线节点");
  assert.equal(
    render(en.publicStatus, allOffline),
    "No nodes online right now",
  );
  assert.equal(
    render(zh.publicStatus, low),
    "全部 8 台在线，1 台可用率偏低",
  );
  assert.equal(
    render(en.publicStatus, low),
    "All 8 nodes online, 1 with low availability",
  );
});

test("statusHeadlineKey appends the low-availability clause to every verdict", () => {
  const partialLow = statusHeadline([
    HEADLINE_SERVER(true, 0.9),
    HEADLINE_SERVER(false, 1),
  ]);
  assert.deepEqual(statusHeadlineKey(partialLow), {
    key: "publicStatus.hero.partialLow",
    values: { total: 2, online: 1, offline: 1, low: 1 },
  });

  const allOfflineLow = statusHeadline([
    HEADLINE_SERVER(false, 0.9),
    HEADLINE_SERVER(false, 1),
  ]);
  assert.deepEqual(statusHeadlineKey(allOfflineLow), {
    key: "publicStatus.hero.allOfflineLow",
    values: { low: 1 },
  });
});

test("totalOnlineRate sums both directions of online servers only", () => {
  assert.equal(totalOnlineRate([]), null);
  // 离线机器保留的是掉线前最后一次读数，不能算进「当前总速率」。
  assert.equal(
    totalOnlineRate([
      { online: false, net_rx_bps: 1_000, net_tx_bps: 2_000 },
    ]),
    null,
  );

  assert.equal(
    totalOnlineRate([
      { online: true, net_rx_bps: 100, net_tx_bps: 50 },
      { online: false, net_rx_bps: 9_999, net_tx_bps: 9_999 },
      { online: true, net_rx_bps: 25, net_tx_bps: 5 },
    ]),
    180,
  );
});

test("totalOnlineRate skips missing and dirty directions but keeps zero", () => {
  // 只有一侧有数据：只加有数据的一侧。
  assert.equal(
    totalOnlineRate([{ online: true, net_rx_bps: null, net_tx_bps: 300 }]),
    300,
  );
  // 两侧都没有数据才是 null（页面显示 —），不能把未知写成 0。
  assert.equal(
    totalOnlineRate([
      { online: true, net_rx_bps: null, net_tx_bps: null },
      { online: true },
    ]),
    null,
  );
  // 负数 / NaN / 无穷大是脏数据，不参与求和。
  assert.equal(
    totalOnlineRate([
      { online: true, net_rx_bps: -1, net_tx_bps: Number.NaN },
      { online: true, net_rx_bps: 10, net_tx_bps: 5 },
    ]),
    15,
  );
  // 真实测到的 0 是有效数据，显示 0 B/s，而不是 —。
  assert.equal(
    totalOnlineRate([{ online: true, net_rx_bps: 0, net_tx_bps: 0 }]),
    0,
  );
  assert.equal(
    totalOnlineRate([
      { online: true, net_rx_bps: 0, net_tx_bps: 0 },
      { online: true, net_rx_bps: 500, net_tx_bps: null },
    ]),
    500,
  );
});

test("public status paths are the list and one-level detail routes", () => {
  assert.equal(isPublicStatusPath("/status"), true);
  assert.equal(isPublicStatusPath("/status/"), true);
  assert.equal(isPublicStatusPath("/status/srv-hk"), true, "详情页是公开路由");
  assert.equal(isPublicStatusPath("/status/srv-hk/"), true);
  assert.equal(isPublicStatusPath("/status/srv-hk/nodes"), false);
  assert.equal(isPublicStatusPath("/statuses"), false);
  assert.equal(isPublicStatusPath("/"), false);
  assert.equal(isPublicStatusPath("/login"), false);

  assert.equal(publicStatusServerId("/status/srv-hk"), "srv-hk");
  assert.equal(publicStatusServerId("/status/srv-hk/"), "srv-hk");
  assert.equal(
    publicStatusServerId("/status/srv%2Fhk"),
    "srv/hk",
    "id 可能是编码过的",
  );
  assert.equal(publicStatusServerId("/status"), null);
  assert.equal(publicStatusServerId("/status/"), null);
  assert.equal(publicStatusServerId("/status/a/b"), null);
  assert.equal(publicStatusServerId("/status/%"), null, "坏编码不崩");
});

test("lowestAvailabilityBucket finds the earliest lowest sampled hour", () => {
  const bucket = (ts, online_ratio) => ({ ts, online_ratio });
  assert.equal(lowestAvailabilityBucket([]), null);
  assert.equal(lowestAvailabilityBucket(null), null);
  assert.equal(
    lowestAvailabilityBucket([null, { ts: 1, online_ratio: Number.NaN }]),
    null,
  );
  assert.deepEqual(
    lowestAvailabilityBucket([
      bucket(1, 1),
      bucket(2, 0.91),
      bucket(3, 0.91),
      bucket(4, 0.98),
    ]),
    { ts: 2, ratio: 0.91 },
    "并列取更早的一段",
  );
  assert.deepEqual(
    lowestAvailabilityBucket([bucket(1, 2), bucket(2, -1)]),
    { ts: 2, ratio: 0 },
    "越界比例先夹到 0..1",
  );
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

test("statusGroupTabs hides the row until a server is actually grouped", () => {
  assert.deepEqual(statusGroupTabs([]), []);
  assert.deepEqual(
    statusGroupTabs([{ group_name: null }, {}, { group_name: "   " }]),
    [],
    "全部未分组时没有可筛选的分组，整行不渲染",
  );
});

test("statusGroupTabs counts each group, sorts named groups and puts ungrouped last", () => {
  assert.deepEqual(
    statusGroupTabs([
      { group_name: " 香港 " },
      { group_name: "香港" },
      { group_name: "日本" },
      { group_name: null },
      { group_name: "   " },
      { group_name: "香港 01" },
    ]),
    [
      { name: "日本", count: 1 },
      { name: "香港", count: 2 },
      { name: "香港 01", count: 1 },
      { name: null, count: 2 },
    ],
  );
});

test("statusGroupTabs omits the ungrouped tab when every server belongs to a group", () => {
  assert.deepEqual(
    statusGroupTabs([
      { group_name: "香港" },
      { group_name: "香港" },
      { group_name: "日本" },
    ]),
    [
      { name: "日本", count: 1 },
      { name: "香港", count: 2 },
    ],
  );
});

test("statusGroupTabs counts servers, not online servers", () => {
  const tabs = statusGroupTabs([
    { group_name: "香港", online: false },
    { group_name: "香港", online: true },
  ]);
  assert.deepEqual(tabs, [{ name: "香港", count: 2 }]);
});

test("matchesGroupFilter treats null as all and blank names as ungrouped", () => {
  assert.equal(matchesGroupFilter({ group_name: "香港" }, null), true);
  assert.equal(matchesGroupFilter({ group_name: null }, null), true);
  assert.equal(matchesGroupFilter({}, null), true);

  assert.equal(matchesGroupFilter({ group_name: null }, UNGROUPED_GROUP_KEY), true);
  assert.equal(matchesGroupFilter({}, UNGROUPED_GROUP_KEY), true);
  assert.equal(matchesGroupFilter({ group_name: "  " }, UNGROUPED_GROUP_KEY), true);
  assert.equal(matchesGroupFilter({ group_name: "香港" }, UNGROUPED_GROUP_KEY), false);

  // 与 normalizeGroupName 一致：去空白，但大小写仍敏感。
  assert.equal(matchesGroupFilter({ group_name: " 香港 " }, "香港"), true);
  assert.equal(matchesGroupFilter({ group_name: "香港" }, "日本"), false);
  assert.equal(matchesGroupFilter({ group_name: "hk" }, "HK"), false);
});

test("filterPublicServers intersects the group filter with status and search", () => {
  const servers = [
    SERVER({ id: "a", name: "HK 01", group_name: "香港" }),
    SERVER({ id: "b", name: "HK 02", group_name: "香港", online: false }),
    SERVER({ id: "c", name: "JP 01", group_name: "日本" }),
    SERVER({ id: "d", name: "U 01", group_name: null }),
  ];

  assert.deepEqual(
    filterPublicServers(servers, "all", "", "香港").map((s) => s.id),
    ["a", "b"],
  );
  assert.deepEqual(
    filterPublicServers(servers, "online", "", "香港").map((s) => s.id),
    ["a"],
  );
  assert.deepEqual(
    filterPublicServers(servers, "all", "hk", "香港").map((s) => s.id),
    ["a", "b"],
  );
  assert.deepEqual(
    filterPublicServers(servers, "all", "", UNGROUPED_GROUP_KEY).map((s) => s.id),
    ["d"],
  );
  assert.deepEqual(filterPublicServers(servers, "all", "jp", "香港"), []);
  // 不传分组时保持「全部」的旧行为。
  assert.deepEqual(
    filterPublicServers(servers, "all", "").map((s) => s.id),
    ["a", "b", "c", "d"],
  );
});

test("selecting a group alone shows that group's count over the total", () => {
  const servers = [
    SERVER({ id: "a", name: "HK 01", group_name: "香港" }),
    SERVER({ id: "b", name: "HK 02", group_name: "香港", online: false }),
    SERVER({ id: "c", name: "JP 01", group_name: "日本" }),
    SERVER({ id: "d", name: "U 01", group_name: null }),
  ];
  const [group] = statusGroupTabs(servers).filter((tab) => tab.name === "香港");

  // 分组按钮不再显示数量，右侧「清除筛选 x / y 台」是可见来源：
  // 只选中分组时 x = 该分组节点数，y = 全部节点数。
  assert.equal(group.count, 2);
  assert.equal(filterPublicServers(servers, "all", "", "香港").length, 2);
  assert.equal(servers.length, 4);
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
    "server.xrayRunning",
    "server.xrayStopped",
    "server.latency",
    "server.rate",
    "server.rateHint",
    "server.trafficTotal",
    "server.trafficTotalHint",
    "server.trafficRx",
    "server.trafficTx",
    "server.uptimeDaysHours",
    "server.uptimeDays",
    "server.uptimeHoursMinutes",
    "server.uptimeHours",
    "server.uptimeMinutes",
    "server.uptimeJustNow",
    "server.availability24hHint",
    "server.notSet",
    "summary.busiest",
    "summary.busiestHint",
    "summary.averageUptime",
    "summary.uptime24hHint",
    "summary.today",
    "hero.allOnline",
    "hero.allOnlineLow",
    "hero.partial",
    "hero.partialLow",
    "hero.allOffline",
    "hero.allOfflineLow",
    "hero.averageLatency",
    "hero.averageUptime",
    "hero.totalRate",
    "hero.load",
    "hero.aria",
    "availability.ok",
    "availability.warn",
    "availability.down",
    "availability.unknown",
    "groups.all",
    "groups.ungrouped",
    "groups.emptyFilteredTitle",
    "groups.title",
  ];
  const pick = (dictionary, path) =>
    path.split(".").reduce((node, part) => node?.[part], dictionary);

  for (const key of keys) {
    assert.equal(typeof pick(zh.publicStatus, key), "string", `zh ${key}`);
    assert.equal(typeof pick(en.publicStatus, key), "string", `en ${key}`);
  }
});

test("isStatusStale keeps data fresh for two minutes and flags it after", () => {
  const nowMs = 1_800_000_000_000;
  const at = nowMs / 1_000;

  // 窗口内：59 秒、119 秒都还算新鲜。
  assert.equal(isStatusStale(nowMs, at - 59), false);
  assert.equal(isStatusStale(nowMs, at - 119), false);
  // 边界：整两分钟起就过期，之后一直是过期。
  assert.equal(isStatusStale(nowMs, at - STATUS_STALE_SECONDS), true);
  assert.equal(isStatusStale(nowMs, at - 180), true);
  assert.equal(STATUS_STALE_SECONDS, 120);
});

test("isStatusStale ignores a missing clock and future timestamps", () => {
  // 首帧还没读到时钟：不能把「未知」当成过期。
  assert.equal(isStatusStale(0, 1_700_000_000), false);
  // 时钟偏差导致的未来时间戳同样不算过期。
  assert.equal(isStatusStale(1_800_000_000_000, 1_800_000_100), false);
  assert.equal(isStatusStale(1_800_000_000_000, Number.NaN), false);
});

test("onlineRateByDirection sums each direction of online servers only", () => {
  // 没有任何在线节点：整组没有读数，页面画一个 —。
  assert.equal(onlineRateByDirection([]), null);
  assert.equal(
    onlineRateByDirection([
      { online: false, net_rx_bps: 1_000, net_tx_bps: 2_000 },
    ]),
    null,
  );

  assert.deepEqual(
    onlineRateByDirection([
      { online: true, net_rx_bps: 100, net_tx_bps: 50 },
      { online: false, net_rx_bps: 9_999, net_tx_bps: 9_999 },
      { online: true, net_rx_bps: 25, net_tx_bps: 5 },
    ]),
    { rx: 125, tx: 55 },
  );
});

test("onlineRateByDirection keeps a missing direction apart from zero", () => {
  // 只有一侧有数据：另一侧是 null（显示 —），不是 0 B/s。
  assert.deepEqual(
    onlineRateByDirection([{ online: true, net_rx_bps: null, net_tx_bps: 300 }]),
    { rx: null, tx: 300 },
  );
  assert.deepEqual(
    onlineRateByDirection([{ online: true, net_rx_bps: 300 }]),
    { rx: 300, tx: null },
  );
  // 真实测到的 0 是有效数据。
  assert.deepEqual(
    onlineRateByDirection([{ online: true, net_rx_bps: 0, net_tx_bps: 0 }]),
    { rx: 0, tx: 0 },
  );
});

test("onlineRateByDirection skips dirty values per direction", () => {
  assert.deepEqual(
    onlineRateByDirection([
      { online: true, net_rx_bps: -1, net_tx_bps: Number.NaN },
      { online: true, net_rx_bps: 10, net_tx_bps: null },
    ]),
    { rx: 10, tx: null },
  );
  // 两个方向都被脏数据污染 = 没有数据。
  assert.equal(
    onlineRateByDirection([
      { online: true, net_rx_bps: -5, net_tx_bps: Number.POSITIVE_INFINITY },
    ]),
    null,
  );
});

test("totalOnlineRate stays the sum of the two directions", () => {
  const servers = [
    { online: true, net_rx_bps: 100, net_tx_bps: 50 },
    { online: true, net_rx_bps: 25, net_tx_bps: null },
  ];
  const rate = onlineRateByDirection(servers);
  assert.equal(totalOnlineRate(servers), rate.rx + rate.tx);
});

test("the public status page polls every 20s and pauses while hidden", () => {
  assert.equal(PUBLIC_STATUS_POLL_MS, 20_000);
  assert.ok(PUBLIC_STATUS_POLL_MS < STATUS_STALE_SECONDS * 1_000);

  const queries = read("./queries.ts");
  assert.match(
    queries,
    /return PUBLIC_STATUS_POLL_MS/,
    "usePublicStatus 正常态必须用 20 秒的共享常量轮询",
  );
  assert.match(
    queries,
    /refetchIntervalInBackground:\s*false/,
    "页签隐藏时必须暂停轮询",
  );
  assert.match(
    queries,
    /visibilitychange/,
    "恢复可见必须由 visibilitychange 触发一次补拉",
  );
  assert.match(queries, /document\.visibilityState === "visible"/);
});

test("the hero shows average latency instead of repeating the online count", () => {
  const hero = read("../components/status/Hero.tsx");
  assert.match(hero, /averageLatency\(servers\)/);
  assert.match(hero, /hero\.averageLatency/);
  assert.match(hero, />\s*ms\s*</);
  assert.doesNotMatch(hero, /hero\.onlineRate/);
});

test("the hero splits the total rate into down/up with a settle pulse", () => {
  const hero = read("../components/status/Hero.tsx");
  assert.match(hero, /onlineRateByDirection\(servers\)/);
  assert.match(hero, /ArrowDownIcon/);
  assert.match(hero, /ArrowUpIcon/);
  assert.match(hero, /value-settle/);
  assert.match(hero, /formatRatePairText/);
  assert.match(hero, /trafficRx/);
  assert.match(hero, /trafficTx/);
});

test("card traffic row leads every figure with an icon and three columns", () => {
  const card = read("../components/status/ServerCard.tsx");
  // 速率用方向箭头，累计用「箭头压线」区分「当前」与「累计」。
  assert.match(card, /ArrowDownIcon/);
  assert.match(card, /ArrowUpIcon/);
  assert.match(card, /ArrowDownToLineIcon/);
  assert.match(card, /ArrowUpToLineIcon/);
  // 第三列：到期 + 价格。
  assert.match(card, /CalendarClockIcon/);
  assert.match(card, /CoinsIcon/);
  // md 三列；<md 两列，账期组横跨两列换到第三行。
  assert.match(
    card,
    /md:grid-cols-\[minmax\(0,1fr\)_minmax\(0,1fr\)_minmax\(0,1\.35fr\)\]/,
  );
  assert.match(card, /col-span-2/);
  assert.match(card, /publicBilling\(server\)/);
  // 第三列永远存在：不再用 `billing ?` 条件渲染，缺项显示「未配置」。
  assert.doesNotMatch(card, /billing\s*&&/);
  assert.doesNotMatch(card, /\{billing\s*\?/);
  assert.match(card, /server\.notSet/);
  assert.match(card, /未配置|notSet/);
});

test("card is a link with the same hover edge, not a fake button", () => {
  const card = read("../components/status/ServerCard.tsx");
  // 整张卡进入详情：真实 <Link>，不是 role=button 的手写状态机。
  assert.match(card, /<Link/);
  assert.match(
    card,
    /to=\{`\/status\/\$\{encodeURIComponent\(server\.id\)\}`\}/,
  );
  assert.match(card, /publicStatus\.detail\.open/);
  assert.match(card, /ChevronRightIcon/);
  // 悬停仍只是 1px 主色 + 阴影，不做单选状态。
  assert.match(card, /group-hover:ring-1/);
  assert.match(card, /group-hover:ring-primary\/70/);
  assert.match(card, /group-hover:shadow-sm/);
  assert.doesNotMatch(card, /hover:ring-2|group-hover:ring-2/);
  assert.doesNotMatch(card, /aria-pressed/);
  assert.doesNotMatch(card, /toggleSelected/);
  assert.doesNotMatch(card, /role="button"/);
  assert.doesNotMatch(card, /cursor-pointer/);
  // 状态 chip / 状态点仍由 state 决定。
  assert.match(card, /<StatusChip state=\{state\}/);
});

test("expiryDays counts UTC+8 business days", () => {
  // 2026-11-20 12:00 (UTC+8)
  const now = Date.UTC(2026, 10, 20, 4, 0, 0);
  assert.equal(expiryDays("2026-12-17", now), 27);
  assert.equal(expiryDays("2026-11-20", now), 0);
  assert.equal(expiryDays("2026-11-19", now), -1);
  assert.equal(expiryDays("2027-01-01", now), 42);
});

test("expiryDays follows the UTC+8 calendar across midnight", () => {
  // 2026-11-20 00:30 (UTC+8) —— 浏览器在 UTC-8 仍是 11-19。
  const justAfterMidnight = Date.UTC(2026, 10, 19, 16, 30, 0);
  assert.equal(expiryDays("2026-11-20", justAfterMidnight), 0);
  // 2026-11-19 23:59 (UTC+8) 还差一分钟到 20 日。
  const beforeMidnight = Date.UTC(2026, 10, 19, 15, 59, 0);
  assert.equal(expiryDays("2026-11-20", beforeMidnight), 1);
  assert.equal(expiryDays("2026-11-19", beforeMidnight), 0);
});

test("expiryDays rejects missing and malformed dates", () => {
  assert.equal(expiryDays(null), null);
  assert.equal(expiryDays(undefined), null);
  assert.equal(expiryDays(""), null);
  assert.equal(expiryDays("   "), null);
  assert.equal(expiryDays("2026-2-1"), null);
  assert.equal(expiryDays("2026/12/17"), null);
  assert.equal(expiryDays("2026-02-30"), null);
  assert.equal(expiryDays("not-a-date"), null);
  // 闰日是真日期。
  assert.equal(expiryDays("2028-02-29", Date.UTC(2028, 1, 28, 4)), 1);
});

test("expiryLabel covers expired, today, tomorrow and N days", () => {
  assert.deepEqual(expiryLabel(-1), { key: "publicStatus.server.expired" });
  assert.deepEqual(expiryLabel(0), { key: "publicStatus.server.expiresToday" });
  assert.deepEqual(expiryLabel(1), {
    key: "publicStatus.server.expiresTomorrow",
  });
  assert.deepEqual(expiryLabel(27), {
    key: "publicStatus.server.expiresInDays",
    values: { days: 27 },
  });
});

test("formatPrice maps known currencies to symbols and others to codes", () => {
  assert.equal(formatPrice(26800, "CNY"), "¥268.00");
  assert.equal(formatPrice(1200, "usd"), "$12.00");
  assert.equal(formatPrice(990, "EUR"), "€9.90");
  // 未知币种显示代码，不猜符号。
  assert.equal(formatPrice(26800, "JPY"), "JPY 268.00");
  assert.equal(formatPrice(123456789, "JPY"), "JPY 1,234,567.89");
  // 0 是有效价格（免费额度），不能当成缺失。
  assert.equal(formatPrice(0, "CNY"), "¥0.00");
});

test("formatPrice hides the whole group when price or currency is missing", () => {
  assert.equal(formatPrice(null, "CNY"), null);
  assert.equal(formatPrice(undefined, "CNY"), null);
  assert.equal(formatPrice(Number.NaN, "CNY"), null);
  assert.equal(formatPrice(-1, "CNY"), null);
  assert.equal(formatPrice(100, null), null);
  assert.equal(formatPrice(100, "   "), null);
  assert.equal(normalizeCurrency(" cny "), "CNY");
  assert.equal(normalizeCurrency(null), null);
  assert.equal(formatPriceCents(26800), "268.00");
});

test("billingCycleKey maps the three cycles and rejects anything else", () => {
  assert.equal(
    billingCycleKey("monthly"),
    "publicStatus.server.cycle.monthly",
  );
  assert.equal(billingCycleKey(" Yearly "), "publicStatus.server.cycle.yearly");
  assert.equal(billingCycleKey("once"), "publicStatus.server.cycle.once");
  assert.equal(billingCycleKey("weekly"), null);
  assert.equal(billingCycleKey(null), null);
  assert.equal(billingCycleKey(undefined), null);
});

test("publicBilling keeps the third column and nulls only missing fields", () => {
  const now = Date.UTC(2026, 10, 20, 4, 0, 0);
  const full = {
    paid_until: "2026-12-17",
    price_cents: 26800,
    currency: "CNY",
    billing_cycle: "monthly",
  };
  assert.deepEqual(publicBilling(full, now), {
    paidUntil: "2026-12-17",
    days: 27,
    price: "¥268.00",
    cycleKey: "publicStatus.server.cycle.monthly",
  });

  // 缺哪项就哪项是 null；整个对象永远存在，第三列不会消失。
  assert.deepEqual(publicBilling({ ...full, paid_until: null }, now), {
    paidUntil: null,
    days: null,
    price: "¥268.00",
    cycleKey: "publicStatus.server.cycle.monthly",
  });
  assert.deepEqual(publicBilling({ ...full, paid_until: undefined }, now), {
    paidUntil: null,
    days: null,
    price: "¥268.00",
    cycleKey: "publicStatus.server.cycle.monthly",
  });
  assert.deepEqual(publicBilling({ ...full, price_cents: null }, now), {
    paidUntil: "2026-12-17",
    days: 27,
    price: null,
    cycleKey: "publicStatus.server.cycle.monthly",
  });
  assert.deepEqual(publicBilling({ ...full, currency: null }, now), {
    paidUntil: "2026-12-17",
    days: 27,
    price: null,
    cycleKey: "publicStatus.server.cycle.monthly",
  });
  assert.deepEqual(publicBilling({ ...full, billing_cycle: null }, now), {
    paidUntil: "2026-12-17",
    days: 27,
    price: "¥268.00",
    cycleKey: null,
  });
  assert.deepEqual(publicBilling({}, now), {
    paidUntil: null,
    days: null,
    price: null,
    cycleKey: null,
  });

  // 字段在但值非法，只让对应项变成 null。
  assert.deepEqual(publicBilling({ ...full, paid_until: "2026-02-30" }, now), {
    paidUntil: null,
    days: null,
    price: "¥268.00",
    cycleKey: "publicStatus.server.cycle.monthly",
  });
  assert.deepEqual(publicBilling({ ...full, billing_cycle: "weekly" }, now), {
    paidUntil: "2026-12-17",
    days: 27,
    price: "¥268.00",
    cycleKey: null,
  });
  assert.deepEqual(publicBilling({ ...full, price_cents: -100 }, now), {
    paidUntil: "2026-12-17",
    days: 27,
    price: null,
    cycleKey: "publicStatus.server.cycle.monthly",
  });
});

test("billing copy is bilingual and the cycles stay short", () => {
  assert.equal(zh.publicStatus.server.notSet, "未配置");
  assert.equal(en.publicStatus.server.notSet, "Not set");
  assert.equal(zh.publicStatus.server.cycle.monthly, "月");
  assert.equal(zh.publicStatus.server.cycle.yearly, "年");
  assert.equal(zh.publicStatus.server.cycle.once, "一次性");
  assert.equal(en.publicStatus.server.cycle.monthly, "mo");
  assert.equal(en.publicStatus.server.cycle.yearly, "yr");
  assert.equal(en.publicStatus.server.cycle.once, "one-time");
  assert.equal(zh.publicStatus.server.expiresToday, "今天到期");
  assert.equal(zh.publicStatus.server.expired, "已过期");
  assert.equal(en.publicStatus.server.expiresToday, "Expires today");
  assert.equal(en.publicStatus.server.expired, "Expired");
});

test("the hero uses average latency as the first KPI in both languages", () => {
  assert.equal(zh.publicStatus.hero.averageLatency, "平均延迟");
  assert.equal(en.publicStatus.hero.averageLatency, "Avg latency");
  // 数值仍是平均值，但标签不再写「平均」：与去掉进度条后的折线一致。
  assert.equal(zh.publicStatus.hero.averageUptime, "24h 可用率");
  assert.equal(en.publicStatus.hero.averageUptime, "24h uptime");
  assert.equal(zh.publicStatus.hero.totalRate, "当前总速率");
});

test("summarizeAvailability derives outages, coverage and extremes", () => {
  const bucket = (ts, online_ratio) => ({ ts, online_ratio });
  const fill = (hours) =>
    Array.from({ length: 24 }, (_, index) =>
      hours[index] === undefined ? bucket(index, 1) : hours[index],
    );

  const healthy = summarizeAvailability(fill({}));
  assert.equal(healthy.sampled, 24);
  assert.equal(healthy.coverageRatio, 1);
  assert.equal(healthy.outageCount, 0);
  assert.equal(healthy.outageHours, 0);
  assert.deepEqual(healthy.lowest, { ts: 0, ratio: 1 });
  assert.deepEqual(healthy.highest, { ts: 0, ratio: 1 });

  const incident = fill({
    2: null,
    3: null,
    8: bucket(8, 0),
    9: bucket(9, 0),
    10: bucket(10, 1),
    15: bucket(15, 0),
    18: null,
  });
  const summary = summarizeAvailability(incident);
  assert.equal(summary.sampled, 21);
  assert.equal(summary.coverageRatio, 21 / 24);
  assert.equal(summary.outageCount, 2, "8-9 与 15 是两段");
  assert.equal(summary.outageHours, 3);
  assert.deepEqual(summary.lowest, { ts: 8, ratio: 0 });
  assert.deepEqual(summary.highest, { ts: 0, ratio: 1 });
  assert.equal(summary.longestNormalHours, 5, "19-23 是连续 5 小时");
  assert.deepEqual(summary.outagePeriods, [
    { startTs: 8, endTs: 3609, hours: 2 },
    { startTs: 15, endTs: 3615, hours: 1 },
  ]);

  const gapped = summarizeAvailability(
    fill({
      4: bucket(4, 0),
      5: null,
      6: bucket(6, 0),
    }),
  );
  assert.equal(gapped.outageCount, 2, "null 打断连续中断");
  assert.equal(gapped.outageHours, 2);
  assert.deepEqual(gapped.outagePeriods, [
    { startTs: 4, endTs: 3604, hours: 1 },
    { startTs: 6, endTs: 3606, hours: 1 },
  ]);

  const empty = summarizeAvailability(Array.from({ length: 24 }, () => null));
  assert.equal(empty.sampled, 0);
  assert.equal(empty.coverageRatio, null);
  assert.equal(empty.outageCount, null, "无采样不能显示 0 次");
  assert.equal(empty.outageHours, null);
  assert.equal(empty.lowest, null);
  assert.equal(empty.highest, null);
  assert.equal(empty.longestNormalHours, null);
  assert.equal(empty.outagePeriods, null);
});

test("availabilityConclusion speaks in whole sentences", () => {
  const healthy = summarizeAvailability(
    Array.from({ length: 24 }, (_, ts) => ({ ts, online_ratio: 1 })),
  );
  assert.deepEqual(availabilityConclusion(healthy), {
    key: "publicStatus.detail.summary.healthy",
  });

  const empty = summarizeAvailability(Array.from({ length: 24 }, () => null));
  assert.deepEqual(availabilityConclusion(empty), {
    key: "publicStatus.detail.summary.noSamples",
  });

  const incident = summarizeAvailability(
    Array.from({ length: 24 }, (_, ts) => ({
      ts,
      online_ratio: ts === 8 || ts === 9 || ts === 15 ? 0 : 1,
    })),
  );
  // 8-9 与 15 是两段中断；精确分钟优先。
  assert.deepEqual(availabilityConclusion(incident, 192), {
    key: "publicStatus.detail.summary.outage",
    values: { count: 2, hours: 3, minutes: 12 },
  });
  // 精确分钟缺失时回落到整小时近似（3 个 0% 桶 = 3 小时）。
  assert.deepEqual(availabilityConclusion(incident, undefined), {
    key: "publicStatus.detail.summary.outageHours",
    values: { count: 2, hours: 3 },
  });
  // 后端明确 null：即便小时桶能算出近似值，也只报次数，不把未知写成具体时长。
  assert.deepEqual(
    availabilityConclusion({ sampled: 24, outageCount: 2, outageHours: 3 }, null),
    {
      key: "publicStatus.detail.summary.outageUnknown",
      values: { count: 2 },
    },
  );
  // 单数用 One 键，英文不会出现 "1 outages"。
  assert.deepEqual(
    availabilityConclusion({ sampled: 24, outageCount: 1, outageHours: 0 }, 0),
    {
      key: "publicStatus.detail.summary.outageLessThanMinuteOne",
      values: { count: 1 },
    },
  );
  assert.deepEqual(
    availabilityConclusion({ sampled: 24, outageCount: 1, outageHours: 1 }, 90),
    {
      key: "publicStatus.detail.summary.outageOne",
      values: { count: 1, hours: 1, minutes: 30 },
    },
  );
});
