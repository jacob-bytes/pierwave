import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PUBLIC_BASE_URL_CHARS,
  agentInstallPreview,
  isValidPublicBaseUrl,
  normalizePublicBaseUrl,
  resolvePublicBase,
  subscriptionPreview,
} from "./publicBase.ts";

test("empty value means no override", () => {
  assert.equal(normalizePublicBaseUrl(""), "");
  assert.equal(normalizePublicBaseUrl("   "), "");
  assert.equal(isValidPublicBaseUrl("   "), true);
});

test("accepts http(s)://host[:port] and trims whitespace", () => {
  assert.equal(
    normalizePublicBaseUrl("  https://panel.example.com  "),
    "https://panel.example.com",
  );
  assert.equal(
    normalizePublicBaseUrl("HTTP://10.0.0.5:8787"),
    "http://10.0.0.5:8787",
  );
  assert.equal(
    normalizePublicBaseUrl("HTTPS://Panel.Example.COM:443"),
    "https://Panel.Example.COM:443",
  );
  assert.equal(normalizePublicBaseUrl("http://[::1]:8787"), "http://[::1]:8787");
  assert.equal(normalizePublicBaseUrl("http://localhost"), "http://localhost");
});

test("rejects paths, non-http schemes, missing hosts and bad ports", () => {
  for (const raw of [
    "panel.example.com",
    "ftp://panel.example.com",
    "//panel.example.com",
    "https://panel.example.com/",
    "https://panel.example.com/path",
    "https://panel.example.com?x=1",
    "https://panel.example.com#top",
    "http://",
    "http://:8787",
    "http://-",
    "http://[::1",
    "http://[not-ipv6]",
    "http://[....]",
    "http://panel.example.com:",
    "http://panel.example.com:abc",
    "http://panel.example.com:0",
    "http://panel.example.com:65536",
    "https://user:pass@panel.example.com",
    "https://panel.example.com /x",
    "x".repeat(MAX_PUBLIC_BASE_URL_CHARS + 1),
  ]) {
    assert.equal(isValidPublicBaseUrl(raw), false, raw);
  }
});

test("only subscription configured: agent still uses the access address", () => {
  assert.equal(
    resolvePublicBase("", "https://sub.example.com", "agent", "http://fallback"),
    "http://fallback",
  );
  assert.equal(
    resolvePublicBase(
      "",
      "https://sub.example.com",
      "subscription",
      "http://fallback",
    ),
    "https://sub.example.com",
  );
});

test("only agent configured: subscription falls back to it", () => {
  assert.equal(
    resolvePublicBase(
      "https://panel.example.com",
      "",
      "subscription",
      "http://fallback",
    ),
    "https://panel.example.com",
  );
  assert.equal(
    resolvePublicBase(
      "https://panel.example.com",
      "",
      "agent",
      "http://fallback",
    ),
    "https://panel.example.com",
  );
});

test("both configured: subscription wins for subscription links", () => {
  assert.equal(
    resolvePublicBase(
      "https://panel.example.com",
      "https://sub.example.com",
      "agent",
      "http://fallback",
    ),
    "https://panel.example.com",
  );
  assert.equal(
    resolvePublicBase(
      "https://panel.example.com",
      "https://sub.example.com",
      "subscription",
      "http://fallback",
    ),
    "https://sub.example.com",
  );
});

test("both empty: access address is used and trailing slash is removed", () => {
  assert.equal(
    resolvePublicBase("", "", "agent", "http://panel.example.com/"),
    "http://panel.example.com",
  );
  assert.equal(
    resolvePublicBase("", "", "subscription", "http://panel.example.com/"),
    "http://panel.example.com",
  );
});

test("previews always join exactly one slash", () => {
  assert.equal(
    agentInstallPreview("https://panel.example.com/"),
    "https://panel.example.com/api/agent/install.sh?token=<token>",
  );
  assert.equal(
    subscriptionPreview("https://sub.example.com/"),
    "https://sub.example.com/api/v1/sub/abc123",
  );
});
