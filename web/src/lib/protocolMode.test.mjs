import assert from "node:assert/strict";
import test from "node:test";
import en from "../i18n/en.ts";
import zhCN from "../i18n/zh-CN.ts";
import {
  DEFAULT_PROTOCOL,
  PROTOCOL_MODES,
  normalizeProtocol,
  protocolAvailable,
  protocolLabelKey,
} from "./protocolMode.ts";

function lookup(messages, key) {
  return key
    .split(".")
    .reduce((node, part) => (node == null ? undefined : node[part]), messages);
}

test("protocol modes are exactly tcp / udp / both and default to tcp", () => {
  assert.deepEqual([...PROTOCOL_MODES], ["tcp", "udp", "both"]);
  assert.equal(DEFAULT_PROTOCOL, "tcp");
});

test("normalizeProtocol accepts the three known values and trims edges", () => {
  assert.equal(normalizeProtocol("tcp"), "tcp");
  assert.equal(normalizeProtocol("udp"), "udp");
  assert.equal(normalizeProtocol("both"), "both");
  assert.equal(normalizeProtocol("  udp  "), "udp");
  assert.equal(normalizeProtocol(" both "), "both");
});

test("normalizeProtocol treats missing values as tcp", () => {
  assert.equal(normalizeProtocol(undefined), "tcp");
  assert.equal(normalizeProtocol(null), "tcp");
  assert.equal(normalizeProtocol(""), "tcp");
  assert.equal(normalizeProtocol("   "), "tcp");
});

test("normalizeProtocol maps the legacy udp flag to both only when protocol is absent", () => {
  // 迁移 0034 的 CASE WHEN udp = 1 THEN 'both' ELSE 'tcp' END。
  assert.equal(normalizeProtocol(undefined, true), "both");
  assert.equal(normalizeProtocol(null, true), "both");
  assert.equal(normalizeProtocol("", true), "both");
  assert.equal(normalizeProtocol(undefined, false), "tcp");
  assert.equal(normalizeProtocol(undefined, undefined), "tcp");

  // 新字段存在时以它为准，旧位即使为 true 也不能覆盖。
  assert.equal(normalizeProtocol("tcp", true), "tcp");
  assert.equal(normalizeProtocol("udp", true), "udp");
  assert.equal(normalizeProtocol("both", false), "both");
});

test("normalizeProtocol falls back to tcp for unknown values", () => {
  // 后端读路径同样回落 tcp：大小写不匹配也算未知。
  assert.equal(normalizeProtocol("TCP"), "tcp");
  assert.equal(normalizeProtocol("Udp"), "tcp");
  assert.equal(normalizeProtocol("tcp/udp"), "tcp");
  assert.equal(normalizeProtocol("all"), "tcp");
  assert.equal(normalizeProtocol("garbage", true), "tcp");
  assert.equal(normalizeProtocol(1), "tcp");
  assert.equal(normalizeProtocol({}), "tcp");
});

test("protocolLabelKey maps every mode to its badge label", () => {
  assert.equal(protocolLabelKey("tcp"), "common.protocol.tcp");
  assert.equal(protocolLabelKey("udp"), "common.protocol.udp");
  assert.equal(protocolLabelKey("both"), "common.protocol.both");
  // 缺失 / 未知与 normalizeProtocol 一致，回落 TCP，绝不指向空键。
  assert.equal(protocolLabelKey(undefined), "common.protocol.tcp");
  assert.equal(protocolLabelKey("wireguard"), "common.protocol.tcp");
});

test("protocol labels exist in both dictionaries", () => {
  for (const dictionary of [zhCN, en]) {
    assert.equal(lookup(dictionary, "common.protocol.tcp"), "TCP");
    assert.equal(lookup(dictionary, "common.protocol.udp"), "UDP");
    assert.equal(lookup(dictionary, "common.protocol.both"), "TCP + UDP");
    assert.equal(
      typeof lookup(dictionary, "common.protocolMode.label"),
      "string",
    );
    assert.ok(lookup(dictionary, "common.protocolMode.tcp").trim().length > 0);
    assert.ok(lookup(dictionary, "common.protocolMode.udp").trim().length > 0);
    assert.ok(lookup(dictionary, "common.protocolMode.both").trim().length > 0);
  }
});

test("protocolAvailable disables UDP-only for realm but keeps both", () => {
  assert.deepEqual(protocolAvailable("realm"), {
    tcp: true,
    udp: false,
    both: true,
  });
  assert.deepEqual(protocolAvailable("  realm  ", "none"), {
    tcp: true,
    udp: false,
    both: true,
  });
  // native / nftables 没有该限制。
  assert.deepEqual(protocolAvailable("native"), {
    tcp: true,
    udp: true,
    both: true,
  });
  assert.deepEqual(protocolAvailable("nftables"), {
    tcp: true,
    udp: true,
    both: true,
  });
});

test("protocolAvailable disables every UDP mode when TLS is on", () => {
  // 加密链只走 TCP：udp 与 both 都不可选，tcp 恒可用。
  assert.deepEqual(protocolAvailable("native", "tls"), {
    tcp: true,
    udp: false,
    both: false,
  });
  assert.deepEqual(protocolAvailable("realm", "tls"), {
    tcp: true,
    udp: false,
    both: false,
  });
  assert.equal(protocolAvailable("realm", "tls").tcp, true);
});

test("protocolAvailable defaults unknown engines and transports to permissive", () => {
  // 缺失 = 旧后端：引擎按 native、transport 按 none。
  assert.deepEqual(protocolAvailable(undefined, undefined), {
    tcp: true,
    udp: true,
    both: true,
  });
  assert.deepEqual(protocolAvailable(null, null), {
    tcp: true,
    udp: true,
    both: true,
  });
  // 未知引擎不能凭空套用 realm 的限制。
  assert.deepEqual(protocolAvailable("wireguard", "quic"), {
    tcp: true,
    udp: true,
    both: true,
  });
});

test("the four protocol error codes are bilingual", () => {
  const codes = [
    "forward.protocol_invalid",
    "chain.protocol_invalid",
    "forward.protocol_udp_requires_native",
    "chain.protocol_udp_with_tls",
  ];
  for (const dictionary of [zhCN, en]) {
    for (const code of codes) {
      const text = dictionary.errors[code];
      assert.equal(typeof text, "string", code);
      assert.ok(text.trim().length > 0, code);
    }
  }
  assert.match(zhCN.errors["forward.protocol_invalid"], /\{protocol\}/);
  assert.match(en.errors["forward.protocol_invalid"], /\{protocol\}/);
  assert.match(en.errors["forward.protocol_udp_requires_native"], /realm/);
  assert.match(en.errors["chain.protocol_udp_with_tls"], /TCP/);
});
