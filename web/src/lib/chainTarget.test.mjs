import assert from "node:assert/strict";
import test from "node:test";
import en from "../i18n/en.ts";
import zhCN from "../i18n/zh-CN.ts";
import { matchTargetNode, nodeTargetValue } from "./chainTarget.ts";

function lookup(messages, key) {
  return key
    .split(".")
    .reduce((node, part) => (node == null ? undefined : node[part]), messages);
}

const nodes = [
  {
    id: "node-hk",
    name: "香港-01",
    server_name: "hk-1",
    server_address: "1.2.3.4",
    port: 443,
  },
  {
    id: "node-jp",
    name: "日本-01",
    server_name: "jp-1",
    server_address: "5.6.7.8",
    port: 443,
  },
  {
    id: "node-ipv6",
    name: "IPv6",
    server_name: "v6-1",
    server_address: "2001:db8::1",
    port: 8443,
  },
];

test("matchTargetNode matches by host and port together", () => {
  assert.equal(matchTargetNode("1.2.3.4", 443, nodes)?.id, "node-hk");
  assert.equal(matchTargetNode("5.6.7.8", "443", nodes)?.id, "node-jp");
});

test("matchTargetNode returns undefined when nothing matches", () => {
  // 端口对、地址不对：不能只按端口猜。
  assert.equal(matchTargetNode("9.9.9.9", 443, nodes), undefined);
  // 地址对、端口不对。
  assert.equal(matchTargetNode("1.2.3.4", 8443, nodes), undefined);
  // 空列表、空地址、非法端口都不匹配。
  assert.equal(matchTargetNode("1.2.3.4", 443, []), undefined);
  assert.equal(matchTargetNode("", 443, nodes), undefined);
  assert.equal(matchTargetNode("1.2.3.4", "", nodes), undefined);
  assert.equal(matchTargetNode("1.2.3.4", 0, nodes), undefined);
});

test("matchTargetNode disambiguates multiple nodes sharing one port", () => {
  // 两台节点都用 443：必须按服务器地址区分，而不是命中第一个。
  assert.equal(matchTargetNode("5.6.7.8", 443, nodes)?.name, "日本-01");
  assert.equal(matchTargetNode("1.2.3.4", 443, nodes)?.name, "香港-01");
});

test("matchTargetNode accepts bracketed IPv6 and ignores host case", () => {
  assert.equal(matchTargetNode("2001:db8::1", 8443, nodes)?.id, "node-ipv6");
  assert.equal(matchTargetNode("[2001:db8::1]", 8443, nodes)?.id, "node-ipv6");
  assert.equal(matchTargetNode(" 2001:DB8::1 ", "8443", nodes)?.id, "node-ipv6");
  // 同端口 443 的 IPv4 节点不能被 IPv6 目标误命中。
  assert.equal(matchTargetNode("[2001:db8::1]", 443, nodes), undefined);
});

test("nodeTargetValue fills the target without changing its semantics", () => {
  assert.deepEqual(nodeTargetValue(nodes[0]), {
    target_host: "1.2.3.4",
    target_port: 443,
  });
  // 回填按服务器地址原样带出（只去首尾空白），不改写 IPv6 的方括号写法。
  assert.deepEqual(
    nodeTargetValue({ ...nodes[2], server_address: " [2001:db8::1] " }),
    { target_host: "[2001:db8::1]", target_port: 8443 },
  );
});

test("target mode labels exist in both dictionaries", () => {
  assert.equal(lookup(zhCN, "chains.form.targetModeManual"), "手动填写");
  assert.equal(lookup(en, "chains.form.targetModeManual"), "Manual");
  assert.equal(lookup(zhCN, "chains.form.targetModeNode"), "从节点选择");
  assert.equal(lookup(en, "chains.form.targetModeNode"), "From node");
  assert.equal(typeof lookup(zhCN, "chains.form.target"), "string");
  assert.equal(typeof lookup(en, "chains.form.target"), "string");
});
