import { Fragment, type ReactNode } from "react";
import { ChevronRightIcon, TriangleAlertIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChainLatencySparkline } from "@/components/overview/ChainLatencyChart";
import {
  ChainLatencyRangeTabs,
  ChainLatencyUpdatedBadge,
} from "@/components/overview/ChainLatencyControls";
import { ChainLossValue } from "@/components/overview/ChainLossValue";
import { ChainSegmentTrendChart } from "@/components/overview/ChainSegmentTrendChart";
import { ChainStatusBadge } from "@/components/overview/ChainStatusBadge";
import {
  chainLastHopReasonLabel,
  chainLastHopReasonText,
} from "@/lib/chainStatusText";
import {
  SLOW_CHAIN_DELTA_MS,
  CHAIN_TOPOLOGY_NODE_HEIGHT_PX,
  chainDiagnosis,
  chainDiagnosisReason,
  chainLastHopUnmeasurable,
  chainLatestSeriesTs,
  chainLossTone,
  chainNodeStatusTone,
  chainPointX,
  chainTimeTicks,
  chainTopologyEdgeEstimated,
  chainTopologyGraph,
  chainTopologyMemberRows,
  chainTopologyNodeTier,
  chainTopologyNodeTone,
  formatChainClock,
  formatLossPct,
  formatLossProbes,
  formatMs,
  formatPercentValue,
  formatSignedMs,
  type ChainDiagnosisReason,
  type ChainDiagnosisView,
  type ChainHealthChain,
  type ChainHealthConfig,
  type ChainHealthPoint,
  type ChainHealthSegment,
  type ChainHealthSnapshot,
  type ChainLatencyRange,
  type ChainSeriesWindow,
  type ChainTimeTick,
  type ChainTopologyEdge,
  type ChainTopologyNode,
} from "@/lib/chainHealth";
import { t, useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

function diagnosisText(
  reason: ChainDiagnosisReason,
  view: ChainDiagnosisView,
): string {
  if (reason === "single_hop") {
    return t("overview.chainLatency.diagnosisSingle", {
      delta: formatSignedMs(view.overallDeltaMs),
      seq: view.seq ?? "—",
      segmentDelta: formatSignedMs(view.segmentDeltaMs),
      pct: formatPercentValue(view.contributionPct),
    });
  }
  if (reason === "overall") {
    if (view.overallDeltaMs === null || view.overallDeltaMs === 0) {
      return t("overview.chainLatency.diagnosisOverallFlat");
    }
    return t(
      view.overallDeltaMs > 0
        ? "overview.chainLatency.diagnosisOverallUp"
        : "overview.chainLatency.diagnosisOverallDown",
    );
  }
  if (reason === "stable") {
    return t("overview.chainLatency.diagnosisStable");
  }
  return t("overview.chainLatency.diagnosisUnknown");
}

function DiagnosisBlock({ chain }: { chain: ChainHealthChain }) {
  const diagnosis = chainDiagnosis(chain);
  const reason = chainDiagnosisReason(diagnosis, chain.hasSamples);
  const tone =
    reason === "unknown" || reason === "stable"
      ? "border-border bg-muted/30 text-muted-foreground"
      : "border-primary/30 bg-primary/10 text-foreground";
  return (
    <div
      data-chain-diagnosis
      data-kind={diagnosis.kind}
      role="status"
      className={cn(
        "mt-3 rounded-md border px-3 py-2 text-xs leading-normal",
        tone,
      )}
    >
      {diagnosisText(reason, diagnosis)}
    </div>
  );
}

/** 首节点 SOURCE、尾节点 TARGET、中间按位置编号 HOP 1 / HOP 2 … */
function topologyNodeLabel(index: number, total: number): string {
  if (index === 0) return "SOURCE";
  if (index === total - 1) return "TARGET";
  return `HOP ${index}`;
}

/** 组内成员的状态点：绿呼吸 / 红 / 灰（未知），始终不抢标签的注意力。 */
function MemberDot({ status }: { status: string | null }) {
  const tone = chainNodeStatusTone(status);
  return (
    <span
      data-chain-topology-member-dot
      data-tone={tone}
      aria-hidden="true"
      className={cn(
        "size-[6px] shrink-0 rounded-full",
        tone === "online"
          ? "bg-success status-breathe"
          : tone === "fault"
            ? "bg-destructive"
            : "bg-muted-foreground",
      )}
    />
  );
}

/**
 * 拓扑节点：一个节点代表一个「组」。
 *
 * 顶部 `SOURCE` / `HOP n` / `TARGET` + 组级状态点（取最差成员）+ `2 台`；
 * 主文本是组名；多成员组在下面列出成员（最多两行，其余折叠成 `+N`），
 * 一台成员时不显示列表，保持旧契约的单节点外观。目标节点不是服务器组，
 * 仍是虚线框、无状态点、无成员。
 */
function TopologyNode({
  node,
  index,
  total,
}: {
  node: ChainTopologyNode;
  index: number;
  total: number;
}) {
  const target = node.role === "target";
  const members = target ? [] : node.members;
  const memberCount = target ? null : node.memberCount;
  const tone = chainTopologyNodeTone({ status: node.status, members });
  const { rows, hidden } = chainTopologyMemberRows({ members, memberCount });
  // 只有拿到真实成员才按「组」渲染；只有 member_count 没有 members 的脏
  // 数据回退到单节点外观，避免画一个没有名字的空列表。
  const multi = rows.length > 0;
  // 目标节点不是服务器，没有状态点；旧主控缺状态时也不画点，避免把
  // 「不知道」画成「正常」。多成员组的成员行会逐个画出灰点，组级点仍按
  // 「未知不画」的既有规则。
  const showDot = !target && tone !== "unknown";
  const representative = members[0]?.name.trim() ?? "";
  const name =
    node.name.trim() !== ""
      ? node.name
      : representative !== ""
        ? representative
        : t("overview.chainLatency.chainTarget");
  const tier = chainTopologyNodeTier(multi ? memberCount : null);
  const title = multi
    ? t("overview.chainLatency.memberGroupTitle", {
        name,
        n: memberCount ?? rows.length,
      })
    : name;
  return (
    <span
      data-chain-topology-node
      data-role={node.role}
      data-status={node.status ?? "none"}
      data-member-count={memberCount ?? 0}
      title={title}
      style={{ height: CHAIN_TOPOLOGY_NODE_HEIGHT_PX[tier] }}
      className={cn(
        "relative flex min-w-[112px] flex-1 flex-col items-center justify-center rounded-md border px-2.5 text-center text-xs font-medium",
        multi ? "gap-1 pt-4 pb-1.5" : "",
        target
          ? "border-dashed border-border text-muted-foreground"
          : "border-border bg-card text-foreground",
      )}
    >
      <span
        data-chain-topology-node-label
        className="absolute inset-x-0 top-1 flex items-center justify-center gap-1 px-1 text-[10px] uppercase tracking-wide text-muted-foreground"
      >
        <span>{topologyNodeLabel(index, total)}</span>
        {showDot ? (
          <span
            data-chain-topology-node-dot
            data-tone={tone}
            aria-hidden="true"
            className={cn(
              "size-[7px] shrink-0 rounded-full",
              tone === "online"
                ? "bg-success status-breathe"
                : tone === "fault"
                  ? "bg-destructive"
                  : "bg-muted-foreground",
            )}
          />
        ) : null}
        {multi ? (
          <span
            data-chain-topology-node-count
            className="normal-case tracking-normal"
          >
            {t("overview.chainLatency.memberCountLabel", {
              n: memberCount ?? rows.length,
            })}
          </span>
        ) : null}
      </span>
      <span
        data-chain-topology-node-name
        className="max-w-full truncate leading-none"
      >
        {name}
      </span>
      {rows.length > 0 ? (
        <span
          data-chain-topology-node-members
          className="flex w-full min-w-0 flex-col gap-0.5"
        >
          {rows.map((member, memberIndex) => (
            <span
              key={`${member.serverId ?? member.name}-${memberIndex}`}
              data-chain-topology-member
              data-status={member.status ?? "none"}
              data-tone={chainNodeStatusTone(member.status)}
              title={member.name}
              className="flex min-w-0 items-center gap-1"
            >
              <MemberDot status={member.status} />
              <span className="min-w-0 flex-1 truncate text-left text-[10px] leading-tight text-muted-foreground">
                {member.name}
              </span>
            </span>
          ))}
          {hidden > 0 ? (
            <span
              data-chain-topology-member-more
              className="text-[9px] leading-tight text-muted-foreground"
            >
              {t("overview.chainLatency.memberMore", { n: hidden })}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

/** 拓扑边：链级边 + 该段窗口丢包（没有探测为 null）+ 是否多路径估算。 */
interface TopologyEdgeView extends ChainTopologyEdge {
  lossPct: number | null;
  estimated: boolean;
  /** 最后一跳不可测时的完整文案；可测 / 旧契约 / 中间段为 null。 */
  unmeasurable: string | null;
  /** 不可测原因短标签；用于边的第二行。 */
  unmeasurableReason: string | null;
}

function TopologyEdge({ edge }: { edge: TopologyEdgeView }) {
  const unmeasurable = edge.unmeasurable !== null;
  // 「测不了」不是「没数据」：不再走 missing 的黄色虚线 / 无历史数据文案。
  const missing = !unmeasurable && (edge.missing || edge.p50 === null);
  const measured = missing
    ? t("overview.chainLatency.missingHop")
    : formatMs(edge.p50);
  // 多成员组之间的段是多条路径的汇总；后端标 estimated 时明确加 ≈。
  const latency = edge.estimated && !missing ? `${measured} ≈` : measured;
  const loss = unmeasurable
    ? edge.unmeasurableReason === null
      ? ""
      : t("overview.chainLatency.unmeasurableReasonDetail", {
          reason: edge.unmeasurableReason,
        })
    : formatLossPct(edge.lossPct);
  const estimate = edge.estimated
    ? t("overview.chainLatency.multiPathEstimate")
    : null;
  const title = [edge.unmeasurable ?? latency, loss, estimate]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ");
  return (
    <span
      data-chain-topology-edge
      data-seq={edge.seq}
      data-missing={missing ? "true" : "false"}
      data-unmeasurable={unmeasurable ? "true" : "false"}
      data-estimated={edge.estimated ? "true" : "false"}
      title={title}
      className={cn(
        "relative flex h-14 flex-1 flex-col items-center justify-center px-0.5",
        unmeasurable ? "min-w-[104px]" : "min-w-[80px]",
      )}
    >
      <span
        data-chain-topology-edge-latency
        className={cn(
          "absolute left-1/2 max-w-full -translate-x-1/2 -translate-y-full truncate whitespace-nowrap font-mono text-[10px] leading-none tabular-nums",
          unmeasurable
            ? "text-muted-foreground"
            : missing
              ? "text-warning"
              : "text-muted-foreground",
        )}
        style={{ top: "calc(50% - 3px)" }}
      >
        {unmeasurable ? t("overview.chainLatency.unmeasurable") : latency}
      </span>
      <span
        data-chain-topology-edge-line
        aria-hidden="true"
        className={cn(
          "absolute top-1/2 right-0 left-0 h-0 -translate-y-1/2 border-t",
          unmeasurable
            ? "border-dashed border-border"
            : missing
              ? "border-dashed border-warning/40"
              : "border-border",
        )}
      />
      <ChevronRightIcon
        aria-hidden="true"
        className="absolute top-1/2 right-0 size-3 -translate-y-1/2 text-muted-foreground"
      />
      <span
        data-chain-topology-edge-loss
        data-kind={unmeasurable ? "unmeasurable-reason" : "loss"}
        className="absolute left-1/2 max-w-full -translate-x-1/2 truncate whitespace-nowrap font-mono text-[10px] leading-none tabular-nums text-muted-foreground"
        style={{ top: "calc(50% + 3px)" }}
      >
        {loss}
      </span>
    </span>
  );
}

/**
 * 顶部整体信息：整链 P50 与整链丢包并列。
 *
 * `loss_pct = null` 时显示 muted 的 `—` 并注明「无探测数据」，绝不画成 0%；
 * `loss_partial` 表示部分跳没有探测，丢包只是可见跳的汇总。
 */
function ChainOverallStats({ chain }: { chain: ChainHealthChain }) {
  const samples = chain.lossSamples;
  const lossTitle =
    chain.lossPct === null
      ? t("overview.chainLatency.windowLossNoData")
      : samples !== null && samples.attempts !== null && samples.failures !== null
        ? t("overview.chainLatency.windowLossProbes", {
            attempts: samples.attempts,
            failures: samples.failures,
          })
        : t("overview.chainLatency.windowLoss");

  return (
    <div
      data-chain-overall-stats
      className="flex min-w-0 flex-wrap items-baseline justify-end gap-x-3 gap-y-1 text-[10px] text-muted-foreground"
    >
      <span className="inline-flex items-baseline gap-1.5">
        <span className="text-[10px] text-muted-foreground">P50</span>
        <span className="font-mono text-xs text-foreground tabular-nums">
          {formatMs(chain.latestP50)}
        </span>
      </span>
      <span
        data-chain-loss-summary
        data-loss-tone={chainLossTone(chain.lossPct) ?? "none"}
        title={lossTitle}
        className="inline-flex items-baseline gap-1.5"
      >
        <span className="text-[10px] text-muted-foreground">
          {t("overview.chainLatency.currentWindowLoss")}
        </span>
        <ChainLossValue value={chain.lossPct} className="text-xs" />
      </span>
      {chain.lossPct === null ? (
        <span
          data-chain-loss-nodata
          className="text-[9px] text-muted-foreground"
        >
          {t("overview.chainLatency.lossNoData")}
        </span>
      ) : null}
      {chain.lossPartial ? (
        <span data-chain-loss-partial className="text-[9px] text-warning">
          {t("overview.chainLatency.lossPartial")}
        </span>
      ) : null}
    </div>
  );
}

function ChainTopologyCard({ chain }: { chain: ChainHealthChain }) {
  const topology = chainTopologyGraph(chain);
  const lastHopUnmeasurable = chainLastHopUnmeasurable(chain);
  const unmeasurableText = chainLastHopReasonText(chain);
  const unmeasurableReason = chainLastHopReasonLabel(chain);
  const segmentsBySeq = new Map(
    chain.segments.map((segment) => [segment.seq, segment]),
  );
  /**
   * 把每段窗口丢包贴到对应的拓扑边上；目标跳没有探测，保持 null。
   * `estimated` 只看链级标记 + 该段两端是否多成员组：单节点链即使整体
   * 估算（缺中间跳）也不该在时延后加 ≈。最后一跳不可测时换掉文案，
   * 不再显示「无历史数据」。
   */
  const withLoss = (
    edge: ChainTopologyEdge,
    index: number,
  ): TopologyEdgeView => {
    const isLastEdge = index === topology.edges.length - 1;
    return {
      ...edge,
      lossPct: segmentsBySeq.get(edge.seq)?.lossPct ?? null,
      estimated: chainTopologyEdgeEstimated(
        chain,
        topology.nodes[index],
        topology.nodes[index + 1],
      ),
      unmeasurable:
        isLastEdge && lastHopUnmeasurable ? unmeasurableText : null,
      unmeasurableReason:
        isLastEdge && lastHopUnmeasurable ? unmeasurableReason : null,
    };
  };

  return (
    <Card className="min-w-0 gap-0" data-chain-topology-card>
      <CardHeader className="border-b border-border pb-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <CardTitle className="text-sm font-medium">
            {t("overview.chainLatency.topologyTitle")}
          </CardTitle>
          <ChainOverallStats chain={chain} />
        </div>
      </CardHeader>
      <CardContent className="min-w-0 p-2 sm:p-4">
        {topology.nodes.length === 0 ? (
          <p className="px-1 py-3 text-xs text-muted-foreground">
            {t("overview.chainLatency.noSamplesShort")}
          </p>
        ) : (
          <>
            <div
              className="-mx-1 overflow-x-auto px-1 pb-2"
              data-chain-topology-scroll
            >
              <div
                className="flex w-full min-w-max items-center"
                data-chain-topology
              >
                {topology.nodes.map((node, index) => (
                  <Fragment key={`${node.seq}-${index}`}>
                    <TopologyNode
                      node={node}
                      index={index}
                      total={topology.nodes.length}
                    />
                    {topology.edges[index] ? (
                      <TopologyEdge
                        edge={withLoss(topology.edges[index], index)}
                      />
                    ) : null}
                  </Fragment>
                ))}
              </div>
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground sm:hidden">
              {t("overview.chainLatency.topologyScroll")}
            </p>
          </>
        )}
        {/* 不可测不是「缺数据」：原因已经标在最后一跳的边上，不再叠旧告警。 */}
        {topology.targetMissing && !lastHopUnmeasurable ? (
          <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-normal text-warning">
            <TriangleAlertIcon
              aria-hidden="true"
              className="mt-0.5 size-3 shrink-0"
            />
            <span>{t("overview.chainLatency.missingLastHop")}</span>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * 整体时延图的时间轴：等距刻度 + 末位真实样本时间。
 *
 * 刻度位置与图内竖向 gridline 用同一个 `chainPointX`，所以文字不会和线错位。
 * 首尾标签分别左 / 右对齐，避免被卡片裁掉。
 */
function TimeAxis({
  ticks,
  window,
}: {
  ticks: readonly ChainTimeTick[];
  window: ChainSeriesWindow;
}) {
  return (
    <div
      data-chain-time-axis
      className="relative mt-1 h-3 font-mono text-[9px] text-muted-foreground tabular-nums"
    >
      {ticks.map((tick) => {
        const left = chainPointX(tick.ts, window, 100);
        const transform =
          left < 4
            ? "translateX(0)"
            : left > 96
              ? "translateX(-100%)"
              : "translateX(-50%)";
        return (
          <span
            key={`${tick.kind}-${tick.ts}`}
            data-chain-time-tick
            data-kind={tick.kind}
            data-ts={tick.ts}
            className={cn(
              "absolute top-0 whitespace-nowrap",
              tick.kind === "last" ? "text-foreground" : "text-muted-foreground",
            )}
            style={{ left: `${left}%`, transform }}
          >
            {tick.label}
          </span>
        );
      })}
    </div>
  );
}

function OverallChartCard({
  chain,
  snapshot,
  range,
  onRangeChange,
}: {
  chain: ChainHealthChain;
  snapshot: ChainHealthSnapshot;
  range: ChainLatencyRange;
  onRangeChange: (range: ChainLatencyRange) => void;
}) {
  const hasCurve = chain.series.some(
    (point) => point.p50 !== null && point.samples > 0,
  );
  const chartLabel = t("overview.chainLatency.overallChartAria", {
    name: chain.name,
    p50: formatMs(chain.latestP50),
    delta: formatSignedMs(chain.deltaMs),
  });
  // 轴右端是最后一个真实样本，而不是「现在」：数据滞后时不能把旧值标成当前值。
  const lastSampleTs = chainLatestSeriesTs(chain.series);
  const axisWindow: ChainSeriesWindow | null =
    lastSampleTs === null
      ? null
      : {
          startTs: lastSampleTs - snapshot.hours * 3_600,
          endTs: lastSampleTs,
        };
  const ticks =
    axisWindow === null
      ? []
      : chainTimeTicks(
          axisWindow.startTs,
          axisWindow.endTs,
          snapshot.hours,
          snapshot.bucket,
        );
  const lagSecs =
    snapshot.generatedAt !== null && lastSampleTs !== null
      ? snapshot.generatedAt - lastSampleTs
      : null;
  // 落后超过 5 分钟才补一行「现在」，避免正常的一个桶延迟也刷出参考值。
  const showNow = lagSecs !== null && lagSecs > 300;

  return (
    <Card className="min-w-0 gap-0" data-chain-overall-card>
      <CardHeader className="border-b border-border pb-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <CardTitle className="text-sm font-medium">
            {t("overview.chainLatency.overallTitle")}
          </CardTitle>
          <div className="flex min-w-0 items-center gap-2">
            <ChainLatencyUpdatedBadge generatedAt={snapshot.generatedAt} />
            <ChainLatencyRangeTabs
              range={range}
              onRangeChange={onRangeChange}
            />
          </div>
        </div>
        {hasCurve ? (
          <div
            data-chain-overall-legend
            className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground"
          >
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="h-0.5 w-4 rounded-full bg-primary"
              />
              P50
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="h-2 w-4 rounded-sm bg-primary/15"
              />
              P10–P90
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="h-2 w-4 rounded-sm bg-primary/30"
              />
              {t("overview.chainLatency.anomalyWindow")}
            </span>
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="min-w-0 p-3 sm:p-4">
        {hasCurve && axisWindow !== null ? (
          <ChainLatencySparkline
            points={chain.series}
            window={axisWindow}
            bucketSecs={snapshot.bucket}
            timeTicks={ticks}
            tone="primary"
            label={chartLabel}
            heightClass="h-40 sm:h-56"
          />
        ) : (
          <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">
            {t("overview.chainLatency.overallEmpty")}
          </div>
        )}
        {hasCurve && axisWindow !== null ? (
          <>
            <TimeAxis ticks={ticks} window={axisWindow} />
            {showNow && snapshot.generatedAt !== null ? (
              <p
                data-chain-axis-now
                className="mt-0.5 text-right font-mono text-[9px] text-muted-foreground tabular-nums"
              >
                {t("overview.chainLatency.now")}{" "}
                {formatChainClock(snapshot.generatedAt, snapshot.hours)}
              </p>
            ) : null}
          </>
        ) : null}
        <DiagnosisBlock chain={chain} />
      </CardContent>
    </Card>
  );
}

function segmentRoute(segment: ChainHealthSegment): string {
  return segment.from && segment.to
    ? t("overview.chainLatency.segmentRoute", {
        from: segment.from,
        to: segment.to,
      })
    : t("overview.chainLatency.missingHop");
}

/**
 * 图表下方的贡献占比：每段一行，紧凑；不重复整张图。
 *
 * 段当前 P50 / 窗口丢包放在同一行右侧，是「窗口值」；图表 tooltip 里的
 * 丢包是「该时刻值」，两者不能混。无数据段仍保留一行，值显示 `—`。
 */
function SegmentContributions({ chain }: { chain: ChainHealthChain }) {
  const lastHopUnmeasurable = chainLastHopUnmeasurable(chain);
  const unmeasurableText = chainLastHopReasonText(chain);
  const lastSeq = chain.segments[chain.segments.length - 1]?.seq ?? null;
  return (
    <div
      data-chain-segment-contributions
      className="mt-3 flex flex-col gap-1.5 border-t border-border pt-3"
    >
      {chain.segments.map((segment) => {
        // 最后一跳「测不了」时按原因标注；旧契约 / 中间段仍走 missing。
        const unmeasurable =
          lastHopUnmeasurable && segment.seq === lastSeq;
        const share =
          segment.contributionPct === null
            ? 0
            : Math.max(0, Math.min(100, segment.contributionPct));
        const slowed =
          (chain.diagnosis.kind === "single_hop" &&
            chain.diagnosis.seq === segment.seq) ||
          (segment.deltaMs !== null &&
            segment.deltaMs >= SLOW_CHAIN_DELTA_MS);
        const route = segmentRoute(segment);
        const probes = formatLossProbes(segment.attempts, segment.failures);
        const probesTitle =
          segment.attempts !== null && segment.failures !== null
            ? t("overview.chainLatency.lossProbes", {
                attempts: segment.attempts,
                failures: segment.failures,
              })
            : undefined;
        const label = t("overview.chainLatency.segmentAria", {
          seq: segment.seq,
          route,
          p50: formatMs(segment.p50),
          delta: formatSignedMs(segment.deltaMs),
          pct: formatPercentValue(segment.contributionPct),
          loss: formatLossPct(segment.lossPct),
          probes,
        });
        return (
          <div
            key={segment.seq}
            data-chain-segment
            data-seq={segment.seq}
            data-missing={segment.missing ? "true" : "false"}
            data-unmeasurable={unmeasurable ? "true" : "false"}
            aria-label={
              unmeasurable && unmeasurableText !== null
                ? `${label} · ${unmeasurableText}`
                : label
            }
            className="flex min-w-0 items-center gap-2 text-[10px]"
          >
            <span className="w-12 shrink-0 font-mono text-muted-foreground sm:w-14">
              {t("overview.chainLatency.segment", { seq: segment.seq })}
            </span>
            <span
              className="hidden min-w-0 flex-1 truncate text-muted-foreground sm:block"
              title={route}
            >
              {route}
            </span>
            {unmeasurable ? (
              <span
                data-segment-unmeasurable
                className="min-w-0 flex-1 truncate text-right text-muted-foreground"
                title={unmeasurableText ?? undefined}
              >
                {unmeasurableText}
              </span>
            ) : (
              <>
                <span
                  data-segment-current
                  className="shrink-0 whitespace-nowrap font-mono tabular-nums"
                >
                  <span className="mr-1 text-[9px] text-muted-foreground">
                    P50
                  </span>
                  {formatMs(segment.p50)}
                </span>
                <span
                  data-segment-loss
                  data-loss-tone={chainLossTone(segment.lossPct) ?? "none"}
                  title={probesTitle}
                  className="shrink-0 whitespace-nowrap"
                >
                  <span className="mr-1 text-[9px] text-muted-foreground">
                    {t("overview.chainLatency.windowLoss")}
                  </span>
                  <ChainLossValue
                    value={segment.lossPct}
                    className="text-[10px]"
                  />
                </span>
                <span
                  data-segment-contribution
                  className="flex min-w-10 flex-1 items-center gap-1.5 sm:w-28 sm:flex-none"
                >
                  <span
                    aria-hidden="true"
                    className="h-1.5 min-w-6 flex-1 overflow-hidden rounded-full bg-muted"
                  >
                    <span
                      className={cn(
                        "block h-full rounded-full",
                        slowed ? "bg-warning" : "bg-primary",
                      )}
                      style={{ width: `${share}%` }}
                    />
                  </span>
                  <span className="w-7 shrink-0 text-right text-[9px] text-muted-foreground tabular-nums">
                    {formatPercentValue(segment.contributionPct)}%
                  </span>
                </span>
              </>
            )}
          </div>
        );
      })}
      {noDataHint(chain)}
    </div>
  );
}

/** 全链都没有逐段样本时给一条说明；有数据时不加噪音。 */
function noDataHint(chain: ChainHealthChain): ReactNode {
  return chain.segments.length === 0 ? (
    <p className="py-2 text-xs text-muted-foreground">
      {t("overview.chainLatency.noSamplesShort")}
    </p>
  ) : null;
}

function SegmentsCard({
  chain,
  bucket,
  trends,
  trendPending,
}: {
  chain: ChainHealthChain;
  bucket: number;
  trends: ReadonlyMap<number, ChainHealthPoint[]>;
  trendPending: boolean;
}) {
  const lastHopUnmeasurable = chainLastHopUnmeasurable(chain);
  const unmeasurableText = chainLastHopReasonText(chain);
  const lastSeq = chain.segments[chain.segments.length - 1]?.seq ?? null;
  return (
    <Card className="min-w-0 gap-0" data-chain-segments-card>
      <CardHeader className="border-b border-border pb-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-sm font-medium">
              {t("overview.chainLatency.detailTitle")}
            </CardTitle>
          </div>
          <div className="flex min-w-0 items-center gap-1.5">
            {chain.estimated ? (
              <Badge
                data-chain-estimated-badge
                variant="outline"
                className="shrink-0 font-normal text-muted-foreground"
                title={t("overview.chainLatency.estimatedHint")}
              >
                {t("overview.chainLatency.estimated")}
              </Badge>
            ) : null}
            <Badge
              variant="outline"
              className="max-w-[55vw] font-normal"
              title={chain.name}
            >
              <span className="truncate">{chain.name}</span>
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="min-w-0 p-2 sm:p-4">
        {chain.segments.length === 0 ? (
          <p className="px-2.5 py-3 text-xs text-muted-foreground">
            {t("overview.chainLatency.noSamplesShort")}
          </p>
        ) : (
          <div data-chain-segments>
            <ChainSegmentTrendChart
              segments={chain.segments}
              trends={trends}
              bucketSecs={bucket}
              trendPending={trendPending}
              unmeasurableSeq={
                lastHopUnmeasurable ? lastSeq : null
              }
              unmeasurableLabel={
                lastHopUnmeasurable ? unmeasurableText : null
              }
            />
            <SegmentContributions chain={chain} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * 链路详情内容：弹窗里渲染，顺序按产品稿：
 * 完整链路（含整链 P50 / 丢包）→ 整体时延图（诊断句在图下方）→
 * 逐段多序列折线 + 每段一行的贡献占比。
 *
 * 标题与关闭动作由外层 Dialog 负责，这里不再画面包屑 / 返回按钮。
 */
export function ChainLatencyDetail({
  chain,
  config,
  snapshot,
  range,
  onRangeChange,
  trends,
  trendPending,
}: {
  chain: ChainHealthChain;
  /** 链列表里的配置；用于保留「停用」与旧契约的配置级阻断 / 降级。 */
  config: ChainHealthConfig | null;
  snapshot: ChainHealthSnapshot;
  range: ChainLatencyRange;
  onRangeChange: (range: ChainLatencyRange) => void;
  trends: ReadonlyMap<number, ChainHealthPoint[]>;
  trendPending: boolean;
}) {
  useI18n();
  return (
    <div className="space-y-4" data-chain-detail>
      <div data-chain-detail-status className="flex min-w-0 items-center">
        <ChainStatusBadge chain={chain} config={config} />
      </div>
      <ChainTopologyCard chain={chain} />
      <OverallChartCard
        chain={chain}
        snapshot={snapshot}
        range={range}
        onRangeChange={onRangeChange}
      />
      <SegmentsCard
        chain={chain}
        bucket={snapshot.bucket}
        trends={trends}
        trendPending={trendPending}
      />
    </div>
  );
}
