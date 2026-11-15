import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeProxyProtocol,
  proxyProtocolAvailable,
  proxyProtocolBadgeVisible,
} from "./proxyProtocol.ts";

test("proxyProtocolAvailable only allows TCP + native", () => {
  assert.equal(proxyProtocolAvailable("tcp", "native"), true);
  assert.equal(proxyProtocolAvailable("tcp", "realm"), false);
  assert.equal(proxyProtocolAvailable("tcp", "nftables"), false);
  assert.equal(proxyProtocolAvailable("tcp", "tunnel"), false);
  assert.equal(proxyProtocolAvailable("udp", "native"), false);
  assert.equal(proxyProtocolAvailable("both", "native"), false);
});

test("proxyProtocolAvailable treats unknown values as unavailable", () => {
  assert.equal(proxyProtocolAvailable(undefined, "native"), false);
  assert.equal(proxyProtocolAvailable("tcp", undefined), false);
  assert.equal(proxyProtocolAvailable(null, null), false);
});

test("normalizeProxyProtocol only submits true for valid combinations", () => {
  assert.equal(normalizeProxyProtocol(true, "tcp", "native"), true);
  assert.equal(normalizeProxyProtocol(false, "tcp", "native"), false);
  assert.equal(normalizeProxyProtocol(true, "both", "native"), false);
  assert.equal(normalizeProxyProtocol(true, "tcp", "realm"), false);
  assert.equal(normalizeProxyProtocol("true", "tcp", "native"), false);
  assert.equal(normalizeProxyProtocol(undefined, "tcp", "native"), false);
});

test("switching protocol off TCP forces the submitted flag off", () => {
  // 用户先开启开关，再把协议从 tcp 改成 both：提交时必须归一化成 false。
  assert.equal(normalizeProxyProtocol(true, "tcp", "native"), true);
  assert.equal(normalizeProxyProtocol(true, "both", "native"), false);
  assert.equal(normalizeProxyProtocol(true, "udp", "native"), false);
});

test("proxyProtocolBadgeVisible only lights up on explicit true", () => {
  assert.equal(proxyProtocolBadgeVisible(true), true);
  assert.equal(proxyProtocolBadgeVisible(false), false);
  assert.equal(proxyProtocolBadgeVisible(undefined), false);
  assert.equal(proxyProtocolBadgeVisible(null), false);
  assert.equal(proxyProtocolBadgeVisible("true"), false);
  assert.equal(proxyProtocolBadgeVisible(1), false);
});
