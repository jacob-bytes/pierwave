import assert from "node:assert/strict";
import test from "node:test";
import {
  SERVER_TABLE_COLUMN_KEYS,
  serverTableColumns,
} from "./tableColumns.ts";

const t = (key) => key;

test("server table has one metadata entry per real column", () => {
  const columns = serverTableColumns(t);
  assert.equal(columns.length, 11);
  assert.equal(columns.length, SERVER_TABLE_COLUMN_KEYS.length);
  assert.deepEqual(
    columns.map((column) => column.key),
    [...SERVER_TABLE_COLUMN_KEYS],
  );
  assert.equal(
    new Set(columns.map((column) => column.key)).size,
    columns.length,
    "列 key 不重复",
  );
});

test("负载与内存合成一列，数值列一律左对齐", () => {
  const columns = serverTableColumns(t);
  const byKey = Object.fromEntries(columns.map((column) => [column.key, column]));

  // 合并：不再有独立的 load / memory 列，只剩 loadMemory。
  assert.equal(byKey.load, undefined);
  assert.equal(byKey.memory, undefined);
  assert.equal(byKey.loadMemory.label, "servers.detail.loadMemory");
  assert.ok(
    columns.findIndex((column) => column.key === "loadMemory") <
      columns.findIndex((column) => column.key === "rate"),
    "负载 / 内存列在速率列之前",
  );

  // 真实表头与骨架都必须带同一套响应式类，否则 1440 下列数会不一致。
  assert.ok(byKey.address.headClassName.includes("hidden lg:table-cell"));
  assert.ok(byKey.address.skeletonClassName.includes("hidden lg:table-cell"));
  assert.ok(byKey.mode.headClassName.includes("hidden 2xl:table-cell"));
  assert.ok(byKey.mode.skeletonClassName.includes("hidden 2xl:table-cell"));
  assert.ok(byKey.version.skeletonClassName.includes("hidden xl:table-cell"));

  for (const key of ["loadMemory", "rate"]) {
    assert.ok(byKey[key].headClassName.includes("text-left"), `${key} 左对齐`);
    assert.ok(
      byKey[key].skeletonClassName.includes("text-left"),
      `${key} 骨架左对齐`,
    );
    assert.doesNotMatch(byKey[key].headClassName, /text-right/, `${key} 不再右对齐`);
    assert.doesNotMatch(
      byKey[key].skeletonClassName,
      /text-right/,
      `${key} 骨架不再右对齐`,
    );
  }

  assert.equal(byKey.select.sticky, "left");
  assert.equal(byKey.actions.sticky, "right");
});

test("server table skeleton widths are explicit, not all equal", () => {
  const columns = serverTableColumns(t);
  const widths = columns.map((column) => column.skeletonWidth);
  assert.ok(widths.every((width) => width.startsWith("w-")));
  assert.ok(new Set(widths).size > 1, "骨架列宽不能全部等宽");
});
