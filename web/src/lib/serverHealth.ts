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

/** 热力图指标；顺序即切换控件的顺序。 */
export const HEATMAP_METRICS = ["uptime", "load", "memory", "disk"] as const;
export type HeatmapMetric = (typeof HEATMAP_METRICS)[number];

export function isHeatmapMetric(value: unknown): value is HeatmapMetric {
  return (
    typeof value === "string" &&
    (HEATMAP_METRICS as readonly string[]).includes(value)
  );
}

export function resolveHeatmapMetric(value: unknown): HeatmapMetric {
  return isHeatmapMetric(value) ? value : "uptime";
}

export type ServerHealthTone =
  | "good"
  | "warn"
  | "bad"
  | "nosample"
  | "offline";

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
}

export type ServerHealthParseResult =
  | { status: "ok"; snapshot: ServerHealthSnapshot }
  | { status: "empty"; snapshot: ServerHealthSnapshot }
  | { status: "unsupported" };

export interface HeatmapColumn {
  ts: number;
}

export interface HeatmapCell {
  tone: ServerHealthTone;
  /** 当前指标值：在线率 / 负载 / 内存比 / 硬盘比。 */
  value: number | null;
  bucket: ServerHealthBucket | null;
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

export interface ServerResourceRow {
  server: ServerHealthServer;
  load1: number | null;
  /** 0..1，按 4 核满载近似；仅用于排序与条形长度。 */
  loadRatio: number | null;
  memRatio: number | null;
  diskRatio: number | null;
  /** 三者中最差的一项，用于排序。 */
  worstRatio: number | null;
}

/** 与原型一致的阈值；负载是绝对值（没有 CPU 核数，不能跨规格比较）。 */
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

  return {
    ts,
    onlineRatio,
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

  let status: ServerHealthServer["status"] =
    raw.status === "online" || raw.status === "offline"
      ? raw.status
      : "unknown";
  if (status === "unknown" && sorted.length > 0) {
    const latest = sorted.at(-1);
    if (latest?.onlineRatio === 1) status = "online";
    else if (latest?.onlineRatio === 0) status = "offline";
  }

  return {
    id,
    name,
    status,
    current: normalizeCurrent(raw.current),
    buckets: sorted,
  };
}

function ratioOf(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0) return null;
  return Math.max(0, Math.min(1, used / total));
}

function bucketMetricValue(
  bucket: ServerHealthBucket,
  metric: HeatmapMetric,
): number | null {
  switch (metric) {
    case "uptime":
      return bucket.onlineRatio;
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

/** 指标 → 三档色调；无采样与离线在 [`heatmapCell`] 里优先处理。 */
export function heatmapTone(
  metric: HeatmapMetric,
  value: number | null,
): ServerHealthTone {
  if (value === null || !Number.isFinite(value)) return "nosample";

  switch (metric) {
    case "uptime":
      if (value >= SERVER_HEALTH_THRESHOLDS.uptimeGood) return "good";
      if (value >= SERVER_HEALTH_THRESHOLDS.uptimeWarn) return "warn";
      return "bad";
    case "load":
      if (value < SERVER_HEALTH_THRESHOLDS.loadGood) return "good";
      if (value < SERVER_HEALTH_THRESHOLDS.loadBad) return "warn";
      return "bad";
    case "memory":
      if (value < SERVER_HEALTH_THRESHOLDS.memWarn) return "good";
      if (value < SERVER_HEALTH_THRESHOLDS.memBad) return "warn";
      return "bad";
    case "disk":
      if (value < SERVER_HEALTH_THRESHOLDS.diskWarn) return "good";
      if (value < SERVER_HEALTH_THRESHOLDS.diskBad) return "warn";
      return "bad";
    default:
      return "nosample";
  }
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

/** 单个格子的色调：无采样 → 灰点；在线率 0 → 离线红斜纹；其余按指标三档。 */
export function heatmapCell(
  server: ServerHealthServer,
  ts: number,
  metric: HeatmapMetric,
  stepSecs: number,
): HeatmapCell {
  const bucket = bucketAt(server, ts, stepSecs);
  if (!bucket || bucket.samples <= 0) {
    return { tone: "nosample", value: null, bucket };
  }
  const value = bucketMetricValue(bucket, metric);
  // 离线优先于指标值：切到负载/内存/硬盘时，离线小时仍然画红斜纹。
  if (bucket.onlineRatio !== null && bucket.onlineRatio <= 0) {
    return { tone: "offline", value, bucket };
  }
  if (value === null) return { tone: "nosample", value: null, bucket };
  return { tone: heatmapTone(metric, value), value, bucket };
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

/** 当前资源行：优先用接口的 current 快照，缺失时回落到最后一个桶。 */
export function buildServerResourceRows(
  snapshot: ServerHealthSnapshot,
  limit = 6,
): ServerResourceRow[] {
  const rows = snapshot.servers.map((server) => {
    const latest = server.buckets.at(-1) ?? null;
    const load1 = server.current.load1 ?? latest?.load1 ?? null;
    const memRatio =
      ratioOf(server.current.memUsed, server.current.memTotal) ??
      latest?.memRatio ??
      null;
    const diskRatio =
      ratioOf(server.current.diskUsed, server.current.diskTotal) ??
      latest?.diskRatio ??
      null;
    const loadRatio =
      load1 === null
        ? null
        : Math.max(0, Math.min(1, load1 / SERVER_HEALTH_THRESHOLDS.loadBad));
    const worstRatio = [loadRatio, memRatio, diskRatio]
      .filter((value): value is number => value !== null)
      .reduce<number | null>(
        (worst, value) => (worst === null || value > worst ? value : worst),
        null,
      );
    return { server, load1, loadRatio, memRatio, diskRatio, worstRatio };
  });

  return rows
    .filter((row) => row.worstRatio !== null)
    .sort(
      (a, b) =>
        (b.worstRatio ?? 0) - (a.worstRatio ?? 0) ||
        a.server.name.localeCompare(b.server.name),
    )
    .slice(0, Math.max(0, Math.floor(limit)));
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
