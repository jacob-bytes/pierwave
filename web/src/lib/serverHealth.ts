import { ApiError } from "./apiError.ts";

/**
 * 「服务器状态」视图的纯逻辑：接口归一化、7×24 热力图、异常窗口与资源快照。
 *
 * 后端契约：
 * `GET /api/v1/overview/server-health?hours=168&bucket=3600`
 * 返回 `{ generated_at, hours, bucket, summary, servers[] }`；桶内是
 * `{ ts, online, load1, mem_ratio, disk_ratio }`，没有采样的桶为 `null`。
 * 前端必须容忍：
 * - 接口 404 / 403（旧主控或非管理员）→ 查询层返回 null，显示「需要新版本主控」；
 * - 字段缺失 / 旧字段名 / 空桶 → 这里统一归一化，绝不把缺失画成 0；
 * - 某台服务器没有 `buckets` → 该行全部显示「无采样」点纹，而不是报错。
 *
 * 所有计算都不依赖 React / DOM / i18n，便于单测。
 */

/** 热力图格子的非数值状态；在线率有采样时用 0–4 的色阶。 */
export type HeatmapCellState = "sample" | "offline" | "nosample";

/** 颜色阶数：0 = 在线率最低（最浅），4 = 在线率最高（最深）。 */
export const HEATMAP_STEP_COUNT = 5;

/** 「当前资源」面积图可切换的指标。 */
export const RESOURCE_METRICS = ["load", "memory", "disk"] as const;
export type ResourceMetric = (typeof RESOURCE_METRICS)[number];

export function isResourceMetric(value: unknown): value is ResourceMetric {
  return (
    typeof value === "string" &&
    (RESOURCE_METRICS as readonly string[]).includes(value)
  );
}

export function resolveResourceMetric(value: unknown): ResourceMetric {
  return isResourceMetric(value) ? value : "load";
}

export type ServerHealthMetric =
  | "offline"
  | "load"
  | "memory"
  | "disk";

export interface ServerHealthBucket {
  /** 桶起点（Unix 秒），已升序。 */
  ts: number;
  /** 0..1；没有采样时为 null。 */
  onlineRatio: number | null;
  /**
   * 在线率是否由 `online` 布尔（或 outage_samples）近似得到。
   * 后端新契约会给桶内 `online_ratio`；缺失时只能回退到 0/1，
   * 热力图图例会注明「近似」，避免 5 档色阶被误读成真实分档。
   */
  ratioApproximate: boolean;
  /** 平均 1 分钟负载；没有采样时为 null。 */
  load1: number | null;
  /** 桶内最大 1 分钟负载；没有采样时为 null。 */
  load1Max: number | null;
  /** 0..1；没有采样时为 null。 */
  memRatio: number | null;
  /** 0..1；没有采样时为 null。 */
  diskRatio: number | null;
  /** 桶内有效采样数；0 = 无采样。 */
  samples: number;
  /** 桶内离线采样数；缺失按 0。 */
  outageSamples: number;
}

export interface ServerHealthCurrent {
  load1: number | null;
  memUsed: number | null;
  memTotal: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
  latencyMs: number | null;
}

export interface ServerHealthServer {
  id: string;
  name: string;
  status: "online" | "offline" | "unknown";
  /** 请求窗口内的可用率（后端新增字段）；缺失时为 null。 */
  onlineRatio: number | null;
  current: ServerHealthCurrent;
  buckets: ServerHealthBucket[];
}

export interface ServerHealthSummary {
  /** 0..1；窗口内没有采样时为 null。 */
  uptime24h: number | null;
  uptime7d: number | null;
  anomalyServers: number;
  /** 0..1；没有磁盘数据时为 null。 */
  diskMax: number | null;
  serversWithoutSamples: number;
  offlineServers: number;
  resourceServers: number;
  maxDiskServer: string | null;
}

export interface ServerHealthWindow {
  hours: number;
  bucketSecs: number;
  generatedAt: number | null;
}

export interface ServerHealthSnapshot {
  window: ServerHealthWindow;
  servers: ServerHealthServer[];
  summary: ServerHealthSummary;
  /** 所有桶里最新的时间戳；没有采样时为 null。 */
  latestTs: number | null;
  hasSamples: boolean;
  /** 至少一个桶的在线率来自 `online` 布尔近似（后端缺 `online_ratio`）。 */
  approximateUptime: boolean;
}

export type ServerHealthParseResult =
  | { status: "ok"; snapshot: ServerHealthSnapshot }
  | { status: "empty"; snapshot: ServerHealthSnapshot }
  | { status: "unsupported" };

export interface HeatmapColumn {
  ts: number;
}

export interface HeatmapCell {
  state: HeatmapCellState;
  /** 0 = 在线率最低（浅），4 = 在线率最高（深）；无采样 / 离线时为 null。 */
  step: number | null;
  /** 桶内在线率 0..1。 */
  value: number | null;
  bucket: ServerHealthBucket | null;
}

/** 热力图里正常展开的一台服务器。 */
export interface HeatmapServerRow {
  kind: "server";
  server: ServerHealthServer;
  /**
   * 在「可见服务器行」中的序号（0 起），与 `data-row` / 键盘上下移动一致。
   * 折叠的聚合行不占序号，所以折叠后后面的行会自然接上。
   */
  row: number;
}

/** 全程没有在线样本的服务器折叠成的聚合行。 */
export interface HeatmapOfflineGroupRow {
  kind: "offline-group";
  servers: ServerHealthServer[];
}

export type HeatmapRow = HeatmapServerRow | HeatmapOfflineGroupRow;

/** 面积图的一台服务器（id + 展示名）。 */
export interface ResourceSeries {
  id: string;
  name: string;
}

/** 面积图的一行：`ts` + 各服务器 id 的百分比值（无采样为 null）。 */
export interface ResourceChartPoint {
  ts: number;
  [serverId: string]: number | null;
}

export interface ResourceChartData {
  points: ResourceChartPoint[];
  series: ResourceSeries[];
  /** 选中服务器里是否至少有一个非 null 点。 */
  hasData: boolean;
}

/** 「当前资源」排序 / chips 用的一行。 */
export interface ResourceServerRow {
  serverId: string;
  name: string;
  /** 原始值：负载为 load1，内存 / 硬盘为 0..1。 */
  value: number | null;
}

/**
 * 「趋势」视图的一行：所选服务器在该小时的聚合在线率。
 *
 * `pct` 与 summary 的在线率同一口径：`Σ(online_ratio * samples) / Σ samples`。
 * 该小时没有任何服务器有采样时为 `null`——折线必须断开，不能画成 0 / 100。
 *
 * `onlineServers` 不是整数台数：一台服务器桶内 7/12 采样在线时按 0.583 台计入，
 * 这样「在线台数 / 总台数」与 `pct` 用的是同一套加权口径，不会出现曲线 58%
 * 却写着「1/1 台在线」的矛盾。`offlineServers` 只列桶内 0% 在线的服务器。
 */
export interface UptimeTrendPoint {
  ts: number;
  /** 0–100；空桶为 null。 */
  pct: number | null;
  /** 桶内所有服务器的采样数合计。 */
  samples: number;
  /** 桶内有采样的服务器数（分母）。 */
  totalServers: number;
  /** 按采样加权后的在线台数（可以带小数）。 */
  onlineServers: number;
  /** 桶内 0% 在线的服务器名，按名称升序。 */
  offlineServers: string[];
}

/** 异常时段（离线窗口合并后）；`endTs` 是最后一个异常桶的起点。 */
export interface UptimeTrendRange {
  startTs: number;
  endTs: number;
}

export interface UptimeTrend {
  /** 与热力图同一时间窗、同一小时粒度，含空桶（`pct: null`）。 */
  points: UptimeTrendPoint[];
  hasData: boolean;
  /** 离线异常窗口合并后的时段，用于折线图背景阴影。 */
  anomalyRanges: UptimeTrendRange[];
}

export interface AnomalyWindow {
  key: string;
  serverId: string;
  serverName: string;
  metric: ServerHealthMetric;
  startTs: number;
  endTs: number;
  /** 该窗口是否延续到最后一个桶。 */
  ongoing: boolean;
  /** 窗口内该指标的峰值（负载为 load1，其余为 0..1）。 */
  peak: number | null;
}


/** 没有 CPU 核数时，负载按 8 核满载近似（tooltip / 图注会标明）。 */
export const RESOURCE_LOAD_APPROX_CORES = 8;

/** 异常窗口阈值；负载是绝对值（没有 CPU 核数，不能跨规格比较）。 */
export const SERVER_HEALTH_THRESHOLDS = {
  uptimeGood: 0.99,
  uptimeWarn: 0.95,
  loadGood: 1,
  loadBad: 4,
  memWarn: 0.6,
  memBad: 0.9,
  diskWarn: 0.7,
  diskBad: 0.9,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstField(
  record: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

/** 有限数字；接受数字或可转数字的字符串，其它一律 null。 */
function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function finiteInt(value: unknown): number | null {
  const number = finiteNumber(value);
  return number === null ? null : Math.max(0, Math.floor(number));
}

/** 0..1 的比率；旧接口/手工数据给 96.4 这种百分比时自动除以 100。 */
function ratio(value: unknown): number | null {
  const number = finiteNumber(value);
  if (number === null || number < 0) return null;
  const normalized = number > 1 && number <= 100 ? number / 100 : number;
  return Math.max(0, Math.min(1, normalized));
}

/** Unix 秒；兼容毫秒时间戳。 */
function unixSeconds(value: unknown): number | null {
  const number = finiteNumber(value);
  if (number === null || number <= 0) return null;
  return number > 1e12 ? Math.floor(number / 1000) : Math.floor(number);
}

function normalizeBucket(raw: unknown): ServerHealthBucket | null {
  if (!isRecord(raw)) return null;
  const ts = unixSeconds(raw.ts);
  if (ts === null) return null;

  const onlineRaw = raw.online;
  const onlineBool = typeof onlineRaw === "boolean" ? onlineRaw : null;
  const samples = finiteInt(raw.samples);
  const outageRaw = finiteInt(raw.outage_samples);
  const load1 = finiteNumber(firstField(raw, ["load1_avg", "load1Avg", "load1"]));
  const load1Max =
    finiteNumber(firstField(raw, ["load1_max", "load1Max"])) ?? load1;
  const memRatio = ratio(firstField(raw, ["mem_ratio_max", "memRatioMax", "mem_ratio"]));
  const diskRatio = ratio(
    firstField(raw, ["disk_ratio_max", "diskRatioMax", "disk_ratio"]),
  );
  let onlineRatio = ratio(
    firstField(raw, ["online_ratio", "onlineRatio"]),
  );
  if (onlineRatio === null && onlineBool !== null) {
    onlineRatio = onlineBool ? 1 : 0;
  }
  if (
    onlineRatio === null &&
    outageRaw !== null &&
    samples !== null &&
    samples > 0
  ) {
    onlineRatio = Math.max(0, Math.min(1, 1 - outageRaw / samples));
  }
  const outageSamples = outageRaw ?? (onlineBool === false ? 1 : 0);

  const hasValue =
    onlineRatio !== null ||
    load1 !== null ||
    load1Max !== null ||
    memRatio !== null ||
    diskRatio !== null;
  // 新契约的桶只有 online 布尔；按 1 个采样计数，供加权在线率使用。
  const resolvedSamples = samples ?? (hasValue ? 1 : 0);
  // 只有后端明确给了桶内 online_ratio 才算真实分档；布尔/outage 推导都是近似。
  const ratioApproximate =
    ratio(firstField(raw, ["online_ratio", "onlineRatio"])) === null &&
    onlineRatio !== null;

  return {
    ts,
    onlineRatio,
    ratioApproximate,
    load1,
    load1Max,
    memRatio,
    diskRatio,
    samples: resolvedSamples,
    outageSamples,
  };
}

function normalizeCurrent(raw: unknown): ServerHealthCurrent {
  if (!isRecord(raw)) {
    return {
      load1: null,
      memUsed: null,
      memTotal: null,
      diskUsed: null,
      diskTotal: null,
      latencyMs: null,
    };
  }
  return {
    load1: finiteNumber(firstField(raw, ["load1"])),
    memUsed: finiteNumber(firstField(raw, ["mem_used", "memUsed"])),
    memTotal: finiteNumber(firstField(raw, ["mem_total", "memTotal"])),
    diskUsed: finiteNumber(firstField(raw, ["disk_used", "diskUsed"])),
    diskTotal: finiteNumber(firstField(raw, ["disk_total", "diskTotal"])),
    latencyMs: finiteNumber(firstField(raw, ["latency_ms", "latencyMs"])),
  };
}

function normalizeServer(raw: unknown): ServerHealthServer | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!id || !name) return null;

  const buckets = Array.isArray(raw.buckets)
    ? raw.buckets
        .map(normalizeBucket)
        .filter((bucket): bucket is ServerHealthBucket => bucket !== null)
    : [];
  // 同一时间戳只保留最后一条，避免旧接口重复桶让网格错位。
  const byTs = new Map<number, ServerHealthBucket>();
  for (const bucket of buckets) byTs.set(bucket.ts, bucket);
  const sorted = [...byTs.values()].sort((a, b) => a.ts - b.ts);

  // 后端新增的真实状态优先；缺失时才从最新桶 / 窗口在线率推断。
  let status: ServerHealthServer["status"] =
    raw.status === "online" || raw.status === "offline"
      ? raw.status
      : "unknown";
  const onlineRatio = ratio(firstField(raw, ["online_ratio", "onlineRatio"]));
  if (status === "unknown" && sorted.length > 0) {
    const latest = sorted.at(-1);
    if (latest?.onlineRatio === 1) status = "online";
    else if (latest?.onlineRatio === 0) status = "offline";
  }
  if (status === "unknown" && onlineRatio !== null) {
    status = onlineRatio >= 0.5 ? "online" : "offline";
  }

  return {
    id,
    name,
    status,
    onlineRatio,
    current: normalizeCurrent(raw.current),
    buckets: sorted,
  };
}

function ratioOf(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0) return null;
  return Math.max(0, Math.min(1, used / total));
}

/**
 * 在线率 → 0–4 的色阶。**数字越大 = 在线率越高 = 颜色越深**。
 *
 * 0: <90% / 1: 90–95% / 2: 95–97% / 3: 97–99% / 4: ≥99%
 */
export function uptimeHeatmapStep(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value >= 0.99) return 4;
  if (value >= 0.97) return 3;
  if (value >= 0.95) return 2;
  if (value >= 0.9) return 1;
  return 0;
}

/** 资源图 / 当前资源排序用的原值（负载为 load1，其余为 0..1）。 */
export function resourceBucketValue(
  bucket: ServerHealthBucket | null,
  metric: ResourceMetric,
): number | null {
  if (!bucket || bucket.samples <= 0) return null;
  switch (metric) {
    case "load":
      return bucket.load1 ?? bucket.load1Max;
    case "memory":
      return bucket.memRatio;
    case "disk":
      return bucket.diskRatio;
    default:
      return null;
  }
}

/** 资源值 → 折线图 y 轴百分比：负载按 8 核近似，内存 / 硬盘直接乘 100。 */
export function resourcePercent(
  metric: ResourceMetric,
  value: number | null,
): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (metric === "load") {
    return Math.min(Math.max(value / RESOURCE_LOAD_APPROX_CORES, 0), 1) * 100;
  }
  return Math.min(Math.max(value, 0), 1) * 100;
}

/**
 * 「当前资源」折线图 y 轴上界：数据最大值 1.2 倍留白后向上取整到 5 的倍数，
 * 至少 25%、至多 100%，0 基线始终保留。
 *
 * 之前写死 0–100% 会把负载曲线（load1/8 近似）压成贴底的一条线。
 */
export function resourceYMax(dataMax: number): number {
  if (!Number.isFinite(dataMax)) return 25;
  const padded = Math.max(0, dataMax) * 1.2;
  const rounded = Math.ceil(padded / 5) * 5;
  return Math.min(100, Math.max(25, rounded));
}

/**
 * 资源折线图的 y 轴刻度：优先 4 等分，其次 5 / 2 / 1 等分，
 * 取第一个能整除 yMax 的份数，保证每档都是整数并回到 0 基线。
 */
export function resourceYTicks(yMax: number): number[] {
  const top =
    Number.isFinite(yMax) && yMax > 0 ? Math.round(Math.min(100, yMax)) : 25;
  const intervals = [4, 5, 2, 1].find((count) => top % count === 0) ?? 1;
  const step = top / intervals;
  return Array.from({ length: intervals + 1 }, (_, index) =>
    Math.round(index * step),
  );
}

/** 找与列时间最接近的桶；容差半个桶，避免时区取整导致整列空。 */
export function bucketAt(
  server: ServerHealthServer,
  ts: number,
  stepSecs: number,
): ServerHealthBucket | null {
  if (server.buckets.length === 0) return null;
  const tolerance = Math.max(1, Math.floor(stepSecs / 2));
  let best: ServerHealthBucket | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const bucket of server.buckets) {
    const distance = Math.abs(bucket.ts - ts);
    if (distance < bestDistance) {
      best = bucket;
      bestDistance = distance;
    }
    if (bucket.ts > ts + tolerance) break;
  }
  return best && bestDistance <= tolerance ? best : null;
}

/** 单个格子的状态：无采样 / 离线 / 在线率（0 最浅，4 最深）。 */
export function heatmapCell(
  server: ServerHealthServer,
  ts: number,
  stepSecs: number,
): HeatmapCell {
  const bucket = bucketAt(server, ts, stepSecs);
  if (!bucket || bucket.samples <= 0 || bucket.onlineRatio === null) {
    return { state: "nosample", step: null, value: null, bucket };
  }
  if (bucket.onlineRatio <= 0) {
    return {
      state: "offline",
      step: null,
      value: bucket.onlineRatio,
      bucket,
    };
  }
  return {
    state: "sample",
    step: uptimeHeatmapStep(bucket.onlineRatio),
    value: bucket.onlineRatio,
    bucket,
  };
}

/** 生成连续的桶时间列；缺桶由 [`heatmapCell`] 画成无采样。 */
export function buildHeatmapColumns(
  snapshot: ServerHealthSnapshot,
  limit = 168,
  now = Date.now() / 1000,
): HeatmapColumn[] {
  const step = Math.max(1, snapshot.window.bucketSecs || 3600);
  const count = Math.max(1, Math.min(Math.floor(limit), 24 * 14));
  const fallbackEnd = snapshot.window.generatedAt ?? Math.floor(now);
  // 后端实际把“截至时间”放在 generated_at；最近的桶可能是 null（无采样），
  // 用 generated_at 对齐到桶起点才能把最后几个小时也画成灰点，而不是截掉。
  const end =
    snapshot.window.generatedAt !== null
      ? Math.floor(snapshot.window.generatedAt / step) * step
      : (snapshot.latestTs ?? Math.floor(fallbackEnd / step) * step);
  const start = end - (count - 1) * step;
  return Array.from({ length: count }, (_, index) => ({
    ts: start + index * step,
  }));
}

/**
 * 整段窗口里是否至少有一个「在线率 > 0」的样本。
 *
 * 离线桶（onlineRatio = 0）和无采样桶都不算在线样本；两者在热力图上
 * 都只有空格子，整行都这样时折叠成一行，把空间留给有信息的行。
 */
export function serverHasOnlineSample(
  server: ServerHealthServer,
  columns: readonly HeatmapColumn[],
  stepSecs: number,
): boolean {
  return columns.some(
    (column) => heatmapCell(server, column.ts, stepSecs).state === "sample",
  );
}

/**
 * 把服务器行折叠成「可见行」列表。
 *
 * - 整段窗口没有任何在线样本（离线 + 无采样）的服务器合并成一行；
 * - 聚合行固定出现在第一台被折叠服务器原来的位置，未折叠行顺序不变；
 * - 聚合行始终保留（它是展开 / 收起的唯一入口），展开后把 N 台
 *   逐行放回聚合行后面；`row` 序号只给真正渲染格子的服务器行，
 *   所以折叠的服务器不会进入热力图的键盘遍历。
 */
export function buildHeatmapRows(
  servers: readonly ServerHealthServer[],
  columns: readonly HeatmapColumn[],
  stepSecs: number,
  { offlineExpanded = false }: { offlineExpanded?: boolean } = {},
): HeatmapRow[] {
  const offline = servers.filter(
    (server) => !serverHasOnlineSample(server, columns, stepSecs),
  );
  const offlineIds = new Set(offline.map((server) => server.id));
  const rows: HeatmapRow[] = [];
  let row = 0;
  let groupPlaced = false;
  for (const server of servers) {
    if (!offlineIds.has(server.id)) {
      rows.push({ kind: "server", server, row });
      row += 1;
      continue;
    }
    if (groupPlaced) continue;
    rows.push({ kind: "offline-group", servers: offline });
    groupPlaced = true;
    if (offlineExpanded) {
      for (const item of offline) {
        rows.push({ kind: "server", server: item, row });
        row += 1;
      }
    }
  }
  return rows;
}

function anomalyMetricValue(
  bucket: ServerHealthBucket,
  metric: ServerHealthMetric,
): number | null {
  switch (metric) {
    case "offline":
      return bucket.onlineRatio;
    case "load":
      return bucket.load1Max ?? bucket.load1;
    case "memory":
      return bucket.memRatio;
    case "disk":
      return bucket.diskRatio;
    default:
      return null;
  }
}

function isAnomalyBucket(
  bucket: ServerHealthBucket,
  metric: ServerHealthMetric,
): boolean {
  if (bucket.samples <= 0) return false;
  switch (metric) {
    case "offline":
      return bucket.onlineRatio !== null
        ? bucket.onlineRatio < SERVER_HEALTH_THRESHOLDS.uptimeGood
        : bucket.outageSamples > 0;
    case "load": {
      const value = bucket.load1Max ?? bucket.load1;
      return value !== null && value >= SERVER_HEALTH_THRESHOLDS.loadBad;
    }
    case "memory":
      return (
        bucket.memRatio !== null &&
        bucket.memRatio >= SERVER_HEALTH_THRESHOLDS.memBad
      );
    case "disk":
      return (
        bucket.diskRatio !== null &&
        bucket.diskRatio >= SERVER_HEALTH_THRESHOLDS.diskBad
      );
    default:
      return false;
  }
}

/**
 * 连续异常窗口：同服务器 + 同指标 + 桶相邻才合并；中间缺桶或指标恢复就断开。
 * `latestTs` 是全局最后一个桶，用来判断「进行中」。
 */
export function buildAnomalyWindows(
  servers: readonly ServerHealthServer[],
  bucketSecs: number,
  latestTs: number | null,
): AnomalyWindow[] {
  const step = Math.max(1, bucketSecs || 3600);
  const maxGap = step * 1.5;
  const metrics: ServerHealthMetric[] = [
    "offline",
    "load",
    "memory",
    "disk",
  ];
  const windows: AnomalyWindow[] = [];

  for (const server of servers) {
    for (const metric of metrics) {
      let open: AnomalyWindow | null = null;
      let previousTs: number | null = null;

      const close = () => {
        if (!open) return;
        open.ongoing = latestTs !== null && open.endTs === latestTs;
        windows.push(open);
        open = null;
      };

      for (const bucket of server.buckets) {
        const active = isAnomalyBucket(bucket, metric);
        if (!active) {
          close();
          previousTs = bucket.ts;
          continue;
        }
        const value = anomalyMetricValue(bucket, metric);
        if (open && previousTs !== null && bucket.ts - previousTs <= maxGap) {
          open.endTs = bucket.ts;
          if (value !== null && (open.peak === null || value > open.peak)) {
            open.peak = value;
          }
        } else {
          close();
          open = {
            key: `${server.id}:${metric}:${bucket.ts}`,
            serverId: server.id,
            serverName: server.name,
            metric,
            startTs: bucket.ts,
            endTs: bucket.ts,
            ongoing: false,
            peak: value,
          };
        }
        previousTs = bucket.ts;
      }
      close();
    }
  }

  return windows.sort(
    (a, b) =>
      Number(b.ongoing) - Number(a.ongoing) ||
      b.startTs - a.startTs ||
      b.endTs - b.startTs - (a.endTs - a.startTs),
  );
}

/**
 * 「趋势」视图：把热力图的同一批小时列聚合成一条在线率折线。
 *
 * 聚合口径与 `summary.online_ratio_24h` / 加权在线率一致：
 * `Σ(bucket.online_ratio * bucket.samples) / Σ bucket.samples`（跳过空桶）。
 * 因此趋势线上任意一小时的值都能和 KPI 用同一把尺子核对。
 *
 * 台数用同一套加权口径反推：`onlineServers = pct / 100 * totalServers`。
 * 桶内有采样的服务器才进入分母，无采样不等于离线；一台服务器桶内只有 7/12
 * 采样在线时贡献 0.583 台，而不是按多数判定写成 1 台。
 *
 * `anomalyRanges` 取现有「异常窗口」里 `metric = offline` 的那些窗口，并把
 * 重叠 / 相邻的时段合并；负载 / 内存 / 硬盘窗口不在这条在线率曲线上标阴影。
 */
export function buildUptimeTrend(
  snapshot: ServerHealthSnapshot,
  limit = 168,
): UptimeTrend {
  const step = Math.max(1, snapshot.window.bucketSecs || 3600);
  const columns = buildHeatmapColumns(snapshot, limit);
  let hasData = false;

  const points: UptimeTrendPoint[] = columns.map(({ ts }) => {
    let samples = 0;
    let onlineSamples = 0;
    let totalServers = 0;
    const offlineServers: string[] = [];

    for (const server of snapshot.servers) {
      const bucket = bucketAt(server, ts, step);
      if (!bucket || bucket.samples <= 0 || bucket.onlineRatio === null) {
        continue;
      }
      totalServers += 1;
      samples += bucket.samples;
      onlineSamples += bucket.onlineRatio * bucket.samples;
      // 只有整个桶都离线才进「离线」名单；部分在线由小数台数表达。
      if (bucket.onlineRatio <= 0) offlineServers.push(server.name);
    }

    const pct = samples > 0 ? (onlineSamples / samples) * 100 : null;
    if (pct !== null) hasData = true;
    offlineServers.sort((a, b) => a.localeCompare(b));
    return {
      ts,
      pct,
      samples: Math.round(samples),
      totalServers,
      // 与折线同一个加权口径：曲线 58.3% 时写「≈0.6/1 台」，不会自相矛盾。
      onlineServers: pct === null ? 0 : (pct / 100) * totalServers,
      offlineServers,
    };
  });

  const firstTs = columns[0]?.ts;
  const windowEnd = (columns.at(-1)?.ts ?? 0) + step;
  const rawRanges = buildAnomalyWindows(
    snapshot.servers,
    step,
    snapshot.latestTs,
  )
    .filter((window) => window.metric === "offline")
    .map((window) => ({
      startTs: Math.max(window.startTs, firstTs ?? window.startTs),
      endTs: Math.min(window.endTs, windowEnd),
    }))
    .filter((range) => range.startTs <= range.endTs)
    .sort((a, b) => a.startTs - b.startTs);

  const anomalyRanges: UptimeTrendRange[] = [];
  for (const range of rawRanges) {
    const last = anomalyRanges.at(-1);
    if (last && range.startTs - last.endTs <= step) {
      last.endTs = Math.max(last.endTs, range.endTs);
    } else {
      anomalyRanges.push({ ...range });
    }
  }

  return { points, hasData, anomalyRanges };
}

/**
 * 趋势 tooltip 的在线台数：整数就写 `4`，带小数时写 `≈3.6`（一位小数）。
 * 单独抽出来是为了让「部分采样」的展示可被单测覆盖。
 */
export function formatOnlineCount(online: number): string {
  const rounded = Math.round(online * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : `≈${rounded.toFixed(1)}`;
}

/** 趋势 tooltip 的离线名单：最多 `limit` 个，其余只报数量。 */
export function offlineServerNamePreview(
  names: readonly string[],
  limit = 3,
): { names: string[]; extra: number } {
  const max = Math.max(0, Math.floor(limit));
  return {
    names: names.slice(0, max),
    extra: Math.max(0, names.length - max),
  };
}

function weightedUptime(
  servers: readonly ServerHealthServer[],
  fromTs: number | null,
): number | null {
  let online = 0;
  let samples = 0;
  for (const server of servers) {
    for (const bucket of server.buckets) {
      if (fromTs !== null && bucket.ts < fromTs) continue;
      if (bucket.samples <= 0 || bucket.onlineRatio === null) continue;
      online += bucket.onlineRatio * bucket.samples;
      samples += bucket.samples;
    }
  }
  return samples > 0 ? online / samples : null;
}

function maxDiskRatio(servers: readonly ServerHealthServer[]): {
  ratio: number | null;
  name: string | null;
} {
  let max: number | null = null;
  let name: string | null = null;
  for (const server of servers) {
    const currentRatio = ratioOf(
      server.current.diskUsed,
      server.current.diskTotal,
    );
    let serverMax = currentRatio;
    for (const bucket of server.buckets) {
      if (bucket.samples <= 0 || bucket.diskRatio === null) continue;
      if (serverMax === null || bucket.diskRatio > serverMax) {
        serverMax = bucket.diskRatio;
      }
    }
    if (serverMax !== null && (max === null || serverMax > max)) {
      max = serverMax;
      name = server.name;
    }
  }
  return { ratio: max, name };
}

function summaryInt(
  raw: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  const value = finiteInt(firstField(raw, keys));
  return value;
}

function buildSnapshot(
  servers: ServerHealthServer[],
  rawRoot: Record<string, unknown>,
): ServerHealthSnapshot {
  const rawWindow = isRecord(rawRoot.window) ? rawRoot.window : {};
  const hours =
    finiteInt(firstField(rawRoot, ["hours"])) ??
    finiteInt(firstField(rawWindow, ["hours"])) ??
    168;
  const bucketSecs =
    finiteInt(firstField(rawRoot, ["bucket", "bucket_secs", "bucketSecs"])) ??
    finiteInt(firstField(rawWindow, ["bucket", "bucket_secs", "bucketSecs"])) ??
    3600;
  const generatedAt =
    unixSeconds(firstField(rawRoot, ["generated_at", "generatedAt"])) ??
    unixSeconds(firstField(rawWindow, ["generated_at", "generatedAt"]));

  let latestTs: number | null = null;
  let hasSamples = false;
  let approximateUptime = false;
  let serversWithoutSamples = 0;
  for (const server of servers) {
    const latest = server.buckets.at(-1)?.ts ?? null;
    if (latest !== null && (latestTs === null || latest > latestTs)) {
      latestTs = latest;
    }
    if (server.buckets.some((bucket) => bucket.samples > 0)) {
      hasSamples = true;
    } else {
      serversWithoutSamples += 1;
    }
    if (
      !approximateUptime &&
      server.buckets.some(
        (bucket) => bucket.samples > 0 && bucket.ratioApproximate,
      )
    ) {
      approximateUptime = true;
    }
  }

  const anomalies = buildAnomalyWindows(servers, bucketSecs, latestTs);
  const offlineServers = new Set(
    anomalies
      .filter((window) => window.metric === "offline")
      .map((window) => window.serverId),
  );
  const resourceServers = new Set(
    anomalies
      .filter((window) => window.metric !== "offline")
      .map((window) => window.serverId),
  );
  const anomalyServers = new Set([...offlineServers, ...resourceServers]);
  const disk = maxDiskRatio(servers);

  const rawSummary = isRecord(rawRoot.summary) ? rawRoot.summary : {};
  const referenceTs =
    generatedAt ?? latestTs;
  const uptime24h =
    ratio(
      firstField(rawSummary, [
        "online_ratio_24h",
        "uptime_24h",
        "uptime24h",
      ]),
    ) ??
    weightedUptime(
      servers,
      referenceTs === null ? null : referenceTs - 24 * 60 * 60,
    );
  const uptime7d =
    ratio(firstField(rawSummary, ["uptime_7d", "uptime7d"])) ??
    weightedUptime(servers, null);
  const summaryAnomaly = summaryInt(rawSummary, [
    "abnormal_servers",
    "anomaly_servers",
    "anomalyServers",
  ]);
  const summaryDiskMax = ratio(
    firstField(rawSummary, [
      "worst_disk_ratio",
      "disk_max",
      "diskMax",
    ]),
  );
  const summaryWithoutSamples = summaryInt(rawSummary, [
    "servers_without_samples",
    "serversWithoutSamples",
  ]);

  return {
    window: { hours, bucketSecs, generatedAt: generatedAt ?? latestTs },
    servers,
    summary: {
      uptime24h,
      uptime7d,
      anomalyServers: summaryAnomaly ?? anomalyServers.size,
      diskMax: summaryDiskMax ?? disk.ratio,
      serversWithoutSamples:
        summaryWithoutSamples ?? serversWithoutSamples,
      offlineServers: offlineServers.size,
      resourceServers: resourceServers.size,
      maxDiskServer: disk.name,
    },
    latestTs,
    hasSamples,
    approximateUptime,
  };
}

/** 404（旧主控）/ 403（非管理员或旧主控）都按「能力未上线」处理。 */
export function isServerHealthUnsupported(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.status === 404 || error.status === 403)
  );
}

/**
 * 归一化接口响应。
 *
 * - 顶层缺 `servers` / `summary`（旧主控或半成品接口）→ `unsupported`；
 * - `servers` 里的条目全部缺 id/name → `unsupported`；
 * - `servers: []` → `empty`；
 * - 其余 → `ok`，缺桶 / 单台缺字段按「无采样」处理，不伪造 0。
 *
 * 这里只把**契约结构**判为不支持：某台服务器没有 buckets、某个指标缺值
 * 都是合法状态，应显示灰点而不是「需要新版本主控」。
 */
export function normalizeServerHealth(
  raw: unknown,
): ServerHealthParseResult {
  if (!isRecord(raw)) return { status: "unsupported" };
  const rawServers = raw.servers;
  if (!Array.isArray(rawServers)) return { status: "unsupported" };
  if (!isRecord(raw.summary)) return { status: "unsupported" };

  const servers = rawServers
    .map(normalizeServer)
    .filter((server): server is ServerHealthServer => server !== null);

  if (rawServers.length > 0 && servers.length === 0) {
    return { status: "unsupported" };
  }
  // `buckets` 是契约字段；整个响应一台服务器都没有该字段 = 旧 / 半成品接口。
  // 单台 `buckets: []` 仍是合法的「无采样」，不能误判。
  if (
    servers.length > 0 &&
    !rawServers.some((entry) => isRecord(entry) && Array.isArray(entry.buckets))
  ) {
    return { status: "unsupported" };
  }

  const snapshot = buildSnapshot(servers, raw);
  return servers.length === 0
    ? { status: "empty", snapshot }
    : { status: "ok", snapshot };
}

/** 单台服务器某个资源指标的当前值：优先 current，缺失时回落到最后一个桶。 */
export function currentResourceValue(
  server: ServerHealthServer,
  metric: ResourceMetric,
): number | null {
  const latest = server.buckets.at(-1) ?? null;
  switch (metric) {
    case "load":
      return server.current.load1 ?? latest?.load1 ?? null;
    case "memory":
      return (
        ratioOf(server.current.memUsed, server.current.memTotal) ??
        latest?.memRatio ??
        null
      );
    case "disk":
      return (
        ratioOf(server.current.diskUsed, server.current.diskTotal) ??
        latest?.diskRatio ??
        null
      );
    default:
      return null;
  }
}

/**
 * 当前资源排序 / 筛选 chips：按当前指标值降序。
 * `limit` 用于默认的「当前值最高的 5 台」；传 `Infinity` 可取全部。
 */
export function resourceServerRows(
  snapshot: ServerHealthSnapshot,
  metric: ResourceMetric,
  limit = 5,
): ResourceServerRow[] {
  const max = Number.isFinite(limit)
    ? Math.max(0, Math.floor(limit))
    : Number.POSITIVE_INFINITY;
  return snapshot.servers
    .map((server) => ({
      serverId: server.id,
      name: server.name,
      value: currentResourceValue(server, metric),
    }))
    .filter((row): row is ResourceServerRow => row.value !== null)
    .sort(
      (a, b) =>
        (b.value ?? 0) - (a.value ?? 0) || a.name.localeCompare(b.name),
    )
    .slice(0, max);
}

/**
 * 面积图数据：x 用连续小时列，y 是百分比（负载按 8 核近似）。
 * 没有采样的点保持 `null`，由 Recharts 断开而不是画 0 线。
 */
export function buildResourceChartData(
  snapshot: ServerHealthSnapshot,
  metric: ResourceMetric,
  serverIds: readonly string[],
  columns: readonly HeatmapColumn[],
): ResourceChartData {
  const byId = new Map(snapshot.servers.map((server) => [server.id, server]));
  const servers = serverIds
    .map((id) => byId.get(id))
    .filter((server): server is ServerHealthServer => server !== undefined);
  const series: ResourceSeries[] = servers.map((server) => ({
    id: server.id,
    name: server.name,
  }));
  const step = Math.max(1, snapshot.window.bucketSecs || 3600);

  const points: ResourceChartPoint[] = columns.map((column) => {
    const point: ResourceChartPoint = { ts: column.ts };
    for (const server of servers) {
      const bucket = bucketAt(server, column.ts, step);
      point[server.id] = resourcePercent(
        metric,
        resourceBucketValue(bucket, metric),
      );
    }
    return point;
  });

  const hasData = points.some((point) =>
    series.some((item) => point[item.id] !== null),
  );
  return { points, series, hasData };
}

/** `96.4%`；null 显示 `—`，不把无采样写成 0%。 */
export function formatPercent(
  value: number | null,
  digits = 1,
): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

/** 负载两位小数；null 显示 `—`。 */
export function formatLoad(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toFixed(2);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Unix 秒 → UTC+8 的 `MM/DD HH:00`，用于热力图 tooltip。 */
export function formatMonthDayHour(unixSecondsValue: number): string {
  const date = new Date((unixSecondsValue + 8 * 3600) * 1000);
  if (Number.isNaN(date.getTime())) return "—";
  return `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ${pad(
    date.getUTCHours(),
  )}:00`;
}

/** 热力图底部的小时标签；用于移动端 24 小时窗口。 */
export function formatHourTick(unixSecondsValue: number): string {
  const date = new Date((unixSecondsValue + 8 * 3600) * 1000);
  if (Number.isNaN(date.getTime())) return "—";
  return `${pad(date.getUTCHours())}:00`;
}

/** 列按 UTC+8 自然日分组，用于 7 天表头。 */
export function groupHeatmapColumnsByDay(
  columns: readonly HeatmapColumn[],
): { day: string; columns: number }[] {
  const groups: { day: string; columns: number }[] = [];
  for (const column of columns) {
    const date = new Date((column.ts + 8 * 3600) * 1000);
    const day = `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}`;
    const last = groups.at(-1);
    if (last && last.day === day) last.columns += 1;
    else groups.push({ day, columns: 1 });
  }
  return groups;
}

/** 异常窗口持续的小时数；桶起点相减后 +1。 */
export function anomalyWindowHours(window: AnomalyWindow, bucketSecs: number): number {
  const step = Math.max(1, bucketSecs || 3600);
  return Math.max(1, Math.round((window.endTs - window.startTs) / step) + 1);
}
