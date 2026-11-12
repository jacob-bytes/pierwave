import assert from "node:assert/strict";
import test from "node:test";
import en from "../i18n/en.ts";
import zhCN from "../i18n/zh-CN.ts";
import {
  MEMBER_SEEN_STALE_MS,
  arrowWarning,
  arrowWidth,
  hopLatencyLabel,
  hopLatencyTone,
  isoToUnixSeconds,
  memberInUse,
  memberSeenTone,
  pathModeBadge,
  protocolBadge,
  targetErrorKey,
  totalLatencyLabel,
} from "./chainTopology.ts";

function lookup(messages, key) {
  return key
    .split(".")
    .reduce((node, part) => (node == null ? undefined : node[part]), messages);
}

const zhT = (key) => lookup(zhCN, key);
const enT = (key) => lookup(en, key);

test("hopLatencyTone maps <200 / 200-500 / >500 to default / warning / destructive", () => {
  assert.equal(hopLatencyTone(0), "default");
  assert.equal(hopLatencyTone(18), "default");
  assert.equal(hopLatencyTone(199), "default");
  assert.equal(hopLatencyTone(200), "warning");
  assert.equal(hopLatencyTone(350), "warning");
  assert.equal(hopLatencyTone(500), "warning");
  assert.equal(hopLatencyTone(501), "destructive");
  assert.equal(hopLatencyTone(1200), "destructive");
});

test("hopLatencyTone treats null / NaN / negative as missing data, never 0 ms", () => {
  assert.equal(hopLatencyTone(null), "muted");
  assert.equal(hopLatencyTone(undefined), "muted");
  assert.equal(hopLatencyTone(Number.NaN), "muted");
  assert.equal(hopLatencyTone(-1), "muted");
});

test("hopLatencyLabel keeps a placeholder so arrows do not collapse", () => {
  assert.equal(hopLatencyLabel(null), "—");
  assert.equal(hopLatencyLabel(undefined), "—");
  assert.equal(hopLatencyLabel(0), "0 ms");
  assert.equal(hopLatencyLabel(18), "18 ms");
  assert.equal(hopLatencyLabel(72.6), "73 ms");
});

test("protocolBadge renders the three chain protocols", () => {
  assert.equal(protocolBadge("tcp"), "TCP");
  assert.equal(protocolBadge("udp"), "UDP");
  assert.equal(protocolBadge("both"), "TCP + UDP");
  assert.equal(protocolBadge("  UDP  "), "UDP");
});

test("protocolBadge falls back to TCP for unknown values, matching the backend", () => {
  assert.equal(protocolBadge("sctp"), "TCP");
  assert.equal(protocolBadge(null), "TCP");
  assert.equal(protocolBadge(undefined), "TCP");
  assert.equal(protocolBadge(""), "TCP");
});

test("pathModeBadge shows current path for single and source hashing for hash", () => {
  assert.equal(pathModeBadge("single", zhT), "当前路径");
  assert.equal(pathModeBadge("single", enT), "Current path");
  assert.equal(pathModeBadge("hash", zhT), "按来源分流");
  assert.equal(pathModeBadge("hash", enT), "Hashed by source");
  assert.equal(pathModeBadge("single", (key) => key), "chains.detail.currentPath");
});

test("pathModeBadge stays silent for multi and unknown modes", () => {
  assert.equal(pathModeBadge("multi", zhT), null);
  assert.equal(pathModeBadge("weird", zhT), null);
  assert.equal(pathModeBadge(null, zhT), null);
  assert.equal(pathModeBadge(undefined, zhT), null);
});

test("totalLatencyLabel returns null exactly when there is no total", () => {
  assert.equal(totalLatencyLabel(null), null);
  assert.equal(totalLatencyLabel(undefined), null);
  assert.equal(totalLatencyLabel(Number.NaN), null);
  assert.equal(totalLatencyLabel(-5), null);
  assert.equal(totalLatencyLabel(0), "0 ms");
  assert.equal(totalLatencyLabel(73), "73 ms");
});

test("total latency copy exists in both dictionaries", () => {
  assert.equal(lookup(zhCN, "chains.detail.totalLatency"), "链路内合计 {total}");
  assert.equal(lookup(en, "chains.detail.totalLatency"), "Chain total {total}");
  assert.equal(lookup(zhCN, "chains.detail.totalLatencyTitle"), "不含客户端到入口");
  assert.equal(lookup(en, "chains.detail.totalLatencyTitle"), "Excludes client to entry");
});

test("memberInUse only marks multi-member groups in multi mode", () => {
  assert.equal(memberInUse("multi", 2), true);
  assert.equal(memberInUse("multi", 8), true);
  assert.equal(memberInUse("multi", 1), false);
  assert.equal(memberInUse("multi", 0), false);
  assert.equal(memberInUse("single", 3), false);
  assert.equal(memberInUse("hash", 3), false);
  assert.equal(memberInUse("unknown", 3), false);
});

const SEEN_NOW = Date.parse("2026-11-12T12:00:00.000Z");
const isoAgo = (ms) => new Date(SEEN_NOW - ms).toISOString();

test("isoToUnixSeconds converts ISO8601 and rejects missing or invalid values", () => {
  assert.equal(isoToUnixSeconds("1970-01-01T00:00:01.000Z"), 1);
  assert.equal(isoToUnixSeconds("2026-11-12T12:00:00.000Z"), SEEN_NOW / 1_000);
  assert.equal(isoToUnixSeconds(" 2026-11-12T12:00:00.000Z "), SEEN_NOW / 1_000);
  assert.equal(isoToUnixSeconds("not-a-date"), null);
  assert.equal(isoToUnixSeconds(""), null);
  assert.equal(isoToUnixSeconds("   "), null);
  assert.equal(isoToUnixSeconds(null), null);
  assert.equal(isoToUnixSeconds(undefined), null);
  assert.equal(isoToUnixSeconds(1_794_000_000), null);
});

test("memberSeenTone: fresh report is default", () => {
  assert.equal(memberSeenTone(isoAgo(32_000), SEEN_NOW), "default");
  assert.equal(memberSeenTone(isoAgo(1_000), SEEN_NOW), "default");
  assert.equal(memberSeenTone(isoAgo(MEMBER_SEEN_STALE_MS), SEEN_NOW), "default");
  assert.equal(memberSeenTone(isoAgo(MEMBER_SEEN_STALE_MS - 1), SEEN_NOW), "default");
  // 时钟偏差给出的未来时间也不该被标成陈旧。
  assert.equal(memberSeenTone(isoAgo(-10_000), SEEN_NOW), "default");
  assert.equal(MEMBER_SEEN_STALE_MS, 300_000);
});

test("memberSeenTone: strictly over 5 minutes is warning", () => {
  assert.equal(memberSeenTone(isoAgo(MEMBER_SEEN_STALE_MS + 1), SEEN_NOW), "warning");
  assert.equal(memberSeenTone(isoAgo(MEMBER_SEEN_STALE_MS + 60_000), SEEN_NOW), "warning");
  assert.equal(memberSeenTone(isoAgo(3_600_000), SEEN_NOW), "warning");
});

test("memberSeenTone: missing or invalid heartbeat is muted, never warning", () => {
  assert.equal(memberSeenTone(null, SEEN_NOW), "muted");
  assert.equal(memberSeenTone(undefined, SEEN_NOW), "muted");
  assert.equal(memberSeenTone("", SEEN_NOW), "muted");
  assert.equal(memberSeenTone("   ", SEEN_NOW), "muted");
  assert.equal(memberSeenTone("not-a-date", SEEN_NOW), "muted");
  assert.equal(memberSeenTone(1_794_000_000, SEEN_NOW), "muted");
});

test("arrowWidth: <50 ms is 1px, 50-200 ms is 1.5px, >200 ms is 2px", () => {
  assert.equal(arrowWidth(0), 1);
  assert.equal(arrowWidth(49), 1);
  assert.equal(arrowWidth(49.9), 1);
  assert.equal(arrowWidth(50), 1.5);
  assert.equal(arrowWidth(100), 1.5);
  assert.equal(arrowWidth(200), 1.5);
  assert.equal(arrowWidth(200.1), 2);
  assert.equal(arrowWidth(201), 2);
  assert.equal(arrowWidth(1_200), 2);
});

test("arrowWidth keeps 1px for missing or invalid latency", () => {
  assert.equal(arrowWidth(null), 1);
  assert.equal(arrowWidth(undefined), 1);
  assert.equal(arrowWidth(Number.NaN), 1);
  assert.equal(arrowWidth(-1), 1);
});

test("arrowWarning only fires above 200 ms", () => {
  assert.equal(arrowWarning(null), false);
  assert.equal(arrowWarning(undefined), false);
  assert.equal(arrowWarning(Number.NaN), false);
  assert.equal(arrowWarning(0), false);
  assert.equal(arrowWarning(50), false);
  assert.equal(arrowWarning(200), false);
  assert.equal(arrowWarning(200.1), true);
  assert.equal(arrowWarning(201), true);
  assert.equal(arrowWarning(1_200), true);
});

test("targetErrorKey maps exactly the six stable TLS probe codes", () => {
  assert.equal(targetErrorKey("tcp_connect_failed"), "chains.tlsError.tcp_connect_failed");
  assert.equal(targetErrorKey("cert_expired"), "chains.tlsError.cert_expired");
  assert.equal(targetErrorKey("unknown_issuer"), "chains.tlsError.unknown_issuer");
  assert.equal(targetErrorKey("name_mismatch"), "chains.tlsError.name_mismatch");
  assert.equal(targetErrorKey("handshake_failed"), "chains.tlsError.handshake_failed");
  assert.equal(targetErrorKey("timeout"), "chains.tlsError.timeout");
  assert.equal(targetErrorKey("  timeout  "), "chains.tlsError.timeout");
});

test("targetErrorKey hides unknown, empty and non-string codes", () => {
  assert.equal(targetErrorKey("connection_reset"), null);
  assert.equal(targetErrorKey("TCP_CONNECT_FAILED"), null);
  assert.equal(targetErrorKey(""), null);
  assert.equal(targetErrorKey("   "), null);
  assert.equal(targetErrorKey(null), null);
  assert.equal(targetErrorKey(undefined), null);
  assert.equal(targetErrorKey(1), null);
});

test("targetErrorKey resolves to translated copy in both dictionaries", () => {
  assert.equal(zhT(targetErrorKey("cert_expired")), "证书已过期");
  assert.equal(zhT(targetErrorKey("timeout")), "TLS 握手超时");
  assert.equal(enT(targetErrorKey("cert_expired")), "Certificate expired");
  assert.equal(enT(targetErrorKey("timeout")), "TLS handshake timed out");
});

test("last-seen and fullscreen copy exist in both dictionaries", () => {
  assert.equal(zhT("chains.member.lastSeen"), "最后上报 {time}");
  assert.equal(enT("chains.member.lastSeen"), "Last reported {time}");
  assert.equal(zhT("chains.member.lastSeenNone"), "未上报");
  assert.equal(enT("chains.member.lastSeenNone"), "Not reported");
  assert.equal(zhT("chains.detail.fullscreen"), "全屏");
  assert.equal(enT("chains.detail.fullscreen"), "Fullscreen");
  assert.equal(zhT("chains.detail.exitFullscreen"), "退出全屏");
  assert.equal(enT("chains.detail.exitFullscreen"), "Exit fullscreen");
});
