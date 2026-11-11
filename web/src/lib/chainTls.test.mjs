import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAIN_TLS_MIN_GROUPS,
  CHAIN_TRANSPORTS,
  TLS_ERROR_CODES,
  needsCert,
  normalizeTransport,
  tlsAvailable,
  tlsErrorKey,
  validateTls,
} from "./chainTls.ts";

const group = (cert_id = "") => ({ cert_id });

test("tlsAvailable requires realm and at least two groups", () => {
  assert.equal(tlsAvailable("realm", 2), true);
  assert.equal(tlsAvailable("realm", 6), true);
  assert.equal(tlsAvailable("realm", 1), false);
  assert.equal(tlsAvailable("realm", 0), false);
  assert.equal(tlsAvailable("native", 2), false);
  assert.equal(tlsAvailable("native", 6), false);
  assert.equal(tlsAvailable("unknown", 3), false);
  assert.equal(tlsAvailable(undefined, 3), false);
  assert.equal(tlsAvailable(null, 3), false);
  assert.equal(CHAIN_TLS_MIN_GROUPS, 2);
});

test("needsCert only applies to seq >= 1", () => {
  assert.equal(needsCert(0), false);
  assert.equal(needsCert(1), true);
  assert.equal(needsCert(2), true);
  assert.equal(needsCert(-1), false);
});

test("normalizeTransport falls back to none for unknown values", () => {
  assert.deepEqual([...CHAIN_TRANSPORTS], ["none", "tls"]);
  assert.equal(normalizeTransport("tls"), "tls");
  assert.equal(normalizeTransport("none"), "none");
  assert.equal(normalizeTransport("TLS"), "none");
  assert.equal(normalizeTransport(undefined), "none");
  assert.equal(normalizeTransport(null), "none");
});

test("tlsErrorKey maps exactly the six stable probe codes", () => {
  assert.deepEqual(
    [...TLS_ERROR_CODES],
    [
      "tcp_connect_failed",
      "cert_expired",
      "unknown_issuer",
      "name_mismatch",
      "handshake_failed",
      "timeout",
    ],
  );
  for (const code of TLS_ERROR_CODES) {
    assert.equal(tlsErrorKey(code), `chains.tlsError.${code}`);
  }
});

test("tlsErrorKey hides unknown, empty and non-string codes", () => {
  assert.equal(tlsErrorKey("connection_reset"), null);
  assert.equal(tlsErrorKey("TCP_CONNECT_FAILED"), null);
  assert.equal(tlsErrorKey(""), null);
  assert.equal(tlsErrorKey("   "), null);
  assert.equal(tlsErrorKey(null), null);
  assert.equal(tlsErrorKey(undefined), null);
  assert.equal(tlsErrorKey(1), null);
});

test("validateTls ignores everything when transport is not tls", () => {
  assert.deepEqual(validateTls({ transport: "none" }), []);
  assert.deepEqual(validateTls({}), []);
  assert.deepEqual(
    validateTls({
      transport: "none",
      udp: true,
      groups: [group("entry-cert"), group()],
    }),
    [],
  );
});

test("validateTls reports an empty group list as too few groups", () => {
  assert.deepEqual(validateTls({ transport: "tls", groups: [] }), [
    { kind: "group_count", count: 0, min: CHAIN_TLS_MIN_GROUPS },
  ]);
});

test("validateTls reports a single group as too few groups", () => {
  const issues = validateTls({
    transport: "tls",
    groups: [group("")],
  });
  assert.deepEqual(issues, [
    { kind: "group_count", count: 1, min: CHAIN_TLS_MIN_GROUPS },
  ]);
});

test("validateTls reports missing certificates by group seq", () => {
  assert.deepEqual(
    validateTls({
      transport: "tls",
      groups: [group(""), group(""), group("  ")],
    }),
    [
      { kind: "cert_missing", groupSeq: 1 },
      { kind: "cert_missing", groupSeq: 2 },
    ],
  );
});

test("validateTls rejects a certificate on entry group 0", () => {
  assert.deepEqual(
    validateTls({
      transport: "tls",
      groups: [group("cert-entry"), group("cert-exit")],
    }),
    [{ kind: "cert_forbidden", groupSeq: 0 }],
  );
});

test("validateTls accepts a complete tls form", () => {
  assert.deepEqual(
    validateTls({
      transport: "tls",
      udp: false,
      groups: [group(""), group("cert-exit"), group("cert-exit-2")],
    }),
    [],
  );
});

test("validateTls reports the udp conflict alongside certificate issues", () => {
  assert.deepEqual(
    validateTls({
      transport: "tls",
      udp: true,
      groups: [group(""), group("cert-exit")],
    }),
    [{ kind: "udp_conflict" }],
  );
  assert.deepEqual(
    validateTls({
      transport: "tls",
      udp: true,
      groups: [group("entry-cert"), group("")],
    }),
    [
      { kind: "udp_conflict" },
      { kind: "cert_forbidden", groupSeq: 0 },
      { kind: "cert_missing", groupSeq: 1 },
    ],
  );
});
