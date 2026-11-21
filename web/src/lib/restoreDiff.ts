/**
 * `POST /api/v1/backup/restore` 响应里「恢复后会发生什么」的纯逻辑。
 *
 * 恢复会整体替换 `settings` / `servers`，后端在调度成功时附带：
 * - `settings_diff`：重启后会变化的设置项（before = 当前值，after = 恢复后的值）；
 * - `servers_needing_token_refresh`：恢复后 token 与现场 Agent 不一致的服务器。
 *
 * 这里只做归一化与安全兜底，不碰 React / 网络：
 * - `secret: true` 的行强制丢弃 before/after，任何秘密值都不进入 UI；
 * - 旧后端缺字段、条目畸形或重复 key 时安全降级；
 * - `count` 与 `names` 对齐，避免只显示一半。
 */

export interface RestoreSettingsDiffEntry {
  key: string;
  /** 当前值；secret 行永远为 null。 */
  before: unknown;
  /** 恢复后的值；secret 行永远为 null。 */
  after: unknown;
  /** 该设置是秘密：只提示「被重置」，不展示任何值。 */
  secret: boolean;
}

export interface RestoreServerTokenRefresh {
  count: number;
  names: string[];
}

export interface RestorePreview {
  settingsDiff: RestoreSettingsDiffEntry[];
  serversNeedingTokenRefresh: RestoreServerTokenRefresh;
}

export function emptyRestorePreview(): RestorePreview {
  return {
    settingsDiff: [],
    serversNeedingTokenRefresh: { count: 0, names: [] },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只接受能可读渲染的标量；对象/数组等异常值按缺失处理。 */
function scalarValue(value: unknown): unknown {
  if (value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return undefined;
}

/**
 * 归一化 `settings_diff`。
 *
 * 秘密行的 before/after 一律置空：即使后端将来误带了值，也只显示
 * 「某秘密被重置」，前端没有任何泄漏路径。
 */
export function normalizeSettingsDiff(raw: unknown): RestoreSettingsDiffEntry[] {
  if (!Array.isArray(raw)) return [];

  const entries: RestoreSettingsDiffEntry[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (!isRecord(item)) continue;
    const key = typeof item.key === "string" ? item.key.trim() : "";
    if (!key || seen.has(key)) continue;

    if (item.secret === true) {
      seen.add(key);
      entries.push({ key, before: null, after: null, secret: true });
      continue;
    }

    const before = scalarValue(item.before);
    const after = scalarValue(item.after);
    // 两端都不是可读标量时没有展示价值，直接跳过（也不能占用 key）。
    if (before === undefined && after === undefined) continue;
    seen.add(key);
    entries.push({
      key,
      before: before ?? null,
      after: after ?? null,
      secret: false,
    });
  }

  return entries;
}

/** 归一化服务器刷新提示：去重、去空，count 至少等于实际名称数量。 */
export function normalizeServerTokenRefresh(
  raw: unknown,
): RestoreServerTokenRefresh {
  if (!isRecord(raw)) return { count: 0, names: [] };

  const names = Array.isArray(raw.names)
    ? raw.names
        .filter((name): name is string => typeof name === "string")
        .map((name) => name.trim())
        .filter((name) => name !== "")
        .filter((name, index, all) => all.indexOf(name) === index)
    : [];

  const rawCount =
    typeof raw.count === "number" &&
    Number.isFinite(raw.count) &&
    raw.count > 0
      ? Math.floor(raw.count)
      : 0;

  return { count: Math.max(rawCount, names.length), names };
}

/** 从 PATCH/POST 响应构造恢复预览；缺字段时返回空预览。 */
export function restorePreviewFromResponse(payload: unknown): RestorePreview {
  if (!isRecord(payload)) return emptyRestorePreview();
  return {
    settingsDiff: normalizeSettingsDiff(payload.settings_diff),
    serversNeedingTokenRefresh: normalizeServerTokenRefresh(
      payload.servers_needing_token_refresh,
    ),
  };
}

/** 两类内容都没有时，卡片不应渲染任何额外区块（避免留空壳）。 */
export function hasRestorePreviewContent(preview: RestorePreview): boolean {
  return (
    preview.settingsDiff.length > 0 ||
    preview.serversNeedingTokenRefresh.count > 0
  );
}

/**
 * 设置 key → 可读名；词典里没有的 key 原样显示。
 *
 * 传 `t` 而不是直接 import，纯逻辑测试可以用假词典断言回落规则。
 */
export function restoreSettingLabel(
  key: string,
  translate: (key: string) => string,
): string {
  const path = `settings.backup.restoreDiff.keys.${key}`;
  const label = translate(path);
  return label === path ? key : label;
}

/** 这些设置是开关：数值 0/1 也要显示成「停用/启用」，而不是裸数字。 */
const FLAG_KEYS = [
  "public_status_enabled",
  "public_billing_visible",
  "telegram_bot_enabled",
  "backup_webdav_enabled",
  "backup_encrypt",
  "update_check_enabled",
  "update_check_notify",
] as const;

export function isRestoreFlagKey(key: string): boolean {
  return (FLAG_KEYS as readonly string[]).includes(key);
}

export interface RestoreValueLabels {
  on: string;
  off: string;
  none: string;
}

/** 标量值 → 展示文本；null 用占位符，布尔走开/关文案。 */
export function formatRestoreValue(
  value: unknown,
  labels: RestoreValueLabels,
): string {
  if (value === null || value === undefined) return labels.none;
  if (typeof value === "boolean") return value ? labels.on : labels.off;
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
