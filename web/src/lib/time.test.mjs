import assert from "node:assert/strict";
import test from "node:test";
import { setCurrentLocale } from "../i18n/locale.ts";
import {
  formatClockTime,
  formatHourRange,
  formatRelativeTime,
} from "./time.ts";

setCurrentLocale("zh-CN");

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const secondsAgo = (seconds) => NOW / 1_000 - seconds;

test("formatRelativeTime keeps the default just-now copy under a minute", () => {
  assert.equal(formatRelativeTime(secondsAgo(0), NOW), "刚刚");
  assert.equal(formatRelativeTime(secondsAgo(32), NOW), "刚刚");
  assert.equal(formatRelativeTime(secondsAgo(59), NOW), "刚刚");
  assert.equal(formatRelativeTime(secondsAgo(60), NOW), "1 分钟前");
});

test("formatRelativeTime can include exact seconds for the member row", () => {
  assert.equal(formatRelativeTime(secondsAgo(0), NOW, true), "0 秒前");
  assert.equal(formatRelativeTime(secondsAgo(1), NOW, true), "1 秒前");
  assert.equal(formatRelativeTime(secondsAgo(32), NOW, true), "32 秒前");
  assert.equal(formatRelativeTime(secondsAgo(59), NOW, true), "59 秒前");
  // 超过一分钟后仍走原有的分钟分支。
  assert.equal(formatRelativeTime(secondsAgo(60), NOW, true), "1 分钟前");
  // 未来时间没有「多久以前」，回退绝对时间而不是显示负数 / 0 秒。
  assert.equal(
    formatRelativeTime(secondsAgo(-5), NOW, true),
    "2026-11-12 20:00:05",
  );
  assert.equal(formatRelativeTime(null, NOW, true), "从未在线");
});

test("formatRelativeTime keeps month-scale timestamps relative within a year", () => {
  // 30 天整：1 个月前；45 天：1 个月前；60 天：2 个月前。
  assert.equal(formatRelativeTime(secondsAgo(30 * 86_400), NOW), "1 个月前");
  assert.equal(formatRelativeTime(secondsAgo(45 * 86_400), NOW), "1 个月前");
  assert.equal(formatRelativeTime(secondsAgo(60 * 86_400), NOW), "2 个月前");
  // 364 天仍在一年内，继续用相对月份，不突然变成裸日期。
  assert.equal(formatRelativeTime(secondsAgo(364 * 86_400), NOW), "12 个月前");
});

test("formatRelativeTime falls back to absolute time over a year or in the future", () => {
  // 超过一年：相对时间失效，显示 UTC+8 绝对时间。
  assert.equal(
    formatRelativeTime(secondsAgo(400 * 86_400), NOW),
    "2025-10-08 20:00:00",
  );
  assert.equal(
    formatRelativeTime(secondsAgo(365 * 86_400), NOW),
    "2025-11-12 20:00:00",
  );
  // 未来一分钟：绝对时间，且不出现「前 / ago」。
  assert.equal(
    formatRelativeTime(secondsAgo(-60), NOW),
    "2026-11-12 20:01:00",
  );
});

test("formatClockTime prints UTC+8 hours, minutes and seconds", () => {
  // 参考实现页头是 `00:02:22`：秒也要在，才能看出数据停在什么时候。
  assert.equal(formatClockTime(0), "08:00:00");
  assert.equal(formatClockTime(1_791_458_933), "19:28:53");
  // UTC 20:00 在 UTC+8 已经是次日 04:00，跨午夜不能进位到前一天。
  assert.equal(
    formatClockTime(Date.UTC(2026, 10, 13, 20, 0, 0) / 1_000),
    "04:00:00",
  );
});

test("formatClockTime keeps a dash for missing or invalid timestamps", () => {
  assert.equal(formatClockTime(null), "—");
  assert.equal(formatClockTime(undefined), "—");
  assert.equal(formatClockTime(Number.NaN), "—");
});

test("formatHourRange prints a UTC+8 hour interval", () => {
  // 2026-11-20 19:00 UTC = 2026-11-21 03:00 UTC+8
  const start = Date.UTC(2026, 10, 20, 19, 0, 0) / 1_000;
  assert.equal(formatHourRange(start), "03:00–04:00");
  // 23:00 的下一段跨到 00:00，只写小时。
  const late = Date.UTC(2026, 10, 20, 15, 0, 0) / 1_000;
  assert.equal(formatHourRange(late), "23:00–00:00");
  assert.equal(formatHourRange(null), "—");
  assert.equal(formatHourRange(Number.NaN), "—");
});
