import assert from "node:assert/strict";
import test from "node:test";
import { setCurrentLocale } from "../i18n/locale.ts";
import { ApiError } from "./apiError.ts";
import { errorText, hasErrorCode } from "./errors.ts";

function withLocale(locale, fn) {
  setCurrentLocale(locale);
  try {
    fn();
  } finally {
    setCurrentLocale("en");
  }
}

test("code hit returns the Chinese translation with params interpolated", () => {
  withLocale("zh-CN", () => {
    const error = new ApiError(
      "目标版本 0.5.2 必须比当前版本 0.5.3 新",
      400,
      "agent.upgrade.not_newer",
      { current: "0.5.3", target: "0.5.2" },
    );
    assert.equal(
      errorText(error, "fallback"),
      "目标版本 0.5.2 必须比当前版本 0.5.3 新",
    );
  });
});

test("code hit returns the English translation with params interpolated", () => {
  withLocale("en", () => {
    const error = new ApiError(
      "目标版本 0.5.2 必须比当前版本 0.5.3 新",
      400,
      "agent.upgrade.not_newer",
      { current: "0.5.3", target: "0.5.2" },
    );
    assert.equal(
      errorText(error, "fallback"),
      "Target version 0.5.2 must be newer than the current version 0.5.3",
    );
  });
});

test("code without params still translates when the template has no placeholders", () => {
  withLocale("en", () => {
    assert.equal(
      errorText(new ApiError("未登录", 401, "auth.unauthorized"), "fallback"),
      "Not signed in",
    );
  });
});

test("unknown code falls back to the backend error text", () => {
  withLocale("en", () => {
    assert.equal(
      errorText(
        new ApiError("服务器内部错误", 500, "backend.unknown_code"),
        "fallback",
      ),
      "服务器内部错误",
    );
  });
});

test("missing code falls back to the backend error text", () => {
  withLocale("en", () => {
    assert.equal(
      errorText(new ApiError("服务器内部错误", 500), "fallback"),
      "服务器内部错误",
    );
  });
});

test("empty backend text falls back to the caller fallback", () => {
  withLocale("en", () => {
    assert.equal(errorText(new ApiError("   ", 500), "load failed"), "load failed");
    assert.equal(
      errorText(new ApiError("", 400, "backend.unknown_code"), "load failed"),
      "load failed",
    );
  });
});

test("params are interpolated in both languages", () => {
  const error = () =>
    new ApiError(
      "尝试过于频繁，请 5 分钟后再试",
      429,
      "auth.too_many_attempts",
      { minutes: 5 },
    );

  withLocale("zh-CN", () => {
    assert.equal(
      errorText(error(), "fallback"),
      "尝试过于频繁，请 5 分钟后再试",
    );
  });
  withLocale("en", () => {
    assert.equal(
      errorText(error(), "fallback"),
      "Too many attempts. Try again in 5 minutes.",
    );
  });
});

test("missing params fall back to the backend error text, never render placeholders", () => {
  withLocale("en", () => {
    const text = errorText(
      new ApiError("目标版本 0.5.2 必须比当前版本 0.5.3 新", 400,
        "agent.upgrade.not_newer"),
      "fallback",
    );
    assert.equal(text, "目标版本 0.5.2 必须比当前版本 0.5.3 新");
    assert.ok(!text.includes("{"), "must not leak a placeholder");
    assert.ok(!text.includes("target"), "must not use the untranslated template");
  });
});

test("partial params also fall back instead of mixing translation and placeholders", () => {
  withLocale("en", () => {
    const text = errorText(
      new ApiError("目标版本 0.5.2 必须比当前版本 0.5.3 新", 400,
        "agent.upgrade.not_newer", { target: "0.5.2" }),
      "fallback",
    );
    assert.equal(text, "目标版本 0.5.2 必须比当前版本 0.5.3 新");
    assert.ok(!text.includes("{"), "must not leak a placeholder");
  });
});

test("missing params with no backend text use the caller fallback", () => {
  withLocale("en", () => {
    const text = errorText(
      new ApiError("", 400, "agent.upgrade.not_newer"),
      "upgrade failed",
    );
    assert.equal(text, "upgrade failed");
    assert.ok(!text.includes("{"), "must not leak a placeholder");
  });
});

test("list params are joined with the current locale's separator", () => {
  const error = () =>
    new ApiError(
      "以下服务器不存在：a、b",
      400,
      "upgrade_batch.servers_not_found",
      { server_ids: ["a", "b"] },
    );

  withLocale("zh-CN", () => {
    assert.equal(
      errorText(error(), "fallback"),
      "以下服务器不存在：a、b",
    );
  });
  withLocale("en", () => {
    assert.equal(
      errorText(error(), "fallback"),
      "These servers do not exist: a, b",
    );
  });
});

test("hasErrorCode probes the dictionary without comparing translated text", () => {
  withLocale("en", () => {
    assert.equal(hasErrorCode("agent.upgrade.not_newer"), true);
    assert.equal(hasErrorCode("errors.not_a_code"), false);
    assert.equal(hasErrorCode("toString"), false);
  });
  withLocale("zh-CN", () => {
    assert.equal(hasErrorCode("agent.upgrade.not_newer"), true);
  });
});
