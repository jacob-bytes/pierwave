import assert from "node:assert/strict";
import test from "node:test";
import en from "../i18n/en.ts";
import zhCN from "../i18n/zh-CN.ts";
import {
  isAutoPortGroup,
  portFieldVisible,
  stripAutoPorts,
} from "./chainPorts.ts";

function lookup(messages, key) {
  return key
    .split(".")
    .reduce((node, part) => (node == null ? undefined : node[part]), messages);
}

const group = (seq, port) => ({
  seq,
  strategy: "round_robin",
  members: [{ server_id: `server-${seq}`, listen_port: port, priority: 0 }],
});

test("isAutoPortGroup treats only seq >= 1 as auto-assigned", () => {
  assert.equal(isAutoPortGroup(0), false, "entry group keeps manual input");
  assert.equal(isAutoPortGroup(1), true);
  assert.equal(isAutoPortGroup(2), true);
  assert.equal(isAutoPortGroup(6), true);
});

test("isAutoPortGroup never treats negative or malformed seq as auto", () => {
  assert.equal(isAutoPortGroup(-1), false);
  assert.equal(isAutoPortGroup(-99), false);
  assert.equal(isAutoPortGroup(1.5), false);
  assert.equal(isAutoPortGroup(Number.NaN), false);
  assert.equal(isAutoPortGroup(Number.POSITIVE_INFINITY), false);
});

test("portFieldVisible is the exact inverse of isAutoPortGroup", () => {
  for (const seq of [-2, 0, 1, 3, 1.5, Number.NaN]) {
    assert.equal(portFieldVisible(seq), !isAutoPortGroup(seq));
  }
  assert.equal(portFieldVisible(0), true);
  assert.equal(portFieldVisible(1), false);
});

test("stripAutoPorts keeps the entry port and removes middle-hop ports", () => {
  const groups = [group(0, 23001), group(1, 24002), group(2, 25003)];
  const out = stripAutoPorts(groups);

  assert.equal(out.length, 3);
  assert.deepEqual(out[0].members[0], {
    server_id: "server-0",
    listen_port: 23001,
    priority: 0,
  });
  assert.equal("listen_port" in out[1].members[0], false);
  assert.equal("listen_port" in out[2].members[0], false);
  // 其它字段与组本身必须原样保留，提交时只少了一个端口。
  assert.deepEqual(out[1].members[0], {
    server_id: "server-1",
    priority: 0,
  });
  assert.equal(out[1].strategy, "round_robin");
});

test("stripAutoPorts also drops the group-level listen_port contract shape", () => {
  const groups = [
    { seq: 0, server_ids: ["a"], strategy: "round_robin", listen_port: 23001 },
    { seq: 1, server_ids: ["b"], strategy: "round_robin", listen_port: 24002 },
  ];
  const out = stripAutoPorts(groups);

  assert.equal(out[0].listen_port, 23001);
  assert.equal("listen_port" in out[1], false);
  assert.deepEqual(out[1].server_ids, ["b"]);
});

test("stripAutoPorts keeps ports for seq 0, negative seq and empty arrays", () => {
  assert.deepEqual(stripAutoPorts([]), []);

  const out = stripAutoPorts([group(0, 20000), group(-1, 20001)]);
  assert.equal(out[0].members[0].listen_port, 20000);
  assert.equal(out[1].members[0].listen_port, 20001);
});

test("stripAutoPorts does not mutate the input groups", () => {
  const groups = [group(0, 23001), group(1, 24002)];
  stripAutoPorts(groups);

  assert.equal(groups[1].members[0].listen_port, 24002);
  assert.equal(groups[0].members[0].listen_port, 23001);
});

test("autoPort and the port-pool error code exist in both dictionaries", () => {
  assert.equal(lookup(zhCN, "chains.autoPort"), "自动");
  assert.equal(lookup(en, "chains.autoPort"), "Auto");
  assert.equal(lookup(zhCN, "chains.autoPortReadonly"), "端口 {port}（自动）");
  assert.equal(lookup(en, "chains.autoPortReadonly"), "Port {port} (auto)");

  const zhError = zhCN.errors["chain.port_pool_exhausted"];
  const enError = en.errors["chain.port_pool_exhausted"];
  assert.equal(typeof zhError, "string");
  assert.equal(typeof enError, "string");
  assert.ok(zhError.includes("20000"));
  assert.ok(enError.includes("20000"));
});
