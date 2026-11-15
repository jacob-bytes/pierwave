import assert from "node:assert/strict";
import test from "node:test";
import {
  API_TOKEN_NAME_MAX,
  DEFAULT_API_TOKEN_SCOPE,
  describeExpiry,
  isApiTokenScope,
  revealedToken,
  scopeHintKey,
  scopeLabelKey,
  tokenRevealReducer,
  tokenStatus,
  validateTokenName,
} from "./apiTokens.ts";

test("scope 只有 read/admin，默认 read", () => {
  assert.equal(DEFAULT_API_TOKEN_SCOPE, "read");
  assert.equal(isApiTokenScope("read"), true);
  assert.equal(isApiTokenScope("admin"), true);
  assert.equal(isApiTokenScope("write"), false);
  assert.equal(isApiTokenScope(null), false);
  assert.equal(scopeLabelKey("read"), "settings.apiTokens.scope.read");
  assert.equal(scopeLabelKey("admin"), "settings.apiTokens.scope.admin");
  // read 的说明必须写清「只能读」，admin 写清「等同管理员」。
  assert.equal(scopeHintKey("read"), "settings.apiTokens.scope.readHint");
  assert.equal(scopeHintKey("admin"), "settings.apiTokens.scope.adminHint");
});

test("过期描述：永久 / 过期 / 具体日期", () => {
  const now = 1_800_000_000;
  assert.deepEqual(describeExpiry(null, now), { kind: "never" });
  assert.deepEqual(describeExpiry(undefined, now), { kind: "never" });
  assert.deepEqual(describeExpiry(now - 1, now), {
    kind: "expired",
    date: "2027-01-15",
  });
  assert.deepEqual(describeExpiry(now + 86_400, now), {
    kind: "at",
    date: "2027-01-16",
  });
  // 恰好等于当前秒视为已过期，与后端 `expires_at > now` 一致。
  assert.equal(describeExpiry(now, now).kind, "expired");
});

test("状态判定：吊销优先于过期", () => {
  const now = 1_800_000_000;
  assert.equal(tokenStatus({ revoked_at: null, expires_at: null }, now), "active");
  assert.equal(
    tokenStatus({ revoked_at: null, expires_at: now - 1 }, now),
    "expired",
  );
  assert.equal(
    tokenStatus({ revoked_at: now - 5, expires_at: now - 1 }, now),
    "revoked",
  );
});

test("名称校验覆盖空、超长与控制字符", () => {
  assert.equal(validateTokenName("  CI  "), null);
  assert.equal(validateTokenName("   "), "empty");
  assert.equal(validateTokenName("x".repeat(API_TOKEN_NAME_MAX + 1)), "too_long");
  assert.equal(validateTokenName("ci\nro"), "control");
});

test("一次性明文：只在 created 阶段持有", () => {
  let state = tokenRevealReducer({ phase: "idle" }, { type: "created", token: "pwt_abc" });
  assert.equal(state.phase, "created");
  assert.equal(revealedToken(state), "pwt_abc");

  // 空 token 不覆盖当前状态。
  const unchanged = tokenRevealReducer(state, { type: "created", token: "" });
  assert.equal(unchanged, state);

  // 关闭（dismissed）后状态里不再有明文。
  state = tokenRevealReducer(state, { type: "dismissed" });
  assert.equal(state.phase, "dismissed");
  assert.equal(revealedToken(state), null);
  assert.equal(JSON.stringify(state).includes("pwt_abc"), false);

  // 已关闭状态再收到 dismissed 不会复活。
  const after = tokenRevealReducer(state, { type: "dismissed" });
  assert.equal(after.phase, "dismissed");
  assert.equal(revealedToken(after), null);

  // reset 才能回到 idle，重新创建必须走一次新的 created。
  state = tokenRevealReducer(state, { type: "reset" });
  assert.equal(state.phase, "idle");
  assert.equal(revealedToken(state), null);
});
