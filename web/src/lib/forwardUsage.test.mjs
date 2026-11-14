import assert from "node:assert/strict";
import test from "node:test";
import {
  FORWARD_USAGE_WINDOWS,
  filterUsageRows,
  forwardUsageName,
  forwardUsageUserName,
  isForwardUsageWindow,
  isUsageEmpty,
  sortUsageRows,
  sumUsageDays,
  usageUserOptions,
  windowLabel,
} from "./forwardUsage.ts";

const row = (overrides = {}) => ({
  forward_id: "fwd-a",
  name: "1.1.1.1:443",
  user_id: "u-alice",
  user_name: "alice",
  bytes: 100,
  weighted: 120,
  ...overrides,
});

test("windowLabel uses the shared i18n key and keeps all three windows", () => {
  assert.deepEqual([...FORWARD_USAGE_WINDOWS], [7, 30, 90]);
  assert.equal(isForwardUsageWindow(7), true);
  assert.equal(isForwardUsageWindow(30), true);
  assert.equal(isForwardUsageWindow(90), true);
  assert.equal(isForwardUsageWindow(14), false);
  assert.equal(isForwardUsageWindow(0), false);

  const calls = [];
  const fakeTranslate = (key, values) => {
    calls.push({ key, values });
    return `${values.n} 天`;
  };
  assert.equal(windowLabel(7, fakeTranslate), "7 天");
  assert.equal(windowLabel(90, fakeTranslate), "90 天");
  assert.deepEqual(calls, [
    { key: "forwardUsage.windowDays", values: { n: 7 } },
    { key: "forwardUsage.windowDays", values: { n: 90 } },
  ]);
});

test("sumUsageDays adds raw and billed separately and ignores invalid values", () => {
  const days = [
    { day: "2026-11-13", bytes: 10, weighted: 20 },
    { day: "2026-11-14", bytes: 5, weighted: 7 },
    { day: "2026-11-15", bytes: Number.NaN, weighted: Number.POSITIVE_INFINITY },
    { day: "2026-11-16", bytes: -100, weighted: -1 },
  ];

  assert.deepEqual(sumUsageDays(days), { bytes: 15, weighted: 27 });
  assert.deepEqual(sumUsageDays([]), { bytes: 0, weighted: 0 });
  assert.deepEqual(sumUsageDays(null), { bytes: 0, weighted: 0 });
  // 输入不被修改。
  assert.equal(days[2].bytes, Number.NaN);
});

test("isUsageEmpty only treats zero totals with no rows as empty", () => {
  assert.equal(isUsageEmpty({ bytes: 0, weighted: 0 }, []), true);
  assert.equal(isUsageEmpty({ bytes: 0, weighted: 0 }, null), true);
  assert.equal(isUsageEmpty({ bytes: 1, weighted: 0 }, []), false);
  assert.equal(isUsageEmpty({ bytes: 0, weighted: 0 }, [row()]), false);
  // 历史行可能只有 bytes、weighted=0（0048 之前），不能算空。
  assert.equal(isUsageEmpty({ bytes: 900, weighted: 0 }, []), false);
});

test("filterUsageRows treats blank as all and matches user_id exactly", () => {
  const rows = [
    row({ forward_id: "fwd-a", user_id: "u-alice", user_name: "alice" }),
    row({ forward_id: "fwd-b", user_id: "u-bob", user_name: "bob", bytes: 5 }),
  ];

  assert.equal(filterUsageRows(rows, undefined).length, 2);
  assert.equal(filterUsageRows(rows, "").length, 2);
  assert.equal(filterUsageRows(rows, "   ").length, 2);
  assert.deepEqual(
    filterUsageRows(rows, "u-bob").map((item) => item.forward_id),
    ["fwd-b"],
  );
  assert.deepEqual(filterUsageRows(rows, "u-carol"), []);
  // 返回新数组，不改原数组。
  assert.notEqual(filterUsageRows(rows, ""), rows);
});

test("sortUsageRows sorts by weighted then bytes then id without mutating", () => {
  const rows = [
    row({ forward_id: "fwd-c", user_id: "u-1", bytes: 10, weighted: 5 }),
    row({ forward_id: "fwd-a", user_id: "u-2", bytes: 100, weighted: 50 }),
    row({ forward_id: "fwd-b", user_id: "u-1", bytes: 200, weighted: 50 }),
    row({ forward_id: "fwd-d", user_id: "u-1", bytes: 200, weighted: 50 }),
  ];
  const snapshot = structuredClone(rows);

  const sorted = sortUsageRows(rows);

  assert.deepEqual(
    sorted.map((item) => item.forward_id),
    ["fwd-b", "fwd-d", "fwd-a", "fwd-c"],
  );
  assert.deepEqual(rows, snapshot, "输入不能被原地排序");
  assert.deepEqual(sortUsageRows(null), []);
});

test("deleted forward/user use the localized placeholder, blank names fall back", () => {
  assert.equal(forwardUsageName(row(), "已删除"), "1.1.1.1:443");
  assert.equal(
    forwardUsageName(row({ name: "已删除", forward_deleted: true }), "Deleted"),
    "Deleted",
  );
  assert.equal(forwardUsageName(row({ name: "   " }), "Deleted"), "Deleted");
  assert.equal(forwardUsageUserName(row(), "Deleted"), "alice");
  assert.equal(
    forwardUsageUserName(
      row({ user_name: "已删除", user_deleted: true }),
      "Deleted",
    ),
    "Deleted",
  );
  assert.equal(forwardUsageUserName(row({ user_name: null }), "Deleted"), "Deleted");
});

test("usageUserOptions dedupes users, sorts labels, and keeps deleted users", () => {
  const options = usageUserOptions(
    [
      row({ user_id: "u-bob", user_name: "bob" }),
      row({ user_id: "u-alice", user_name: "alice" }),
      row({ forward_id: "fwd-b", user_id: "u-bob", user_name: "bob" }),
      row({
        forward_id: "fwd-old",
        user_id: "u-gone",
        user_name: "已删除",
        user_deleted: true,
      }),
    ],
    "Deleted",
  );

  assert.deepEqual(options, [
    { id: "u-alice", label: "alice" },
    { id: "u-bob", label: "bob" },
    { id: "u-gone", label: "Deleted" },
  ]);
  assert.deepEqual(usageUserOptions([], "Deleted"), []);
});
