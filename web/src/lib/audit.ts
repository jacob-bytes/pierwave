/**
 * 审计日志的纯逻辑：动作词典、语义色与对象列解析。
 *
 * 从 `AuditPanel.tsx` 抽出来，是为了让「未知动作兜底」「对象解析失败」这类
 * 边界能在 `node:test` 里直接断言，而不是只能靠肉眼。
 *
 * 三条规则：
 * - 动作文案是白名单：后端新增 code 时显示「未知动作 · code」，但不假装看得懂；
 * - 语义色只表达结果：成功 = muted / primary，删除与失败 = destructive，
 *   amber 只留给真正的告警（恢复、批量停用、凭据轮换）；
 * - 对象列永远给人话：能解析就显示名称，解析不到就显示「转发 80b918f8」，
 *   不把裸 UUID 直接丢到表格里。
 */
import { t } from "../i18n/index.ts";

/** 审计动作的语义色，与 Badge 的 toneClass 一一对应。 */
export type AuditTone = "primary" | "destructive" | "warning" | "muted";

/**
 * 动作 → 文案键。新增后端 action 时只需要在这里补一行，并在两个词典里补文案。
 * 注意顺序无关，但前缀相近的动作（chain / chain_template）必须分开匹配。
 */
export const AUDIT_ACTION_KEYS: Record<string, string> = {
  "agent.upgrade.batch": "audit.action.agent_upgrade_batch",
  "agent.upgrade": "audit.action.agent_upgrade",
  "backup.export": "audit.action.backup_export",
  "backup.remote.upload": "audit.action.backupRemoteUpload",
  "backup.restore.schedule": "audit.action.backup_restore_schedule",
  "backup.restore.cancel": "audit.action.backup_restore_cancel",
  "backup.restore.apply": "audit.action.backup_restore_apply",
  "chain.create": "audit.action.chain_create",
  "chain.update": "audit.action.chain_update",
  "chain.delete": "audit.action.chain_delete",
  "chain_template.create": "audit.action.chainTemplateCreate",
  "chain_template.update": "audit.action.chainTemplateUpdate",
  "chain_template.delete": "audit.action.chainTemplateDelete",
  "forward.create": "audit.action.forward_create",
  "forward.update": "audit.action.forward_update",
  "forward.delete": "audit.action.forward_delete",
  "user.create": "audit.action.userCreate",
  "user.update": "audit.action.userUpdate",
  "user.delete": "audit.action.userDelete",
  "user.bulk_disable_over_quota": "audit.action.userBulkDisableOverQuota",
  "user_package.bind": "audit.action.userPackageBind",
  "user_package.update": "audit.action.userPackageUpdate",
  "user_package.unbind": "audit.action.userPackageUnbind",
  "user_chain.create": "audit.action.userChainCreate",
  "user_chain.update": "audit.action.userChainUpdate",
  "user_chain.delete": "audit.action.userChainDelete",
  "user_forward.create": "audit.action.userForwardCreate",
  "user_forward.delete": "audit.action.userForwardDelete",
  "package.create": "audit.action.packageCreate",
  "package.update": "audit.action.packageUpdate",
  "package.delete": "audit.action.packageDelete",
  "package_instance.batch_renew": "audit.action.packageInstanceBatchRenew",
  "server.create": "audit.action.serverCreate",
  "server.update": "audit.action.serverUpdate",
  "server.delete": "audit.action.serverDelete",
  "server.token_rotated": "audit.action.serverTokenRotated",
  "node.create": "audit.action.nodeCreate",
  "node.update": "audit.action.nodeUpdate",
  "node.delete": "audit.action.nodeDelete",
  "node.tcping": "audit.action.nodeTcping",
  "certificate.upload": "audit.action.certificateUpload",
  "certificate.delete": "audit.action.certificateDelete",
  "rule_template.create": "audit.action.ruleTemplateCreate",
  "rule_template.update": "audit.action.ruleTemplateUpdate",
  "rule_template.delete": "audit.action.ruleTemplateDelete",
  "subscription_template.create": "audit.action.subscriptionTemplateCreate",
  "subscription_template.update": "audit.action.subscriptionTemplateUpdate",
  "subscription_template.delete": "audit.action.subscriptionTemplateDelete",
  "outbound.create": "audit.action.outboundCreate",
  "outbound.update": "audit.action.outboundUpdate",
  "outbound.delete": "audit.action.outboundDelete",
  "routing_rule.create": "audit.action.routingRuleCreate",
  "routing_rule.update": "audit.action.routingRuleUpdate",
  "routing_rule.delete": "audit.action.routingRuleDelete",
  "api_token.create": "audit.action.apiTokenCreate",
  "api_token.revoke": "audit.action.apiTokenRevoke",
  "event.cleanup": "audit.action.eventCleanup",
  "updates.check": "audit.action.updatesCheck",
  "settings.update": "audit.action.settingsUpdate",
  "password.change": "audit.action.passwordChange",
  "user.reset_subscription": "audit.action.userResetSubscription",
  "auth.login": "audit.action.authLogin",
  "auth.login_failed": "audit.action.authLoginFailed",
  "auth.logout": "audit.action.authLogout",
  "auth.session_kick": "audit.action.authSessionKick",
  "auth.sessions_kick_others": "audit.action.authSessionsKickOthers",
  "config.apply": "audit.action.configApply",
};

/** 语义上是「告警」而不是「成功 / 失败」的动作，amber 只留给它们。 */
const WARNING_ACTIONS = new Set<string>([
  "backup.restore.apply",
  "backup.restore.schedule",
  "backup.restore.cancel",
  "user.bulk_disable_over_quota",
  "server.token_rotated",
]);

/** 失败 / 删除语义：红色，且优先于任何成功分类。 */
function isFailureAction(action: string): boolean {
  return (
    action === "auth.login_failed" ||
    action.endsWith(".delete") ||
    action.endsWith(".revoke") ||
    action.endsWith(".failed") ||
    action.endsWith(".failure")
  );
}

/** 写操作成功统一用 muted / primary；登录、设置、模板类不再占用告警色。 */
export function auditActionTone(action: string): AuditTone {
  if (isFailureAction(action)) return "destructive";
  if (WARNING_ACTIONS.has(action)) return "warning";
  if (
    action.startsWith("user.") ||
    action.startsWith("user_package.") ||
    action.startsWith("user_chain.") ||
    action.startsWith("user_forward.") ||
    action.startsWith("package.")
  ) {
    return "primary";
  }
  return "muted";
}

/** 词典里的文案键；未知动作返回 null，由展示层补「未知动作」。 */
export function auditActionKey(action: string): string | null {
  return AUDIT_ACTION_KEYS[action] ?? null;
}

/**
 * 动作的可读文案。
 *
 * 未知 code 不能显示成裸代码：前面加「未知动作」标签，原文保留在 · 后面，
 * 方便排查后端新增了什么、又不让用户以为自己看懂了。
 */
export function auditActionLabel(action: string): string {
  const key = auditActionKey(action);
  if (key) return t(key);
  return t("audit.action.unknownWithCode", { action });
}

/** 对象列能识别的资源类型；顺序即前缀匹配优先级。 */
export const AUDIT_TARGET_KINDS = [
  "chain_template",
  "chain",
  "forward",
  "node",
  "certificate",
  "api_token",
  "outbound",
  "routing_rule",
  "subscription_template",
  "rule_template",
  "server",
  "package",
  "user",
  "settings",
] as const;

export type AuditTargetKind = (typeof AUDIT_TARGET_KINDS)[number];

const TARGET_PREFIXES: readonly [string, AuditTargetKind][] = [
  ["chain_template.", "chain_template"],
  ["chain.", "chain"],
  ["forward.", "forward"],
  ["node.", "node"],
  ["certificate.", "certificate"],
  ["api_token.", "api_token"],
  ["outbound.", "outbound"],
  ["routing_rule.", "routing_rule"],
  ["subscription_template.", "subscription_template"],
  ["rule_template.", "rule_template"],
  ["user_chain.", "chain"],
  ["user_forward.", "forward"],
  ["user_package.", "package"],
  ["package_instance.", "package"],
  ["package.", "package"],
  ["user.", "user"],
  ["auth.", "user"],
  ["password.", "user"],
  ["agent.upgrade", "server"],
  ["server.", "server"],
  ["config.apply", "server"],
  ["settings.", "settings"],
];

/** action → 对象类型；未知动作返回 null（对象列只显示短 id）。 */
export function auditTargetKind(action: string): AuditTargetKind | null {
  for (const [prefix, kind] of TARGET_PREFIXES) {
    if (action.startsWith(prefix)) return kind;
  }
  return null;
}

/** 对象类型的可读名，例如「转发链」「转发」「链模板」。 */
export function auditTargetName(kind: AuditTargetKind): string {
  return t(`audit.target.${kind}`);
}

/** 对象列里 id 的展示长度：8 位足够区分，又不撑爆列宽。 */
export const AUDIT_ID_PREVIEW = 8;

/** `80b918f8-…` → `80b918f8`；短 id 原样返回。 */
export function shortAuditId(id: string): string {
  return id.length > AUDIT_ID_PREVIEW ? id.slice(0, AUDIT_ID_PREVIEW) : id;
}

export interface ResolvedAuditTarget {
  /** 列里显示的文字。 */
  label: string;
  /** hover 的完整值（对象 id 或名称）。 */
  title?: string;
  /** true = 解析到了人话；false = 显示的是「类型 + 短 id」。 */
  resolved: boolean;
}

/** `(kind, id) => 名称`；缓存里没有时返回 undefined，由纯函数降级。 */
export type AuditNameResolver = (
  kind: AuditTargetKind,
  id: string,
) => string | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 对象已删除 / 超出列表返回条数时，从 detail 里回收名称。
 *
 * 后端绝大多数写操作都在 detail 里带了 `name` / `tag`；只有用户自助删除
 * 这类隐私敏感动作故意不带，此时按契约降级为「类型 + 短 id」。
 */
function detailName(detail: unknown): string | undefined {
  if (!isRecord(detail)) return undefined;
  for (const field of ["name", "package_name", "tag", "username"]) {
    const value = detail[field];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/**
 * 对象列解析。
 *
 * - 没有对象（null / 空串）→ `—`；
 * - `settings` 是固定目标，直接翻译；
 * - 先查缓存名称，再退回 detail 里的名称；
 * - 都没有时显示「转发 80b918f8」，完整 id 放 title。
 */
export function resolveAuditTarget(
  action: string,
  target: string | null | undefined,
  resolve: AuditNameResolver,
  detail?: unknown,
): ResolvedAuditTarget {
  if (!target) return { label: "—", resolved: true };
  if (target === "settings" && auditTargetKind(action) === "settings") {
    return { label: t("audit.target.settings"), resolved: true };
  }

  const kind = auditTargetKind(action);
  if (!kind) {
    return { label: shortAuditId(target), title: target, resolved: false };
  }

  const name = resolve(kind, target) ?? detailName(detail);
  if (name) return { label: name, title: target, resolved: true };

  return {
    label: t("audit.target.withId", {
      name: auditTargetName(kind),
      id: shortAuditId(target),
    }),
    title: target,
    resolved: false,
  };
}
