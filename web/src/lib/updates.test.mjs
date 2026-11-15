import assert from "node:assert/strict";
import test from "node:test";
import { setCurrentLocale } from "../i18n/locale.ts";
import {
  checkedAtText,
  compareVersions,
  DEFAULT_UPDATE_INTERVAL_HOURS,
  formatVersion,
  hasUpdate,
  isNewerVersion,
  parseUpdateInterval,
  pickBilingual,
  releaseDateText,
  showsUpdateDot,
  UPDATE_INTERVAL_MAX_HOURS,
  UPDATE_INTERVAL_MIN_HOURS,
  updateBadgeState,
  updateErrorText,
} from "./updates.ts";

setCurrentLocale("zh-CN");

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const secondsAgo = (seconds) => NOW / 1_000 - seconds;

/** 构造一份 /updates 响应；`master` 可局部覆盖。 */
function payload(master = {}, agents = {}) {
  return {
    master: {
      current: "0.11.3",
      latest: "0.12.0",
      update_available: true,
      release_url: "https://github.com/jacob-bytes/pierwave/releases/tag/v0.12.0",
      released_at: 1_795_168_800,
      checked_at: 1_795_200_000,
      error: null,
      ...master,
    },
    agents: {
      current_protocol: 25,
      min_supported: 16,
      versions: [],
      ...agents,
    },
  };
}

test("compareVersions compares numeric segments, not strings", () => {
  assert.ok(compareVersions("0.12.0", "0.11.3") > 0);
  assert.ok(compareVersions("0.11.3", "0.12.0") < 0);
  assert.equal(compareVersions("0.11.3", "0.11.3"), 0);
  assert.ok(compareVersions("0.11.10", "0.11.9") > 0, "10 > 9，不是字符串比较");
  assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
  assert.ok(compareVersions("0.9", "0.9.0") === 0, "缺失段补 0");
});

test("compareVersions accepts v prefix and ignores build metadata", () => {
  assert.ok(isNewerVersion("v0.12.0", "0.11.3"));
  assert.ok(isNewerVersion("V0.12.0", "v0.11.3"));
  assert.ok(isNewerVersion("0.12.0+build.7", "0.11.3"));
  assert.equal(compareVersions("0.12.0+build.7", "0.12.0"), 0);
});

test("pre-release is older than the matching release", () => {
  assert.ok(compareVersions("0.12.0-rc.1", "0.12.0") < 0);
  assert.ok(isNewerVersion("0.12.0", "0.12.0-rc.1"));
  assert.ok(isNewerVersion("0.12.0-rc.2", "0.12.0-rc.1"));
  assert.ok(isNewerVersion("0.12.0-rc.1", "0.12.0-beta"));
});

test("non-numeric versions never claim an update and never throw", () => {
  assert.equal(compareVersions("banana", "0.11.3"), 0);
  assert.equal(isNewerVersion("banana", "0.11.3"), false);
  assert.equal(hasUpdate("0.12.0", "dev"), false);
  assert.equal(hasUpdate("nope", "0.11.3"), false);
});

test("hasUpdate only fires for a strictly newer, parseable version", () => {
  assert.equal(hasUpdate("0.12.0", "0.11.3"), true);
  assert.equal(hasUpdate("v0.12.0", "v0.11.3"), true);
  assert.equal(hasUpdate("0.11.3", "0.11.3"), false);
  assert.equal(hasUpdate("0.11.2", "0.11.3"), false);
  assert.equal(hasUpdate(null, "0.11.3"), false);
  assert.equal(hasUpdate("", "0.11.3"), false);
  assert.equal(hasUpdate("0.11.10", "0.11.9"), true);
});

test("formatVersion always renders a v prefix", () => {
  assert.equal(formatVersion("0.11.3"), "v0.11.3");
  assert.equal(formatVersion("v0.11.3"), "v0.11.3");
  assert.equal(formatVersion(" V0.11.3 "), "V0.11.3");
  assert.equal(formatVersion(null), "—");
  assert.equal(formatVersion("   "), "—");
});

test("updateBadgeState hides the entry for non-admins", () => {
  assert.equal(
    updateBadgeState({ enabled: false, pending: false, failed: false, data: payload() }),
    "hidden",
  );
  assert.equal(showsUpdateDot("hidden"), false);
});

test("updateBadgeState shows a dot only when a new version is available", () => {
  const state = updateBadgeState({
    enabled: true,
    pending: false,
    failed: false,
    data: payload(),
  });
  assert.equal(state, "update");
  assert.equal(showsUpdateDot(state), true);
});

test("updateBadgeState reports latest without a dot", () => {
  const state = updateBadgeState({
    enabled: true,
    pending: false,
    failed: false,
    data: payload({ latest: "0.11.3", update_available: false }),
  });
  assert.equal(state, "latest");
  assert.equal(showsUpdateDot(state), false);
});

test("updateBadgeState hides the dot when the check failed", () => {
  const state = updateBadgeState({
    enabled: true,
    pending: false,
    failed: false,
    data: payload({ error: "GitHub Releases 返回 HTTP 503 / GitHub responded with HTTP 503" }),
  });
  assert.equal(state, "error");
  assert.equal(showsUpdateDot(state), false);
});

test("updateBadgeState covers loading, request failures and never-checked", () => {
  assert.equal(
    updateBadgeState({ enabled: true, pending: true, failed: false, data: null }),
    "loading",
  );
  assert.equal(
    updateBadgeState({ enabled: true, pending: false, failed: true, data: null }),
    "error",
  );
  assert.equal(
    updateBadgeState({
      enabled: true,
      pending: false,
      failed: false,
      data: payload({ latest: null, update_available: false, checked_at: null }),
    }),
    "unknown",
    "从未检测过不能谎称已是最新",
  );
});

test("a backend flag without a newer version never shows the dot", () => {
  const state = updateBadgeState({
    enabled: true,
    pending: false,
    failed: false,
    data: payload({ latest: "0.11.3", update_available: true }),
  });
  assert.equal(state, "latest");
  assert.equal(showsUpdateDot(state), false);
});

test("checkedAtText uses the shared relative-time wording", () => {
  assert.equal(checkedAtText(secondsAgo(3 * 3600), NOW), "3 小时前");
  assert.equal(checkedAtText(secondsAgo(60), NOW), "1 分钟前");
  assert.equal(checkedAtText(secondsAgo(30), NOW), "刚刚");
  assert.equal(checkedAtText(null, NOW), "尚未检测");
});

test("releaseDateText and updateErrorText tolerate missing values", () => {
  assert.equal(releaseDateText(1_795_168_800), "2026-11-20");
  assert.equal(releaseDateText(null), null);
  assert.equal(updateErrorText("  boom / boom  "), "boom / boom");
  assert.equal(updateErrorText("   "), null);
  assert.equal(updateErrorText(null), null);
});

test("pickBilingual keeps only the current language half", () => {
  const message =
    "GitHub Releases 返回 HTTP 503 / GitHub Releases responded with HTTP 503";
  assert.equal(pickBilingual(message, "zh-CN"), "GitHub Releases 返回 HTTP 503");
  assert.equal(
    pickBilingual(message, "en"),
    "GitHub Releases responded with HTTP 503",
  );
  assert.equal(pickBilingual("单语错误", "en"), "单语错误");
  assert.equal(pickBilingual("  ", "zh-CN"), "");
});

test("relative-time wording follows the current locale", () => {
  setCurrentLocale("en");
  try {
    assert.equal(checkedAtText(secondsAgo(3 * 3600), NOW), "3 hours ago");
    assert.equal(checkedAtText(null, NOW), "Not checked yet");
  } finally {
    setCurrentLocale("zh-CN");
  }
});

test("update interval accepts the documented 1–168 hour window", () => {
  assert.equal(UPDATE_INTERVAL_MIN_HOURS, 1);
  assert.equal(UPDATE_INTERVAL_MAX_HOURS, 168);
  assert.equal(DEFAULT_UPDATE_INTERVAL_HOURS, 6);
  assert.equal(parseUpdateInterval("1"), 1);
  assert.equal(parseUpdateInterval("6"), 6);
  assert.equal(parseUpdateInterval("168"), 168);
  assert.equal(parseUpdateInterval(" 24 "), 24);
});

test("update interval rejects empty, non-numeric and out-of-range input", () => {
  for (const raw of ["", "   ", "0", "169", "-1", "1.5", "6h", "abc", "1e3"]) {
    assert.equal(parseUpdateInterval(raw), null, raw);
  }
});
