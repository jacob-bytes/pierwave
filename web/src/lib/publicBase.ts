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

/**
 * 地址为空或非法时，示例链接使用的占位域名。
 *
 * 设置页不再用「当前访问地址」（通常是 127.0.0.1）兜底：面板可能部署在
 * 内网或反代后面，拿本地地址当示例只会误导用户。
 */
export const EXAMPLE_PLACEHOLDER_BASE = "https://your-domain.com";

export type ExampleUrls = {
  /** 安装命令示例：只取决于 Agent 纳管地址。 */
  installCommand: string;
  /** 订阅链接示例：订阅地址优先，留空时回退 Agent 纳管地址。 */
  subscriptionLink: string;
};

/** 示例用的基础地址：空值返回 `empty`，非法值返回 `invalid`，尾斜杠先去掉。 */
function exampleBase(
  raw: string | null | undefined,
):
  | { state: "empty" }
  | { state: "invalid" }
  | { state: "valid"; base: string } {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (trimmed === "") return { state: "empty" };
  const normalized = normalizePublicBaseUrl(trimmed);
  if (!normalized) return { state: "invalid" };
  return { state: "valid", base: normalized };
}

/**
 * 设置页「对外地址」的两个示例链接。
 *
 * 跟随输入框的实时值（不要求已保存），规则与后端回退顺序一致：
 * - 安装命令：Agent 纳管地址；空或非法时用占位域名。
 * - 订阅链接：订阅地址；订阅留空时回退有效 Agent 地址；否则用占位域名。
 * 非法地址直接跳过，绝不在半截输入上拼 `/api/...`。
 */
export function exampleUrls(
  agentBaseUrl: string | null | undefined,
  subscriptionBaseUrl: string | null | undefined,
): ExampleUrls {
  const agent = exampleBase(agentBaseUrl);
  const subscription = exampleBase(subscriptionBaseUrl);
  const agentBase = agent.state === "valid" ? agent.base : null;
  const subscriptionBase =
    subscription.state === "valid"
      ? subscription.base
      : subscription.state === "empty"
        ? agentBase
        : null;

  return {
    installCommand: agentInstallPreview(agentBase ?? EXAMPLE_PLACEHOLDER_BASE),
    subscriptionLink: subscriptionPreview(
      subscriptionBase ?? EXAMPLE_PLACEHOLDER_BASE,
    ),
  };
}
