/**
 * 服务器列表「负载 / 内存 / 当前速率」三列对齐的源码级回归。
 *
 * 几何（text-align、行高、元素宽度）由 screenshots/server-columns/shots.mjs
 * 在真实浏览器里量；这里锁住 DOM 结构与文案契约，避免后续把右对齐、
 * 进度条或单行速率改回去。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import en from "../i18n/en.ts";
import zh from "../i18n/zh-CN.ts";
import { serverTableColumns } from "../lib/tableColumns.ts";
import {
  LOAD_MEMORY_SEPARATOR,
  formatLoadMemory,
} from "../lib/serverMetrics.ts";

function read(relative) {
  return readFileSync(
    fileURLToPath(new URL(`../${relative}`, import.meta.url)),
    "utf8",
  );
}

const servers = read("pages/Servers.tsx");

function block(startMarker, endMarker) {
  const start = servers.indexOf(startMarker);
  const end = servers.indexOf(endMarker, start);
  assert.ok(start > 0 && end > start, `找不到源码块：${startMarker}`);
  return servers.slice(start, end);
}

test("表头文案：负载 / 内存一列，中英词典都有", () => {
  assert.equal(zh.servers.detail.loadMemory, "负载 / 内存");
  assert.equal(en.servers.detail.loadMemory, "Load / Memory");

  const column = serverTableColumns((key) => key).find(
    (entry) => entry.key === "loadMemory",
  );
  assert.ok(column, "缺少 loadMemory 列");
  assert.equal(column.label, "servers.detail.loadMemory");
});

test("合并单元格：`0.39 / 31%`、tabular-nums、斜杠 muted、没有进度条", () => {
  const cell = block("function LoadMemoryCell", "function RatePartsView");

  assert.match(cell, /data-slot="server-load-memory"/);
  assert.match(cell, /loadMemoryDisplay\(/);
  assert.match(cell, /tabular-nums/);
  assert.match(cell, /LOAD_MEMORY_SEPARATOR/);
  // 斜杠单独成 span 并弱化；数值本身不是 muted（有数据时要能被读到）。
  assert.match(
    cell,
    /data-slot="load-memory-slash"\s+className="text-muted-foreground"/,
  );
  assert.doesNotMatch(cell, /<Progress/, "合并列里不允许再有进度条");
  assert.doesNotMatch(cell, /justify-end/, "合并列不能右对齐");
  assert.equal(LOAD_MEMORY_SEPARATOR, " / ");
  assert.equal(formatLoadMemory(0.39, 31, 100), "0.39 / 31%");
});

test("表格行：负载 + 内存只剩一个单元格，速率用两行布局", () => {
  const row = block("function renderRow", "function renderCard");

  // 三列合并成两列：loadMemory + rate，且都不再挂 text-right。
  assert.match(row, /<LoadMemoryCell server=\{server\} \/>/);
  assert.match(row, /<RateCell server=\{server\} layout="stacked" \/>/);
  assert.doesNotMatch(row, /<MemoryCell server=\{server\} \/>/);
  assert.doesNotMatch(row, /renderServerLoad\(server\)/);
  assert.doesNotMatch(row, /text-right/, "表格行不允许数值列右对齐");
  assert.match(row, /"h-16"/, "行高仍为 64px");
});

test("速率两行：上行（↑）在上、下行（↓）在下，13px 紧行高", () => {
  const cell = block("function RateLine", "function VersionCell");

  // stacked 分支在 inline 分支之前，DOM 顺序由源码顺序决定。
  const stackedStart = cell.indexOf('data-layout="stacked"');
  const tx = cell.indexOf('direction="tx"');
  const rx = cell.indexOf('direction="rx"');
  assert.ok(stackedStart > 0, "缺少 stacked 布局");
  assert.ok(tx > stackedStart, "上行行在 stacked 块内");
  assert.ok(rx > tx, "下行行必须排在上行之后");

  const stacked = cell.slice(stackedStart, cell.indexOf("return (", stackedStart + 1));
  assert.match(stacked, /flex-col items-start/, "两行左对齐堆叠");
  assert.match(stacked, /tabular-nums/);
  assert.match(cell, /leading-\[1\.15\]/, "两行 13px 用 1.15 行高");
  assert.match(cell, /text-\[13px\]/);

  // 箭头 muted + aria-hidden，不参与读屏（方向由 ↑ / ↓ 字形本身表达）。
  assert.match(
    cell,
    /<span className="text-muted-foreground" aria-hidden="true">\s*\{glyph\}/,
  );
  // 没有数据时仍然只有一个 —，不退化成两行上下箭头。
  assert.match(cell, /text-\[13px\] text-muted-foreground"\s+title=\{title\}/);
});

test("390 卡片视图保持独立字段，不被表格合并牵连", () => {
  const card = block("function renderCard", "function openCreateDialog");
  for (const key of [
    "servers.detail.load",
    "servers.detail.memory",
    "servers.detail.rate",
  ]) {
    assert.ok(card.includes(`t("${key}")`), `卡片缺少 ${key}`);
  }
  assert.match(card, /<MemoryCell server=\{server\} \/>/);
  // 卡片速率保持单行（未传 layout），避免卡片默认高度变化。
  assert.match(card, /<RateCell server=\{server\} \/>/);
});
