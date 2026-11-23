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

test("master-key errors translate secret keys as readable comma-separated labels", () => {
  const mismatch = () =>
    new ApiError(
      "备份来自另一把主密钥（无法解密：telegram_bot_token, hmac_secret_v1）",
      400,
      "backup.key_mismatch",
      { keys: ["telegram_bot_token", "hmac_secret_v1"] },
    );

  withLocale("zh-CN", () => {
    const text = errorText(mismatch(), "fallback");
    assert.ok(text.includes("Telegram Bot Token, 订阅派生 secret"), text);
    assert.ok(!text.includes("[\""), "不能直接渲染 JSON 数组");
    assert.ok(!text.includes("telegram_bot_token"), "不能暴露原始键名");
    assert.ok(text.includes("secret.key"), "要告诉用户下一步怎么做");
    assert.ok(text.includes("强制恢复"), "要提示强制恢复这条逃生路径");
  });

  withLocale("en", () => {
    const text = errorText(mismatch(), "fallback");
    assert.ok(text.includes("Telegram bot token, Subscription derivation secret"), text);
    assert.ok(!text.includes("[\""), "must not render a raw JSON array");
    assert.ok(!text.includes("telegram_bot_token"), "must not leak raw keys");
    assert.ok(text.includes("secret.key"), "must state the next step");
    assert.ok(text.includes("forced restore"), "must mention forced restore");
  });
});

test("settings.secret_overwrite and secret_decrypt_failed include readable keys", () => {
  const overwrite = () =>
    new ApiError(
      "已保存的 WebDAV 密码无法用当前主密钥解密",
      400,
      "settings.secret_overwrite",
      { keys: ["backup_webdav_password"] },
    );
  const decrypt = () =>
    new ApiError(
      "秘密设置无法解密",
      400,
      "settings.secret_decrypt_failed",
      { keys: ["telegram_bot_token", "webhook_url"] },
    );

  withLocale("zh-CN", () => {
    assert.equal(
      errorText(overwrite(), "fallback"),
      "以下秘密无法用当前主密钥解密：WebDAV 密码。请重新填写这些秘密，或先关闭依赖它们的功能后保存。",
    );
    assert.equal(
      errorText(decrypt(), "fallback"),
      "以下秘密设置无法用当前主密钥解密：Telegram Bot Token, Webhook 地址。请恢复写入时使用的主密钥（data/secret.key 或 PIERWAVE_SECRET_KEY）后重试。",
    );
  });

  withLocale("en", () => {
    assert.equal(
      errorText(overwrite(), "fallback"),
      "These secrets cannot be decrypted with the current master key: WebDAV password. Re-enter them, or turn off the features that depend on them before saving.",
    );
    assert.equal(
      errorText(decrypt(), "fallback"),
      "These secrets cannot be decrypted with the current master key: Telegram bot token, Webhook URL. Restore the master key used when they were written (data/secret.key or PIERWAVE_SECRET_KEY), then retry.",
    );
  });
});

test("unknown secret keys fall through as-is and missing keys fall back to backend text", () => {
  withLocale("en", () => {
    assert.equal(
      errorText(
        new ApiError("x", 400, "settings.secret_overwrite", {
          keys: ["future_secret"],
        }),
        "fallback",
      ),
      "These secrets cannot be decrypted with the current master key: future_secret. Re-enter them, or turn off the features that depend on them before saving.",
    );
    const missing = errorText(
      new ApiError("后端原文", 400, "settings.secret_decrypt_failed"),
      "fallback",
    );
    assert.equal(missing, "后端原文");
    assert.ok(!missing.includes("{"), "missing keys must not leak placeholders");
  });
});

test("self-service forward errors translate in both languages with backend params", () => {
  const quota = () =>
    new ApiError(
      "转发规则数量已达套餐上限（2/2）",
      400,
      "me.forward_quota_exceeded",
      { limit: 2, used: 2 },
    );
  const notAllowed = () =>
    new ApiError(
      "当前套餐不允许在服务器「hk-1」上创建转发",
      403,
      "me.forward_server_not_allowed",
      { server_id: "s1", server_name: "hk-1" },
    );
  const notFound = () =>
    new ApiError("转发规则不存在", 404, "me.forward_not_found");

  withLocale("zh-CN", () => {
    assert.equal(
      errorText(quota(), "fallback"),
      "自助转发配额不足（已用 2 / 上限 2）；请删除不再使用的转发，或联系管理员调整套餐",
    );
    assert.equal(
      errorText(notAllowed(), "fallback"),
      "当前套餐不允许在服务器「hk-1」上创建转发",
    );
    assert.equal(errorText(notFound(), "fallback"), "转发规则不存在或已被删除");
  });

  withLocale("en", () => {
    assert.equal(
      errorText(quota(), "fallback"),
      "Self-service forward quota exceeded (2 used / 2 allowed); delete an existing forward or ask an administrator to adjust your package",
    );
    assert.equal(
      errorText(notAllowed(), "fallback"),
      'Your current package does not allow forwards on server "hk-1"',
    );
    assert.equal(
      errorText(notFound(), "fallback"),
      "The forward does not exist or has already been deleted",
    );
  });
});

test("backup.export_too_large maps to a readable, localized limit", () => {
  const error = () =>
    new ApiError(
      "当前数据库 2 字节，超过导出/异地备份上限 1 字节",
      400,
      "backup.export_too_large",
      { db_bytes: 2, max_bytes: 1_048_576, max_mb: 1 },
    );
  assert.equal(hasErrorCode("backup.export_too_large"), true);

  withLocale("zh-CN", () => {
    assert.equal(
      errorText(error(), "fallback"),
      "数据库超过导出与异地备份上限 1 MB；请先清理数据或调大 PIERWAVE_MAX_BACKUP_MB 后重试",
    );
  });
  withLocale("en", () => {
    assert.equal(
      errorText(error(), "fallback"),
      "The database exceeds the 1 MB export and off-site backup limit; clean up data or raise PIERWAVE_MAX_BACKUP_MB and retry",
    );
  });
});

test("backup.restore_sync_failed points at the disk instead of a generic failure", () => {
  const error = () =>
    new ApiError(
      "failed to fsync directory /srv/pierwave",
      500,
      "backup.restore_sync_failed",
      { path: "/srv/pierwave" },
    );
  assert.equal(hasErrorCode("backup.restore_sync_failed"), true);

  withLocale("zh-CN", () => {
    const text = errorText(error(), "fallback");
    assert.equal(text.includes("磁盘"), true, text);
    assert.equal(text.includes("重试"), true, text);
  });
  withLocale("en", () => {
    const text = errorText(error(), "fallback");
    assert.equal(text.toLowerCase().includes("disk"), true, text);
    assert.equal(text.toLowerCase().includes("try again"), true, text);
  });
});

test("新汇率 / server-health 错误码在中英词典里都有", () => {
  const codes = [
    "settings.fx_rates_invalid",
    "query.server_health_hours_invalid",
    "query.server_health_bucket_invalid",
  ];
  for (const locale of ["zh-CN", "en"]) {
    withLocale(locale, () => {
      for (const code of codes) {
        assert.equal(hasErrorCode(code), true, `${locale} ${code}`);
      }
    });
  }
});

test("server-health 参数错误在中英里都带边界", () => {
  const error = () =>
    new ApiError("hours 非法", 400, "query.server_health_hours_invalid", {
      min: 1,
      max: 168,
      default: 168,
    });
  withLocale("zh-CN", () => {
    assert.equal(
      errorText(error(), "fallback"),
      "hours 必须是 1-168 的整数（默认 168）",
    );
  });
  withLocale("en", () => {
    assert.equal(
      errorText(error(), "fallback"),
      "hours must be an integer between 1 and 168 (default 168)",
    );
  });
});

test("入口端口范围 / 模板冲突 / 停用模板三个错误码中英都有译文", () => {
  const codes = [
    "chain.entry_port_out_of_range",
    "chain.template_conflict",
    "chain_template.disabled",
  ];
  for (const locale of ["zh-CN", "en"]) {
    withLocale(locale, () => {
      for (const code of codes) {
        assert.equal(hasErrorCode(code), true, `${locale} ${code}`);
      }
    });
  }

  withLocale("zh-CN", () => {
    assert.equal(
      errorText(
        new ApiError("入口端口越界", 400, "chain.entry_port_out_of_range", {
          port: 70000,
          min: 1,
          max: 65535,
        }),
        "fallback",
      ),
      "入口端口必须在 1-65535 之间（当前 70000）",
    );
    assert.equal(
      errorText(
        new ApiError("模板冲突", 400, "chain.template_conflict", {
          template_id: "tpl-1",
          conflicts: "groups / engine",
        }),
        "fallback",
      ),
      "从模板创建时不能再提供 groups / engine：groups / hops 与 template_id 互斥，engine / protocol / transport / tunnel_security 直接沿用模板",
    );
    assert.equal(
      errorText(
        new ApiError("模板已停用", 400, "chain_template.disabled", {
          template_id: "tpl-1",
          template_name: "港日",
        }),
        "fallback",
      ),
      "链模板「港日」已停用，不能用于建链",
    );
  });

  withLocale("en", () => {
    assert.equal(
      errorText(
        new ApiError("entry port out of range", 400, "chain.entry_port_out_of_range", {
          port: 70000,
          min: 1,
          max: 65535,
        }),
        "fallback",
      ),
      "The entry port must be between 1 and 65535 (got 70000)",
    );
    assert.equal(
      errorText(
        new ApiError("template conflict", 400, "chain.template_conflict", {
          template_id: "tpl-1",
          conflicts: "groups / engine",
        }),
        "fallback",
      ),
      "Creating from a template cannot also pass groups / engine: groups/hops are mutually exclusive with template_id, and engine/protocol/transport/tunnel_security come from the template",
    );
    assert.equal(
      errorText(
        new ApiError("template disabled", 400, "chain_template.disabled", {
          template_id: "tpl-1",
          template_name: "港日",
        }),
        "fallback",
      ),
      'Chain template "港日" is disabled and cannot be used to create a chain',
    );
  });
});
