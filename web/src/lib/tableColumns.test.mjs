import assert from "node:assert/strict";
import test from "node:test";
import {
  SERVER_TABLE_COLUMN_KEYS,
  serverTableColumns,
} from "./tableColumns.ts";

const t = (key) => key;

test("server table has one metadata entry per real column", () => {
  const columns = serverTableColumns(t);
  assert.equal(columns.length, 12);
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

test("server table keeps responsive visibility and right alignment in metadata", () => {
  const columns = serverTableColumns(t);
  const byKey = Object.fromEntries(columns.map((column) => [column.key, column]));

  // 真实表头与骨架都必须带同一套响应式类，否则 1440 下列数会不一致。
  assert.ok(byKey.address.headClassName.includes("hidden lg:table-cell"));
  assert.ok(byKey.address.skeletonClassName.includes("hidden lg:table-cell"));
  assert.ok(byKey.mode.headClassName.includes("hidden 2xl:table-cell"));
  assert.ok(byKey.mode.skeletonClassName.includes("hidden 2xl:table-cell"));
  assert.ok(byKey.version.skeletonClassName.includes("hidden xl:table-cell"));

  for (const key of ["load", "memory", "rate"]) {
    assert.ok(byKey[key].headClassName.includes("text-right"), `${key} 右对齐`);
    assert.ok(byKey[key].skeletonClassName.includes("text-right"), `${key} 骨架右对齐`);
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
