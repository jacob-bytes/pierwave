import assert from "node:assert/strict";
import test from "node:test";
import { setCurrentLocale } from "../i18n/locale.ts";
import { formatClockTime, formatRelativeTime } from "./time.ts";

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
  // 时钟偏差导致的未来时间不显示负数。
  assert.equal(formatRelativeTime(secondsAgo(-5), NOW, true), "0 秒前");
  assert.equal(formatRelativeTime(null, NOW, true), "从未在线");
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
