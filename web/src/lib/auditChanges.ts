/**
 * 审计 detail → 人类可读的变更摘要。
 *
 * 纯逻辑（不依赖 React / DOM），供 `AuditPanel` 与 `node:test` 共用：
 * - 字段名走 `audit.changes.fields.*` 翻译，未知字段把下划线换成空格；
 * - 值按类型渲染，UUID 形状的 id 交给调用方的缓存 `resolve(kind, id)` 换成名字；
 * - 只有真正的 `{from, to}` 才算变更；创建类记录的平铺字段由页面兜底展示。
 */
import { t } from "../i18n/index.ts";

/** 缓存能翻译的对象类型；与 `audit.changes.fields.*` 里的 id 字段对应。 */
export type ChangeEntityKind = "rule_template" | "user" | "package" | "server";

/** 返回 id 对应的名字；缓存未命中时返回空值，由本模块回落到 id 前缀。 */
export type ChangeResolver = (
  kind: ChangeEntityKind,
  id: string,
) => string | null | undefined;

export interface ChangeItem {
  label: string;
  from: string;
  to: string;
}

interface DiffValue {
  from: unknown;
  to: unknown;
}

/** 字段 → 翻译键。新增后端字段时在这里补一行，两个词典同步补文案。 */
const FIELD_LABEL_KEYS: Record<string, string> = {
  rule_template_id: "audit.changes.fields.rule_template_id",
  node_scope: "audit.changes.fields.node_scope",
  node_count: "audit.changes.fields.node_count",
  node_ids: "audit.changes.fields.node_ids",
  quota_bytes: "audit.changes.fields.quota_bytes",
  quota_override: "audit.changes.fields.quota_override",
  status: "audit.changes.fields.status",
  role: "audit.changes.fields.role",
  panel_name: "audit.changes.fields.panel_name",
  name: "audit.changes.fields.name",
  username: "audit.changes.fields.username",
  package_id: "audit.changes.fields.package_id",
  package_name: "audit.changes.fields.package_name",
  xray_mode: "audit.changes.fields.xray_mode",
  port: "audit.changes.fields.port",
  tag: "audit.changes.fields.tag",
  enabled: "audit.changes.fields.enabled",
  expires_at: "audit.changes.fields.expires_at",
  // 后端其它常见字段（创建 / 更新审计都会出现）。
  user_id: "audit.changes.fields.user_id",
  server_id: "audit.changes.fields.server_id",
  address: "audit.changes.fields.address",
  protocol: "audit.changes.fields.protocol",
  transport: "audit.changes.fields.transport",
  security: "audit.changes.fields.security",
  cert_id: "audit.changes.fields.cert_id",
  bandwidth_kbps: "audit.changes.fields.bandwidth_kbps",
  config: "audit.changes.fields.config",
  description: "audit.changes.fields.description",
  rule_count: "audit.changes.fields.rule_count",
  is_default: "audit.changes.fields.is_default",
  target_host: "audit.changes.fields.target_host",
  target_port: "audit.changes.fields.target_port",
  listen_port: "audit.changes.fields.listen_port",
  hops: "audit.changes.fields.hops",
  inbound_tag: "audit.changes.fields.inbound_tag",
  outbound_tag: "audit.changes.fields.outbound_tag",
  domain: "audit.changes.fields.domain",
  ip: "audit.changes.fields.ip",
  sort_order: "audit.changes.fields.sort_order",
  period_days: "audit.changes.fields.period_days",
  direction: "audit.changes.fields.direction",
  node_ratio: "audit.changes.fields.node_ratio",
  speed_limit_kbps: "audit.changes.fields.speed_limit_kbps",
  reset_day: "audit.changes.fields.reset_day",
  password: "audit.changes.fields.password",
  allow_agent_upgrade: "audit.changes.fields.allow_agent_upgrade",
  keys: "audit.changes.fields.keys",
  domains: "audit.changes.fields.domains",
  version: "audit.changes.fields.version",
  config_version: "audit.changes.fields.config_version",
  revoked_sessions: "audit.changes.fields.revoked_sessions",
  warnings: "audit.changes.fields.warnings",
  short_code: "audit.changes.fields.short_code",
  used_bytes: "audit.changes.fields.used_bytes",
};

/** id 字段 → 缓存类型；只对 UUID 形状的值生效。 */
const FIELD_ENTITY_KINDS: Record<string, ChangeEntityKind> = {
  rule_template_id: "rule_template",
  user_id: "user",
  package_id: "package",
  server_id: "server",
};

/** `node_scope` 的两个机器值；其余值原样展示。 */
const NODE_SCOPE_KEYS: Record<string, string> = {
  all: "audit.changes.value.all",
  custom: "audit.changes.value.custom",
};

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const ID_PREFIX_LENGTH = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDiff(value: unknown): value is DiffValue {
  return isRecord(value) && "from" in value && "to" in value;
}

/** 字段名：命中词典取当前语言；未知字段把下划线换成空格（按约定不吞字段）。 */
export function formatFieldLabel(field: string): string {
  const key = FIELD_LABEL_KEYS[field];
  return key ? t(key) : field.replace(/_/g, " ");
}

/** UUID 解析失败时的降级样式：前 8 位 + 省略号。 */
function idPrefix(id: string): string {
  return `${id.slice(0, ID_PREFIX_LENGTH)}…`;
}

function formatStringValue(
  field: string,
  value: string,
  resolve: ChangeResolver,
): string {
  const trimmed = value.trim();

  if (field === "node_scope") {
    const key = NODE_SCOPE_KEYS[trimmed];
    if (key) return t(key);
  }

  if (!UUID_RE.test(trimmed)) return value;

  const kind = FIELD_ENTITY_KINDS[field];
  if (kind) {
    try {
      const name = resolve(kind, trimmed);
      if (typeof name === "string" && name.trim() !== "") return name.trim();
    } catch {
      // 解析器只是缓存查询；异常时与未命中同样降级，不能影响整行摘要。
    }
  }

  return idPrefix(trimmed);
}

/**
 * 单个值的展示：null → 未设置，布尔 → 是/否，数组 → N 项，对象 → 对象。
 * 数字保持原样，不套流量单位（同一字段可能是端口、天数或字节数）。
 */
export function formatFieldValue(
  field: string,
  value: unknown,
  resolve: ChangeResolver = () => undefined,
): string {
  if (value === null || value === undefined) {
    return t("audit.changes.value.unset");
  }
  if (typeof value === "boolean") {
    return value ? t("audit.changes.value.yes") : t("audit.changes.value.no");
  }
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return formatStringValue(field, value, resolve);
  if (Array.isArray(value)) {
    return t("audit.changes.value.items", { n: value.length });
  }
  if (isRecord(value)) return t("audit.changes.value.object");
  return String(value);
}

function collectDiffs(detail: Record<string, unknown>): [string, DiffValue][] {
  const diffs: [string, DiffValue][] = [];
  const seen = new Set<string>();

  const push = (field: string, value: unknown) => {
    if (seen.has(field) || !isDiff(value)) return;
    seen.add(field);
    diffs.push([field, value]);
  };

  // 1. 常规更新：`changes` 里每个 `{from, to}`。
  const changes = detail.changes;
  if (isRecord(changes)) {
    for (const [field, value] of Object.entries(changes)) push(field, value);
  }

  // 2. package.update 把 node_scope / node_count / node_ids 摊平到顶层。
  for (const [field, value] of Object.entries(detail)) {
    if (field === "changes") continue;
    push(field, value);
  }

  return diffs;
}

/**
 * 从审计 `detail` 提取变更列表。
 *
 * 支持两种真实结构：`{ changes: { field: {from, to} } }`，以及
 * package.update 顶层的 `{ node_scope: {from, to}, ... }`。空 detail、
 * 字符串 detail（后端解析失败时的退化形态）都返回空数组，不抛错。
 */
export function formatChanges(
  detail: unknown,
  resolve: ChangeResolver = () => undefined,
): ChangeItem[] {
  if (!isRecord(detail)) return [];

  return collectDiffs(detail).map(([field, diff]) => ({
    label: formatFieldLabel(field),
    from: formatFieldValue(field, diff.from, resolve),
    to: formatFieldValue(field, diff.to, resolve),
  }));
}

/** 摘要列的一行：`规则模板：未设置 → 流媒体分流`（分隔符跟随语言）。 */
export function formatChangeText(item: ChangeItem): string {
  return t("audit.changes.diff", {
    label: item.label,
    from: item.from,
    to: item.to,
  });
}
