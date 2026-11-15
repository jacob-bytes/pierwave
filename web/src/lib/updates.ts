/**
 * 版本更新检测的前端纯逻辑：版本比较、`hasUpdate`、圆点状态机、相对时间。
 *
 * 单独成文件是为了 `node --test` 能直接跑（不挂 React、不发请求）；
 * 组件只负责把这里的结果画出来。
 */
import { t } from "../i18n/index.ts";
import { formatDate, formatRelativeTime } from "./time.ts";

/** `GET /api/v1/updates` 响应里 master 部分。 */
export interface MasterUpdateView {
  /** 当前 master 版本，例如 `0.11.3`。 */
  current: string;
  /** 最新 Release 版本（不带 `v`）；null = 从未成功检测。 */
  latest: string | null;
  update_available: boolean;
  release_url: string | null;
  /** Release 发布时间（Unix 秒）。 */
  released_at: number | null;
  /** 上次检测时间（Unix 秒）；失败也会更新。 */
  checked_at: number | null;
  /** 失败原因（中英双语）；null = 最近一次成功。 */
  error: string | null;
}

/** 某个 Agent 版本的服务器台数。 */
export interface AgentVersionCount {
  version: string;
  count: number;
}

/** `agents` 部分：完全不依赖外网，来自心跳落库。 */
export interface AgentUpdateView {
  current_protocol: number;
  min_supported: number;
  versions: AgentVersionCount[];
}

export interface UpdatesResponse {
  master: MasterUpdateView;
  agents: AgentUpdateView;
}

/** 侧栏圆点 / 浮层的五种状态。 */
export type UpdateBadgeState =
  | "hidden"
  | "loading"
  | "unknown"
  | "latest"
  | "update"
  | "error";

/** 自动检测间隔的允许范围（小时），与后端白名单一致。 */
export const UPDATE_INTERVAL_MIN_HOURS = 1;
export const UPDATE_INTERVAL_MAX_HOURS = 168;
export const DEFAULT_UPDATE_INTERVAL_HOURS = 6;

/**
 * master 升级命令。
 *
 * 来源：仓库 `scripts/install.sh`（master 分支的一键安装脚本）。
 * 脚本没有默认动作——不带参数只打印 usage 并退出，所以必须显式传
 * `-s -- upgrade`；`upgrade` 子命令会拒绝降级、备份数据库并保留旧二进制。
 */
export const MASTER_UPGRADE_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/jacob-bytes/pierwave/main/scripts/install.sh | sudo bash -s -- upgrade";

/** 输入文本 → 合法检测间隔；空串、非数字或越界都返回 null。 */
export function parseUpdateInterval(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= UPDATE_INTERVAL_MIN_HOURS &&
    value <= UPDATE_INTERVAL_MAX_HOURS
    ? value
    : null;
}

interface ParsedVersion {
  core: number[];
  /** `-rc.1` 里的 `rc.1`；null = 正式版。 */
  pre: string | null;
}

/**
 * 解析版本号；无法解析返回 null。
 *
 * 规则与后端 `pierwave_domain::updates` 保持一致：允许 `v` 前缀，
 * 忽略 `+build` 元数据，`-` 之后是预发布串。
 */
export function parseVersion(raw: string | null | undefined): ParsedVersion | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^[vV]/, "");
  if (!trimmed) return null;
  const withoutBuild = trimmed.split("+")[0] ?? "";
  const dash = withoutBuild.indexOf("-");
  const corePart = dash >= 0 ? withoutBuild.slice(0, dash) : withoutBuild;
  const pre = dash >= 0 ? withoutBuild.slice(dash + 1) || null : null;
  if (!/\d/.test(corePart)) return null;
  const core = corePart.split(".").map((segment) => {
    const match = /^\d+/.exec(segment);
    return match ? Number(match[0]) : 0;
  });
  if (core.length === 0) return null;
  return { core, pre };
}

function comparePreRelease(a: string, b: string): number {
  const left = a.split(".");
  const right = b.split(".");
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const l = left[index];
    const r = right[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const lNumber = /^\d+$/.test(l) ? Number(l) : null;
    const rNumber = /^\d+$/.test(r) ? Number(r) : null;
    if (lNumber !== null && rNumber !== null) {
      if (lNumber !== rNumber) return lNumber > rNumber ? 1 : -1;
      continue;
    }
    // 数字段比字母段小：`rc.1 < rc.beta`。
    if (lNumber !== null) return -1;
    if (rNumber !== null) return 1;
    if (l !== r) return l > r ? 1 : -1;
  }
  return 0;
}

/**
 * 比较两个版本号：`a > b` 返回正数，相等 0，`a < b` 负数。
 *
 * 任一侧无法解析时返回 0（「无法比较」），调用方据此不判定更新。
 */
export function compareVersions(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  const length = Math.max(left.core.length, right.core.length);
  for (let index = 0; index < length; index += 1) {
    const l = left.core[index] ?? 0;
    const r = right.core[index] ?? 0;
    if (l !== r) return l > r ? 1 : -1;
  }
  // 数字核心相同：没有预发布串的正式版更大。
  if (left.pre === null && right.pre === null) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return comparePreRelease(left.pre, right.pre);
}

/** `candidate` 是否比 `current` 新；任一版本非法时返回 false。 */
export function isNewerVersion(
  candidate: string | null | undefined,
  current: string | null | undefined,
): boolean {
  return compareVersions(candidate, current) > 0;
}

/**
 * 最新版本是否构成一次可提示的更新。
 *
 * `latest` 为空或任一版本号非法时返回 false：宁可不提醒，也不给假红点。
 */
export function hasUpdate(
  latest: string | null | undefined,
  current: string | null | undefined,
): boolean {
  if (!latest || !latest.trim()) return false;
  if (!parseVersion(latest) || !parseVersion(current)) return false;
  return isNewerVersion(latest, current);
}

/**
 * 是否展示「升级 master」提示块。
 *
 * 只有确认存在更新时才显示：后端 `update_available` 标记、版本确实更新、
 * 且最近一次检测没有失败（失败时保留的旧「最新版本」不足以给出升级建议）。
 */
export function shouldShowUpgradeHint(
  master: Pick<
    MasterUpdateView,
    "update_available" | "latest" | "current" | "error"
  >,
): boolean {
  if (master.error) return false;
  return Boolean(
    master.update_available && hasUpdate(master.latest, master.current),
  );
}

/** 展示用版本号：统一带 `v` 前缀；空值显示占位符。 */
export function formatVersion(raw: string | null | undefined): string {
  if (!raw) return "—";
  const trimmed = raw.trim();
  if (!trimmed) return "—";
  return /^[vV]/.test(trimmed) ? trimmed : `v${trimmed}`;
}

/** `发布日期` 文案：非 Unix 秒返回 null，交给调用方决定是否展示。 */
export function releaseDateText(releasedAt: number | null | undefined): string | null {
  if (releasedAt === null || releasedAt === undefined) return null;
  const date = formatDate(releasedAt);
  return date === "—" ? null : date;
}

/** 「上次检测」文案：从未检测显示专用文案，其余复用全站相对时间。 */
export function checkedAtText(
  checkedAt: number | null | undefined,
  now = Date.now(),
): string {
  if (checkedAt === null || checkedAt === undefined) {
    return t("updates.neverChecked");
  }
  return formatRelativeTime(checkedAt, now);
}

interface BadgeInput {
  /** 只有管理员才渲染这个入口。 */
  enabled: boolean;
  /** 查询还没拿到任何数据。 */
  pending: boolean;
  /** 查询本身失败（403/404/网络）。 */
  failed: boolean;
  data: UpdatesResponse | null | undefined;
}

/**
 * 圆点 / 浮层状态机。
 *
 * * 非管理员 → hidden（入口整块不渲染）；
 * * 首屏加载 → loading；
 * * 接口失败或最近一次检测失败 → error（圆点消失，浮层给原因）；
 * * 有新版本 → update（显示圆点）；
 * * 已是最新 → latest；
 * * 从未检测过 → unknown（不能谎称「已是最新」）。
 */
export function updateBadgeState(input: BadgeInput): UpdateBadgeState {
  if (!input.enabled) return "hidden";
  if (!input.data) return input.failed ? "error" : "loading";
  const master = input.data.master;
  if (master.error) return "error";
  if (master.checked_at === null || master.checked_at === undefined) {
    return "unknown";
  }
  if (master.update_available && hasUpdate(master.latest, master.current)) {
    return "update";
  }
  return "latest";
}

/** 圆点只在「有新版本」时出现；失败/已最新/加载中都不显示。 */
export function showsUpdateDot(state: UpdateBadgeState): boolean {
  return state === "update";
}

/** 检测失败原因：去掉首尾空白，空串按「没有错误」处理。 */
export function updateErrorText(error: string | null | undefined): string | null {
  const trimmed = error?.trim();
  return trimmed ? trimmed : null;
}

/**
 * 后端错误是「中文 / English」一段双语文本；界面只显示当前语言那一半。
 *
 * 只有一段（没有 ` / ` 分隔）时原样返回——宁可露出原文，也不要吞掉原因。
 */
export function pickBilingual(
  message: string,
  locale: "zh-CN" | "en",
): string {
  const trimmed = message.trim();
  const parts = trimmed.split(" / ");
  if (parts.length < 2) return trimmed;
  return locale === "en" ? parts.slice(1).join(" / ") : parts[0];
}
