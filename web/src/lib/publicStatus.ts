/**
 * 探针公开页的纯逻辑：状态点、百分比与可用率色阶。
 *
 * 这里不依赖 React / DOM / i18n，方便用 `node --test` 直接覆盖边界；
 * 页面只负责把返回值映射成 token 与文案。
 */

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

/** 24 个桶里至少有一个采样，才画迷你条；全是 null 时整条显示空态。 */
export function hasSamples(
  buckets: readonly (unknown | null | undefined)[],
): boolean {
  return buckets.some((bucket) => bucket !== null && bucket !== undefined);
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
 * 四个字段**任一**缺失或非法时整组不渲染——宁可少一组信息，也不画
 * 「— / —」这种看起来像坏数据的占位。
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
}

/** 卡片底部「到期与价格」一组的渲染数据；整组要么完整，要么不出现。 */
export interface PublicBilling {
  /** 规范化后的到期日 `YYYY-MM-DD`。 */
  paidUntil: string;
  /** 距今 UTC+8 业务日：`> 0` 未来、`0` 今天、`< 0` 已过期。 */
  days: number;
  /** 含币种符号的价格，如 `¥268.00`；其它币种显示代码，如 `JPY 268.00`。 */
  price: string;
  /** 计费周期的 i18n key，如 `publicStatus.server.cycle.monthly`。 */
  cycleKey: string;
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

/**
 * 卡片第三组「到期与价格」的完整数据。四个字段任一缺失 / 非法 → null。
 *
 * 这是「整组显示或不显示」的唯一判定点：调用方拿到 null 就不渲染这一组，
 * 不去猜缺失字段的默认值。
 */
export function publicBilling(
  fields: PublicBillingFields,
  nowMs: number = Date.now(),
): PublicBilling | null {
  if (typeof fields.paid_until !== "string") return null;
  const paidUntil = fields.paid_until.trim();
  const days = expiryDays(paidUntil, nowMs);
  const price = formatPrice(fields.price_cents, fields.currency);
  const cycleKey = billingCycleKey(fields.billing_cycle);
  if (days === null || price === null || cycleKey === null) return null;
  return { paidUntil, days, price, cycleKey };
}

/**
 * `/status` 与 `/status/` 是公开路由，必须在 `useMe` 之前放行；
 * `/status/xxx` 不在白名单里，仍走登录守卫。
 */
export function isPublicStatusPath(pathname: string): boolean {
  return pathname === "/status" || pathname === "/status/";
}
