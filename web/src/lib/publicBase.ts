/**
 * 面板对外地址的纯逻辑：校验、回退与预览。
 *
 * 与后端 `crates/master/src/routes/public_url.rs` 保持同一套规则：
 * 只接受 `http(s)://host[:port]`，trim 首尾空白，不允许路径/查询/片段。
 * 设置页与测试共用这里，避免表单校验和实际生成链接是两套口径。
 */

export const MAX_PUBLIC_BASE_URL_CHARS = 512;

export type PublicBaseKind = "agent" | "subscription";

const SCHEME_HTTP = "http://";
const SCHEME_HTTPS = "https://";

function validPort(port: string): boolean {
  if (!/^\d+$/.test(port)) return false;
  const value = Number(port);
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function validHost(host: string): boolean {
  if (!host) return false;
  if (!/^[\p{L}\p{N}._-]+$/u.test(host)) return false;
  return /[\p{L}\p{N}]/u.test(host);
}

/**
 * 规范化对外地址；空串合法（= 不配置）。非法值返回 `null`。
 * scheme 大小写不敏感，统一输出小写。
 */
export function normalizePublicBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  if ([...trimmed].length > MAX_PUBLIC_BASE_URL_CHARS) return null;

  const lower = trimmed.toLowerCase();
  let scheme: string;
  let rest: string;
  if (lower.startsWith(SCHEME_HTTP)) {
    scheme = "http";
    rest = trimmed.slice(SCHEME_HTTP.length);
  } else if (lower.startsWith(SCHEME_HTTPS)) {
    scheme = "https";
    rest = trimmed.slice(SCHEME_HTTPS.length);
  } else {
    return null;
  }

  if (!rest) return null;
  if (/\s/.test(rest) || /[\u0000-\u001f\u007f]/.test(rest)) return null;
  if (/[/?#]/.test(rest)) return null;
  if (rest.includes("@")) return null;

  if (rest.startsWith("[")) {
    const end = rest.indexOf("]");
    if (end < 0) return null;
    const host = rest.slice(1, end);
    if (!host.includes(":") || !/^[0-9a-fA-F:.]+$/.test(host)) return null;
    // 后端用 `Ipv6Addr::parse` 严格校验；这里用 URL 解析保持同一口径。
    try {
      new URL(`http://[${host}]`);
    } catch {
      return null;
    }
    const after = rest.slice(end + 1);
    if (after !== "") {
      if (!after.startsWith(":") || !validPort(after.slice(1))) return null;
    }
  } else {
    if (rest.includes("[") || rest.includes("]")) return null;
    const parts = rest.split(":");
    if (parts.length > 2) return null;
    if (!validHost(parts[0])) return null;
    if (parts.length === 2 && !validPort(parts[1])) return null;
  }

  return `${scheme}://${rest}`;
}

export function isValidPublicBaseUrl(raw: string): boolean {
  return normalizePublicBaseUrl(raw) !== null;
}

/**
 * 与后端 `public_base` 相同的回退顺序：
 * 订阅设置 → Agent 设置（仅订阅）→ 当前访问地址。
 */
export function resolvePublicBase(
  agentBaseUrl: string | null | undefined,
  subscriptionBaseUrl: string | null | undefined,
  kind: PublicBaseKind,
  fallbackBase: string,
): string {
  const agent = normalizePublicBaseUrl(agentBaseUrl ?? "") ?? "";
  const subscription = normalizePublicBaseUrl(subscriptionBaseUrl ?? "") ?? "";
  const configured =
    kind === "subscription" ? subscription || agent : agent;
  const fallback = normalizePublicBaseUrl(fallbackBase) || fallbackBase.trim();
  const base = configured || fallback;
  return base.replace(/\/+$/, "");
}

/** 预览用的示例安装命令地址。 */
export function agentInstallPreview(base: string): string {
  return `${base.replace(/\/+$/, "")}/api/agent/install.sh?token=<token>`;
}

/** 预览用的示例订阅链接。 */
export function subscriptionPreview(
  base: string,
  shortCode = "abc123",
): string {
  return `${base.replace(/\/+$/, "")}/api/v1/sub/${shortCode}`;
}
