/**
 * 探针公开页的纯逻辑：状态点、百分比与可用率色阶。
 *
 * 这里不依赖 React / DOM / i18n，方便用 `node --test` 直接覆盖边界；
 * 页面只负责把返回值映射成 token 与文案。
 */

import type {
  PublicStatusDayBucket,
  PublicStatusSeries,
} from "./api.ts";
import { normalizeGroupName } from "./serverGroups.ts";

/** 卡片右上角的状态：离线优先于「异常」，因为离线时 Xray 字段本就不可信。 */
export type ServerState = "online" | "offline" | "abnormal";

/** 工具栏的状态标签；`all` 是未筛选。 */
export type StatusFilter = "all" | "online" | "offline" | "abnormal";

/**
 * 分组筛选：`null` = 全部节点；[`UNGROUPED_GROUP_KEY`] = 未分组；
 * 其它值是已经归一化过的分组名（非空、去首尾空白）。
 */
export type StatusGroupFilter = string | null;

/** 「未分组」在筛选状态里的键；分组名归一化后不可能为空，所以不冲突。 */
export const UNGROUPED_GROUP_KEY = "";

/** 分组标签行里的一项；`name = null` 是未分组，永远排在最后。 */
export interface StatusGroupTab {
  name: string | null;
  count: number;
}

/** 公开页的两种版式。 */
export type StatusView = "grid" | "list";

/** 视图选择存这个键；与主题、语言一样只属于本页。 */
export const STATUS_VIEW_STORAGE_KEY = "pierwave.status.view";

/** 没有存过、或存的值不认识时的默认版式。 */
export const DEFAULT_STATUS_VIEW: StatusView = "grid";

/**
 * 页头「更新于」的新鲜窗口：2 分钟内算实时，之后数据点转 muted。
 *
 * 轮询本身是 20 秒一次；连续失败时页面仍挂着最后一次数据，时间戳超过
 * 两分钟就不该再被当成「刚刚」——参考实现同样只把新鲜数据画成实心点。
 */
export const STATUS_STALE_SECONDS = 2 * 60;

/**
 * 探针页轮询间隔：20 秒。
 *
 * 页面隐藏时暂停（见 `usePublicStatus`），恢复可见时立即补拉一次；
 * 查询的 staleTime 比它短（15 秒），切回页签时不会拿着旧缓存当权威值。
 */
export const PUBLIC_STATUS_POLL_MS = 20_000;

/**
 * 失败后的退避重试：5s、10s、20s、40s，最高 60s。
 *
 * 正常态仍是 20 秒一次；只有连续失败才指数退避，避免主控短暂故障时
 * 用固定高频轮询持续加压。服务端恢复后第一次成功会把失败计数清零，
 * 间隔自动回到 `PUBLIC_STATUS_POLL_MS`。
 */
export const PUBLIC_STATUS_RETRY_BASE_MS = 5_000;
export const PUBLIC_STATUS_RETRY_MAX_MS = 60_000;

/**
 * 第 `failureCount` 次连续失败之后等多久再试。
 *
 * 计数从 1 开始：1 → 5s、2 → 10s、3 → 20s、4 → 40s、5 及以后 → 60s。
 * 非正数 / 非有限值按第一次失败处理，间隔不会退化成 0 或 NaN。
 */
export function publicStatusRetryDelay(failureCount: number): number {
  const count =
    Number.isFinite(failureCount) && failureCount > 0
      ? Math.floor(failureCount)
      : 1;
  return Math.min(
    PUBLIC_STATUS_RETRY_MAX_MS,
    PUBLIC_STATUS_RETRY_BASE_MS * 2 ** (count - 1),
  );
}

/**
 * 连续失败计数器。React Query 的 `fetchFailureCount` 每次发起请求都会归零，
 * 不能拿来算跨轮询的退避；`errorUpdateCount` 又是累计值，成功后不回落。
 * 这里用成功 / 失败两个单调计数自己维护「当前这串失败」：
 *
 * - `dataUpdateCount` 变了 = 刚成功，连续失败清零；
 * - `errorUpdateCount` 变了 = 刚失败，连续失败加一；
 * - 两个都没变 = 状态没变化，返回原对象，避免无谓重渲染。
 */
export interface PublicStatusFailureStreak {
  dataUpdateCount: number;
  errorUpdateCount: number;
  failures: number;
}

export function nextPublicStatusFailureStreak(
  previous: PublicStatusFailureStreak,
  counts: Pick<
    PublicStatusFailureStreak,
    "dataUpdateCount" | "errorUpdateCount"
  >,
): PublicStatusFailureStreak {
  const succeeded = counts.dataUpdateCount !== previous.dataUpdateCount;
  const failed = counts.errorUpdateCount !== previous.errorUpdateCount;
  if (!succeeded && !failed) return previous;
  return {
    dataUpdateCount: counts.dataUpdateCount,
    errorUpdateCount: counts.errorUpdateCount,
    failures: succeeded ? 0 : previous.failures + 1,
  };
}

/**
 * 公开页内容区的五种状态，判定顺序即优先级：
 *
 * 1. 请求失败：404 是「未开放」，其余（5xx / 网络错误）是「暂时不可用」；
 * 2. 没有数据且请求未结束：首屏骨架；
 * 3. 有数据但节点数为 0：从未接入节点；
 * 4. 有数据且有节点：正常态（筛选后为空由工具栏内部处理，不改变页面状态）。
 *
 * 错误优先于旧数据：轮询失败时页面明确告诉访客「现在拿不到」，
 * 而不是继续把一份可能过期的数据当成当前状态展示。
 */
export type PublicStatusPhase =
  | "loading"
  | "disabled"
  | "error"
  | "empty"
  | "ready";

export interface PublicStatusPhaseInput {
  /** 查询里是否有成功返回过的数据（React Query 的 `data !== undefined`）。 */
  hasData: boolean;
  isError: boolean;
  /** 404（或等价语义）：公开页被管理员关闭。 */
  notFound: boolean;
  /** 成功响应里的节点数；没有数据时传 0 或省略。 */
  serverCount?: number | null;
}

export function publicStatusPhase({
  hasData,
  isError,
  notFound,
  serverCount,
}: PublicStatusPhaseInput): PublicStatusPhase {
  if (isError) return notFound ? "disabled" : "error";
  if (!hasData) return "loading";
  return (serverCount ?? 0) === 0 ? "empty" : "ready";
}

/**
 * 公开页数据是否已过期。
 *
 * `nowMs` 是浏览器时钟（毫秒），`generatedAtSeconds` 是主控下发的时间戳。
 * `nowMs <= 0` 是首帧还没读到时钟，未来时间戳是时钟偏差：两者都不能
 * 判定为过期，否则页面会在首帧或偏差下误报。
 */
export function isStatusStale(
  nowMs: number,
  generatedAtSeconds: number,
): boolean {
  if (nowMs <= 0 || !Number.isFinite(generatedAtSeconds)) return false;
  return nowMs / 1_000 - generatedAtSeconds >= STATUS_STALE_SECONDS;
}

/** 可用率迷你条的色阶；`unknown` 表示该小时没有采样。 */
export type AvailabilityTone = "ok" | "warn" | "down" | "unknown";

export function serverState(server: {
  online: boolean;
  xray_running: boolean | null;
}): ServerState {
  if (!server.online) return "offline";
  return server.xray_running === false ? "abnormal" : "online";
}

/** 状态对应的 i18n key；卡片、列表和汇总共用一份映射。 */
export function statusLabelKey(state: ServerState): string {
  switch (state) {
    case "online":
      return "publicStatus.server.online";
    case "offline":
      return "publicStatus.server.offline";
    case "abnormal":
      return "publicStatus.server.abnormal";
  }
}

/**
 * 卡片副行：`发行版 版本 · 虚拟化 · 架构`。
 *
 * 缺哪项就跳过哪项（空串、null、`virt = none` 都不占位），全缺返回 null，
 * 由调用方决定不渲染这一行 —— 绝不让 `undefined` / `null` 漏进界面。
 *
 * 架构放在最后：它是最短的一段，正常宽度下不会多占一行；OS 名称过长时
 * 由整行的 truncate 收尾，卡片不会被顶成两行。
 */
export function serverSpecLine(server: {
  os_name?: string | null;
  os_version?: string | null;
  virt?: string | null;
  arch?: string | null;
}): string | null {
  const clean = (value: string | null | undefined) =>
    typeof value === "string" ? value.trim() : "";
  const os = [clean(server.os_name), clean(server.os_version)]
    .filter((part) => part.length > 0)
    .join(" ");
  const virt = clean(server.virt);
  const arch = clean(server.arch);
  const parts = [os, virt.toLowerCase() === "none" ? "" : virt, arch].filter(
    (part) => part.length > 0,
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * `null` / 非有限值都是「没有数据」。
 *
 * 三档：`≥99%` 正常（primary）、`95–99%` 可用性下降（warning）、
 * `<95%` 可用性不足（destructive）。之前 96% 与 71% 都落在 warning，
 * 两档看起来一样；95% 把「掉了一点」和「掉了三成」分开。
 */
export function availabilityTone(
  ratio: number | null | undefined,
): AvailabilityTone {
  if (
    ratio === null ||
    ratio === undefined ||
    !Number.isFinite(ratio)
  ) {
    return "unknown";
  }
  if (ratio >= 0.99) return "ok";
  if (ratio >= 0.95) return "warn";
  return "down";
}

/**
 * 可用率进度条的填充长度（0..100）。与色阶同源：
 * 色盲用户即使分不清 amber / destructive，也能从长度看出 96% 与 71% 的差别。
 */
export function availabilityFill(
  ratio: number | null | undefined,
): number {
  const percent = availabilityPercent(ratio);
  return percent === null ? 0 : Math.min(100, Math.max(0, percent));
}

/** 0..1 → 0..100 的整数百分比；没有数据返回 null。 */
export function availabilityPercent(
  ratio: number | null | undefined,
): number | null {
  if (
    ratio === null ||
    ratio === undefined ||
    !Number.isFinite(ratio)
  ) {
    return null;
  }
  return Math.round(Math.min(1, Math.max(0, ratio)) * 100);
}

/**
 * 可用率的展示文本（不含 `%`）：只有精确的 100% 才写 `100`。
 *
 * 99.99% / 99.9% 被整数四舍五入成 `100%` 是把「掉了 0.01%」说成完美，
 * 属于数据错误。这里对小于 100% 的值**截断**到最多 2 位小数（不是四舍五入），
 * 保证 `ratio !== 1` 永远不会打印成 `100`；小于 0.01% 的非零值显示
 * `<0.01`，不写成 `0`。`0%` 仍然返回 `0`（红色档由 tone 决定）。
 */
export function availabilityPercentText(
  ratio: number | null | undefined,
): string | null {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) {
    return null;
  }
  if (ratio >= 1) return "100";
  if (ratio <= 0) return "0";

  const percent = Math.min(1, ratio) * 100;
  // 截断而不是四舍五入：99.9999% 保留 99.99%，不会被说成 100。
  const truncated = Math.floor(percent * 100) / 100;
  if (truncated <= 0) return "<0.01";

  // 最多 2 位小数，去掉末尾的 0：99.90 → 99.9，95.83 保留。
  return truncated
    .toFixed(2)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
}

/**
 * 心跳上报的 RTT（毫秒）。null / undefined / 非有限值 / 负数都视为「没有数据」，
 * 页面据此整项隐藏；0 不特殊处理——后端已保证探测成功至少是 1。
 */
export function reportedLatency(
  latency_ms: number | null | undefined,
): number | null {
  if (
    latency_ms === null ||
    latency_ms === undefined ||
    !Number.isFinite(latency_ms) ||
    latency_ms < 0
  ) {
    return null;
  }
  return Math.round(latency_ms);
}

/**
 * 在线节点的平均延迟（毫秒）。
 *
 * 离线机器的 `latency_ms` 是掉线前最后一次探测的残留，不能算进「当前平均」；
 * 没有上报 / 探测失败 / 脏数据都跳过。没有任何在线节点有读数时返回 null，
 * 英雄区显示 `—`，而不是 `0 ms`。
 */
export function averageLatency(
  servers: readonly {
    online: boolean;
    latency_ms: number | null | undefined;
  }[],
): number | null {
  let total = 0;
  let sampled = 0;

  for (const server of servers) {
    if (!server.online) continue;
    const latency = server.latency_ms;
    if (
      latency === null ||
      latency === undefined ||
      !Number.isFinite(latency) ||
      latency < 0
    ) {
      continue;
    }
    total += latency;
    sampled += 1;
  }

  return sampled === 0 ? null : Math.round(total / sampled);
}

/** 24 个桶里至少有一个采样，才画迷你条；全是 null 时整条显示空态。 */
export function hasSamples(
  buckets: readonly (unknown | null | undefined)[],
): boolean {
  return buckets.some((bucket) => bucket !== null && bucket !== undefined);
}

/** 精确到分钟的 24h 中断时长拆成小时 / 分钟，供 ② 的指标格使用。 */
export interface OutageMinutesParts {
  hours: number;
  minutes: number;
}

/**
 * `outage_minutes_24h` → `{ hours, minutes }`。
 *
 * `null` / `undefined` / 负数 / 非有限值是「后端没给这个精确值」，返回
 * `null`，由 UI 显示 `—`；**不能落到 0 分钟**。真实的 0 是有效数据，
 * 显示「0 分钟」，与「不知道」严格区分。小数分钟向下取整。
 */
export function outageMinutesParts(
  minutes: number | null | undefined,
): OutageMinutesParts | null {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) {
    return null;
  }
  const whole = Math.floor(minutes);
  return { hours: Math.floor(whole / 60), minutes: whole % 60 };
}

/**
 * 服务年龄（整天）：`first_seen_at` 是 Unix 秒，`nowMs` 是浏览器毫秒时钟。
 *
 * 与 `uptime_secs` 不同，这个值不会因为重启归零。未来时间戳按 0 天处理
 * （时钟偏差不该显示「−3 天」）；缺失 / 非法值为 `null`，UI 整项隐藏。
 */
export function serviceAgeDays(
  firstSeenAt: number | null | undefined,
  nowMs: number,
): number | null {
  if (
    typeof firstSeenAt !== "number" ||
    !Number.isFinite(firstSeenAt) ||
    firstSeenAt <= 0 ||
    !Number.isFinite(nowMs) ||
    nowMs <= 0
  ) {
    return null;
  }
  const elapsed = nowMs / 1_000 - firstSeenAt;
  return Math.max(0, Math.floor(elapsed / 86_400));
}

export interface ServiceAgeText {
  key: string;
  values?: Record<string, number>;
}

/** ① 头部的「已运行 45 天」；不足一天时换一条不写 0 的文案。 */
export function serviceAgeLabel(
  firstSeenAt: number | null | undefined,
  nowMs: number,
): ServiceAgeText | null {
  const days = serviceAgeDays(firstSeenAt, nowMs);
  if (days === null) return null;
  if (days === 1) return { key: "publicStatus.detail.runningOneDay" };
  return days > 1
    ? {
        key: "publicStatus.detail.runningDays",
        values: { days },
      }
    : { key: "publicStatus.detail.runningJustStarted" };
}

/** ② 的 7 天日条固定 7 格。 */
export const WEEK_DAYS = 7;

export interface DayAvailability {
  /** `YYYY-MM-DD`；该格没有日期时为 null。 */
  day: string | null;
  /** 0..1；该日没有采样时为 null（画斜线，不画 0%）。 */
  ratio: number | null;
  /** 采样数；缺失或非法为 null。 */
  samples: number | null;
}

/**
 * `buckets_7d` → 固定 7 格（旧 → 新）。
 *
 * - 字段整个缺失（旧后端）或数组为空 → `null`，调用方整条隐藏；
 * - 数组里的 `null` 日、非法比例都保留为空格，画斜线，不当成 0%；
 * - 少于 7 天时向更早补 null，最新一天仍在最右；
 * - 多于 7 天只取最后 7 天，日条永远不横向溢出。
 */
export function weekAvailability(
  buckets:
    | readonly (PublicStatusDayBucket | null | undefined)[]
    | null
    | undefined,
): DayAvailability[] | null {
  if (!Array.isArray(buckets) || buckets.length === 0) return null;
  const recent = buckets.slice(-WEEK_DAYS);
  const padding = WEEK_DAYS - recent.length;
  return Array.from({ length: WEEK_DAYS }, (_, index) => {
    if (index < padding) {
      return { day: null, ratio: null, samples: null };
    }
    const raw = recent[index - padding];
    if (!raw) return { day: null, ratio: null, samples: null };
    const day =
      typeof raw.day === "string" && raw.day.trim().length > 0
        ? raw.day.trim()
        : null;
    const ratio =
      typeof raw.online_ratio === "number" &&
      Number.isFinite(raw.online_ratio)
        ? Math.min(1, Math.max(0, raw.online_ratio))
        : null;
    const samples =
      typeof raw.samples === "number" &&
      Number.isFinite(raw.samples) &&
      raw.samples >= 0
        ? Math.floor(raw.samples)
        : null;
    return { day, ratio, samples };
  });
}

export interface LatencyTrend {
  min: number;
  max: number;
  avg: number;
  samples: number;
}

/**
 * `series_24h.latency_ms` 的 24 点摘要，供 ③ 的一行「延迟趋势」小字。
 *
 * null / 负数 / 非有限值跳过（探测失败不是 0 ms）；有效点不足一个时返回
 * `null`，整行隐藏。只展示 min–max，不把这一行做成第二张图。
 */
export function latencyTrend(
  series: Pick<PublicStatusSeries, "latency_ms"> | null | undefined,
): LatencyTrend | null {
  const values = Array.isArray(series?.latency_ms)
    ? series.latency_ms
    : [];
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let total = 0;
  let samples = 0;

  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      continue;
    }
    min = Math.min(min, value);
    max = Math.max(max, value);
    total += value;
    samples += 1;
  }

  if (samples === 0) return null;
  return {
    min: Math.round(min),
    max: Math.round(max),
    avg: Math.round(total / samples),
    samples,
  };
}

/**
 * `inbound_count`：只接受非负有限数，向下取整；缺失 / 脏数据为 null。
 * 0 是有效值（「承载 0 个入站」），不能当成未知。
 */
export function inboundCount(
  value: number | null | undefined,
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
}

/**
 * 已用 / 总量 → 0..100；任一为 null、总量非正数或非有限值时返回 null。
 * 结果夹在 0..100，避免脏数据把进度条画到卡片外。
 */
export function resourcePercent(
  used: number | null | undefined,
  total: number | null | undefined,
): number | null {
  if (
    used === null ||
    used === undefined ||
    total === null ||
    total === undefined ||
    !Number.isFinite(used) ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return null;
  }
  return Math.min(100, Math.max(0, (used / total) * 100));
}

/** 一段节点数据里够用来判断状态的字段。 */
type StatusFields = { online: boolean; xray_running: boolean | null };

/**
 * 运行时长拆成天 / 时 / 分，供卡片的状态 pill 显示「141 天 1 小时」。
 *
 * 不足一分钟按 0 分钟算：向上取整会让刚启动的机器写成「1 分钟」，
 * 与下一次刷新前的真实值对不上。负数、NaN 与无穷大都是没有数据。
 */
export type UptimeParts = { days: number; hours: number; minutes: number };

export function uptimeParts(
  seconds: number | null | undefined,
): UptimeParts | null {
  if (
    seconds === null ||
    seconds === undefined ||
    !Number.isFinite(seconds) ||
    seconds < 0
  ) {
    return null;
  }
  const totalMinutes = Math.floor(seconds / 60);
  return {
    days: Math.floor(totalMinutes / (60 * 24)),
    hours: Math.floor((totalMinutes % (60 * 24)) / 60),
    minutes: totalMinutes % 60,
  };
}

/**
 * 运行时长该用哪条文案：只显示到有意义的最高一级，但保留次一级。
 * 「141 天 1 小时」不会写成「141 天 0 小时」，「5 小时 0 分钟」也不会。
 */
export function uptimeLabelKey(parts: UptimeParts): string {
  if (parts.days > 0) {
    return parts.hours > 0
      ? "publicStatus.server.uptimeDaysHours"
      : "publicStatus.server.uptimeDays";
  }
  if (parts.hours > 0) {
    return parts.minutes > 0
      ? "publicStatus.server.uptimeHoursMinutes"
      : "publicStatus.server.uptimeHours";
  }
  if (parts.minutes > 0) return "publicStatus.server.uptimeMinutes";
  return "publicStatus.server.uptimeJustNow";
}

/**
 * 汇总卡里的「最忙节点」：在线且上报过 `load1` 的节点里取最大的一台。
 *
 * 离线机器的负载是掉线前的残留，不参与评选；`load1` 为 null 或非有限值时
 * 同理。并列时保留列表里先出现的一台，避免刷新时名字来回跳。
 */
export function busiestServer<
  T extends { online: boolean; load1: number | null },
>(servers: readonly T[]): T | null {
  let top: T | null = null;
  let topLoad = Number.NEGATIVE_INFINITY;

  for (const server of servers) {
    if (!server.online) continue;
    const load = server.load1;
    if (load === null || !Number.isFinite(load)) continue;
    if (top === null || load > topLoad) {
      top = server;
      topLoad = load;
    }
  }

  return top;
}

/**
 * 所有节点 24 小时可用率的均值；没有一台有采样时返回 null。
 *
 * 没有采样的节点不进分母 —— 把「没数据」当成 0% 会把均值拉垮；
 * 越界的比例先夹到 0..1，脏数据不会让汇总出现 120%。
 */
export function averageUptime24h(
  servers: readonly { uptime_24h: number | null }[],
): number | null {
  let total = 0;
  let sampled = 0;

  for (const server of servers) {
    const ratio = server.uptime_24h;
    if (ratio === null || !Number.isFinite(ratio)) continue;
    total += Math.min(1, Math.max(0, ratio));
    sampled += 1;
  }

  return sampled === 0 ? null : total / sampled;
}

/**
 * 顶部结论的四种形态。`lowAvailability` 是叠加在任一形态上的补充信息，
 * 单独计数，不改变「有没有在线机器」这个主判断。
 */
export type StatusHeadlineKind =
  | "empty"
  | "all-offline"
  | "all-online"
  | "partial";

export interface StatusHeadline {
  kind: StatusHeadlineKind;
  total: number;
  online: number;
  offline: number;
  /** 24h 可用率有采样且低于 95% 的台数。 */
  lowAvailability: number;
}

/**
 * 公开页顶部的一句话结论。
 *
 * 优先级：没有节点 → 全部离线 → 全部在线 → 部分离线。
 * `online` 以心跳为准，和卡片一致：Agent 在线但 Xray 没跑仍算在线，
 * 那是「异常」，不是「离线」。可用率只统计有采样的机器 —— 没数据
 * 不等于 0%，也不该被算成「可用率偏低」。
 */
export function statusHeadline(
  servers: readonly { online: boolean; uptime_24h: number | null }[],
): StatusHeadline {
  let online = 0;
  let lowAvailability = 0;

  for (const server of servers) {
    if (server.online) online += 1;
    const ratio = server.uptime_24h;
    if (
      ratio !== null &&
      ratio !== undefined &&
      Number.isFinite(ratio) &&
      ratio < 0.95
    ) {
      lowAvailability += 1;
    }
  }

  const total = servers.length;
  const kind: StatusHeadlineKind =
    total === 0
      ? "empty"
      : online === 0
        ? "all-offline"
        : online === total
          ? "all-online"
          : "partial";

  return { kind, total, online, offline: total - online, lowAvailability };
}

/** 结论对应的 i18n 键与插值；组件不自己拼句子，标点留给翻译层。 */
export interface HeadlineText {
  key: string;
  values?: Record<string, number>;
}

export function statusHeadlineKey(headline: StatusHeadline): HeadlineText {
  const { kind, total, online, offline, lowAvailability: low } = headline;

  if (kind === "empty") return { key: "publicStatus.summary.noServers" };

  if (kind === "all-offline") {
    return low > 0
      ? { key: "publicStatus.hero.allOfflineLow", values: { low } }
      : { key: "publicStatus.hero.allOffline" };
  }

  if (kind === "all-online") {
    return low > 0
      ? { key: "publicStatus.hero.allOnlineLow", values: { total, low } }
      : { key: "publicStatus.hero.allOnline", values: { total } };
  }

  return low > 0
    ? {
        key: "publicStatus.hero.partialLow",
        values: { total, online, offline, low },
      }
    : {
        key: "publicStatus.hero.partial",
        values: { total, online, offline },
      };
}

/**
 * 所有在线节点的当前速率合计（`net_rx_bps + net_tx_bps`，字节/秒）。
 *
 * 离线机器保留的是掉线前最后一次读数，不能算进「当前」；某一方向缺数据时
 * 只加另一方向。没有任何在线机器给出有效读数时返回 `null`，页面显示 `—`，
 * 与 `0 B/s` 区分开：0 是「确实没有流量」，null 是「不知道」。
 */
export function totalOnlineRate(
  servers: readonly {
    online: boolean;
    net_rx_bps?: number | null;
    net_tx_bps?: number | null;
  }[],
): number | null {
  const rate = onlineRateByDirection(servers);
  if (rate === null) return null;
  if (rate.rx === null) return rate.tx;
  if (rate.tx === null) return rate.rx;
  return rate.rx + rate.tx;
}

/** 上下行各自的合计（字节/秒）；某方向没有任何有效读数时为 null。 */
export interface OnlineRate {
  rx: number | null;
  tx: number | null;
}

/**
 * 所有在线节点的上下行速率**分别**求和，供英雄区拆成 `↓ … ↑ …` 两个数字。
 *
 * 口径与 `totalOnlineRate` 相同：离线机器的读数是掉线前的残留，不参与；
 * 脏数据（NaN / 负数 / 非有限值）跳过；真实测到的 0 是有效值。
 * 只有一个方向有数据时，另一边返回 null（页面显示 `—`），不拿 0 冒充。
 * 两个方向都没有数据时返回 null，整组显示一个 `—`。
 */
export function onlineRateByDirection(
  servers: readonly {
    online: boolean;
    net_rx_bps?: number | null;
    net_tx_bps?: number | null;
  }[],
): OnlineRate | null {
  let rx = 0;
  let tx = 0;
  let rxSampled = false;
  let txSampled = false;

  for (const server of servers) {
    if (!server.online) continue;

    const down = server.net_rx_bps;
    if (down !== null && down !== undefined && Number.isFinite(down) && down >= 0) {
      rx += down;
      rxSampled = true;
    }

    const up = server.net_tx_bps;
    if (up !== null && up !== undefined && Number.isFinite(up) && up >= 0) {
      tx += up;
      txSampled = true;
    }
  }

  if (!rxSampled && !txSampled) return null;
  return {
    rx: rxSampled ? rx : null,
    tx: txSampled ? tx : null,
  };
}

/** 状态标签与一个节点是否匹配；`all` 永远匹配。 */
export function matchesStatusFilter(
  server: StatusFields,
  filter: StatusFilter,
): boolean {
  return filter === "all" || serverState(server) === filter;
}

/**
 * 搜索只按名称做子串匹配，大小写与首尾空格都不敏感。
 * 空查询（或只有空格）匹配全部，避免搜索框里一个空格就把整页清空。
 */
export function matchesServerQuery(
  server: { name: string },
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  return needle === "" || server.name.toLowerCase().includes(needle);
}

/**
 * 从节点列表派生分组标签。
 *
 * - 只有至少一个**具名分组**时才返回标签；全部未分组返回空数组，
 *   页面据此不渲染整行（一个「全部节点 / 未分组」的切换没有意义）。
 * - 具名分组按名称升序，未分组固定最后，与 `groupServers` 一致。
 * - 计数是该组节点数，不是在线数；同一列表里的空白差异会合并。
 */
export function statusGroupTabs(
  servers: readonly { group_name?: string | null }[],
): StatusGroupTab[] {
  const named = new Map<string, number>();
  let ungrouped = 0;

  for (const server of servers) {
    const name = normalizeGroupName(server.group_name);
    if (name === null) {
      ungrouped += 1;
    } else {
      named.set(name, (named.get(name) ?? 0) + 1);
    }
  }

  if (named.size === 0) return [];

  const tabs: StatusGroupTab[] = [...named.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, count]) => ({ name, count }));
  if (ungrouped > 0) tabs.push({ name: null, count: ungrouped });
  return tabs;
}

/** 一个节点是否落在选中的分组里；`null`（全部）永远匹配。 */
export function matchesGroupFilter(
  server: { group_name?: string | null },
  group: StatusGroupFilter,
): boolean {
  if (group === null) return true;
  const name = normalizeGroupName(server.group_name) ?? UNGROUPED_GROUP_KEY;
  return name === group;
}

/** 先按搜索、再按状态标签过滤；两个条件互不知道对方。 */
export function filterPublicServers<
  T extends StatusFields & { name: string; group_name?: string | null },
>(
  servers: readonly T[],
  filter: StatusFilter,
  query: string,
  group: StatusGroupFilter = null,
): T[] {
  return servers.filter(
    (server) =>
      matchesServerQuery(server, query) &&
      matchesStatusFilter(server, filter) &&
      matchesGroupFilter(server, group),
  );
}

/**
 * 每个状态标签下的数量。搜索时由调用方传入已经按关键字筛过的列表，
 * 让标签上的数字与点下去看到的结果一致。
 */
export function publicServerCounts(
  servers: readonly StatusFields[],
): Record<StatusFilter, number> {
  const counts: Record<StatusFilter, number> = {
    all: servers.length,
    online: 0,
    offline: 0,
    abnormal: 0,
  };
  for (const server of servers) counts[serverState(server)] += 1;
  return counts;
}

/** 只认 grid / list；其它任何值（含 null）都不是合法选择。 */
export function parseStatusView(
  value: string | null | undefined,
): StatusView | null {
  return value === "grid" || value === "list" ? value : null;
}

/**
 * 从 localStorage 读视图。隐私模式或存储被禁用时读取会抛错，
 * 这里静默回落到默认值，页面永远能画出来。
 */
export function loadStatusView(
  storage: { getItem(key: string): string | null } | null | undefined,
): StatusView {
  try {
    return (
      parseStatusView(storage?.getItem(STATUS_VIEW_STORAGE_KEY)) ??
      DEFAULT_STATUS_VIEW
    );
  } catch {
    return DEFAULT_STATUS_VIEW;
  }
}

/** 写入视图选择；写失败不阻断切换（只是下次打开回到默认）。 */
export function persistStatusView(
  storage: { setItem(key: string, value: string): void } | null | undefined,
  view: StatusView,
): void {
  try {
    storage?.setItem(STATUS_VIEW_STORAGE_KEY, view);
  } catch {
    // ignore storage access errors
  }
}

/**
 * 公开状态页新增的账期字段（由后端另一条 lane 提供）。
 *
 * 旧后端不返回整组字段，所以四个都可选；前端必须容忍 undefined。
 * 缺哪项就由渲染层把那项显示成「未配置」，第三列永远保留占位。
 */
export interface PublicBillingFields {
  /** 到期日，`YYYY-MM-DD`（UTC+8 业务日）。 */
  paid_until?: string | null;
  /** 价格，单位「分」。 */
  price_cents?: number | null;
  /** 币种代码，如 `CNY` / `USD` / `EUR` / `JPY`。 */
  currency?: string | null;
  /** 计费周期：`monthly` / `yearly` / `once`。 */
  billing_cycle?: string | null;
  /** 计费周期数量（1–1200）；旧后端 / 旧数据缺失。 */
  billing_cycle_count?: number | null;
  /** 计费周期单位：`month` / `year` / `once`；与数量成对。 */
  billing_cycle_unit?: string | null;
}

/**
 * 卡片底部「到期与价格」一组的渲染数据。
 *
 * 四项各自独立：缺哪项就哪项是 null，由卡片显示「未配置」。现在不再整组
 * 消失 —— 第三列要一直占位，否则三列网格会塌成两列、左右对不齐。
 */
export interface PublicBilling {
  /** 规范化后的到期日 `YYYY-MM-DD`；缺失或非法为 null。 */
  paidUntil: string | null;
  /** 距今 UTC+8 业务日：`> 0` 未来、`0` 今天、`< 0` 已过期；无日期为 null。 */
  days: number | null;
  /** 含币种符号的价格，如 `¥268.00`；价格或币种缺失 / 非法为 null。 */
  price: string | null;
  /** 计费周期的 i18n key，如 `publicStatus.server.cycle.monthly`；缺失为 null。 */
  cycleKey: string | null;
}

const UTC8_OFFSET_MS = 8 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

/** 已知币种才画符号；其它（含未来新增）一律显示代码，不猜符号。 */
const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: "¥",
  USD: "$",
  EUR: "€",
};

/** 币种代码归一化：去空白、转大写；空串 / 非字符串是「没有数据」。 */
export function normalizeCurrency(
  currency: string | null | undefined,
): string | null {
  if (typeof currency !== "string") return null;
  const code = currency.trim().toUpperCase();
  return code.length > 0 ? code : null;
}

/** 分 → `268.00`，带千分位；无效价格返回 null。 */
export function formatPriceCents(
  priceCents: number | null | undefined,
): string | null {
  if (
    priceCents === null ||
    priceCents === undefined ||
    !Number.isFinite(priceCents) ||
    priceCents < 0
  ) {
    return null;
  }
  const [whole, fraction] = (priceCents / 100).toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${grouped}.${fraction}`;
}

/**
 * 价格 + 币种：`¥268.00`、`$12.00`、`€9.90`；未知币种显示代码 `JPY 268.00`。
 * 价格或币种任一无效都返回 null（整组隐藏），不拼出只有半截的文案。
 */
export function formatPrice(
  priceCents: number | null | undefined,
  currency: string | null | undefined,
): string | null {
  const amount = formatPriceCents(priceCents);
  const code = normalizeCurrency(currency);
  if (amount === null || code === null) return null;
  const symbol = CURRENCY_SYMBOLS[code];
  return symbol ? `${symbol}${amount}` : `${code} ${amount}`;
}

/** `YYYY-MM-DD` → UTC+8 业务日的序号；非法日期（含 2 月 30 日）返回 null。 */
function parsedDayIndex(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.floor(date.getTime() / DAY_MS);
}

/** 浏览器时钟 → UTC+8 业务日序号；与 `parsedDayIndex` 同一把尺子。 */
function todayDayIndex(nowMs: number): number {
  return Math.floor((nowMs + UTC8_OFFSET_MS) / DAY_MS);
}

/**
 * 距到期还有几天（UTC+8 业务日）：未来为正、今天为 0、已过期为负。
 *
 * 到期、重置、日账本都按 UTC+8 计算（见 `lib/time.ts`），探针页沿用同一
 * 口径：东京和伦敦的管理员看到的是同一个日期，不会被浏览器时区改掉一天。
 * 日期缺失 / 格式非法时返回 null，调用方整组隐藏。
 */
export function expiryDays(
  paidUntil: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (typeof paidUntil !== "string") return null;
  const deadline = parsedDayIndex(paidUntil);
  if (deadline === null) return null;
  return deadline - todayDayIndex(nowMs);
}

/** 到期文案：`{days} 天后到期` / `明天到期` / `今天到期` / `已过期`。 */
export interface BillingText {
  key: string;
  values?: Record<string, number>;
}

export function expiryLabel(days: number): BillingText {
  if (days < 0) return { key: "publicStatus.server.expired" };
  if (days === 0) return { key: "publicStatus.server.expiresToday" };
  // 只有一天时英文的 `1 days left` 是错的，单独给一条文案。
  if (days === 1) return { key: "publicStatus.server.expiresTomorrow" };
  return {
    key: "publicStatus.server.expiresInDays",
    values: { days },
  };
}

/** 计费周期 → 文案 key；未知值返回 null（整组隐藏）。 */
export function billingCycleKey(
  cycle: string | null | undefined,
): string | null {
  if (typeof cycle !== "string") return null;
  const value = cycle.trim().toLowerCase();
  if (value === "monthly") return "publicStatus.server.cycle.monthly";
  if (value === "yearly") return "publicStatus.server.cycle.yearly";
  if (value === "once") return "publicStatus.server.cycle.once";
  return null;
}

/** 公开页的计费周期展示数据（数量 + 单位）。 */
export interface PublicBillingCycle {
  /** 规范化后的单位。 */
  unit: "month" | "year" | "once";
  /** 数量；`once` 固定 1。 */
  count: number;
  /** 独立文案 key：`1 个月` / `3 个月` / `2 年` / `一次性`。 */
  labelKey: string;
  labelValues?: Record<string, number>;
  /** 价格行 `/` 后的后缀 key：数量为 1 时省略数字（`月` / `年` / `一次性`）。 */
  suffixKey: string;
  suffixValues?: Record<string, number>;
  /** 一个周期折算的天数（月按 30、年按 365）；`once` 为 null。 */
  days: number | null;
}

const CYCLE_UNIT_DAYS = { month: 30, year: 365 } as const;

function cycleTextFor(
  unit: "month" | "year" | "once",
  count: number,
): PublicBillingCycle {
  if (unit === "once") {
    return {
      unit,
      count: 1,
      labelKey: "publicStatus.server.cycle.once",
      suffixKey: "publicStatus.server.cycle.once",
      days: null,
    };
  }
  const values = { count };
  if (count === 1) {
    return {
      unit,
      count,
      labelKey:
        unit === "month"
          ? "publicStatus.server.cycle.monthOne"
          : "publicStatus.server.cycle.yearOne",
      suffixKey:
        unit === "month"
          ? "publicStatus.server.cycle.monthly"
          : "publicStatus.server.cycle.yearly",
      days: CYCLE_UNIT_DAYS[unit],
    };
  }
  return {
    unit,
    count,
    labelKey:
      unit === "month"
        ? "publicStatus.server.cycle.months"
        : "publicStatus.server.cycle.years",
    labelValues: values,
    suffixKey:
      unit === "month"
        ? "publicStatus.server.cycle.months"
        : "publicStatus.server.cycle.years",
    suffixValues: values,
    days: CYCLE_UNIT_DAYS[unit] * count,
  };
}

/** 新契约的周期单位；非法 / 缺失返回 null。 */
function normalizedCycleUnit(
  unit: string | null | undefined,
): "month" | "year" | "once" | null {
  if (typeof unit !== "string") return null;
  const value = unit.trim().toLowerCase();
  return value === "month" || value === "year" || value === "once"
    ? value
    : null;
}

/**
 * 卡片与详情页的计费周期文案。
 *
 * 新契约优先：`billing_cycle_count` + `billing_cycle_unit` 同时合法才用；
 * 缺一半、脏值或旧后端没有这两个字段时回落到 `billing_cycle`
 * （`monthly → 1 个月`、`yearly → 1 年`、`once → 一次性`）。
 * 两者都没有返回 null，由调用方显示「未配置」。
 *
 * 展示分两种：独立文案带数量（`1 个月`），价格后缀在数量为 1 时省略
 * （`¥268.00 / 月`）—— 与截图里「1 个月」和「/ 月」并存一致。
 */
export function billingCycleText(
  fields: PublicBillingFields,
): PublicBillingCycle | null {
  const unit = normalizedCycleUnit(fields.billing_cycle_unit);
  const rawCount = fields.billing_cycle_count;
  const count =
    typeof rawCount === "number" &&
    Number.isInteger(rawCount) &&
    rawCount >= 1 &&
    rawCount <= 1200
      ? rawCount
      : null;

  if (unit === "once") return cycleTextFor("once", 1);
  if (unit !== null && count !== null) return cycleTextFor(unit, count);

  // 回落到旧派生字段；旧值只承载「一个周期」，数量按 1 处理。
  const legacy = billingCycleKey(fields.billing_cycle);
  if (legacy === "publicStatus.server.cycle.monthly") {
    return cycleTextFor("month", 1);
  }
  if (legacy === "publicStatus.server.cycle.yearly") {
    return cycleTextFor("year", 1);
  }
  if (legacy === "publicStatus.server.cycle.once") {
    return cycleTextFor("once", 1);
  }
  return null;
}

/**
 * 卡片第三组「到期与价格」的数据。
 *
 * 四项独立解析，任何一项缺失或非法只让那一项为 null；返回对象永远非 null，
 * 调用方据此保留第三列，并在对应行显示「未配置」。
 */
export function publicBilling(
  fields: PublicBillingFields,
  nowMs: number = Date.now(),
): PublicBilling {
  const rawPaidUntil =
    typeof fields.paid_until === "string" ? fields.paid_until.trim() : "";
  const days = expiryDays(rawPaidUntil, nowMs);
  return {
    paidUntil: days === null ? null : rawPaidUntil,
    days,
    price: formatPrice(fields.price_cents, fields.currency),
    cycleKey: billingCycleKey(fields.billing_cycle),
  };
}

/** 详情页路径里的服务器 id；不是 `/status/:id` 时返回 null。 */
export function publicStatusServerId(pathname: string): string | null {
  const match = /^\/status\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]);
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * 公开状态页的路径：`/status`、`/status/` 与 `/status/:id` 都在 `useMe`
 * 之前放行；`/status/xxx/nodes` 这种多段路径仍走登录守卫。
 */
export function isPublicStatusPath(pathname: string): boolean {
  return (
    pathname === "/status" ||
    pathname === "/status/" ||
    publicStatusServerId(pathname) !== null
  );
}

/** 24 小时桶里可用率最低的一段；没有采样时返回 null。 */
export interface LowestAvailabilityBucket {
  ts: number;
  /** 0..1 */
  ratio: number;
}

/**
 * 找 `buckets_24h` 里最低的一段（并列取更早的一段），供详情页脚注
 * 「最低时段 03:00–04:00 · 91%」使用。null / 非有限值 / 负值都跳过。
 */
export function lowestAvailabilityBucket(
  buckets:
    | readonly ({ ts: number; online_ratio: number } | null)[]
    | null
    | undefined,
): LowestAvailabilityBucket | null {
  if (!Array.isArray(buckets)) return null;
  let lowest: LowestAvailabilityBucket | null = null;

  for (const bucket of buckets) {
    if (!bucket) continue;
    const raw = bucket.online_ratio;
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    const ratio = Math.min(1, Math.max(0, raw));
    if (lowest === null || ratio < lowest.ratio) {
      lowest = { ts: bucket.ts, ratio };
    }
  }

  return lowest;
}

/** 24h 可用率的逐小时明细；全部由 `buckets_24h` 在前端推导。 */
export interface AvailabilityHour {
  ts: number;
  /** 0..1 */
  ratio: number;
}

export interface AvailabilitySummary {
  /** 期望的小时数（固定 24，但保留参数便于测试）。 */
  total: number;
  /** 有采样的桶数。 */
  sampled: number;
  /** sampled / total；无采样时为 null（避免把“不知道”当成 0）。 */
  coverageRatio: number | null;
  /** 连续 0% 段数；无采样时为 null（不能显示 0 次中断）。 */
  outageCount: number | null;
  /** 0% 桶数 = 按小时计的累计中断时长；无采样时为 null。 */
  outageHours: number | null;
  /** 最低的已采样小时（并列取更早）；无采样时为 null。 */
  lowest: AvailabilityHour | null;
  /** 最高的已采样小时（并列取更早）；无采样时为 null。 */
  highest: AvailabilityHour | null;
  /** 最长连续正常小时数（正常 = ≥99%）；无采样时为 null。 */
  longestNormalHours: number | null;
  /** 连续 0% 时段（最多保留全部，UI 取前 2）；无采样时为 null。 */
  outagePeriods: AvailabilityPeriod[] | null;
}

export interface AvailabilityPeriod {
  startTs: number;
  /** 结束小时起点 + 1h，便于 formatHourRange 直接展示。 */
  endTs: number;
  hours: number;
}

/**
 * 从 24 个公开小时桶推导详情页的可用性明细。
 *
 * 规则：
 * - `online_ratio === 0` 才是中断小时；null 不是 0，也会打断连续段；
 * - 连续 0 小时算一段，段数 = 中断次数；
 * - 累计中断时长 = 0 桶数 × 1 小时（公开 API 只有小时粒度，实际中断
 *   可能更短，UI 会注明）；
 * - 覆盖度 = 非 null 桶数 / total；
 * - 最低/最高只比较有采样的小时，并列取更早的一段；
 * - 没有任何采样时，段数、时长、覆盖度、最低/最高全部为 null，让 UI
 *   显示 `—`，而不是伪造 0。
 */
export function summarizeAvailability(
  buckets:
    | readonly ({ ts: number; online_ratio: number } | null)[]
    | null
    | undefined,
  total = 24,
): AvailabilitySummary {
  const hours = Math.max(0, Math.floor(total));
  const list = Array.isArray(buckets) ? buckets : [];
  let sampled = 0;
  let zeroHours = 0;
  let outageCount = 0;
  let previousZero = false;
  let normalRun = 0;
  let longestNormal = 0;
  let currentOutageStart: number | null = null;
  let currentOutageLast: number | null = null;
  let currentOutageHours = 0;
  const outagePeriods: AvailabilityPeriod[] = [];
  let lowest: AvailabilityHour | null = null;
  let highest: AvailabilityHour | null = null;

  const closeOutage = () => {
    if (currentOutageStart !== null && currentOutageLast !== null) {
      outagePeriods.push({
        startTs: currentOutageStart,
        endTs: currentOutageLast + 3_600,
        hours: currentOutageHours,
      });
    }
    currentOutageStart = null;
    currentOutageLast = null;
    currentOutageHours = 0;
  };

  for (let index = 0; index < hours; index += 1) {
    const bucket = list[index] ?? null;
    const raw = bucket?.online_ratio;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      // 缺失 / 非法值不是 0，且会打断“连续中断”和连续正常。
      closeOutage();
      previousZero = false;
      normalRun = 0;
      continue;
    }
    const ratio = Math.min(1, Math.max(0, raw));
    sampled += 1;
    if (ratio >= 0.99) {
      normalRun += 1;
      longestNormal = Math.max(longestNormal, normalRun);
    } else {
      normalRun = 0;
    }
    if (ratio === 0) {
      zeroHours += 1;
      if (!previousZero) {
        outageCount += 1;
        currentOutageStart = bucket.ts;
      }
      currentOutageLast = bucket.ts;
      currentOutageHours += 1;
      previousZero = true;
    } else {
      closeOutage();
      previousZero = false;
    }
    if (lowest === null || ratio < lowest.ratio) {
      lowest = { ts: bucket.ts, ratio };
    }
    if (highest === null || ratio > highest.ratio) {
      highest = { ts: bucket.ts, ratio };
    }
  }
  closeOutage();

  return {
    total: hours,
    sampled,
    coverageRatio: sampled === 0 ? null : sampled / hours,
    outageCount: sampled === 0 ? null : outageCount,
    outageHours: sampled === 0 ? null : zeroHours,
    lowest,
    highest,
    longestNormalHours: sampled === 0 ? null : longestNormal,
    outagePeriods: sampled === 0 ? null : outagePeriods,
  };
}

/** 结论式摘要只依赖这三个字段，便于单测直接构造。 */
export type AvailabilityConclusionInput = Pick<
  AvailabilitySummary,
  "sampled" | "outageCount" | "outageHours"
>;

export interface AvailabilityConclusion {
  key: string;
  values?: Record<string, number>;
}

function outageConclusionKey(base: string, count: number): string {
  return `publicStatus.detail.summary.${base}${count === 1 ? "One" : ""}`;
}

/**
 * ② 卡顶部的一句话结论。**不新增接口**，只把已有的 24h 桶与
 * `outage_minutes_24h` 翻译成访客能直接读懂的一句话：
 *
 * - 无采样 → 「过去 24 小时暂无采样」；
 * - 有采样、0 次中断 → 「过去 24 小时持续在线，无中断」；
 * - 有中断 → 次数 + 累计时长（精确分钟优先，缺失时回落到整小时近似）；
 * - 时长也未知 → 只报次数，绝不编造 0 分钟。
 */
export function availabilityConclusion(
  summary: AvailabilityConclusionInput,
  outageMinutes?: number | null,
): AvailabilityConclusion | null {
  if (summary.sampled === 0) {
    return { key: "publicStatus.detail.summary.noSamples" };
  }
  if (summary.outageCount === null) return null;
  if (summary.outageCount === 0) {
    return { key: "publicStatus.detail.summary.healthy" };
  }

  // `null` 是后端明确说「没有精确值」，不能拿整小时近似冒充；
  // `undefined` 才是旧后端缺字段，可以用小时桶兜底。
  const exact =
    outageMinutes === null ? null : outageMinutesParts(outageMinutes);
  const duration =
    outageMinutes === null
      ? null
      : (exact ??
        (summary.outageHours === null
          ? null
          : { hours: summary.outageHours, minutes: 0 }));

  if (duration === null) {
    return {
      key: outageConclusionKey("outageUnknown", summary.outageCount),
      values: { count: summary.outageCount },
    };
  }
  if (duration.hours === 0 && duration.minutes === 0) {
    return {
      key: outageConclusionKey("outageLessThanMinute", summary.outageCount),
      values: { count: summary.outageCount },
    };
  }
  if (duration.hours > 0 && duration.minutes > 0) {
    return {
      key: outageConclusionKey("outage", summary.outageCount),
      values: {
        count: summary.outageCount,
        hours: duration.hours,
        minutes: duration.minutes,
      },
    };
  }
  if (duration.hours > 0) {
    return {
      key: outageConclusionKey("outageHours", summary.outageCount),
      values: { count: summary.outageCount, hours: duration.hours },
    };
  }
  return {
    key: outageConclusionKey("outageMinutes", summary.outageCount),
    values: { count: summary.outageCount, minutes: duration.minutes },
  };
}
