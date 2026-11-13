import assert from "node:assert/strict";
import test from "node:test";
import { setCurrentLocale } from "../i18n/locale.ts";
import { ApiError } from "./apiError.ts";
import { errorText } from "./errors.ts";
import {
  DEFAULT_TUNNEL_SECURITY,
  TUNNEL_SECURITY_MODES,
  normalizeTunnelSecurity,
  securityBadgeKey,
  securityLabelKey,
  securityVisible,
} from "./tunnelSecurity.ts";

test("normalizeTunnelSecurity defaults to tls and falls back for unknown values", () => {
  assert.deepEqual([...TUNNEL_SECURITY_MODES], ["tls", "noise"]);
  assert.equal(DEFAULT_TUNNEL_SECURITY, "tls");
  assert.equal(normalizeTunnelSecurity("tls"), "tls");
  assert.equal(normalizeTunnelSecurity("noise"), "noise");
  assert.equal(normalizeTunnelSecurity(" tls "), "tls");
  assert.equal(normalizeTunnelSecurity(" noise "), "noise");
  // 大小写不匹配算未知值（后端同样不忽略大小写），回落到默认证书模式。
  assert.equal(normalizeTunnelSecurity("TLS"), "tls");
  assert.equal(normalizeTunnelSecurity("NOISE"), "tls");
  assert.equal(normalizeTunnelSecurity("Noise"), "tls");
  assert.equal(normalizeTunnelSecurity("psk"), "tls");
  assert.equal(normalizeTunnelSecurity(""), "tls");
  assert.equal(normalizeTunnelSecurity(undefined), "tls");
  assert.equal(normalizeTunnelSecurity(null), "tls");
  assert.equal(normalizeTunnelSecurity(1), "tls");
  assert.equal(normalizeTunnelSecurity(false), "tls");
});

test("securityLabelKey maps both modes and falls back to the tls label", () => {
  assert.equal(securityLabelKey("tls"), "chains.tunnelSecurity.tls.label");
  assert.equal(securityLabelKey("noise"), "chains.tunnelSecurity.noise.label");
  assert.equal(securityLabelKey("TLS"), "chains.tunnelSecurity.tls.label");
  assert.equal(securityLabelKey(undefined), "chains.tunnelSecurity.tls.label");
  assert.equal(securityLabelKey(null), "chains.tunnelSecurity.tls.label");
  assert.equal(securityLabelKey("unknown"), "chains.tunnelSecurity.tls.label");
});

test("securityBadgeKey renders TLS / PSK and falls back to TLS", () => {
  assert.equal(securityBadgeKey("tls"), "chains.tunnelSecurity.tls.badge");
  assert.equal(securityBadgeKey("noise"), "chains.tunnelSecurity.noise.badge");
  assert.equal(securityBadgeKey("NOISE"), "chains.tunnelSecurity.tls.badge");
});

test("securityVisible is true only for the tunnel engine", () => {
  assert.equal(securityVisible("tunnel"), true);
  assert.equal(securityVisible("realm"), false);
  assert.equal(securityVisible("native"), false);
  assert.equal(securityVisible("nftables"), false);
  assert.equal(securityVisible("unknown"), false);
  // 未知引擎（含大写与 null / 缺失字段）一律不可见。
  assert.equal(securityVisible("TUNNEL"), false);
  assert.equal(securityVisible(null), false);
  assert.equal(securityVisible(undefined), false);
  assert.equal(securityVisible(42), false);
});

test("chain.tunnel_security_invalid is translated in both languages", () => {
  const error = () =>
    new ApiError(
      "隧道安全模式「psk」无效，只支持 tls / noise",
      400,
      "chain.tunnel_security_invalid",
      { tunnel_security: "psk", allowed: ["tls", "noise"] },
    );

  setCurrentLocale("zh-CN");
  assert.equal(
    errorText(error(), "fallback"),
    "不支持的隧道加密模式「psk」（可选 tls、noise）",
  );

  setCurrentLocale("en");
  assert.equal(
    errorText(error(), "fallback"),
    'Unsupported tunnel encryption mode "psk" (choose tls, noise)',
  );
});
