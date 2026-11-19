import assert from "node:assert/strict";
import test from "node:test";
import en from "../i18n/en.ts";
import zh from "../i18n/zh-CN.ts";
import { setCurrentLocale } from "../i18n/locale.ts";
import {
  AUDIT_ACTION_KEYS,
  auditActionKey,
  auditActionLabel,
  auditActionTone,
  auditTargetKind,
  resolveAuditTarget,
  shortAuditId,
} from "./audit.ts";

const UUID = "80b918f8-6a7c-4b1d-9f02-3c5e8d7a1b64";

/**
 * 后端当前会写入的全部 action code（crates/master 的 audit::record 调用）。
 * 新增后端动作却忘了补前端词典时，这条用例会先红。
 */
const BACKEND_ACTIONS = [
  "agent.upgrade",
  "agent.upgrade.batch",
  "api_token.create",
  "api_token.revoke",
  "auth.login",
  "auth.login_failed",
  "auth.logout",
  "auth.session_kick",
  "auth.sessions_kick_others",
  "backup.export",
  "backup.remote.upload",
  "backup.restore.apply",
  "backup.restore.cancel",
  "backup.restore.schedule",
  "certificate.delete",
  "certificate.upload",
  "chain.create",
  "chain.delete",
  "chain.update",
  "chain_template.create",
  "chain_template.delete",
  "chain_template.update",
  "config.apply",
  "event.cleanup",
  "forward.create",
  "forward.delete",
  "forward.update",
  "node.create",
  "node.delete",
  "node.tcping",
  "node.update",
  "outbound.create",
  "outbound.delete",
  "outbound.update",
  "package.create",
  "package.delete",
  "package.update",
  "package_instance.batch_renew",
  "password.change",
  "routing_rule.create",
  "routing_rule.delete",
  "routing_rule.update",
  "rule_template.create",
  "rule_template.delete",
  "rule_template.update",
  "server.create",
  "server.delete",
  "server.token_rotated",
  "server.update",
  "settings.update",
  "subscription_template.create",
  "subscription_template.delete",
  "subscription_template.update",
  "updates.check",
  "user.bulk_disable_over_quota",
  "user.create",
  "user.delete",
  "user.reset_subscription",
  "user.update",
  "user_chain.create",
  "user_chain.delete",
  "user_chain.update",
  "user_forward.create",
  "user_forward.delete",
  "user_package.bind",
  "user_package.unbind",
  "user_package.update",
];

function withLocale(locale, fn) {
  setCurrentLocale(locale);
  try {
    fn();
  } finally {
    setCurrentLocale("zh-CN");
  }
}

function lookup(messages, key) {
  let node = messages;
  for (const part of key.split(".")) node = node?.[part];
  return node;
}

test("every backend action has a dictionary key in both locales", () => {
  for (const action of BACKEND_ACTIONS) {
    const key = auditActionKey(action);
    assert.ok(key, `missing audit action key: ${action}`);
    assert.equal(typeof lookup(zh, key), "string", `zh missing ${key}`);
    assert.equal(typeof lookup(en, key), "string", `en missing ${key}`);
  }
  // 词典里的键都指向 audit.action.*，避免误抄成 changes 字段。
  for (const key of Object.values(AUDIT_ACTION_KEYS)) {
    assert.match(key, /^audit\.action\./);
  }
});

test("known codes translate to readable labels", () => {
  withLocale("zh-CN", () => {
    assert.equal(auditActionLabel("chain.create"), "创建转发链");
    assert.equal(auditActionLabel("chain_template.create"), "创建链模板");
    assert.equal(auditActionLabel("api_token.revoke"), "吊销 API Token");
    assert.equal(auditActionLabel("node.tcping"), "探测节点");
  });
  withLocale("en", () => {
    assert.equal(auditActionLabel("chain.create"), "Create forward chain");
    assert.equal(auditActionLabel("chain_template.create"), "Created chain template");
    assert.equal(auditActionLabel("api_token.revoke"), "Revoked API token");
  });
});

test("unknown codes keep the raw action behind an explicit unknown tag", () => {
  assert.equal(auditActionKey("mystery.action"), null);
  withLocale("zh-CN", () => {
    assert.equal(
      auditActionLabel("mystery.action"),
      "未知动作 · mystery.action",
    );
  });
  withLocale("en", () => {
    assert.equal(
      auditActionLabel("mystery.action"),
      "Unknown action · mystery.action",
    );
  });
});

test("success actions no longer use the amber warning tone", () => {
  for (const action of [
    "auth.login",
    "settings.update",
    "rule_template.create",
    "rule_template.update",
    "rule_template.delete",
    "config.apply",
    "password.change",
    "mystery.action",
  ]) {
    assert.notEqual(
      auditActionTone(action),
      "warning",
      `${action} must not be amber`,
    );
  }
  // 删除 / 失败才是红色；普通的模板删除属于 destructive，不是 amber。
  assert.equal(auditActionTone("rule_template.delete"), "destructive");
  assert.equal(auditActionTone("chain.delete"), "destructive");
  assert.equal(auditActionTone("auth.login_failed"), "destructive");
  assert.equal(auditActionTone("api_token.revoke"), "destructive");
  // amber 只留给真正的告警动作。
  assert.equal(auditActionTone("backup.restore.apply"), "warning");
  assert.equal(auditActionTone("user.bulk_disable_over_quota"), "warning");
  assert.equal(auditActionTone("server.token_rotated"), "warning");
});

test("target kind distinguishes chain from chain template", () => {
  assert.equal(auditTargetKind("chain.create"), "chain");
  assert.equal(auditTargetKind("chain_template.create"), "chain_template");
  assert.equal(auditTargetKind("user_chain.update"), "chain");
  assert.equal(auditTargetKind("user_forward.delete"), "forward");
  assert.equal(auditTargetKind("forward.update"), "forward");
  assert.equal(auditTargetKind("node.tcping"), "node");
  assert.equal(auditTargetKind("certificate.upload"), "certificate");
  assert.equal(auditTargetKind("api_token.create"), "api_token");
  assert.equal(auditTargetKind("settings.update"), "settings");
  assert.equal(auditTargetKind("agent.upgrade"), "server");
  assert.equal(auditTargetKind("mystery.action"), null);
});

test("unresolved object falls back to a readable type + short id", () => {
  withLocale("zh-CN", () => {
    const target = resolveAuditTarget("forward.update", UUID, () => undefined);
    assert.equal(target.resolved, false);
    assert.equal(target.label, `转发 ${UUID.slice(0, 8)}`);
    assert.equal(target.title, UUID);
    // 不能把完整 UUID 直接当 label。
    assert.ok(!target.label.includes(UUID));
  });
  withLocale("en", () => {
    const target = resolveAuditTarget("chain.delete", UUID, () => undefined);
    assert.equal(target.label, `Forward chain ${UUID.slice(0, 8)}`);
  });
});

test("object names resolve from cache, then from detail", () => {
  const resolve = (kind, id) =>
    kind === "forward" && id === UUID ? "港-办公转发" : undefined;
  assert.deepEqual(resolveAuditTarget("forward.update", UUID, resolve), {
    label: "港-办公转发",
    title: UUID,
    resolved: true,
  });

  // 缓存里没有（对象已删除）时，detail 里的 name 仍然可读。
  const target = resolveAuditTarget(
    "chain_template.delete",
    UUID,
    () => undefined,
    { name: "单跳模板" },
  );
  assert.equal(target.label, "单跳模板");
  assert.equal(target.resolved, true);

  // user_package.* 的 target 是套餐实例 id，detail 里只有 package_name。
  assert.equal(
    resolveAuditTarget("user_package.bind", UUID, () => undefined, {
      package_name: "月卡",
    }).label,
    "月卡",
  );
});

test("settings target and empty target keep readable labels", () => {
  assert.deepEqual(resolveAuditTarget("settings.update", "settings", () => undefined), {
    label: "系统设置",
    resolved: true,
  });
  assert.deepEqual(resolveAuditTarget("settings.update", null, () => undefined), {
    label: "—",
    resolved: true,
  });
  // 未知动作 + 目标 id：至少只显示短 id，不铺满整列。
  assert.equal(resolveAuditTarget("mystery.action", UUID, () => undefined).label, shortAuditId(UUID));
});
