import assert from "node:assert/strict";
import test from "node:test";
import {
  base64ToBytes,
  expectedKeyBytes,
  generateSsKey,
  normalizeSsMethod,
  SS_DEFAULT_METHOD,
  SS_DEFAULT_NETWORK,
  SS_LEGACY_GENERATED_LENGTH,
  SS_METHODS,
  SS_NETWORKS,
  ssKeyRequirementLabel,
  ssMethodBadge,
  ssSettings,
  stripSsSettings,
  validateSsKey,
  withSsSettings,
} from "./shadowsocks.ts";

/** `bytes` 个 0x07 的标准 base64，与后端测试的 `ss_key()` 同构。 */
function key(bytes) {
  return Buffer.from(new Uint8Array(bytes).fill(7)).toString("base64");
}

const zeros = (length) => new Uint8Array(length);
const filled = (byte) => (length) => new Uint8Array(length).fill(byte);

test("SS_METHODS matches the backend whitelist order", () => {
  assert.deepEqual(SS_METHODS, [
    "2022-blake3-aes-128-gcm",
    "2022-blake3-aes-256-gcm",
    "2022-blake3-chacha20-poly1305",
    "aes-256-gcm",
    "aes-128-gcm",
    "chacha20-poly1305",
    "xchacha20-poly1305",
  ]);
  assert.equal(SS_METHODS.length, 7);
});

test("SS_NETWORKS matches the backend whitelist", () => {
  assert.deepEqual(SS_NETWORKS, ["tcp", "udp", "tcp,udp"]);
});

test("expectedKeyBytes maps 2022 methods and ignores case/whitespace", () => {
  assert.equal(expectedKeyBytes("2022-blake3-aes-128-gcm"), 16);
  assert.equal(expectedKeyBytes("2022-blake3-aes-256-gcm"), 32);
  assert.equal(expectedKeyBytes("2022-blake3-chacha20-poly1305"), 32);
  assert.equal(expectedKeyBytes("  2022-BLAKE3-AES-128-GCM  "), 16);
});

test("expectedKeyBytes returns null for legacy AEAD methods", () => {
  for (const method of [
    "aes-256-gcm",
    "aes-128-gcm",
    "chacha20-poly1305",
    "xchacha20-poly1305",
  ]) {
    assert.equal(expectedKeyBytes(method), null, method);
  }
  assert.equal(expectedKeyBytes("unknown-method"), null);
});

test("normalizeSsMethod lowercases and trims", () => {
  assert.equal(normalizeSsMethod(" AES-256-GCM "), "aes-256-gcm");
});

test("validateSsKey accepts exact 16/32-byte base64 keys", () => {
  assert.deepEqual(validateSsKey("2022-blake3-aes-128-gcm", key(16)), {
    ok: true,
  });
  assert.deepEqual(validateSsKey("2022-blake3-aes-256-gcm", key(32)), {
    ok: true,
  });
  assert.deepEqual(
    validateSsKey("2022-blake3-chacha20-poly1305", key(32)),
    { ok: true },
  );
});

test("validateSsKey trims surrounding whitespace and method case", () => {
  assert.deepEqual(
    validateSsKey("2022-BLAKE3-AES-256-GCM", `  ${key(32)}\n`),
    { ok: true },
  );
});

test("validateSsKey rejects a key one byte short with key_length", () => {
  assert.deepEqual(validateSsKey("2022-blake3-aes-256-gcm", key(31)), {
    ok: false,
    error: "key_length",
  });
  assert.deepEqual(validateSsKey("2022-blake3-aes-128-gcm", key(15)), {
    ok: false,
    error: "key_length",
  });
});

test("validateSsKey rejects a 16-byte key for a 32-byte method", () => {
  assert.deepEqual(validateSsKey("2022-blake3-aes-256-gcm", key(16)), {
    ok: false,
    error: "key_length",
  });
});

test("validateSsKey treats an empty 2022 key as key_length", () => {
  assert.deepEqual(validateSsKey("2022-blake3-aes-256-gcm", ""), {
    ok: false,
    error: "key_length",
  });
  assert.deepEqual(validateSsKey("2022-blake3-aes-256-gcm", "   "), {
    ok: false,
    error: "key_length",
  });
});

test("validateSsKey rejects non-base64 with key_base64", () => {
  assert.deepEqual(validateSsKey("2022-blake3-aes-256-gcm", "not base64!!"), {
    ok: false,
    error: "key_base64",
  });
  // 长度刚好 24、字符也在字母表里，但不是 4 的倍数。
  assert.deepEqual(validateSsKey("2022-blake3-aes-256-gcm", "AAAAAAAAAAAAAAAAAAAAAAA"), {
    ok: false,
    error: "key_base64",
  });
});

test("validateSsKey rejects unpadded and non-canonical base64", () => {
  const unpadded = key(32).replace(/=+$/, "");
  assert.deepEqual(validateSsKey("2022-blake3-aes-256-gcm", unpadded), {
    ok: false,
    error: "key_base64",
  });
  // 1 字节的尾部 4 bit 非零：base64 crate 的 STANDARD 会拒绝。
  assert.equal(base64ToBytes("AB=="), null);
});

test("validateSsKey accepts legacy passwords at 8 chars and rejects 7", () => {
  assert.deepEqual(validateSsKey("aes-256-gcm", "12345678"), { ok: true });
  assert.deepEqual(validateSsKey("aes-256-gcm", "1234567"), {
    ok: false,
    error: "key_too_short",
  });
  assert.deepEqual(validateSsKey("xchacha20-poly1305", ""), {
    ok: false,
    error: "key_too_short",
  });
});

test("validateSsKey counts legacy password length in Unicode characters", () => {
  assert.deepEqual(validateSsKey("aes-128-gcm", "密码密码密码密码"), { ok: true });
  assert.deepEqual(validateSsKey("aes-128-gcm", "密码密码密码密"), {
    ok: false,
    error: "key_too_short",
  });
});

test("generateSsKey returns a base64 key of exactly the required byte length", () => {
  for (const [method, bytes] of [
    ["2022-blake3-aes-128-gcm", 16],
    ["2022-blake3-aes-256-gcm", 32],
    ["2022-blake3-chacha20-poly1305", 32],
  ]) {
    const generated = generateSsKey(method, zeros);
    assert.equal(Buffer.from(generated, "base64").length, bytes, method);
    assert.deepEqual(validateSsKey(method, generated), { ok: true }, method);
  }
});

test("generateSsKey uses the injected random source", () => {
  const generated = generateSsKey("2022-blake3-aes-128-gcm", filled(255));
  assert.deepEqual([...Buffer.from(generated, "base64")], Array(16).fill(255));
});

test("generateSsKey returns a 24-character alphanumeric legacy password", () => {
  for (const method of ["aes-256-gcm", "chacha20-poly1305"]) {
    const generated = generateSsKey(method, zeros);
    assert.equal(generated.length, SS_LEGACY_GENERATED_LENGTH);
    assert.match(generated, /^[A-Za-z0-9]{24}$/);
    assert.deepEqual(validateSsKey(method, generated), { ok: true });
  }
});

test("ssSettings falls back to defaults for a missing config", () => {
  for (const node of [undefined, null, {}, { config: null }, { config: {} }]) {
    assert.deepEqual(ssSettings(node), {
      method: SS_DEFAULT_METHOD,
      password: "",
      network: SS_DEFAULT_NETWORK,
    });
  }
});

test("ssSettings normalizes stored method, password and network", () => {
  assert.deepEqual(
    ssSettings({
      config: {
        settings: {
          method: "  AES-256-GCM ",
          password: "  secret123  ",
          network: " TCP,UDP ",
        },
      },
    }),
    { method: "aes-256-gcm", password: "secret123", network: "tcp,udp" },
  );
});

test("ssSettings keeps unknown values visible and defaults only empty ones", () => {
  assert.deepEqual(
    ssSettings({
      config: { settings: { method: "AES-256-CFB", network: "ws" } },
    }),
    { method: "aes-256-cfb", password: "", network: "ws" },
  );
  assert.deepEqual(
    ssSettings({
      config: { settings: { method: "  ", network: "" } },
    }),
    {
      method: SS_DEFAULT_METHOD,
      password: "",
      network: SS_DEFAULT_NETWORK,
    },
  );
});

test("ssSettings ignores non-object settings", () => {
  assert.deepEqual(ssSettings({ config: { settings: ["method"] } }), {
    method: SS_DEFAULT_METHOD,
    password: "",
    network: SS_DEFAULT_NETWORK,
  });
});

test("withSsSettings writes only under config.settings and keeps other keys", () => {
  const config = {
    settings: { clients: [{ id: "u1" }] },
    streamSettings: { network: "tcp" },
  };
  assert.deepEqual(
    withSsSettings(config, {
      method: " 2022-blake3-aes-128-gcm ",
      password: "  abc  ",
      network: " TCP ",
    }),
    {
      settings: {
        clients: [{ id: "u1" }],
        method: "2022-blake3-aes-128-gcm",
        password: "abc",
        network: "tcp",
      },
      streamSettings: { network: "tcp" },
    },
  );
  // 不修改入参。
  assert.deepEqual(config, {
    settings: { clients: [{ id: "u1" }] },
    streamSettings: { network: "tcp" },
  });
});

test("stripSsSettings removes SS-only keys but keeps clients", () => {
  const original = {
    settings: {
      method: "aes-256-gcm",
      password: "secret123",
      network: "tcp",
      clients: [{ id: "u1" }],
    },
    streamSettings: {},
  };
  assert.deepEqual(stripSsSettings(original), {
    settings: { clients: [{ id: "u1" }] },
    streamSettings: {},
  });
  const clean = { settings: { clients: [] } };
  assert.equal(stripSsSettings(clean), clean, "无 SS 键时返回原对象");
});

test("ssMethodBadge maps every method to a compact badge", () => {
  assert.equal(ssMethodBadge("2022-blake3-aes-256-gcm"), "SS · 2022-256");
  assert.equal(ssMethodBadge("2022-blake3-aes-128-gcm"), "SS · 2022-128");
  assert.equal(ssMethodBadge("2022-blake3-chacha20-poly1305"), "SS · 2022-Chacha");
  assert.equal(ssMethodBadge("aes-256-gcm"), "SS · AES-256");
  assert.equal(ssMethodBadge("aes-128-gcm"), "SS · AES-128");
  assert.equal(ssMethodBadge("chacha20-poly1305"), "SS · ChaCha20");
  assert.equal(ssMethodBadge("xchacha20-poly1305"), "SS · XChaCha20");
  assert.equal(ssMethodBadge(" AES-256-GCM "), "SS · AES-256");
  assert.equal(ssMethodBadge("aes-256-cfb"), "SS");
});

test("ssKeyRequirementLabel shortens 2022 names for field errors", () => {
  assert.equal(ssKeyRequirementLabel("2022-blake3-aes-128-gcm"), "128-gcm");
  assert.equal(ssKeyRequirementLabel("2022-blake3-aes-256-gcm"), "256-gcm");
  assert.equal(
    ssKeyRequirementLabel("2022-blake3-chacha20-poly1305"),
    "chacha20-poly1305",
  );
  assert.equal(ssKeyRequirementLabel("aes-256-gcm"), "aes-256-gcm");
});
