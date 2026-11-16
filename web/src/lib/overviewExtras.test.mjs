import assert from "node:assert/strict";
import test from "node:test";
import {
  packageShare,
  packageSplitRows,
  packageTotal,
  packageUsers,
  topNodeMeta,
  topNodeRows,
} from "./overviewExtras.ts";

const node = (node_id, name, traffic_7d, protocol = "vless", server_name = "香港") => ({
  node_id,
  name,
  protocol,
  server_name,
  traffic_7d,
});

const pkg = (package_id, name, users, traffic_7d) => ({
  package_id,
  name,
  users,
  traffic_7d,
});

test("topNodeRows sorts by traffic descending and keeps the input order on ties", () => {
  const rows = topNodeRows([
    node("a", "A", 100),
    node("b", "B", 300),
    node("c", "C", 100),
  ]);
  assert.deepEqual(
    rows.map((row) => row.node_id),
    ["b", "a", "c"],
  );
});

test("topNodeRows drops zero / NaN traffic and invalid rows", () => {
  const rows = topNodeRows([
    node("zero", "Zero", 0),
    node("nan", "NaN", Number.NaN),
    node("", "No id", 10),
    node("ok", "OK", 5),
  ]);
  assert.deepEqual(
    rows.map((row) => row.node_id),
    ["ok"],
  );
});

test("topNodeRows caps at five by default and handles empty input", () => {
  const rows = topNodeRows(
    Array.from({ length: 7 }, (_, index) =>
      node(`n${index}`, `N${index}`, (index + 1) * 10),
    ),
  );
  assert.equal(rows.length, 5);
  assert.deepEqual(
    rows.map((row) => row.traffic_7d),
    [70, 60, 50, 40, 30],
  );
  assert.deepEqual(topNodeRows([]), []);
  assert.deepEqual(topNodeRows(null), []);
});

test("topNodeMeta joins protocol and server name, with a dash fallback", () => {
  assert.equal(
    topNodeMeta({ protocol: "trojan", server_name: "日本-01" }),
    "trojan · 日本-01",
  );
  assert.equal(
    topNodeMeta({ protocol: " ", server_name: "" }),
    "— · —",
  );
});

test("packageSplitRows sorts by traffic and drops zero-traffic packages", () => {
  const rows = packageSplitRows([
    pkg("month", "月卡", 2, 500),
    pkg("empty", "空卡", 1, 0),
    pkg("quarter", "季卡", 1, 1200),
  ]);
  assert.deepEqual(
    rows.map((row) => row.package_id),
    ["quarter", "month"],
  );
});

test("packageSplitRows requires users > 0 and caps at five", () => {
  const rows = packageSplitRows([
    pkg("no-users", "无用户", 0, 900),
    ...Array.from({ length: 7 }, (_, index) =>
      pkg(`p${index}`, `P${index}`, 1, (index + 1) * 10),
    ),
  ]);
  assert.equal(rows.length, 5);
  assert.deepEqual(
    rows.map((row) => row.package_id),
    ["p6", "p5", "p4", "p3", "p2"],
  );
  assert.deepEqual(packageSplitRows(undefined), []);
});

test("packageTotal and packageShare handle normal and empty inputs", () => {
  const rows = [pkg("a", "A", 1, 300), pkg("b", "B", 1, 100)];
  assert.equal(packageTotal(rows), 400);
  assert.equal(packageTotal([]), 0);
  assert.equal(packageShare(300, 400), 75);
  assert.equal(packageShare(100, 0), 0);
  assert.equal(packageShare(Number.NaN, 400), 0);
  assert.equal(packageShare(900, 400), 100);
});

test("packageUsers normalizes invalid or negative counts", () => {
  assert.equal(packageUsers(3), 3);
  assert.equal(packageUsers(2.9), 2);
  assert.equal(packageUsers(0), 0);
  assert.equal(packageUsers(-1), 0);
  assert.equal(packageUsers(Number.NaN), 0);
});
