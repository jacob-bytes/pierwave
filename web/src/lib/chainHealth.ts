import { ApiError } from "./apiError.ts";

/**
 * 「链路时延」视图的纯逻辑：契约归一化、逐段行、诊断、异常窗口与迷你图数据。
 *
 * 后端契约：
 * `GET /api/v1/overview/chain-health?hours=24&bucket=900&server_ids=...`
 * 返回 `{ generated_at, hours, bucket, summary, chains[], scope, warnings }`。
 *
 * 前端必须容忍：
 * - 接口 404 / 403（旧主控）→ 查询层返回 null，页面显示「需要新版本主控」；
 * - `summary` / `series` / `segments` 字段缺失或旧字段名 → 这里统一归一化，
 *   绝不把缺失画成 0；
 * - 最后一跳没有历史数据 → `missing_hops` 里会有该 seq，逐段行明确标出，
 *   不计入跳间时延。
 *
 * 所有计算都不依赖 React / DOM / i18n，便于 `node:test` 直接覆盖边界。
 */

/** 时延窗口：24h 用 15 分钟桶，7d 用 1 小时桶。 */
export const CHAIN_LATENCY_RANGES = ["24h", "7d"] as const;
export type ChainLatencyRange = (typeof CHAIN_LATENCY_RANGES)[number];

export interface ChainLatencyWindow {
  hours: number;
  bucket: number;
}

const RANGE_WINDOWS: Record<ChainLatencyRange, ChainLatencyWindow> = {
  "24h": { hours: 24, bucket: 900 },
  "7d": { hours: 168, bucket: 3600 },
};

export function isChainLatencyRange(value: unknown): value is ChainLatencyRange {
  return (
    typeof value === "string" &&
    (CHAIN_LATENCY_RANGES as readonly string[]).includes(value)
  );
}

export function resolveChainLatencyRange(value: unknown): ChainLatencyRange {
  return isChainLatencyRange(value) ? value : "24h";
}

export function chainLatencyWindow(range: ChainLatencyRange): ChainLatencyWindow {
  return RANGE_WINDOWS[range];
}

/** 链级 delta 达到该值才在前端兜底标记「变慢」；KPI 仍以后端 summary 为准。 */
export const SLOW_CHAIN_DELTA_MS = 8;

/** 异常窗口：P50 超过基线 1.5 倍，且至少高出 8ms。 */
export const ANOMALY_RATIO = 1.2;
export const ANOMALY_MIN_DELTA_MS = 8;

/** 单条链的时延曲线点；没有采样的桶不补 0。 */
export interface ChainHealthPoint {
  /** 桶起点（Unix 秒），升序。 */
  ts: number;
  p50: number | null;
  p10: number | null;
  p90: number | null;
  samples: number;
  /** 该桶（该时刻）的探测丢包；旧主控 / 无探测为 null，不回落到窗口值。 */
  lossPct: number | null;
}

/**
 * 丢包色阶（只复用既有语义色，不引入新色相）：
 * `< 0.5%` 正常、`0.5–2%` 警告、`> 2%` 危险。
 */
export const LOSS_WARNING_PCT = 0.5;
export const LOSS_DESTRUCTIVE_PCT = 2;
export type ChainLossTone = "normal" | "warning" | "destructive";

export type ChainDiagnosisKind = "single_hop" | "overall" | "unknown";

export interface ChainHealthDiagnosis {
  kind: ChainDiagnosisKind;
  seq: number | null;
}

/** 丢包探测计数：失败次数 / 探测次数。缺失为 null，绝不补 0。 */
export interface ChainLossSamples {
  attempts: number | null;
  failures: number | null;
}

/** 逐段行：`missing = true` 表示该跳没有历史数据（例如最后一跳）。 */
export interface ChainHealthSegment {
  seq: number;
  from: string | null;
  to: string | null;
  p50: number | null;
  deltaMs: number | null;
  contributionPct: number | null;
  missing: boolean;
  /** 该段丢包百分比（0–100）；无探测数据为 null。 */
  lossPct: number | null;
  /** 该段探测次数；契约缺失为 null。 */
  attempts: number | null;
  /** 该段探测失败次数；契约缺失为 null。 */
  failures: number | null;
  /** 新契约可能直接给逐段序列；没有时由 `/chains/{id}/latency` 补齐。 */
  series: ChainHealthPoint[];
}

/**
 * 链路两端：契约的 `chains[].entry` / `chains[].exit`。
 *
 * 旧主控完全不返回这两个字段 → 整个端点为 `null`；字段存在但地址缺失 →
 * `address: null`。两种情况列表都显示 `—`，但 title 的降级原因不同，
 * 不能把「契约没上线」和「这一侧没有地址」混成一句话。
 */
export interface ChainEndpoint {
  ip: string | null;
  port: number | null;
  /** `ip:port`；契约没给时由 `ip` + `port` 拼出，两者都没有才是 null。 */
  address: string | null;
  serverName: string | null;
}

/** 端点某一行的缺失原因：整段缺失 / 只有地址缺失 / 只有服务器名缺失。 */
export type ChainEndpointIssue = "missing" | "no_address" | "no_name" | null;

export interface ChainHealthChain {
  id: string;
  name: string;
  hops: number;
  /** 链路入口；旧主控没有该字段时为 null。 */
  entry: ChainEndpoint | null;
  /** 链路出口；旧主控没有该字段时为 null。 */
  exit: ChainEndpoint | null;
  /** 归一化后缺失的跳（含契约没列出的中间缺口）。 */
  missingHops: number[];
  estimated: boolean;
  series: ChainHealthPoint[];
  segments: ChainHealthSegment[];
  diagnosis: ChainHealthDiagnosis;
  latestP50: number | null;
  deltaMs: number | null;
  slow: boolean;
  hasSamples: boolean;
  lastHopMissing: boolean;
  /** 整链丢包百分比（0–100）；旧主控 / 无探测时为 null。 */
  lossPct: number | null;
  /** 部分跳缺少探测数据：`lossPct` 只是可见跳的汇总，不是全链精确值。 */
  lossPartial: boolean;
  /** 整链探测计数；旧主控缺失时为 null。 */
  lossSamples: ChainLossSamples | null;
}

export interface ChainHealthWorstHop {
  chainId: string | null;
  chainName: string | null;
  seq: number | null;
  p50Ms: number | null;
}

/** 丢包最严重的链；旧主控没有该字段时为 null。 */
export interface ChainHealthWorstLoss {
  chainId: string | null;
  chainName: string | null;
  lossPct: number | null;
}

export interface ChainHealthSummary {
  hopP50: number | null;
  deltaMs: number | null;
  slowChains: number | null;
  totalChains: number;
  worstHop: ChainHealthWorstHop | null;
  /** 全局面板丢包百分比；旧主控缺失时为 null。 */
  lossPct: number | null;
  worstLoss: ChainHealthWorstLoss | null;
}

export interface ChainHealthSnapshot {
  generatedAt: number | null;
  hours: number;
  bucket: number;
  summary: ChainHealthSummary;
  chains: ChainHealthChain[];
  /** 至少一条链有 P50 样本。 */
  hasSamples: boolean;
}

export type ChainHealthParseResult =
  | { status: "ok"; snapshot: ChainHealthSnapshot }
  | { status: "empty"; snapshot: ChainHealthSnapshot }
  | { status: "unsupported" };

export interface ChainAnomalyWindow {
  startTs: number;
  endTs: number;
  peakMs: number;
}

/** 逐段趋势用的原始点：来自 `GET /api/v1/chains/{id}/latency`。 */
export interface ChainLatencySample {
  ts: number;
  seq: number;
  latency_ms: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

/** 时延值必须是非负有限数；负数 / NaN / Infinity 都按「无效」处理。 */
function nonNegativeNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function positiveInt(value: unknown): number | null {
  const number = finiteInt(value);
  return number === null || number <= 0 ? null : number;
}

function unixSeconds(value: unknown): number | null {
  const number = finiteNumber(value);
  if (number === null || number <= 0) return null;
  return number > 1e12 ? Math.floor(number / 1000) : Math.floor(number);
}

function trimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function readPoint(raw: unknown): ChainHealthPoint | null {
  if (!isRecord(raw)) return null;
  const ts = unixSeconds(raw.ts);
  if (ts === null) return null;

  const p50 = nonNegativeNumber(raw.p50);
  const p10Raw = nonNegativeNumber(raw.p10);
  const p90Raw = nonNegativeNumber(raw.p90);
  const samplesRaw = finiteInt(raw.samples);
  // 显式 `samples: 0` 表示没有采样：值一律置空，不能画成 0ms。
  const samples = samplesRaw ?? (p50 !== null ? 1 : 0);
  if (samples <= 0) {
    return { ts, p50: null, p10: null, p90: null, samples: 0, lossPct: null };
  }

  let p10 = p10Raw;
  let p90 = p90Raw;
  if (p10 !== null && p90 !== null && p10 > p90) {
    [p10, p90] = [p90, p10];
  }
  return { ts, p50, p10, p90, samples, lossPct: readLossPct(raw.loss_pct) };
}

/** 契约的时间轴：固定 `count` 个等距桶，空桶在 JSON 里是 `null`。 */
interface SeriesWindowSpec {
  count: number;
  bucketSecs: number;
}

function sortedSeries(points: ChainHealthPoint[]): ChainHealthPoint[] {
  const byTs = new Map<number, ChainHealthPoint>();
  for (const point of points) byTs.set(point.ts, point);
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

/**
 * 读一条序列。
 *
 * 新契约的 `series` 是**定长数组**：`null` 表示该桶没有样本，但桶仍在时间轴上。
 * 直接把 `null` 过滤掉会让 x 轴按「有效点个数」压缩，20–29 槽的 10 个空桶
 * 消失后，后面的点会整体左移。这里用相邻有效桶的时间戳反推空槽的 `ts`
 * （`ts = anchorTs + (index - anchorIndex) * bucket`），保留定长空槽。
 *
 * 旧主控 / 测试里的稀疏数组不是定长契约，仍按原来的去重 + 排序处理。
 */
function readSeries(raw: unknown, window?: SeriesWindowSpec): ChainHealthPoint[] {
  if (!Array.isArray(raw)) return [];
  const parsed = raw.map(readPoint);
  const fixedLength =
    window !== undefined &&
    window.count > 0 &&
    window.bucketSecs > 0 &&
    raw.length === window.count;
  if (!fixedLength) {
    return sortedSeries(
      parsed.filter((point): point is ChainHealthPoint => point !== null),
    );
  }

  const anchorIndex = parsed.findIndex(
    (point): point is ChainHealthPoint => point !== null,
  );
  if (anchorIndex < 0) return [];
  const anchor = parsed[anchorIndex] as ChainHealthPoint;
  const bucket = window.bucketSecs;
  const points: ChainHealthPoint[] = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const point = parsed[index];
    if (point !== null) {
      points.push(point);
      continue;
    }
    const ts = anchor.ts + (index - anchorIndex) * bucket;
    if (ts <= 0) continue;
    points.push({
      ts,
      p50: null,
      p10: null,
      p90: null,
      samples: 0,
      lossPct: null,
    });
  }
  return sortedSeries(points);
}

function readPositiveInts(raw: unknown, max = Number.POSITIVE_INFINITY): number[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  for (const entry of raw) {
    const value = positiveInt(entry);
    if (value !== null && value <= max) seen.add(value);
  }
  return [...seen].sort((a, b) => a - b);
}

function readDiagnosis(raw: unknown): ChainHealthDiagnosis {
  if (!isRecord(raw)) return { kind: "unknown", seq: null };
  const seq = positiveInt(raw.seq);
  if (raw.kind === "single_hop") return { kind: "single_hop", seq };
  if (raw.kind === "overall") return { kind: "overall", seq: null };
  return { kind: "unknown", seq: null };
}

/**
 * 丢包百分比：只接受 0–100 的有限数。
 *
 * 越界值（负数 / 120%）按「数据不可信」处理返回 null，宁可显示 — 也不把它
 * 夹成 0% 或 100% 伪造一个看似正常的读数。
 */
function readLossPct(value: unknown): number | null {
  const number = finiteNumber(value);
  if (number === null || number < 0 || number > 100) return null;
  return number;
}

function readLossSamples(raw: unknown): ChainLossSamples | null {
  if (!isRecord(raw)) return null;
  const attempts = positiveInt(raw.attempts);
  // attempts 是比值的分母：没有它就没有可展示的探测次数，整组按缺失处理。
  if (attempts === null) return null;
  const failures = finiteInt(raw.failures);
  // 失败数大于探测数是脏数据：整组计数不渲染，而不是画一个不可能的比值。
  if (failures !== null && failures > attempts) return null;
  return { attempts, failures };
}

/** TCP 端口：只接受 1–65535；越界按「没有端口」处理，不夹成一个假端口。 */
function readPort(value: unknown): number | null {
  const port = positiveInt(value);
  return port !== null && port <= 65_535 ? port : null;
}

/**
 * 归一化 `chains[].entry` / `chains[].exit`。
 *
 * 契约同时给 `ip` / `port` / `address` / `server_name`；任一侧为空都不算错误。
 * `address` 缺失时用 `ip:port` 拼，拼不出来就保持 null（列表显示 `—`）。
 * 整个对象没有任何可用字段时返回 null，表示旧主控没有这个能力。
 */
function readEndpoint(raw: unknown): ChainEndpoint | null {
  if (!isRecord(raw)) return null;
  const ip = trimmedString(raw.ip);
  const port = readPort(raw.port);
  // 契约显式给 `address: null` 时必须显示 `—`；只有字段**缺失**时才用
  // `ip:port` 拼。否则「这一侧没有可展示地址」会被悄悄补成一个假地址。
  const address =
    "address" in raw
      ? trimmedString(raw.address)
      : ip !== null && port !== null
        ? `${ip}:${port}`
        : null;
  const serverName = trimmedString(raw.server_name);
  if (
    ip === null &&
    port === null &&
    address === null &&
    serverName === null
  ) {
    return null;
  }
  return { ip, port, address, serverName };
}

function readSegment(
  raw: unknown,
  window?: SeriesWindowSpec,
): ChainHealthSegment | null {
  if (!isRecord(raw)) return null;
  const seq = positiveInt(raw.seq);
  if (seq === null) return null;
  const contribution = finiteNumber(raw.contribution_pct);
  const attempts = positiveInt(raw.attempts);
  const failures = finiteInt(raw.failures);
  // 失败数不能大于探测数；脏数据按「没有计数」处理，避免渲染 11 / 10。
  const probesValid =
    attempts === null || failures === null || failures <= attempts;
  return {
    seq,
    from: trimmedString(raw.from),
    to: trimmedString(raw.to),
    p50: nonNegativeNumber(raw.p50),
    deltaMs: finiteNumber(raw.delta_ms),
    contributionPct:
      contribution === null ? null : clamp(contribution, 0, 100),
    missing: false,
    lossPct: readLossPct(raw.loss_pct),
    attempts: probesValid ? attempts : null,
    failures: probesValid ? failures : null,
    series: readSeries(raw.series, window),
  };
}

/**
 * 逐段行：契约只给有样本的段 + `missing_hops`，这里补齐成 1..hops 的连续行，
 * 缺数据的跳以 `missing: true` 出现，最后一跳缺失才能被明确标出。
 */
function buildSegments(
  rawSegments: unknown,
  rawHops: unknown,
  rawMissing: unknown,
  window?: SeriesWindowSpec,
): { segments: ChainHealthSegment[]; missingHops: number[]; lastHopMissing: boolean } {
  const bySeq = new Map<number, ChainHealthSegment>();
  if (Array.isArray(rawSegments)) {
    for (const raw of rawSegments) {
      const segment = readSegment(raw, window);
      if (segment) bySeq.set(segment.seq, segment);
    }
  }
  // 契约最多 8 组（7 段）；>32 的 missing_hops 是脏数据，直接丢弃。
  const declaredMissing = readPositiveInts(rawMissing, 32);
  const maxSeq = Math.max(
    0,
    ...[...bySeq.keys()],
    ...declaredMissing,
    positiveInt(rawHops) ?? 0,
  );
  // 契约最多 8 组（7 段）；夹住异常值，避免脏数据生成巨大列表。
  const totalHops = Math.min(32, maxSeq);

  const segments: ChainHealthSegment[] = [];
  for (let seq = 1; seq <= totalHops; seq += 1) {
    const segment = bySeq.get(seq);
    if (segment) {
      segments.push(segment);
      continue;
    }
    segments.push({
      seq,
      from: null,
      to: null,
      p50: null,
      deltaMs: null,
      contributionPct: null,
      missing: true,
      lossPct: null,
      attempts: null,
      failures: null,
      series: [],
    });
  }

  // 贡献占比缺失时，用各段正增量补齐；没有正增量就不编造比例。
  const deltaSum = segments.reduce(
    (sum, segment) =>
      segment.deltaMs !== null && segment.deltaMs > 0
        ? sum + segment.deltaMs
        : sum,
    0,
  );
  if (deltaSum > 0) {
    for (const segment of segments) {
      if (
        segment.contributionPct === null &&
        segment.deltaMs !== null &&
        segment.deltaMs > 0
      ) {
        segment.contributionPct = clamp(
          (segment.deltaMs / deltaSum) * 100,
          0,
          100,
        );
      }
    }
  }

  const missingHops = segments
    .filter((segment) => segment.missing)
    .map((segment) => segment.seq);
  return {
    segments,
    missingHops,
    lastHopMissing:
      segments.length > 0 && segments[segments.length - 1].missing,
  };
}

function chainDelta(segments: readonly ChainHealthSegment[]): number | null {
  let sum = 0;
  let found = false;
  for (const segment of segments) {
    if (segment.deltaMs === null) continue;
    found = true;
    sum += segment.deltaMs;
  }
  return found ? sum : null;
}

function latestSeriesP50(series: readonly ChainHealthPoint[]): number | null {
  for (let index = series.length - 1; index >= 0; index -= 1) {
    const value = series[index].p50;
    if (value !== null) return value;
  }
  return null;
}

function sumSegmentP50(segments: readonly ChainHealthSegment[]): number | null {
  let sum = 0;
  let found = false;
  for (const segment of segments) {
    if (segment.p50 === null) continue;
    found = true;
    sum += segment.p50;
  }
  return found ? sum : null;
}

function readChain(
  raw: unknown,
  window?: SeriesWindowSpec,
): ChainHealthChain | null {
  if (!isRecord(raw)) return null;
  const id = trimmedString(raw.id);
  const name = trimmedString(raw.name);
  if (!id || !name) return null;

  const series = readSeries(raw.series, window);
  const built = buildSegments(raw.segments, raw.hops, raw.missing_hops, window);
  const segments = built.segments;
  const deltaMs = chainDelta(segments);
  const latestP50 = latestSeriesP50(series) ?? sumSegmentP50(segments);
  const estimatedRaw =
    typeof raw.estimated === "boolean" ? raw.estimated : null;
  const diagnosis = readDiagnosis(raw.diagnosis);
  const hasSamples =
    series.some((point) => point.p50 !== null) ||
    segments.some((segment) => segment.p50 !== null);

  return {
    id,
    name,
    hops: clamp(
      Math.max(
        segments.length,
        positiveInt(raw.hops) ?? 1,
        built.missingHops.length,
      ),
      1,
      32,
    ),
    entry: readEndpoint(raw.entry),
    exit: readEndpoint(raw.exit),
    missingHops: built.missingHops,
    estimated: estimatedRaw ?? built.missingHops.length > 0,
    series,
    segments,
    diagnosis,
    latestP50,
    deltaMs,
    slow: deltaMs !== null && deltaMs >= SLOW_CHAIN_DELTA_MS,
    hasSamples,
    lastHopMissing: built.lastHopMissing,
    lossPct: readLossPct(raw.loss_pct),
    lossPartial: raw.loss_partial === true,
    lossSamples: readLossSamples(raw.loss_samples),
  };
}

function worstHopFromChains(
  chains: readonly ChainHealthChain[],
): ChainHealthWorstHop | null {
  let worst: ChainHealthWorstHop | null = null;
  for (const chain of chains) {
    for (const segment of chain.segments) {
      if (segment.p50 === null) continue;
      if (worst !== null && worst.p50Ms !== null && segment.p50 <= worst.p50Ms) {
        continue;
      }
      worst = {
        chainId: chain.id,
        chainName: chain.name,
        seq: segment.seq,
        p50Ms: segment.p50,
      };
    }
  }
  return worst;
}

function readWorstHop(raw: unknown): ChainHealthWorstHop | null {
  if (!isRecord(raw)) return null;
  const p50Ms = nonNegativeNumber(raw.p50_ms);
  const seq = positiveInt(raw.seq);
  const chainId = trimmedString(raw.chain_id);
  const chainName = trimmedString(raw.chain_name);
  if (p50Ms === null) return null;
  return { chainId, chainName, seq, p50Ms };
}

function worstLossFromChains(
  chains: readonly ChainHealthChain[],
): ChainHealthWorstLoss | null {
  let worst: ChainHealthWorstLoss | null = null;
  for (const chain of chains) {
    if (chain.lossPct === null) continue;
    if (
      worst !== null &&
      worst.lossPct !== null &&
      chain.lossPct <= worst.lossPct
    ) {
      continue;
    }
    worst = {
      chainId: chain.id,
      chainName: chain.name,
      lossPct: chain.lossPct,
    };
  }
  return worst;
}

function readWorstLoss(raw: unknown): ChainHealthWorstLoss | null {
  if (!isRecord(raw)) return null;
  const lossPct = readLossPct(raw.loss_pct);
  if (lossPct === null) return null;
  return {
    chainId: trimmedString(raw.chain_id),
    chainName: trimmedString(raw.chain_name),
    lossPct,
  };
}

function buildSummary(
  raw: Record<string, unknown>,
  chains: readonly ChainHealthChain[],
): ChainHealthSummary {
  const rawSummary = isRecord(raw.summary) ? raw.summary : {};
  const segments = chains.flatMap((chain) => chain.segments);
  const segmentP50 = segments
    .map((segment) => segment.p50)
    .filter((value): value is number => value !== null);
  const segmentDelta = segments
    .map((segment) => segment.deltaMs)
    .filter((value): value is number => value !== null);
  const chainDeltaValues = chains
    .map((chain) => chain.deltaMs)
    .filter((value): value is number => value !== null);

  const hopP50 =
    nonNegativeNumber(rawSummary.hop_p50_ms) ??
    median(segmentP50) ??
    median(
      chains
        .map((chain) => chain.latestP50)
        .filter((value): value is number => value !== null),
    );
  const deltaMs =
    finiteNumber(rawSummary.delta_ms) ??
    median(segmentDelta) ??
    median(chainDeltaValues);
  const slowChains =
    finiteInt(rawSummary.slow_chains) ??
    chains.filter((chain) => chain.slow).length;
  const totalChains = finiteInt(rawSummary.total_chains) ?? chains.length;
  const worstHop =
    readWorstHop(rawSummary.worst_hop) ?? worstHopFromChains(chains);
  const worstLoss =
    readWorstLoss(rawSummary.worst_loss) ?? worstLossFromChains(chains);

  return {
    hopP50,
    deltaMs,
    slowChains,
    totalChains,
    worstHop,
    lossPct: readLossPct(rawSummary.loss_pct),
    worstLoss,
  };
}

function buildSnapshot(
  raw: Record<string, unknown>,
  chains: ChainHealthChain[],
): ChainHealthSnapshot {
  return {
    generatedAt: unixSeconds(raw.generated_at),
    hours: finiteInt(raw.hours) ?? 24,
    bucket: Math.max(1, finiteInt(raw.bucket) ?? 900),
    summary: buildSummary(raw, chains),
    chains,
    hasSamples: chains.some((chain) => chain.hasSamples),
  };
}

/**
 * 归一化接口响应。
 *
 * - 顶层缺 `chains` 数组（旧主控 / 半成品接口）→ `unsupported`；
 * - `chains: []` → `empty`；
 * - 有链但全部没有样本 → 仍是 `ok`，由页面显示「暂无时延样本」；
 * - 缺 `summary` / 某条链缺 `series` / 最后一跳缺数据都是合法状态，按缺数据展示。
 */
export function normalizeChainHealth(raw: unknown): ChainHealthParseResult {
  if (!isRecord(raw) || !Array.isArray(raw.chains)) {
    return { status: "unsupported" };
  }
  const hours = finiteInt(raw.hours) ?? 24;
  const bucketSecs = Math.max(1, finiteInt(raw.bucket) ?? 900);
  const count = Math.max(1, Math.floor((hours * 3600) / bucketSecs));
  const seriesWindow: SeriesWindowSpec = { count, bucketSecs };
  const chains = raw.chains
    .map((entry) => readChain(entry, seriesWindow))
    .filter((chain): chain is ChainHealthChain => chain !== null);
  if (raw.chains.length > 0 && chains.length === 0) {
    return { status: "unsupported" };
  }

  const snapshot = buildSnapshot(raw, chains);
  return chains.length === 0
    ? { status: "empty", snapshot }
    : { status: "ok", snapshot };
}

/** 404 / 403（旧主控或非管理员）都按「能力未上线」处理。 */
export function isChainHealthUnsupported(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.status === 404 || error.status === 403)
  );
}

/** 单条链诊断视图：句子由组件按 kind 渲染，这里只给数字。 */
export interface ChainDiagnosisView {
  kind: ChainDiagnosisKind;
  overallDeltaMs: number | null;
  seq: number | null;
  segmentDeltaMs: number | null;
  contributionPct: number | null;
}

export function chainDiagnosis(chain: ChainHealthChain): ChainDiagnosisView {
  const overallDeltaMs = chain.deltaMs;
  const unknown: ChainDiagnosisView = {
    kind: "unknown",
    overallDeltaMs,
    seq: null,
    segmentDeltaMs: null,
    contributionPct: null,
  };
  if (!chain.hasSamples) return unknown;

  if (chain.diagnosis.kind === "single_hop") {
    const seq = chain.diagnosis.seq;
    const segment = chain.segments.find(
      (item) => item.seq === seq && !item.missing,
    );
    if (!segment || segment.deltaMs === null) return unknown;
    const contribution =
      segment.contributionPct ??
      (overallDeltaMs !== null && overallDeltaMs !== 0
        ? clamp((segment.deltaMs / overallDeltaMs) * 100, 0, 100)
        : null);
    return {
      kind: "single_hop",
      overallDeltaMs,
      seq: segment.seq,
      segmentDeltaMs: segment.deltaMs,
      contributionPct: contribution,
    };
  }

  if (chain.diagnosis.kind === "overall") {
    return {
      kind: "overall",
      overallDeltaMs,
      seq: null,
      segmentDeltaMs: null,
      contributionPct: null,
    };
  }
  return unknown;
}

/** 该链是否有可画的整体 P50 曲线（逐段数据不算）。 */
export function chainHasTrend(chain: ChainHealthChain): boolean {
  return chain.series.some(
    (point) => point.p50 !== null && point.samples > 0,
  );
}

/** 多序列折线的一行：`ts` + 每条有样本链的 P50（无样本为 null）。 */
export interface ChainTrendRow {
  ts: number;
  [chainId: string]: number | null;
}

/**
 * 把多条链的 `series` 合并成一张图的数据。
 *
 * 只把至少有一个有效 P50 的链放进 `series`；样本不足的链留在图例里灰显，
 * 但不进折线图，也不伪造 0。时间轴取所有有样本链的时间戳并集，升序。
 */
export function buildChainTrendData(
  chains: readonly ChainHealthChain[],
): { rows: ChainTrendRow[]; series: ChainHealthChain[] } {
  const series = chains.filter(chainHasTrend);
  const timestamps = new Set<number>();
  const values = new Map<string, Map<number, number | null>>();
  for (const chain of series) {
    const byTs = new Map<number, number | null>();
    for (const point of chain.series) {
      if (!Number.isFinite(point.ts)) continue;
      timestamps.add(point.ts);
      if (point.samples > 0 && point.p50 !== null) {
        byTs.set(point.ts, point.p50);
      } else if (!byTs.has(point.ts)) {
        byTs.set(point.ts, null);
      }
    }
    values.set(chain.id, byTs);
  }
  const rows = [...timestamps]
    .sort((a, b) => a - b)
    .map((ts) => {
      const row = { ts } as ChainTrendRow;
      for (const chain of series) {
        row[chain.id] = values.get(chain.id)?.get(ts) ?? null;
      }
      return row;
    });
  return { rows, series };
}

/** 列表页一行链路的状态；正常 / 变慢 / 样本不足。 */
export type ChainLatencyStatus = "normal" | "slow" | "insufficient";

export function chainStatus(chain: ChainHealthChain): ChainLatencyStatus {
  if (!chain.hasSamples || chain.deltaMs === null) return "insufficient";
  return chain.slow ? "slow" : "normal";
}

/** 数值变化的语义色：只有后端标记 slow（≥8ms）才 warning。 */
export type ChainDeltaTone = "warning" | "primary" | "muted";

/**
 * 单条链的「较基线」色。
 *
 * `deltaMs > 0` 不等于「变慢」：几毫秒的抖动是噪声。只有 `chain.slow`
 * （后端按 8ms 阈值判定）才 warning；变快用 primary；其余用 muted。
 */
export function chainDeltaTone(
  deltaMs: number | null,
  slow: boolean,
): ChainDeltaTone {
  if (deltaMs === null || deltaMs === 0) return "muted";
  if (slow) return "warning";
  return deltaMs < 0 ? "primary" : "muted";
}

/** KPI「较上一周期」：没有 chain.slow，按同一个 8ms 阈值判断。 */
export function summaryDeltaTone(deltaMs: number | null): ChainDeltaTone {
  if (deltaMs === null || deltaMs === 0) return "muted";
  if (deltaMs >= SLOW_CHAIN_DELTA_MS) return "warning";
  return deltaMs < 0 ? "primary" : "muted";
}

/** 「最慢段」KPI 对应段的 delta；缺口 / 找不到段时 null。 */
export function worstHopDeltaMs(
  chains: readonly ChainHealthChain[],
  worst: ChainHealthWorstHop | null,
): number | null {
  if (worst === null || worst.chainId === null || worst.seq === null) {
    return null;
  }
  const chain = chains.find((item) => item.id === worst.chainId);
  const segment = chain?.segments.find((item) => item.seq === worst.seq);
  return segment?.deltaMs ?? null;
}

/** 「最慢段」KPI 的色：只有该段 delta ≥8ms 才 warning。 */
export function worstHopTone(
  chains: readonly ChainHealthChain[],
  worst: ChainHealthWorstHop | null,
): ChainDeltaTone {
  if (worst === null) return "muted";
  const delta = worstHopDeltaMs(chains, worst);
  if (delta === null || delta === 0) return "muted";
  if (delta >= SLOW_CHAIN_DELTA_MS) return "warning";
  return delta < 0 ? "primary" : "muted";
}

/** 链路拓扑的一条边：段序号 + 该段 P50；没有样本时 missing = true。 */
export interface ChainTopologyEdge {
  seq: number;
  p50: number | null;
  missing: boolean;
}

export interface ChainTopology {
  /** 真实服务器节点，按路径顺序；不包含链目标。 */
  nodes: string[];
  edges: ChainTopologyEdge[];
  /** 最后一跳（最后一组 → 链目标）没有历史数据。 */
  targetMissing: boolean;
}

/**
 * 把逐段行拼成「香港-01 → 东京-01 → …」的完整链路。
 *
 * 只使用有 from/to 的段；最后一跳到链目标没有服务器节点，由
 * `targetMissing` 单独表达，组件在末尾补一个「链目标」节点。
 */
export function chainTopology(chain: ChainHealthChain): ChainTopology {
  const nodes: string[] = [];
  const edges: ChainTopologyEdge[] = [];

  for (const segment of chain.segments) {
    if (segment.missing || !segment.from || !segment.to) continue;
    if (nodes.length === 0) nodes.push(segment.from);
    else if (nodes[nodes.length - 1] !== segment.from) nodes.push(segment.from);
    edges.push({
      seq: segment.seq,
      p50: segment.p50,
      missing: segment.p50 === null,
    });
    if (nodes[nodes.length - 1] !== segment.to) nodes.push(segment.to);
  }

  return { nodes, edges, targetMissing: chain.lastHopMissing };
}

/**
 * 诊断句分支：后端把「整体稳定 / 变快」也归到 `unknown`，所以不能只看
 * kind；有样本且 delta ≤ 0 时是 stable，真正缺样本才是 unknown。
 */
export type ChainDiagnosisReason =
  | "single_hop"
  | "overall"
  | "stable"
  | "unknown";

export function chainDiagnosisReason(
  view: ChainDiagnosisView,
  hasSamples: boolean,
): ChainDiagnosisReason {
  if (view.kind === "single_hop") return "single_hop";
  if (view.kind === "overall") return "overall";
  if (hasSamples && view.overallDeltaMs !== null && view.overallDeltaMs <= 0) {
    return "stable";
  }
  return "unknown";
}

/**
 * 异常窗口：以 P50 中位数为基线，超过 `基线 × 1.5` 且高出至少 8ms 的连续桶。
 * 少于 3 个有效点时返回空数组，避免把两个点之间的抖动误标成异常。
 */
export function chainAnomalyWindows(
  series: readonly ChainHealthPoint[],
  bucketSecs: number,
): ChainAnomalyWindow[] {
  const step = Math.max(1, Math.floor(bucketSecs) || 900);
  const valid = series.filter(
    (point) => point.p50 !== null && point.samples > 0,
  );
  if (valid.length < 3) return [];
  const baseline = median(
    valid.map((point) => point.p50 as number),
  );
  if (baseline === null) return [];
  const threshold = Math.max(
    baseline * ANOMALY_RATIO,
    baseline + ANOMALY_MIN_DELTA_MS,
  );

  const windows: ChainAnomalyWindow[] = [];
  let open: ChainAnomalyWindow | null = null;
  let previousTs: number | null = null;

  const close = () => {
    if (open) windows.push(open);
    open = null;
  };

  for (const point of series) {
    const value = point.p50;
    const anomaly =
      value !== null && point.samples > 0 && value > threshold;
    if (!anomaly) {
      close();
      previousTs = point.ts;
      continue;
    }
    if (
      open &&
      previousTs !== null &&
      point.ts - previousTs <= step * 1.5
    ) {
      open.endTs = point.ts;
      open.peakMs = Math.max(open.peakMs, value);
    } else {
      close();
      open = { startTs: point.ts, endTs: point.ts, peakMs: value };
    }
    previousTs = point.ts;
  }
  close();
  return windows;
}

/** 独立纵轴的最大值：优先 P90，缺失时用 P50；没有数据返回 0。 */
export function chainSeriesMax(series: readonly ChainHealthPoint[]): number {
  let max = 0;
  for (const point of series) {
    for (const value of [point.p90, point.p50]) {
      if (value !== null && value > max) max = value;
    }
  }
  return max;
}

/** 曲线的时间窗：第一个与最后一个槽的 `ts`（包含空槽）。 */
export interface ChainSeriesWindow {
  startTs: number;
  endTs: number;
}

export function chainSeriesWindow(
  series: readonly Pick<ChainHealthPoint, "ts">[],
): ChainSeriesWindow | null {
  let first: number | null = null;
  let last: number | null = null;
  for (const point of series) {
    if (!Number.isFinite(point.ts)) continue;
    if (first === null || point.ts < first) first = point.ts;
    if (last === null || point.ts > last) last = point.ts;
  }
  if (first === null || last === null) return null;
  return { startTs: first, endTs: last };
}

/**
 * 时间戳 → viewBox x：`(ts - windowStart) / (windowEnd - windowStart) * width`。
 *
 * 只按时间定位，不按「第几个有效点」定位；否则一个 10 桶的空窗会把后面的
 * 点整体压缩左移。单点 / 零跨度窗口画在中间。
 */
export function chainPointX(
  ts: number,
  window: ChainSeriesWindow,
  width: number,
): number {
  if (!Number.isFinite(width) || width <= 0) return 0;
  const span = window.endTs - window.startTs;
  if (!Number.isFinite(ts) || !(span > 0)) return width / 2;
  const ratio = (ts - window.startTs) / span;
  return clamp(ratio, 0, 1) * width;
}

/**
 * 指定时间桶的「该时刻丢包」；没有这个桶或该桶没有探测时返回 null。
 *
 * 只读 `series[].loss_pct`，**不**回落到 `chain.lossPct`（窗口聚合值）：
 * 图上的时刻值与列表的窗口值必须能区分开。
 */
export function chainLossAt(
  chain: Pick<ChainHealthChain, "series">,
  ts: number | null,
): number | null {
  if (ts === null || !Number.isFinite(ts)) return null;
  const point = chain.series.find((item) => item.ts === ts);
  return point?.lossPct ?? null;
}

/**
 * 最近一次有效时延样本的时间（Unix 秒）：整体序列与逐段序列取最大。
 * 没有任何「p50 非空 + samples > 0」的点时返回 null。
 */
export function chainLatestSampleTs(
  chain: Pick<ChainHealthChain, "series" | "segments">,
): number | null {
  let latest: number | null = null;
  const visit = (points: readonly ChainHealthPoint[]) => {
    for (const point of points) {
      if (point.p50 === null || point.samples <= 0) continue;
      if (latest === null || point.ts > latest) latest = point.ts;
    }
  };
  visit(chain.series);
  for (const segment of chain.segments) visit(segment.series);
  return latest;
}

/**
 * 把 `/chains/{id}/latency` 的 5 分钟点按目标桶聚合成逐段序列。
 * 同一 `(seq, 桶)` 取中位数；没有样本的桶不补 0。
 */
export function segmentTrends(
  points: readonly ChainLatencySample[],
  bucketSecs: number,
): Map<number, ChainHealthPoint[]> {
  const bucket = Math.max(1, Math.floor(bucketSecs) || 900);
  const grouped = new Map<number, Map<number, number[]>>();
  for (const point of points) {
    if (
      !Number.isFinite(point.ts) ||
      !Number.isFinite(point.seq) ||
      !Number.isFinite(point.latency_ms) ||
      // 负时延是无效样本，不能参与中位数。
      point.latency_ms < 0
    ) {
      continue;
    }
    const seq = Math.floor(point.seq);
    if (seq <= 0) continue;
    const ts = Math.floor(point.ts / bucket) * bucket;
    const byTs = grouped.get(seq);
    if (byTs) {
      const values = byTs.get(ts);
      if (values) values.push(point.latency_ms);
      else byTs.set(ts, [point.latency_ms]);
    } else {
      grouped.set(seq, new Map([[ts, [point.latency_ms]]]));
    }
  }

  const trends = new Map<number, ChainHealthPoint[]>();
  for (const [seq, byTs] of grouped) {
    const series = [...byTs.entries()]
      .sort(([a], [b]) => a - b)
      .map(([ts, values]) => ({
        ts,
        p50: median(values),
        p10: null,
        p90: null,
        samples: values.length,
        // 逐段延迟历史来自 `/chains/{id}/latency`，不含探测丢包。
        lossPct: null,
      }));
    trends.set(seq, series);
  }
  return trends;
}

/** 段趋势优先用契约自带的 `series`，没有时用逐段延迟历史。 */
export function segmentSeries(
  segment: ChainHealthSegment,
  trends: ReadonlyMap<number, ChainHealthPoint[]>,
): ChainHealthPoint[] {
  return segment.series.length > 0
    ? segment.series
    : (trends.get(segment.seq) ?? []);
}

/**
 * 端点地址（`ip:port`）；整个端点缺失或 address 为 null 都显示 `—`。
 *
 * 只做展示，不拿链配置里的组信息兜底：契约没上线时列表整列 `—`，
 * 比猜一个「看起来像起点」的地址更安全。
 */
export function chainEndpointAddress(endpoint: ChainEndpoint | null): string {
  return endpoint?.address ?? "—";
}

/** 端点服务器名；缺失显示 `—`（与地址独立，可能只有其中一项）。 */
export function chainEndpointServerName(
  endpoint: ChainEndpoint | null,
): string {
  return endpoint?.serverName ?? "—";
}

/** 地址缺失原因，用于列表 title：整段缺失 / 没给地址 / 正常。 */
export function chainEndpointAddressIssue(
  endpoint: ChainEndpoint | null,
): ChainEndpointIssue {
  if (endpoint === null) return "missing";
  return endpoint.address === null ? "no_address" : null;
}

/** 服务器名缺失原因，用于列表 title：整段缺失 / 没给名字 / 正常。 */
export function chainEndpointNameIssue(
  endpoint: ChainEndpoint | null,
): ChainEndpointIssue {
  if (endpoint === null) return "missing";
  return endpoint.serverName === null ? "no_name" : null;
}

/** `43 ms` / `14.1 ms`；null 显示 `—`，不把无样本写成 0ms。 */
export function formatMs(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ms`;
}

/** `+15 ms` / `-3 ms` / `0 ms`；null 显示 `—`。 */
export function formatSignedMs(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value === 0) return "0 ms";
  return `${value > 0 ? "+" : "-"}${formatMs(Math.abs(value))}`;
}

/** 贡献占比：整数百分比，不做四舍五入以外的美化。 */
export function formatPercentValue(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return String(Math.round(value));
}

/**
 * 丢包色阶：`<0.5%` 正常、`0.5–2%` warning、`>2%` destructive。
 *
 * 无数据返回 null（渲染成 muted 的 `—`），不把「没有探测」当成 0% 正常。
 */
export function chainLossTone(value: number | null): ChainLossTone | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value < LOSS_WARNING_PCT) return "normal";
  if (value <= LOSS_DESTRUCTIVE_PCT) return "warning";
  return "destructive";
}

/**
 * 丢包百分比：`1.2%` / `0.3%` / `0%`；null 显示 `—`。
 *
 * 真实测到的极小丢包保留一位小数；不足 0.1% 但大于 0 时写 `<0.1%`，
 * 避免四舍五入成 `0%` 与「没有丢包」混淆。
 */
export function formatLossPct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 10) / 10;
  if (value > 0 && rounded === 0) return "<0.1%";
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

/** 探测计数 `2 / 240`（失败 / 总数）；任一侧缺失、为 0 或失败数超过总数
 * （脏数据）时显示 `—`，不渲染一个不可能的比值。 */
export function formatLossProbes(
  attempts: number | null,
  failures: number | null,
): string {
  if (
    attempts === null ||
    failures === null ||
    attempts <= 0 ||
    failures < 0 ||
    failures > attempts
  ) {
    return "—";
  }
  return `${failures} / ${attempts}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Unix 秒 → UTC+8 的 `MM/DD HH:MM`（15 分钟桶）或 `MM/DD HH:00`（小时桶）。 */
export function formatChainTime(ts: number, bucketSecs = 900): string {
  const date = new Date((ts + 8 * 3600) * 1000);
  if (Number.isNaN(date.getTime())) return "—";
  const hour = pad2(date.getUTCHours());
  const minute =
    bucketSecs >= 3600 ? "00" : pad2(date.getUTCMinutes());
  return `${pad2(date.getUTCMonth() + 1)}/${pad2(date.getUTCDate())} ${hour}:${minute}`;
}

/** 30 秒刷新；与概览的 30–60s 节奏一致。 */
export const CHAIN_HEALTH_POLL_MS = 30_000;
