/**
 * 异地备份（WebDAV）的前端纯逻辑。
 *
 * 这里只放与 React / 网络无关的规则：
 * - WebDAV 地址只接受 http(s)、不允许内嵌用户名密码或查询串（与后端一致）；
 * - 间隔 1–168 小时、保留份数 1–30 份（与后端 `remote_backup` 常量一致）；
 * - 密码留空 = 保持不变，因此提交时**不能**带空密码字段；
 * - 远端文件列表只展示本产品命名（`pierwave-backup-YYYYMMDD-HHMMSS.db.gz`）
 *   的文件，最新在前、最多 30 条。
 *
 * 文件名与设置默认值必须与 `crates/domain/src/remote_backup.rs` 保持一致。
 */

export const REMOTE_BACKUP_PREFIX = "pierwave-backup";
export const REMOTE_BACKUP_INTERVAL_MIN = 1;
export const REMOTE_BACKUP_INTERVAL_MAX = 168;
export const REMOTE_BACKUP_INTERVAL_DEFAULT = 24;
export const REMOTE_BACKUP_KEEP_MIN = 1;
export const REMOTE_BACKUP_KEEP_MAX = 30;
export const REMOTE_BACKUP_KEEP_DEFAULT = 7;
export const REMOTE_BACKUP_MAX_FILES = 30;

/** 地址输入框占位；也是 README / 文档里的统一示例。 */
export const REMOTE_BACKUP_URL_PLACEHOLDER =
  "https://dav.example.com/remote.php/dav/files/user/pierwave";

/** 表单值一律用字符串保存，避免受控输入在编辑过程中被 Number 改写。 */
export interface RemoteBackupFormValues {
  enabled: boolean;
  url: string;
  username: string;
  password: string;
  intervalHours: string;
  keep: string;
}

export const EMPTY_REMOTE_BACKUP_FORM: RemoteBackupFormValues = {
  enabled: false,
  url: "",
  username: "",
  password: "",
  intervalHours: String(REMOTE_BACKUP_INTERVAL_DEFAULT),
  keep: String(REMOTE_BACKUP_KEEP_DEFAULT),
};

/** 后端设置里与异地备份相关的字段（结构化子集，避免测试依赖 api.ts）。 */
export interface RemoteBackupSettings {
  backup_webdav_enabled?: boolean | null;
  backup_webdav_url?: string | null;
  backup_webdav_username?: string | null;
  backup_webdav_has_password?: boolean | null;
  backup_webdav_interval_hours?: number | null;
  backup_webdav_keep?: number | null;
}

/** 设置 → 表单。密码永远是空串：后端不回显，输入框只显示「已保存」占位。 */
export function remoteBackupFormFromSettings(
  items: RemoteBackupSettings,
): RemoteBackupFormValues {
  return {
    enabled: items.backup_webdav_enabled === true,
    url: items.backup_webdav_url ?? "",
    username: items.backup_webdav_username ?? "",
    password: "",
    intervalHours: String(
      items.backup_webdav_interval_hours ?? REMOTE_BACKUP_INTERVAL_DEFAULT,
    ),
    keep: String(items.backup_webdav_keep ?? REMOTE_BACKUP_KEEP_DEFAULT),
  };
}

export type WebdavUrlProblem =
  | "scheme"
  | "host"
  | "credentials"
  | "query"
  | "whitespace"
  | "port";

/**
 * 与后端一致的地址校验；空串表示「未配置」，返回 `null`。
 *
 * 依次检查空白 → scheme → 主机/凭据/query → 端口，返回第一个问题。
 */
export function validateWebdavUrl(raw: string): WebdavUrlProblem | null {
  const value = raw.trim();
  if (!value) return null;
  if (/\s/.test(value)) return "whitespace";
  if (!/^https?:\/\//i.test(value)) return "scheme";

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "host";
  }
  if (!url.hostname) return "host";
  if (url.username || url.password) return "credentials";
  if (url.search || url.hash) return "query";
  if (url.port) {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return "port";
  }
  return null;
}

/** 去掉首尾空白与末尾斜杠；`https://host/dav/` → `https://host/dav`。 */
export function normalizeWebdavUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/** 只接受整数且在闭区间内；空值、小数、非数字都返回 null。 */
export function parseIntegerInRange(
  raw: string,
  min: number,
  max: number,
): number | null {
  const value = raw.trim();
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : null;
}

export interface RemoteBackupFormErrors {
  url?: WebdavUrlProblem;
  intervalHours?: true;
  keep?: true;
}

/** 提交前校验；返回空对象表示可以保存。 */
export function validateRemoteBackupForm(
  values: RemoteBackupFormValues,
): RemoteBackupFormErrors {
  const errors: RemoteBackupFormErrors = {};
  const urlProblem = validateWebdavUrl(values.url);
  if (urlProblem) errors.url = urlProblem;
  if (
    parseIntegerInRange(
      values.intervalHours,
      REMOTE_BACKUP_INTERVAL_MIN,
      REMOTE_BACKUP_INTERVAL_MAX,
    ) === null
  ) {
    errors.intervalHours = true;
  }
  if (
    parseIntegerInRange(
      values.keep,
      REMOTE_BACKUP_KEEP_MIN,
      REMOTE_BACKUP_KEEP_MAX,
    ) === null
  ) {
    errors.keep = true;
  }
  return errors;
}

export function hasRemoteBackupFormErrors(
  errors: RemoteBackupFormErrors,
): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * 表单 → PATCH 负载。
 *
 * 关键规则：密码为空时**不发送**该字段，后端据此保持原密码不变。
 */
export function buildRemoteBackupPayload(
  values: RemoteBackupFormValues,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    backup_webdav_enabled: values.enabled,
    backup_webdav_url: normalizeWebdavUrl(values.url),
    backup_webdav_username: values.username.trim(),
    backup_webdav_interval_hours: Number(values.intervalHours),
    backup_webdav_keep: Number(values.keep),
  };
  if (values.password.trim() !== "") {
    payload.backup_webdav_password = values.password;
  }
  return payload;
}

/** 是否已配置完成（地址 + 密码）；决定「测试连接 / 立即备份」是否可点。 */
export function isRemoteBackupConfigured(
  items: RemoteBackupSettings,
): boolean {
  const url = (items.backup_webdav_url ?? "").trim();
  return url !== "" && items.backup_webdav_has_password === true;
}

export interface RemoteBackupFileView {
  name: string;
  size: number;
  modified: number | null;
}

/** 本产品文件名：`pierwave-backup-` + 8 位日期 + `-` + 6 位时间 + `.db.gz`。 */
export function isManagedRemoteBackupName(name: string): boolean {
  const prefix = `${REMOTE_BACKUP_PREFIX}-`;
  if (!name.startsWith(prefix) || !name.endsWith(".db.gz")) return false;
  const stamp = name.slice(prefix.length, -".db.gz".length);
  return /^\d{8}-\d{6}$/.test(stamp);
}

/**
 * 只保留本产品备份，最新在前，最多 30 条。
 *
 * 时间戳格式可直接字典序比较，避免依赖 `modified`（部分服务器不返回）。
 */
export function selectRemoteBackupFiles(
  files: readonly RemoteBackupFileView[],
): RemoteBackupFileView[] {
  return files
    .filter((file) => isManagedRemoteBackupName(file.name))
    .slice()
    .sort((left, right) => (left.name < right.name ? 1 : -1))
    .slice(0, REMOTE_BACKUP_MAX_FILES);
}

export type RemoteBackupTone = "never" | "ok" | "failed";

/** 状态徽标：从未成功 / 最近一次成功 / 最近一次失败。 */
export function remoteBackupTone(status: {
  last_success_at?: number | null;
  last_error?: string | null;
}): RemoteBackupTone {
  if (status.last_error) return "failed";
  if (status.last_success_at) return "ok";
  return "never";
}

/**
 * 错误文本兜底打码：后端已对密码打码，这里再挡一层 URL 内嵌凭据
 * （旧版本/代理返回的错误里可能出现 `https://user:pass@host`）。
 */
export function redactRemoteError(text: string): string {
  return text.replace(/(https?:\/\/)([^/\s@]+)@/gi, "$1***@");
}
