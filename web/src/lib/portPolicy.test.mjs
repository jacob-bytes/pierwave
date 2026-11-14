import assert from "node:assert/strict";
import test from "node:test";
import { setCurrentLocale } from "../i18n/locale.ts";
import { ApiError } from "./apiError.ts";
import { errorText } from "./errors.ts";
import {
  invalidPortAllowTokens,
  isPortAllowed,
  isPortPolicyConstrained,
  normalizePortPolicy,
  parsePortAllow,
  parsePortRangeInput,
  portPolicyLabel,
  portPolicySummary,
} from "./portPolicy.ts";

test("parsePortAllow accepts commas, whitespace and both separators, sorting and deduping", () => {
  assert.deepEqual(parsePortAllow("443, 8443"), [443, 8443]);
  assert.deepEqual(parsePortAllow("8443，443、8443 80\n81"), [80, 81, 443, 8443]);
  assert.deepEqual(parsePortAllow("  "), []);
  assert.deepEqual(parsePortAllow(""), []);
  // 去重后按升序，保证同样的输入与后端回读顺序一致。
  assert.deepEqual(parsePortAllow("30000, 443, 30000"), [443, 30000]);
});

test("parsePortAllow drops invalid input instead of widening the policy", () => {
  assert.deepEqual(parsePortAllow("0, 65536, -1, 1.5, 443"), [443]);
  assert.deepEqual(parsePortAllow("abc, 44x, 0443"), [443]);
});

test("invalidPortAllowTokens reports exactly the bad tokens for form errors", () => {
  assert.deepEqual(invalidPortAllowTokens("443, abc, 0, 70000"), [
    "abc",
    "0",
    "70000",
  ]);
  assert.deepEqual(invalidPortAllowTokens("443, 8443"), []);
});

test("an empty policy allows every valid port", () => {
  for (const port of [1, 80, 443, 30000, 65535]) {
    assert.equal(isPortAllowed(port, {}), true, `port ${port} should be allowed`);
    assert.equal(
      isPortAllowed(port, { port_start: null, port_end: null, port_allow: [] }),
      true,
    );
  }
  assert.equal(isPortPolicyConstrained({}), false);
});

test("invalid ports are rejected even when the policy is empty", () => {
  for (const port of [0, -1, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(isPortAllowed(port, {}), false, `port ${port} must be rejected`);
  }
});

test("range boundaries are inclusive and outside ports are rejected", () => {
  const policy = { port_start: 30000, port_end: 31000 };
  assert.equal(isPortAllowed(30000, policy), true);
  assert.equal(isPortAllowed(30500, policy), true);
  assert.equal(isPortAllowed(31000, policy), true);
  assert.equal(isPortAllowed(29999, policy), false);
  assert.equal(isPortAllowed(31001, policy), false);
  assert.equal(isPortPolicyConstrained(policy), true);
});

test("extra allowed ports can live outside the configured range", () => {
  const policy = {
    port_start: 30000,
    port_end: 31000,
    port_allow: [443, 8443, 443],
  };
  assert.equal(isPortAllowed(443, policy), true);
  assert.equal(isPortAllowed(8443, policy), true);
  assert.equal(isPortAllowed(80, policy), false);
  assert.deepEqual(normalizePortPolicy(policy).allow, [443, 8443]);
});

test("an allow-only policy whitelists exactly those ports", () => {
  const policy = { port_allow: [443, 8443] };
  assert.equal(isPortAllowed(443, policy), true);
  assert.equal(isPortAllowed(8443, policy), true);
  assert.equal(isPortAllowed(30000, policy), false);
});

test("one-sided ranges stay open on the missing side", () => {
  assert.equal(isPortAllowed(29999, { port_start: 30000 }), false);
  assert.equal(isPortAllowed(30000, { port_start: 30000 }), true);
  assert.equal(isPortAllowed(65535, { port_start: 30000 }), true);
  assert.equal(isPortAllowed(31000, { port_end: 31000 }), true);
  assert.equal(isPortAllowed(31001, { port_end: 31000 }), false);
});

test("an inverted range does not widen access and dirty values are ignored", () => {
  const inverted = { port_start: 31000, port_end: 30000 };
  assert.equal(isPortAllowed(30500, inverted), false);
  assert.equal(isPortAllowed(31000, inverted), false);
  assert.equal(isPortPolicyConstrained(inverted), true);

  const dirty = { port_start: 0, port_end: 70000, port_allow: [443, 0, 70000] };
  assert.deepEqual(normalizePortPolicy(dirty), {
    start: null,
    end: null,
    allow: [443],
    constrained: true,
    hasRange: false,
    rangeOrdered: true,
  });
  assert.equal(isPortAllowed(443, dirty), true);
  assert.equal(isPortAllowed(80, dirty), false);
});

test("portPolicyLabel renders the compact list badge in Chinese and English", () => {
  setCurrentLocale("zh-CN");
  assert.equal(portPolicyLabel({}), "");
  assert.equal(
    portPolicyLabel({ port_start: 30000, port_end: 31000 }),
    "端口 30000-31000",
  );
  assert.equal(portPolicyLabel({ port_allow: [443, 8443, 2053] }), "端口：自定义 3 个");
  assert.equal(
    portPolicyLabel({ port_start: 30000, port_end: 31000, port_allow: [443] }),
    "端口 30000-31000 · 自定义 1 个",
  );
  // 单边留空按开放区间展示。
  assert.equal(portPolicyLabel({ port_start: 30000 }), "端口 30000-65535");

  setCurrentLocale("en");
  assert.equal(portPolicyLabel({}), "");
  assert.equal(
    portPolicyLabel({ port_start: 30000, port_end: 31000 }),
    "Ports 30000-31000",
  );
  assert.equal(portPolicyLabel({ port_allow: [443, 8443] }), "Ports: 2 custom");
});

test("portPolicySummary is always non-empty and describes every policy shape", () => {
  setCurrentLocale("zh-CN");
  assert.equal(portPolicySummary({}), "端口不受限制");
  assert.equal(
    portPolicySummary({ port_start: 30000, port_end: 31000 }),
    "允许端口 30000-31000",
  );
  assert.equal(
    portPolicySummary({ port_allow: [443, 8443] }),
    "允许自定义端口：443、8443",
  );
  assert.equal(
    portPolicySummary({ port_start: 30000, port_end: 31000, port_allow: [443] }),
    "允许端口 30000-31000；额外允许：443",
  );

  setCurrentLocale("en");
  assert.equal(portPolicySummary({}), "Ports are unrestricted");
  assert.equal(
    portPolicySummary({ port_start: 30000, port_end: 31000, port_allow: [443, 8443] }),
    "Allowed ports 30000-31000; additionally allowed: 443, 8443",
  );
});

test("parsePortRangeInput treats blank as unlimited and rejects partial or inverted input", () => {
  assert.deepEqual(parsePortRangeInput("", ""), { start: null, end: null });
  assert.deepEqual(parsePortRangeInput("  ", " "), { start: null, end: null });
  assert.deepEqual(parsePortRangeInput("30000", "31000"), {
    start: 30000,
    end: 31000,
  });
  assert.deepEqual(parsePortRangeInput("30000", "30000"), {
    start: 30000,
    end: 30000,
  });
  // 只填一边 = 不合法：提交时后端会返回 server.port_range_invalid。
  assert.equal(parsePortRangeInput("30000", ""), null);
  assert.equal(parsePortRangeInput("", "31000"), null);
  assert.equal(parsePortRangeInput("31000", "30000"), null);
  assert.equal(parsePortRangeInput("0", "31000"), null);
  assert.equal(parsePortRangeInput("30000", "70000"), null);
  assert.equal(parsePortRangeInput("abc", "31000"), null);
  assert.equal(parsePortRangeInput("30000.5", "31000"), null);
});

test("the policy type accepts a fully missing backend payload", () => {
  assert.equal(isPortAllowed(443, null), true);
  assert.equal(isPortAllowed(443, undefined), true);
  assert.equal(isPortPolicyConstrained(null), false);
  assert.equal(portPolicyLabel(null), "");
  setCurrentLocale("zh-CN");
  assert.equal(portPolicySummary(null), "端口不受限制");
});

test("the port-policy error codes are bilingual and carry the right params", () => {
  const exhausted = () =>
    new ApiError(
      "服务器「edge-1」允许的端口都已占用",
      400,
      "chain.port_allowed_exhausted",
      { server: "edge-1", server_id: "srv-1" },
    );

  setCurrentLocale("zh-CN");
  assert.equal(
    errorText(exhausted(), "fallback"),
    "服务器「edge-1」允许的端口都已占用；请先释放端口，或为该跳手动填写允许范围内的端口",
  );
  assert.equal(
    errorText(
      new ApiError("bad range", 400, "server.port_range_invalid"),
      "fallback",
    ),
    "端口范围不合法：起始与结束端口必须同时填写或留空，且起始不大于结束（1-65535）",
  );
  assert.equal(
    errorText(
      new ApiError("bad allow", 400, "server.port_allow_invalid"),
      "fallback",
    ),
    "额外允许的端口必须是 1-65535 的整数",
  );
  assert.equal(
    errorText(
      new ApiError("node port", 400, "node.port_not_allowed", {
        port: 80,
        server: "edge-1",
      }),
      "fallback",
    ),
    "端口 80 不在服务器「edge-1」允许的范围内",
  );

  setCurrentLocale("en");
  assert.equal(
    errorText(exhausted(), "fallback"),
    'Every port allowed on server "edge-1" is in use; free one or provide an allowed port manually',
  );
  assert.equal(
    errorText(
      new ApiError("bad range", 400, "server.port_range_invalid"),
      "fallback",
    ),
    "Invalid port range: start and end must be provided together or left empty, start ≤ end, both within 1-65535",
  );
  assert.equal(
    errorText(
      new ApiError("bad allow", 400, "server.port_allow_invalid"),
      "fallback",
    ),
    "Additional allowed ports must be integers between 1 and 65535",
  );
  assert.equal(
    errorText(
      new ApiError("node port", 400, "node.port_not_allowed", {
        port: 80,
        server: "edge-1",
      }),
      "fallback",
    ),
    'Port 80 is outside the range allowed by server “edge-1”',
  );
});
