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
}

export type ChainDiagnosisKind = "single_hop" | "overall" | "unknown";

export interface ChainHealthDiagnosis {
  kind: ChainDiagnosisKind;
  seq: number | null;
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
  /** 新契约可能直接给逐段序列；没有时由 `/chains/{id}/latency` 补齐。 */
  series: ChainHealthPoint[];
}

export interface ChainHealthChain {
  id: string;
  name: string;
  hops: number;
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
}

export interface ChainHealthWorstHop {
  chainId: string | null;
  chainName: string | null;
  seq: number | null;
  p50Ms: number | null;
}

export interface ChainHealthSummary {
  hopP50: number | null;
  deltaMs: number | null;
  slowChains: number | null;
  totalChains: number;
  worstHop: ChainHealthWorstHop | null;
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

  const p50 = finiteNumber(raw.p50);
  const p10Raw = finiteNumber(raw.p10);
  const p90Raw = finiteNumber(raw.p90);
  const samplesRaw = finiteInt(raw.samples);
  // 显式 `samples: 0` 表示没有采样：值一律置空，不能画成 0ms。
  const samples = samplesRaw ?? (p50 !== null ? 1 : 0);
  if (samples <= 0) {
    return { ts, p50: null, p10: null, p90: null, samples: 0 };
  }

  let p10 = p10Raw;
  let p90 = p90Raw;
  if (p10 !== null && p90 !== null && p10 > p90) {
    [p10, p90] = [p90, p10];
  }
  return { ts, p50, p10, p90, samples };
}

function readSeries(raw: unknown): ChainHealthPoint[] {
  if (!Array.isArray(raw)) return [];
  const byTs = new Map<number, ChainHealthPoint>();
  for (const entry of raw) {
    const point = readPoint(entry);
    if (point) byTs.set(point.ts, point);
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

function readPositiveInts(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  for (const entry of raw) {
    const value = positiveInt(entry);
    if (value !== null) seen.add(value);
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

function readSegment(raw: unknown): ChainHealthSegment | null {
  if (!isRecord(raw)) return null;
  const seq = positiveInt(raw.seq);
  if (seq === null) return null;
  const contribution = finiteNumber(raw.contribution_pct);
  return {
    seq,
    from: trimmedString(raw.from),
    to: trimmedString(raw.to),
    p50: finiteNumber(raw.p50),
    deltaMs: finiteNumber(raw.delta_ms),
    contributionPct:
      contribution === null ? null : clamp(contribution, 0, 100),
    missing: false,
    series: readSeries(raw.series),
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
): { segments: ChainHealthSegment[]; missingHops: number[]; lastHopMissing: boolean } {
  const bySeq = new Map<number, ChainHealthSegment>();
  if (Array.isArray(rawSegments)) {
    for (const raw of rawSegments) {
      const segment = readSegment(raw);
      if (segment) bySeq.set(segment.seq, segment);
    }
  }
  const declaredMissing = readPositiveInts(rawMissing);
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

function readChain(raw: unknown): ChainHealthChain | null {
  if (!isRecord(raw)) return null;
  const id = trimmedString(raw.id);
  const name = trimmedString(raw.name);
  if (!id || !name) return null;

  const series = readSeries(raw.series);
  const built = buildSegments(raw.segments, raw.hops, raw.missing_hops);
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
    hops: Math.max(
      segments.length,
      positiveInt(raw.hops) ?? 0,
      built.missingHops.length,
    ),
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
  const p50Ms = finiteNumber(raw.p50_ms);
  const seq = positiveInt(raw.seq);
  const chainId = trimmedString(raw.chain_id);
  const chainName = trimmedString(raw.chain_name);
  if (p50Ms === null) return null;
  return { chainId, chainName, seq, p50Ms };
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
    finiteNumber(rawSummary.hop_p50_ms) ??
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

  return { hopP50, deltaMs, slowChains, totalChains, worstHop };
}

function buildSnapshot(
  raw: Record<string, unknown>,
  chains: ChainHealthChain[],
): ChainHealthSnapshot {
  return {
    generatedAt: unixSeconds(raw.generated_at),
    hours: finiteInt(raw.hours) ?? 24,
    bucket: finiteInt(raw.bucket) ?? 900,
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
  const chains = raw.chains
    .map(readChain)
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

/** 一条链最近一个有效 P50；没有样本返回 null。 */
export function chainLatestP50(series: readonly ChainHealthPoint[]): number | null {
  return latestSeriesP50(series);
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
      !Number.isFinite(point.latency_ms)
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
