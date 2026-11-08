import assert from "node:assert/strict";
import test from "node:test";
import en from "../i18n/en.ts";
import zh from "../i18n/zh-CN.ts";
import {
  ALERT_COOLDOWN_MAX,
  ALERT_COOLDOWN_MIN,
  ALERT_EVENTS,
  DEFAULT_ALERT_COOLDOWN_SECS,
  DEFAULT_ALERT_EVENTS,
  alertTestOutcome,
  hasConfiguredAlertChannel,
  hasWhitespaceOrControl,
  isHttpUrl,
  isTelegramIncomplete,
  maskSecret,
  normalizeAlertTestResults,
  parseAlertEvents,
  serializeAlertEvents,
} from "./alerts.ts";

test("defaults match the alert design", () => {
  assert.equal(DEFAULT_ALERT_COOLDOWN_SECS, 600);
  assert.equal(ALERT_COOLDOWN_MIN, 0);
  assert.equal(ALERT_COOLDOWN_MAX, 86400);
  assert.deepEqual(DEFAULT_ALERT_EVENTS, [
    "server_offline",
    "user_exhausted",
    "chain_degraded",
  ]);
  assert.deepEqual(ALERT_EVENTS, [
    "server_offline",
    "user_exhausted",
    "chain_degraded",
    "upgrade_failed",
  ]);
});

test("parseAlertEvents treats a missing key as defaults and empty string as none", () => {
  assert.deepEqual(parseAlertEvents(null), [...DEFAULT_ALERT_EVENTS]);
  assert.deepEqual(parseAlertEvents(undefined), [...DEFAULT_ALERT_EVENTS]);
  assert.deepEqual(parseAlertEvents(""), []);
  assert.deepEqual(parseAlertEvents("   "), []);
});

test("parseAlertEvents ignores unknown values, dedupes and keeps canonical order", () => {
  assert.deepEqual(
    parseAlertEvents("upgrade_failed, chain_degraded ,server_offline"),
    ["server_offline", "chain_degraded", "upgrade_failed"],
  );
  assert.deepEqual(
    parseAlertEvents("server_offline,server_offline,nope,UPGRADE_FAILED"),
    ["server_offline"],
  );
});

test("serializeAlertEvents writes the canonical comma-separated form", () => {
  assert.equal(
    serializeAlertEvents([
      "upgrade_failed",
      "server_offline",
      "upgrade_failed",
      "unknown",
    ]),
    "server_offline,upgrade_failed",
  );
  assert.equal(serializeAlertEvents([]), "");
  assert.equal(
    serializeAlertEvents(["chain_degraded", "user_exhausted"]),
    "user_exhausted,chain_degraded",
  );
});

test("parse/serialize round-trips every non-empty subset", () => {
  for (let mask = 1; mask < 1 << ALERT_EVENTS.length; mask += 1) {
    const selected = ALERT_EVENTS.filter((_, index) => mask & (1 << index));
    assert.deepEqual(parseAlertEvents(serializeAlertEvents(selected)), selected);
  }
});

test("isHttpUrl accepts only http(s) absolute URLs", () => {
  assert.equal(isHttpUrl("http://example.com"), true);
  assert.equal(isHttpUrl("https://example.com/hooks/pierwave"), true);
  assert.equal(isHttpUrl("HTTPS://Example.com:8443/hook?a=1"), true);
  assert.equal(isHttpUrl("http://127.0.0.1:8787/hook"), true);
  assert.equal(isHttpUrl("  https://example.com  "), true);
});

test("isHttpUrl rejects other schemes, relative paths and malformed input", () => {
  assert.equal(isHttpUrl(""), false);
  assert.equal(isHttpUrl("   "), false);
  assert.equal(isHttpUrl("example.com/hook"), false);
  assert.equal(isHttpUrl("//example.com/hook"), false);
  assert.equal(isHttpUrl("ftp://example.com"), false);
  assert.equal(isHttpUrl("javascript:alert(1)"), false);
  assert.equal(isHttpUrl("http://"), false);
  assert.equal(isHttpUrl("https:// example.com"), false);
  assert.equal(isHttpUrl("https://example.com:bad"), false);
});

test("maskSecret never exposes the full saved value", () => {
  assert.equal(maskSecret(""), "");
  assert.equal(maskSecret("   "), "");
  assert.equal(maskSecret("12345678"), "••••••••");
  assert.equal(maskSecret("short"), "•••••");

  const token = "123456789:AAHfake-token-value-0123456789";
  const masked = maskSecret(token);
  assert.ok(masked.endsWith("6789"));
  assert.ok(masked.startsWith("••••••••"));
  assert.equal(masked.includes(token), false);
  assert.equal(masked.length, 12);
});

test("maskSecret keeps an already masked value untouched", () => {
  assert.equal(maskSecret("••••••••6789"), "••••••••6789");
});

test("hasConfiguredAlertChannel requires a complete Telegram pair or a webhook", () => {
  assert.equal(
    hasConfiguredAlertChannel({
      telegramBotToken: "123:abc",
      telegramChatId: "-100123",
    }),
    true,
  );
  assert.equal(
    hasConfiguredAlertChannel({ telegramBotToken: "123:abc" }),
    false,
  );
  assert.equal(
    hasConfiguredAlertChannel({ telegramChatId: "-100123" }),
    false,
  );
  assert.equal(
    hasConfiguredAlertChannel({ webhookUrl: "https://example.com/hook" }),
    true,
  );
  assert.equal(
    hasConfiguredAlertChannel({ webhookUrl: "   " }),
    false,
  );
  assert.equal(hasConfiguredAlertChannel({}), false);
});

test("isTelegramIncomplete flags exactly one filled field", () => {
  assert.equal(
    isTelegramIncomplete({ telegramBotToken: "123:abc" }),
    true,
  );
  assert.equal(
    isTelegramIncomplete({ telegramChatId: "-100123" }),
    true,
  );
  assert.equal(
    isTelegramIncomplete({
      telegramBotToken: "123:abc",
      telegramChatId: "-100123",
    }),
    false,
  );
  assert.equal(isTelegramIncomplete({}), false);
});

test("hasWhitespaceOrControl matches the backend's whitespace/control rule", () => {
  assert.equal(hasWhitespaceOrControl("123456:ABC-_x"), false);
  assert.equal(hasWhitespaceOrControl("@channel_name"), false);
  assert.equal(hasWhitespaceOrControl(""), false);
  assert.equal(hasWhitespaceOrControl("123 456"), true);
  assert.equal(hasWhitespaceOrControl("123\t456"), true);
  assert.equal(hasWhitespaceOrControl("123\n456"), true);
  assert.equal(hasWhitespaceOrControl("123\u0000456"), true);
  assert.equal(hasWhitespaceOrControl("123\u007f456"), true);
  assert.equal(hasWhitespaceOrControl("123\u009f456"), true);
});

test("normalizeAlertTestResults sorts known channels and keeps unknown ones", () => {
  const results = normalizeAlertTestResults({
    results: [
      { channel: "webhook", ok: false, error: " 500 " },
      { channel: "sms", ok: true, error: "" },
      { channel: "telegram", ok: true, error: "" },
    ],
  });

  assert.deepEqual(results, [
    { channel: "telegram", ok: true, error: "" },
    { channel: "webhook", ok: false, error: "500" },
    { channel: "sms", ok: true, error: "" },
  ]);
});

test("normalizeAlertTestResults falls back on malformed payloads", () => {
  assert.deepEqual(normalizeAlertTestResults(null), []);
  assert.deepEqual(normalizeAlertTestResults({}), []);
  assert.deepEqual(normalizeAlertTestResults({ results: "nope" }), []);
  assert.deepEqual(
    normalizeAlertTestResults({
      results: [
        null,
        "telegram",
        { channel: "", ok: true },
        { channel: "telegram", ok: "true", error: 42 },
        { channel: "telegram", ok: true, error: "first" },
      ],
    }),
    [{ channel: "telegram", ok: false, error: "" }],
  );
});

test("alertTestOutcome distinguishes empty, ok, partial and failed", () => {
  assert.equal(alertTestOutcome([]), "empty");
  assert.equal(
    alertTestOutcome([{ channel: "telegram", ok: true, error: "" }]),
    "ok",
  );
  assert.equal(
    alertTestOutcome([
      { channel: "telegram", ok: true, error: "" },
      { channel: "webhook", ok: false, error: "timeout" },
    ]),
    "partial",
  );
  assert.equal(
    alertTestOutcome([
      { channel: "telegram", ok: false, error: "401" },
      { channel: "webhook", ok: false, error: "timeout" },
    ]),
    "failed",
  );
});

test("every alert event has a label and description in both locales", () => {
  const pick = (dictionary, path) =>
    path.split(".").reduce((node, part) => node?.[part], dictionary);

  for (const event of ALERT_EVENTS) {
    assert.equal(
      typeof pick(zh.settings.alerts.events, event),
      "string",
      `zh ${event}`,
    );
    assert.equal(
      typeof pick(en.settings.alerts.events, event),
      "string",
      `en ${event}`,
    );
    assert.equal(
      typeof pick(zh.settings.alerts.events, `${event}Desc`),
      "string",
      `zh ${event}Desc`,
    );
    assert.equal(
      typeof pick(en.settings.alerts.events, `${event}Desc`),
      "string",
      `en ${event}Desc`,
    );
  }
});
