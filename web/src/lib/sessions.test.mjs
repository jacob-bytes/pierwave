import assert from "node:assert/strict";
import test from "node:test";
import en from "../i18n/en.ts";
import zh from "../i18n/zh-CN.ts";
import { setCurrentLocale } from "../i18n/locale.ts";
import { ALERT_EVENTS } from "./alerts.ts";
import {
  LOGIN_ALERT_EVENTS,
  RAW_UA_MAX_CHARS,
  SESSIONS_EMPTY_KEY,
  deviceSummary,
  formatLastSeen,
  ipLabel,
  lastSeenAt,
  parseUserAgent,
  sessionCountText,
  sortSessions,
  truncateUserAgent,
} from "./sessions.ts";

setCurrentLocale("zh-CN");

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const secondsAgo = (seconds) => NOW / 1_000 - seconds;

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const EDGE_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";
const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36";

test("deviceSummary recognises the common browsers and systems", () => {
  assert.equal(deviceSummary(CHROME_MAC), "Chrome 120 · macOS");
  assert.equal(deviceSummary(ANDROID_CHROME), "Chrome 119 · Android");
  assert.equal(deviceSummary(IPHONE_SAFARI), "Safari 17 · iOS");
  // Edge 的 UA 里也有 Chrome，必须优先识别 Edge。
  assert.equal(deviceSummary(EDGE_WINDOWS), "Edge 120 · Windows");
});

test("parseUserAgent exposes the parts used by the UI", () => {
  assert.deepEqual(parseUserAgent(CHROME_MAC), {
    browser: "Chrome 120",
    os: "macOS",
  });
  assert.deepEqual(parseUserAgent(""), { browser: null, os: null });
  assert.deepEqual(parseUserAgent(null), { browser: null, os: null });
});

test("unknown or empty UA falls back to raw text and the unknown label", () => {
  assert.equal(deviceSummary(""), "未知设备");
  assert.equal(deviceSummary(null), "未知设备");
  // 短 UA 解析不出浏览器时原样显示，不丢信息。
  assert.equal(deviceSummary("curl/8.0.1"), "curl/8.0.1");
  // 解析出系统但解析不出浏览器：仍按「解析失败」展示原始 UA。
  assert.equal(
    deviceSummary("CustomWindows (Windows NT 10.0)"),
    "CustomWindows (Windows NT 10.0)",
  );
});

test("long unknown UAs are truncated with an ellipsis", () => {
  const raw = "x".repeat(200);
  const summary = deviceSummary(raw);
  assert.equal(summary.length, RAW_UA_MAX_CHARS);
  assert.equal(summary.endsWith("…"), true);
  assert.equal(truncateUserAgent(raw), summary);
  assert.equal(truncateUserAgent("  short  "), "short");
  assert.equal(truncateUserAgent("", 10), "");
  // 按 Unicode 字符截断，不把表情切成半个。
  assert.equal(Array.from(truncateUserAgent("😀😀😀", 2)).length, 2);
});

test("last seen falls back to created_at and formats relative time", () => {
  const session = {
    id: "s1",
    user_agent: CHROME_MAC,
    ip: "203.0.113.1",
    created_at: secondsAgo(7200),
    last_seen_at: null,
    current: false,
  };
  assert.equal(lastSeenAt(session), session.created_at);
  assert.equal(formatLastSeen(session, NOW), "2 小时前");

  assert.equal(
    formatLastSeen({ ...session, last_seen_at: secondsAgo(60) }, NOW),
    "1 分钟前",
  );
});

test("sortSessions puts the current session first and newest activity next", () => {
  const sessions = [
    { id: "old", created_at: 10, last_seen_at: 20, current: false },
    { id: "current", created_at: 1, last_seen_at: 2, current: true },
    { id: "new", created_at: 30, last_seen_at: 90, current: false },
  ];
  assert.deepEqual(
    sortSessions(sessions).map((session) => session.id),
    ["current", "new", "old"],
  );
  assert.deepEqual(
    sessions.map((session) => session.id),
    ["old", "current", "new"],
    "不能改原数组",
  );
});

test("ip and count copy handle empty and singular values", () => {
  assert.equal(ipLabel("203.0.113.1"), "203.0.113.1");
  assert.equal(ipLabel(""), "IP 未知");
  assert.equal(ipLabel(null), "IP 未知");
  assert.equal(sessionCountText(1), "1 个设备");
  assert.equal(sessionCountText(2), "2 个设备");
});

test("empty states and the two new alert events exist in both locales", () => {
  const pick = (dictionary, path) =>
    path.split(".").reduce((node, part) => node?.[part], dictionary);

  for (const dictionary of [zh, en]) {
    assert.equal(typeof pick(dictionary, SESSIONS_EMPTY_KEY), "string");
    for (const event of LOGIN_ALERT_EVENTS) {
      assert.equal(
        typeof pick(dictionary, `settings.alerts.events.${event}`),
        "string",
        `${event} label`,
      );
      assert.equal(
        typeof pick(dictionary, `settings.alerts.events.${event}Desc`),
        "string",
        `${event} description`,
      );
    }
  }

  for (const event of LOGIN_ALERT_EVENTS) {
    assert.equal(
      ALERT_EVENTS.includes(event),
      true,
      `${event} 必须加入告警事件白名单`,
    );
  }
});
