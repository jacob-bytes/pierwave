/**
 * 服务器端口约束的纯逻辑：不依赖 React / DOM，`node --test` 可直接覆盖。
 *
 * 后端契约（`servers`）：
 * - `port_start` / `port_end`：可空；两个都空 = 不限制；
 * - `port_allow`：额外允许的端口，空数组 = 没有额外端口；
 * - 三者都为空时，节点端口与链的自动分配不受限制。
 *
 * 单边留空按「该侧不设边界」处理（只有起始 = `start..65535`），
 * 这样旧数据 / 脏数据不会把端口约束解释成「全部禁止」。
 */

import { t } from "../i18n/index.ts";

export const PORT_MIN = 1;
export const PORT_MAX = 65535;

/** 读侧字段可能缺失（旧后端）或为 null（未设置）。 */
export interface PortPolicy {
  port_start?: number | null;
  port_end?: number | null;
  port_allow?: readonly (number | string | null)[] | null;
}

export interface NormalizedPortPolicy {
  start: number | null;
  end: number | null;
  allow: number[];
  /** 至少有一个边界或一个额外端口；false = 完全不限制。 */
  constrained: boolean;
  /** 原始策略里出现过起始或结束端口（即使另一侧留空）。 */
  hasRange: boolean;
  /** 起始 / 结束都填了，且起始 ≤ 结束。 */
  rangeOrdered: boolean;
}

/** 合法端口：1–65535 的整数。字符串按纯数字解析，`0443` 也算 443。 */
function portNumber(value: unknown): number | null {
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    parsed = Number(value.trim());
  } else {
    return null;
  }
  return Number.isSafeInteger(parsed) && parsed >= PORT_MIN && parsed <= PORT_MAX
    ? parsed
    : null;
}

/** 端口输入的分隔符：英文 / 中文逗号、分号、顿号、空白都算。 */
const PORT_SEPARATORS = /[\s,，;；、]+/;

/** 按分隔符切成原始 token（保留非法项，供表单报错与测试使用）。 */
export function splitPortTokens(text: string): string[] {
  return text
    .split(PORT_SEPARATORS)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/** 文本里无法解析为 1–65535 的 token；表单据此提示用户。 */
export function invalidPortAllowTokens(text: string): string[] {
  return splitPortTokens(text).filter((token) => portNumber(token) === null);
}

/**
 * 「额外允许的端口」文本 → 端口数组。
 *
 * - 逗号 / 空白 / 换行分隔；
 * - 只保留 1–65535 的整数，非法 token 直接丢弃（表单先用
 *   `invalidPortAllowTokens` 拦下来）；
 * - 去重并按升序排列，保证同样的输入与后端回读得到同样的顺序。
 */
export function parsePortAllow(text: string): number[] {
  const unique = new Set<number>();
  for (const token of splitPortTokens(text)) {
    const port = portNumber(token);
    if (port !== null) unique.add(port);
  }
  return [...unique].sort((left, right) => left - right);
}

/** 归一化读侧策略；非法边界 / 额外端口一律忽略，避免脏数据放大权限。 */
export function normalizePortPolicy(
  policy?: PortPolicy | null,
): NormalizedPortPolicy {
  const start = portNumber(policy?.port_start);
  const end = portNumber(policy?.port_end);
  const allow = normalizePortAllow(policy?.port_allow);
  const hasRange = start !== null || end !== null;
  return {
    start,
    end,
    allow,
    constrained: hasRange || allow.length > 0,
    hasRange,
    rangeOrdered: start === null || end === null || start <= end,
  };
}

/** `port_allow` 可能是后端数字数组，也可能是旧数据里的字符串；统一去重升序。 */
function normalizePortAllow(
  values: PortPolicy["port_allow"] | undefined,
): number[] {
  if (!Array.isArray(values)) return [];
  const unique = new Set<number>();
  for (const value of values) {
    const port = portNumber(value);
    if (port !== null) unique.add(port);
  }
  return [...unique].sort((left, right) => left - right);
}

/** 有约束 = 配了范围或额外端口；列表只在有约束时显示小标。 */
export function isPortPolicyConstrained(policy?: PortPolicy | null): boolean {
  return normalizePortPolicy(policy).constrained;
}

/**
 * 端口是否落在策略内。
 *
 * - 空策略 = 所有合法端口都允许；
 * - 端口本身非法（0 / 65536 / 小数 / NaN）一律 false；
 * - 范围含边界；额外端口可以越过范围；
 * - 起始 > 结束视为非法范围：不再放行范围内端口，额外端口仍然有效。
 */
export function isPortAllowed(
  port: number,
  policy?: PortPolicy | null,
): boolean {
  if (portNumber(port) === null) return false;

  const normalized = normalizePortPolicy(policy);
  if (!normalized.constrained) return true;

  if (normalized.hasRange) {
    const lower = normalized.start ?? PORT_MIN;
    const upper = normalized.end ?? PORT_MAX;
    if (normalized.rangeOrdered && port >= lower && port <= upper) return true;
  }

  return normalized.allow.includes(port);
}

/**
 * 列表 / 详情用的小标：
 * - 纯范围：`端口 30000-31000`；
 * - 纯额外端口：`端口：自定义 3 个`；
 * - 两者都有：`端口 30000-31000 · 自定义 3 个`；
 * - 无约束或范围非法且没有额外端口：空串（调用方不渲染）。
 */
export function portPolicyLabel(policy?: PortPolicy | null): string {
  const normalized = normalizePortPolicy(policy);
  if (!normalized.constrained) return "";

  const { start, end, allow } = normalized;
  const hasValidRange =
    normalized.rangeOrdered && (start !== null || end !== null);

  if (hasValidRange) {
    const range = {
      start: start ?? PORT_MIN,
      end: end ?? PORT_MAX,
    };
    return allow.length > 0
      ? t("servers.portPolicy.rangeAndAllow", {
          ...range,
          count: allow.length,
        })
      : t("servers.portPolicy.range", range);
  }

  return allow.length > 0
    ? t("servers.portPolicy.allow", { count: allow.length })
    : "";
}

/**
 * 详情 / 节点表单里的完整说明，总是非空：
 * - 无约束：`端口不受限制`；
 * - 范围：`允许端口 30000-31000`；
 * - 额外端口：`允许自定义端口：443、8443`；
 * - 两者：`允许端口 30000-31000；额外允许：443、8443`。
 */
export function portPolicySummary(policy?: PortPolicy | null): string {
  const normalized = normalizePortPolicy(policy);
  if (!normalized.constrained) {
    return t("servers.portPolicy.summaryNone");
  }

  const { start, end, allow } = normalized;
  const ports = allow.join(t("common.listSeparator"));
  const hasValidRange =
    normalized.rangeOrdered && (start !== null || end !== null);

  if (!hasValidRange) {
    return allow.length > 0
      ? t("servers.portPolicy.summaryAllow", { ports })
      : t("servers.portPolicy.summaryNone");
  }

  const range = { start: start ?? PORT_MIN, end: end ?? PORT_MAX };
  return allow.length > 0
    ? t("servers.portPolicy.summaryBoth", { ...range, ports })
    : t("servers.portPolicy.summaryRange", range);
}

/**
 * 表单里「起始 / 结束端口」两个输入 → 提交值。
 *
 * - 两个都留空 = 不限制，返回 `{ start: null, end: null }`；
 * - 只填一边、非纯数字、越界、起始 > 结束都返回 `null`（表单据此报错）；
 * - 提交前无需再做 `parsePortAllow`，额外端口由 tag 输入单独维护。
 */
export function parsePortRangeInput(
  startText: string,
  endText: string,
): { start: number | null; end: number | null } | null {
  const startRaw = startText.trim();
  const endRaw = endText.trim();
  if (startRaw === "" && endRaw === "") {
    return { start: null, end: null };
  }
  if (startRaw === "" || endRaw === "") return null;

  const start = portNumber(startRaw);
  const end = portNumber(endRaw);
  if (start === null || end === null || start > end) return null;
  return { start, end };
}

/**
 * 单个输入框里的「端口范围」→ 提交值。
 *
 * 接受 `30000-31000`、`30000～31000`、`30000~31000`（含两侧空格）。
 * 留空 = 不限制；只写一个端口视为 `n-n`（单端口范围）；其余一律返回 `null`。
 */
export function parsePortRangeText(
  text: string,
): { start: number | null; end: number | null } | null {
  const raw = text.trim();
  if (raw === "") return { start: null, end: null };
  const parts = raw.split(/[-~～—]/).map((part) => part.trim());
  if (parts.length === 1) {
    const port = portNumber(parts[0]);
    return port === null ? null : { start: port, end: port };
  }
  if (parts.length !== 2) return null;
  const start = portNumber(parts[0]);
  const end = portNumber(parts[1]);
  if (start === null || end === null || start > end) return null;
  return { start, end };
}

/** 反向：两个数值 → 输入框里该显示的文本。 */
export function formatPortRangeText(
  start: number | string | null | undefined,
  end: number | string | null | undefined,
): string {
  const from = portNumber(start);
  const to = portNumber(end);
  if (from === null || to === null) return "";
  return from === to ? `${from}` : `${from}-${to}`;
}
