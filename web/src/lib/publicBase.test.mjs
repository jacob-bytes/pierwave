import assert from "node:assert/strict";
import test from "node:test";
import {
  EXAMPLE_PLACEHOLDER_BASE,
  MAX_PUBLIC_BASE_URL_CHARS,
  agentInstallPreview,
  exampleUrls,
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

const PLACEHOLDER_INSTALL = `${EXAMPLE_PLACEHOLDER_BASE}/api/agent/install.sh?token=<token>`;
const PLACEHOLDER_SUB = `${EXAMPLE_PLACEHOLDER_BASE}/api/v1/sub/abc123`;

test("exampleUrls falls back to a placeholder domain when both are empty", () => {
  const empty = exampleUrls("", "");
  assert.deepEqual(empty, {
    installCommand: PLACEHOLDER_INSTALL,
    subscriptionLink: PLACEHOLDER_SUB,
  });
  // 空串、纯空白、null/undefined 都算未填写。
  for (const [agent, subscription] of [
    ["   ", "  "],
    [null, undefined],
  ]) {
    assert.deepEqual(exampleUrls(agent, subscription), empty);
  }
  // 不能回退到当前访问地址这类本地地址。
  assert.ok(!empty.installCommand.includes("127.0.0.1"));
  assert.ok(!empty.subscriptionLink.includes("localhost"));
});

test("exampleUrls follows a filled Agent address for both examples", () => {
  assert.deepEqual(exampleUrls("https://panel.example.com", ""), {
    installCommand:
      "https://panel.example.com/api/agent/install.sh?token=<token>",
    subscriptionLink: "https://panel.example.com/api/v1/sub/abc123",
  });
});

test("exampleUrls uses the placeholder install command when only subscription is set", () => {
  assert.deepEqual(exampleUrls("", "https://sub.example.com"), {
    installCommand: PLACEHOLDER_INSTALL,
    subscriptionLink: "https://sub.example.com/api/v1/sub/abc123",
  });
});

test("exampleUrls uses the subscription address when both are filled", () => {
  assert.deepEqual(
    exampleUrls("https://panel.example.com", "https://sub.example.com"),
    {
      installCommand:
        "https://panel.example.com/api/agent/install.sh?token=<token>",
      subscriptionLink: "https://sub.example.com/api/v1/sub/abc123",
    },
  );
});

test("exampleUrls never joins an invalid address", () => {
  // 两个都非法：全部回退占位域名，不出现半截 URL。
  assert.deepEqual(exampleUrls("https://bad/path", "not-a-url"), {
    installCommand: PLACEHOLDER_INSTALL,
    subscriptionLink: PLACEHOLDER_SUB,
  });
  // Agent 非法但订阅合法：安装命令用占位，订阅链接仍跟随合法输入。
  assert.deepEqual(exampleUrls("https://bad/path", "https://sub.example.com"), {
    installCommand: PLACEHOLDER_INSTALL,
    subscriptionLink: "https://sub.example.com/api/v1/sub/abc123",
  });
  // 订阅非法：不回退到合法 Agent 地址，也不拼半截地址。
  assert.deepEqual(exampleUrls("https://panel.example.com", "https://bad/path"), {
    installCommand:
      "https://panel.example.com/api/agent/install.sh?token=<token>",
    subscriptionLink: PLACEHOLDER_SUB,
  });
});

test("exampleUrls normalizes trailing slashes and surrounding whitespace", () => {
  assert.deepEqual(
    exampleUrls("  https://panel.example.com/  ", "https://sub.example.com//"),
    {
      installCommand:
        "https://panel.example.com/api/agent/install.sh?token=<token>",
      subscriptionLink: "https://sub.example.com/api/v1/sub/abc123",
    },
  );
  // 只有 scheme 的输入去掉尾斜杠后仍非法，不能拼出 `https:api/...`。
  assert.deepEqual(exampleUrls("https:///", "https://"), {
    installCommand: PLACEHOLDER_INSTALL,
    subscriptionLink: PLACEHOLDER_SUB,
  });
});
