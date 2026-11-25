import assert from "node:assert/strict";
import test from "node:test";
import {
  LOAD_MEMORY_SEPARATOR,
  formatLoadMemory,
  loadMemoryDisplay,
  loadText,
  memoryPercent,
} from "./serverMetrics.ts";

test("合并列文案：负载两位小数 + 内存百分比，斜杠两侧留空格", () => {
  const display = loadMemoryDisplay(0.39, 3.1 * 1024 ** 3, 10 * 1024 ** 3);
  assert.equal(display.load, "0.39");
  assert.equal(display.memory, "31%");
  assert.equal(formatLoadMemory(0.39, 3.1 * 1024 ** 3, 10 * 1024 ** 3), "0.39 / 31%");
  assert.equal(LOAD_MEMORY_SEPARATOR, " / ");
});

test("负载固定两位小数，0 是有效值", () => {
  assert.equal(loadText(0), "0.00");
  assert.equal(loadText(12), "12.00");
  assert.equal(loadText(1.239), "1.24");
  assert.equal(loadText(null), "—");
  assert.equal(loadText(undefined), "—");
  // 负数 / NaN / Infinity 都是「没有数据」，不能画出 -1.00 或 NaN。
  assert.equal(loadText(-1), "—");
  assert.equal(loadText(Number.NaN), "—");
  assert.equal(loadText(Number.POSITIVE_INFINITY), "—");
});

test("内存百分比四舍五入、夹在 0–100", () => {
  assert.equal(memoryPercent(31.4, 100), 31.4);
  assert.equal(loadMemoryDisplay(0, 31.4, 100).memory, "31%");
  assert.equal(loadMemoryDisplay(0, 31.5, 100).memory, "32%");
  assert.equal(loadMemoryDisplay(0, 200, 100).memory, "100%");
  assert.equal(loadMemoryDisplay(0, -5, 100).memory, "0%");
});

test("内存缺值 / 总量为 0 时显示 —，不拿 0 冒充", () => {
  assert.equal(memoryPercent(null, 100), null);
  assert.equal(memoryPercent(10, null), null);
  assert.equal(memoryPercent(10, 0), null);
  assert.equal(memoryPercent(10, -1), null);
  assert.equal(memoryPercent(Number.NaN, 100), null);
  assert.equal(loadMemoryDisplay(0.39, null, null).memory, "—");
  // 两侧都缺数据时保留合并格式，而不是塌成一个 —。
  assert.equal(formatLoadMemory(null, null, null), "— / —");
});
