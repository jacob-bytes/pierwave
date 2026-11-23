import { Fragment, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  ArrowDownIcon,
  ArrowRightIcon,
  BracesIcon,
  MaximizeIcon,
  MinimizeIcon,
  WaypointsIcon,
  InfoIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
  WorkflowIcon,
} from "lucide-react";
import {
  EmptyState,
  EngineBadge,
  ListError,
  ListErrorRow,
  MobileDataCard,
  PageHeader,
  ProtocolBadge,
  ProxyProtocolBadge,
  SkeletonCard,
  SkeletonTable,
  TlsBadge,
  TunnelSecurityBadge,
} from "@/components/common";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ChainFormDialog } from "@/components/chains/ChainFormDialog";
import { ChainFromTemplateDialog } from "@/components/chains/ChainFromTemplateDialog";
import { ChainLatencyTrend } from "@/components/chains/ChainLatencyTrend";
import { ChainProbeHealth } from "@/components/chains/ChainProbeHealth";
import { DeleteChainDialog } from "@/components/chains/DeleteChainDialog";
import { StrategyBadge } from "@/components/chains/StrategyBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Chain, ChainGroup, ChainGroupMember } from "@/lib/api";
import {
  chainGroupSummary,
  chainStatus,
  degradedGroups,
  entryMember,
  groupIsDegraded,
  groupKind,
  hopListeningState,
  isChainStrategy,
  hopTargetState,
  orderGroups,
  orderMembers,
  weightFieldVisible,
  type ChainStatus,
  type HopListeningState,
  type HopTargetState,
} from "@/lib/chains";
import {
  arrowWarning,
  arrowWidth,
  formatHopTraffic,
  hopLatencyLabel,
  hopLatencyTone,
  isoToUnixSeconds,
  memberInUse,
  memberSeenTone,
  pathModeBadge,
  protocolBadge,
  sumHopTraffic,
  targetErrorKey,
  totalLatencyLabel,
  type HopLatencyTone,
  type MemberSeenTone,
} from "@/lib/chainTopology";
import { isTlsTransport } from "@/lib/chainTls";
import {
  availabilityLabel,
  availabilityTone,
  DEFAULT_AVAILABILITY_THRESHOLD_PERCENT,
  lossLabel,
  memberAvailability,
} from "@/lib/chainProbe";
import {
  chainEngineMissing,
  chainServersMissingRealm,
  engineMissing,
} from "@/lib/engines";
import { errorText } from "@/lib/errors";
import { formatForwardTarget } from "@/lib/forwards";
import { portPairLabel } from "@/lib/publicPort";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";
import {
  useChainTemplates,
  useChains,
  useServers,
  useUpdateChain,
} from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { useIsDesktop } from "@/lib/useIsDesktop";

const CHAIN_COLUMN_COUNT = 8;
const HEAD_CLASS =
  "h-9 px-4 text-xs font-medium tracking-wide text-muted-foreground";

/** 延迟三档 + 无数据的文字色；色值全部走 CSS 变量。 */
const LATENCY_TONE_CLASS: Record<HopLatencyTone, string> = {
  default: "text-foreground",
  warning: "text-warning",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};

/** 最后上报的色调：只有陈旧才是 warning，未上报保持次要文字色。 */
const MEMBER_SEEN_TONE_CLASS: Record<MemberSeenTone, string> = {
  default: "text-muted-foreground",
  warning: "text-warning",
  muted: "text-muted-foreground",
};

/**
 * 进入某个组的那一段延迟。
 *
 * 组内只有一台成员时这段是唯一值；多成员组由策略选路，没有唯一路径，
 * 返回 null 由箭头显示 `—`，不拿某一台的数字冒充整组。
 */
function segmentLatency(group: ChainGroup): number | null {
  const members = orderMembers(group.members);
  return members.length === 1 ? members[0].latency_ms : null;
}

/** 末跳 → 目标：同样只在末跳唯一成员时才有唯一值。 */
function targetLatency(group: ChainGroup | undefined): number | null {
  if (!group) return null;
  const members = orderMembers(group.members);
  return members.length === 1 ? members[0].target_latency_ms : null;
}

/** 英文需要区分单复数：按组数 / 成员数挑文案键，中文四把键文案相同。 */
function groupCountKey(groups: number, members: number): string {
  if (groups === 1) {
    return members === 1
      ? "chains.list.groupCountOneGroupOneMember"
      : "chains.list.groupCountOneGroup";
  }
  return members === 1
    ? "chains.list.groupCountOneMember"
    : "chains.list.groupCount";
}

/** 整链状态：停用走 muted，降级走 warning，正常走主色（在线态）。 */
const CHAIN_STATUS_META: Record<
  ChainStatus,
  { labelKey: string; titleKey: string; dot: string; text: string }
> = {
  disabled: {
    labelKey: "chains.status.disabled",
    titleKey: "chains.status.disabledTitle",
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
  },
  degraded: {
    labelKey: "chains.status.degraded",
    titleKey: "chains.status.degradedTitle",
    dot: "bg-warning",
    text: "text-warning",
  },
  ok: {
    labelKey: "chains.status.ok",
    titleKey: "chains.status.okTitle",
    dot: "bg-primary",
    text: "text-primary",
  },
};

/**
 * 成员的监听状态：`listening=true` 才写「监听中」；
 * `null` 是「未上报」，不是失败。
 */
const MEMBER_LISTENING_META: Record<
  HopListeningState,
  { labelKey: string; dot: string; text: string }
> = {
  listening: {
    labelKey: "chains.member.listening",
    dot: "bg-primary",
    text: "text-primary",
  },
  failed: {
    labelKey: "chains.member.listeningFailed",
    dot: "bg-destructive",
    text: "text-destructive",
  },
  unreported: {
    labelKey: "chains.member.listeningUnreported",
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
  },
};

/** 成员的目标探测状态：`target_ok=false` 写「目标不可达」（destructive）。 */
const MEMBER_TARGET_META: Record<
  HopTargetState,
  { labelKey: string; dot: string; text: string }
> = {
  reachable: {
    labelKey: "chains.member.targetReachable",
    dot: "bg-primary",
    text: "text-primary",
  },
  unreachable: {
    labelKey: "chains.member.targetUnreachable",
    dot: "bg-destructive",
    text: "text-destructive",
  },
  unprobed: {
    labelKey: "chains.member.targetUnprobed",
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
  },
};

function StatusDot({ className }: { className: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-1.5 shrink-0 rounded-full", className)}
    />
  );
}

/**
 * 两跳之间的箭头：上行延迟、下行协议。
 *
 * 延迟为 null 时仍渲染 `—`，否则箭头上下两行会塌掉；
 * 桌面横向箭头、移动端纵向箭头共用同一组数据。
 */
function HopArrow({
  latencyMs,
  protocol,
}: {
  latencyMs: number | null;
  protocol: string;
}) {
  const tone = hopLatencyTone(latencyMs);
  const width = arrowWidth(latencyMs);
  const warning = arrowWarning(latencyMs);

  return (
    <div className="flex shrink-0 flex-row items-center justify-center gap-1.5 py-1 lg:flex-col lg:gap-0.5 lg:py-0">
      {/* 没有实测数据时不画占位横线：留空比一条「—」更干净，箭头和协议标记照常显示 */}
      {latencyMs !== null ? (
        <span
          className={cn(
            "whitespace-nowrap type-micro tabular-nums leading-none",
            LATENCY_TONE_CLASS[tone],
          )}
        >
          {hopLatencyLabel(latencyMs)}
        </span>
      ) : null}
      <div
        className={cn(
          "flex items-center",
          warning ? "text-warning" : "text-muted-foreground",
        )}
      >
        <span
          className={cn(
            "hidden w-2.5 lg:block",
            warning ? "bg-warning" : "bg-border",
          )}
          style={{ height: `${width}px` }}
          aria-hidden="true"
        />
        <ArrowDownIcon
          className="size-3.5 lg:hidden"
          strokeWidth={width}
          aria-hidden="true"
        />
        <ArrowRightIcon
          className="hidden size-3.5 lg:block"
          strokeWidth={width}
          aria-hidden="true"
        />
        <span
          className={cn(
            "hidden w-2.5 lg:block",
            warning ? "bg-warning" : "bg-border",
          )}
          style={{ height: `${width}px` }}
          aria-hidden="true"
        />
      </div>
      <span className="whitespace-nowrap type-micro leading-none text-muted-foreground">
        {protocol}
      </span>
    </div>
  );
}

function MemberListeningStatus({ member }: { member: ChainGroupMember }) {
  const { t } = useI18n();
  const state = hopListeningState(member.listening);
  const meta = MEMBER_LISTENING_META[state];
  // realm 成员报「未安装」：这是引擎缺失，不是端口 / 目标配置错。
  const missingEngine =
    state === "failed" && engineMissing(member.listening, member.error);
  const title =
    state === "listening"
      ? t("chains.member.listeningTitle", {
          server: member.server_name,
          port: member.listen_port,
        })
      : missingEngine
        ? t("chains.engine.memberMissingTitle", {
            server: member.server_name,
          })
        : state === "failed"
          ? t("chains.member.listeningFailedTitle", {
              error: member.error.trim() || t("chains.member.noError"),
            })
          : t("chains.member.listeningUnreportedTitle");

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 type-micro",
        missingEngine ? "text-warning" : meta.text,
      )}
      title={title}
    >
      <StatusDot
        className={cn(
          missingEngine ? "bg-warning" : meta.dot,
          state === "listening" && "motion-safe:animate-pulse",
        )}
      />
      {missingEngine ? t("chains.engine.memberMissing") : t(meta.labelKey)}
    </span>
  );
}

function MemberTargetStatus({ member }: { member: ChainGroupMember }) {
  const { t } = useI18n();
  const state = hopTargetState(member.target_ok);
  const meta = MEMBER_TARGET_META[state];
  const title =
    state === "reachable"
      ? t("chains.member.targetReachableTitle")
      : state === "unreachable"
        ? t("chains.member.targetUnreachableTitle")
        : t("chains.member.targetUnprobedTitle");

  return (
    <span
      className={cn("inline-flex items-center gap-1 type-micro", meta.text)}
      title={title}
    >
      <StatusDot className={meta.dot} />
      {t(meta.labelKey)}
    </span>
  );
}

/**
 * 成员级 24h 可用率徽标。
 *
 * 只换文字色（低于阈值 → `--warning`），不新增色相；没有数据（样本不足 /
 * 旧 Agent）显示 `—` 而非 0%。阈值与链级一致，由后端随链视图下发。
 * title 里带上探测次数，避免把「一次探测」与「一整天的统计」混为一谈。
 */
function MemberAvailabilityBadge({
  member,
  threshold,
}: {
  member: ChainGroupMember;
  threshold: number;
}) {
  const { t } = useI18n();
  const { label, tone } = memberAvailability(member.availability_24h, threshold);
  const title =
    member.availability_24h === null || member.availability_24h === undefined
      ? t("chains.detail.probe.insufficient")
      : `${t("chains.detail.probe.availabilityTitle")} · ${t(
          "chains.detail.probe.attempts",
          { count: member.probe_attempts_24h ?? 0 },
        )}`;

  return (
    <Badge
      variant="outline"
      title={title}
      className={cn(
        "h-4 px-1.5 type-micro font-normal tabular-nums",
        tone === "warning"
          ? "border-warning/40 bg-warning/10 text-warning"
          : tone === "muted"
            ? "border-border/60 bg-muted/30 text-muted-foreground"
            : "border-border/60 bg-muted/30 text-foreground",
      )}
    >
      <span className="sr-only">{t("chains.detail.probe.availability")}</span>
      {label}
    </Badge>
  );
}

/**
 * 整链状态列。降级时逐条列出「第 N 组 组名」，
 * 不用展开就能看到坏在哪一组；展开行的成员卡片给出同样的信息与错误原文。
 *
 * realm 链报「realm 未安装」时链本身未必降级（target_ok 没失败），
 * 所以额外用 warning 提示「引擎缺失」，避免把环境问题看成链路健康。
 */
/** 列表「可用率」单元格：数值优先，低于阈值用 warning，无数据用 `—`。 */
function AvailabilityCell({ chain }: { chain: Chain }) {
  const { t } = useI18n();
  const threshold =
    chain.availability_threshold_percent ??
    DEFAULT_AVAILABILITY_THRESHOLD_PERCENT;
  const availability = chain.availability_24h ?? null;
  const tone = availabilityTone(availability, threshold);
  const title =
    availability === null
      ? t("chains.detail.probe.insufficient")
      : `${t("chains.detail.probe.availabilityTitle")} · ${t(
          "chains.detail.probe.loss",
        )} ${lossLabel(chain.loss_24h)}`;

  return (
    <span
      className={cn(
        "inline-flex items-center font-mono text-xs tabular-nums",
        tone === "warning" && "text-warning",
        tone === "muted" && "text-muted-foreground",
      )}
      title={title}
    >
      {availabilityLabel(availability)}
    </span>
  );
}

function ChainStatusCell({ chain }: { chain: Chain }) {
  const { t } = useI18n();
  const status = chainStatus(chain.enabled, chain.degraded);
  const meta = CHAIN_STATUS_META[status];
  const failing = degradedGroups(chain.groups);
  // 停用的链 Agent 本来就不会监听，不提示引擎缺失。
  const missingEngine = status !== "disabled" && chainEngineMissing(chain);
  // 还没降级但引擎缺失时，主标签用「引擎缺失」代替会误导的「正常」。
  const main =
    missingEngine && status === "ok"
      ? {
          labelKey: "chains.engine.missing",
          dot: "bg-warning",
          text: "text-warning",
        }
      : meta;
  const title =
    missingEngine && status === "ok"
      ? t("chains.engine.missingTitle")
      : t(meta.titleKey);

  // 降级详情可能有很多组：第一组压成同一行的短标签，其余收进 title。
  const degradedText =
    failing.length > 0
      ? t("chains.list.degradedGroup", {
          seq: failing[0].seq + 1,
          name:
            failing[0].name?.trim() || t("chains.detail.unnamedGroup"),
        })
      : t("chains.list.degradedHint");
  const detailTitle = [
    ...failing.map((group) =>
      t("chains.list.degradedGroup", {
        seq: group.seq + 1,
        name: group.name?.trim() || t("chains.detail.unnamedGroup"),
      }),
    ),
    ...(missingEngine ? [t("chains.engine.missingTitle")] : []),
  ].join(" · ");
  const compactDetail =
    status === "degraded"
      ? degradedText
      : missingEngine
        ? t("chains.engine.missing")
        : null;

  return (
    <div
      className="flex max-w-64 items-center gap-1.5"
      title={detailTitle || title}
    >
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 text-xs",
          main.text,
        )}
        title={title}
      >
        <StatusDot
          className={cn(
            main.dot,
            status === "degraded" && "motion-safe:animate-pulse",
          )}
        />
        {t(main.labelKey)}
      </span>
      {compactDetail ? (
        <span className="truncate type-micro text-warning">
          {compactDetail}
        </span>
      ) : null}
    </div>
  );
}

function GroupMemberRow({
  member,
  index,
  inUse,
  isLastHop,
  publicPort,
  showWeight,
  availabilityThreshold,
}: {
  member: ChainGroupMember;
  index: number;
  inUse: boolean;
  isLastHop: boolean;
  /** 入口组的对外端口；其它组 / 未设置时为 null。 */
  publicPort?: number | null;
  /** 加权 + 多成员组：成员行展示权重。 */
  showWeight?: boolean;
  /** 链级可用率阈值（百分比）；成员徽标的 warning 判定与链列表同源。 */
  availabilityThreshold: number;
}) {
  const { t } = useI18n();
  const endpoint = `${member.server_name.trim()}:${portPairLabel(
    member.listen_port,
    publicPort,
  )}`;
  const error = member.error.trim();
  const tlsError = targetErrorKey(member.target_error);
  const degraded = Boolean(member.degraded);
  const now = Date.now();
  const seenSeconds = isoToUnixSeconds(member.last_seen_at);
  const seenTone = memberSeenTone(member.last_seen_at, now);
  const seenLabel =
    seenSeconds === null
      ? t("chains.member.lastSeenNone")
      : t("chains.member.lastSeen", {
          time: formatRelativeTime(seenSeconds, now, true),
        });

  return (
    <Link
      to={`/servers?highlight=${encodeURIComponent(member.server_id)}`}
      aria-label={t("chains.member.openServerAria", {
        server: member.server_name,
      })}
      className={cn(
        "block rounded-md border px-2 py-1.5 transition-colors duration-150 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        degraded
          ? "border-warning/45 bg-warning/5"
          : "border-border/60 bg-background/30",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 type-micro tabular-nums text-muted-foreground">
            {t("chains.detail.member", { seq: index + 1 })}
          </span>
          <span
            className="truncate font-mono text-xs text-foreground"
            title={endpoint}
          >
            {endpoint}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
          {showWeight ? (
            <span
              className="type-micro tabular-nums text-muted-foreground"
              title={t("chains.detail.memberWeightHint")}
            >
              {t("chains.detail.memberWeight", { weight: member.weight })}
            </span>
          ) : null}
          <MemberAvailabilityBadge
            member={member}
            threshold={availabilityThreshold}
          />
          <span
            className={cn(
              "type-micro tabular-nums",
              MEMBER_SEEN_TONE_CLASS[seenTone],
            )}
            title={
              seenSeconds === null
                ? undefined
                : formatAbsoluteTime(seenSeconds)
            }
          >
            {seenLabel}
          </span>
          <MemberListeningStatus member={member} />
          <MemberTargetStatus member={member} />
          {isLastHop && tlsError ? (
            <span
              className="inline-flex items-center gap-1 type-micro text-destructive"
              title={member.target_error ?? undefined}
            >
              <TriangleAlertIcon
                className="size-3 shrink-0"
                aria-hidden="true"
              />
              {t(tlsError)}
            </span>
          ) : null}
          {inUse ? (
            <Badge
              variant="outline"
              className="h-4 border-border/60 px-1.5 type-micro font-normal text-muted-foreground"
            >
              {t("chains.detail.memberInUse")}
            </Badge>
          ) : null}
        </div>
      </div>
      {error ? (
        <p
          className="mt-1 truncate type-micro text-destructive"
          title={t("chains.member.errorTitle", { error })}
        >
          {error}
        </p>
      ) : null}
      {/* 非最后一跳的 target_error 是「上一跳 → 本跳」的握手失败，保留原有提示；
          最后一跳的目标探测失败已经放在状态行里，避免重复。 */}
      {!isLastHop && tlsError ? (
        <p
          className="mt-1 flex items-center gap-1 type-micro text-destructive"
          title={member.target_error ?? undefined}
        >
          <TriangleAlertIcon className="size-3 shrink-0" aria-hidden="true" />
          {t(tlsError)}
        </p>
      ) : null}
    </Link>
  );
}

/** 一张组卡片：组名 + 策略徽标 + 成员（服务器:端口 + 逐成员状态）。 */
function GroupCard({
  group,
  isEntry,
  isLastHop,
  pathMode,
  highlight,
  availabilityThreshold,
}: {
  group: ChainGroup;
  isEntry: boolean;
  isLastHop: boolean;
  pathMode: string;
  highlight: boolean;
  /** 链级可用率阈值（百分比），逐成员徽标共用。 */
  availabilityThreshold: number;
}) {
  const { t } = useI18n();
  const members = orderMembers(group.members);
  const degraded = groupIsDegraded(group);
  const kind = groupKind(group);
  const single = kind === "single";
  // 只有加权 + 多成员组才有权重语义；其它组不显示，避免制造「权重生效了」的错觉。
  const showWeight = weightFieldVisible(group.strategy, members.length);
  const inUse = memberInUse(pathMode, members.length);
  const name = group.name?.trim() || t("chains.detail.unnamedGroup");
  const trafficTotals = sumHopTraffic(members);
  const traffic = formatHopTraffic(trafficTotals.inB, trafficTotals.outB);

  return (
    <div
      className={cn(
        "min-w-0 flex-1 overflow-hidden rounded-md border bg-card/70 px-2.5 py-2 transition-colors duration-150",
        degraded
          ? "border-warning/45 bg-warning/5"
          : "border-border",
        highlight && "ring-1 ring-primary/40",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="shrink-0 type-micro text-muted-foreground">
            {t("chains.detail.hop", { seq: group.seq + 1 })}
          </span>
          {isEntry ? (
            <Badge
              variant="secondary"
              className="h-4 px-1.5 type-micro font-normal"
            >
              {t("chains.detail.entryBadge")}
            </Badge>
          ) : null}
          <Badge
            variant="secondary"
            className="h-4 px-1.5 type-micro font-normal"
          >
            {t(single ? "chains.detail.singleNode" : "chains.detail.groupType")}
          </Badge>
          {!single ? (
            <span
              className="max-w-full truncate text-xs font-medium"
              title={name}
            >
              {name}
            </span>
          ) : null}
          {!single ? <StrategyBadge strategy={group.strategy} /> : null}
          {degraded ? (
            <Badge
              variant="outline"
              className="h-4 border-warning/40 px-1.5 type-micro font-normal text-warning"
            >
              {t("chains.member.degradedBadge")}
            </Badge>
          ) : null}
        </div>
        <span className="shrink-0 type-micro tabular-nums text-muted-foreground">
          {t(
            members.length === 1
              ? "chains.detail.memberCountOne"
              : "chains.detail.memberCount",
            { count: members.length },
          )}
        </span>
      </div>

      {traffic ? (
        // 流量单独占一行：四跳并排时和徽标 / 成员数挤在一行会顶出卡片，
        // 与箭头上的延迟标签视觉重叠。允许在数字之间换行，窄屏不溢出。
        <div
          className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 type-micro tabular-nums text-muted-foreground"
          title={t("chains.detail.hopTrafficTitle")}
        >
          {traffic}
        </div>
      ) : null}

      <div
        className="mt-1.5 flex flex-col gap-1"
        title={t("chains.detail.priorityHint")}
      >
        {members.length === 0 ? (
          <p className="type-micro leading-normal text-muted-foreground">
            {t("chains.detail.emptyMembers")}
          </p>
        ) : (
          members.map((member, index) => (
            <GroupMemberRow
              key={`${member.server_id}:${member.listen_port}:${index}`}
              member={member}
              index={index}
              inUse={inUse}
              isLastHop={isLastHop}
              publicPort={isEntry ? group.public_port : null}
              showWeight={showWeight}
              availabilityThreshold={availabilityThreshold}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** 分组详情：桌面展开行与移动端卡片共用。 */
function ChainGroupsDetail({ chain }: { chain: Chain }) {
  const { t } = useI18n();
  const groups = orderGroups(chain.groups);
  const target = formatForwardTarget(chain.target_host, chain.target_port);
  const pathMode = chain.path_mode ?? "";
  const singlePath = pathMode === "single";
  const hashBadge = pathMode === "hash" ? pathModeBadge(pathMode, t) : null;
  const total = totalLatencyLabel(chain.total_latency_ms);
  const protocol = protocolBadge(chain.protocol);
  const lastGroup = groups[groups.length - 1];
  const lastTargetLatency = targetLatency(lastGroup);
  // 成员徽标的阈值与链列表同源：后端可配，缺省 99。
  const availabilityThreshold =
    chain.availability_threshold_percent ??
    DEFAULT_AVAILABILITY_THRESHOLD_PERCENT;

  return (
    <div className="rounded-lg border border-border bg-muted/25 p-3">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="type-micro font-medium text-muted-foreground">
          {t("chains.detail.title")}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {hashBadge ? (
            <Badge
              variant="outline"
              className="h-4 border-border/60 px-1.5 type-micro font-normal text-muted-foreground"
            >
              {hashBadge}
            </Badge>
          ) : null}
          {total ? (
            <span
              className="type-micro tabular-nums text-muted-foreground"
              title={t("chains.detail.totalLatencyTitle")}
            >
              {t("chains.detail.totalLatency", { total })}
            </span>
          ) : null}
        </div>
      </div>
      <p className="mb-2 type-micro leading-normal text-muted-foreground">
        {t("chains.detail.hint")}
      </p>
      {groups.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("chains.detail.empty")}
        </p>
      ) : (
        <div className="flex min-w-0 flex-col gap-1.5 lg:flex-row lg:items-center">
          {groups.map((group, index) => {
            const next = groups[index + 1];
            return (
              <Fragment key={group.id || group.seq}>
                <GroupCard
                  group={group}
                  isEntry={index === 0}
                  isLastHop={index === groups.length - 1}
                  pathMode={pathMode}
                  highlight={singlePath}
                  availabilityThreshold={availabilityThreshold}
                />
                <HopArrow
                  latencyMs={next ? segmentLatency(next) : lastTargetLatency}
                  protocol={protocol}
                />
              </Fragment>
            );
          })}
          <div
            className={cn(
              "min-w-40 rounded-md border border-primary/25 bg-primary/5 px-2.5 py-2 lg:flex-1",
              singlePath && "ring-1 ring-primary/40",
            )}
          >
            <span className="type-micro text-muted-foreground">
              {t("chains.detail.targetBadge")}
            </span>
            <div
              className="mt-0.5 break-all font-mono text-xs text-foreground"
              title={target}
            >
              {target}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ChainEnabledSwitch({ chain }: { chain: Chain }) {
  const { t } = useI18n();
  const update = useUpdateChain();
  const enabled = Boolean(chain.enabled);

  return (
    <div className="flex items-center gap-2">
      <Switch
        size="sm"
        checked={enabled}
        disabled={update.isPending}
        aria-label={t("chains.toggleAria", {
          action: enabled ? t("chains.disableAction") : t("chains.enableAction"),
          name: chain.name,
        })}
        onCheckedChange={(checked) => {
          update.mutate(
            { id: chain.id, input: { enabled: checked } },
            {
              onSuccess: () => {
                toast.success(
                  checked
                    ? t("chains.enabledToast", { name: chain.name })
                    : t("chains.disabledToast", { name: chain.name }),
                );
              },
              onError: (error) => {
                toast.error(errorText(error, t("chains.toggleError")));
              },
            },
          );
        }}
      />
      <span className="text-xs text-muted-foreground">
        {enabled ? t("common.enabled") : t("common.disabled")}
      </span>
    </div>
  );
}

function EmptyRow({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions: ReactNode;
}) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={CHAIN_COLUMN_COUNT} className="px-4 py-8">
        <EmptyState
          size="sm"
          icon={WorkflowIcon}
          title={title}
          description={description}
          action={actions}
        />
      </TableCell>
    </TableRow>
  );
}

/**
 * 「从模板创建」入口。旧主控不支持时按钮禁用，并解释原因。
 *
 * 禁用按钮本身收不到 hover，所以把 Tooltip 触发层包在 span 上
 * （与服务器页批量勾选同一种做法）。
 */
function FromTemplateButton({
  disabled,
  onOpen,
  size = "sm",
}: {
  disabled: boolean;
  onOpen: () => void;
  size?: "sm" | "default";
}) {
  const { t } = useI18n();
  const label = t("chains.templateCreate.fromTemplate");
  if (!disabled) {
    return (
      <Button variant="outline" size={size} onClick={onOpen}>
        <BracesIcon className="size-3.5" />
        {label}
      </Button>
    );
  }
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button
              variant="outline"
              size={size}
              disabled
              className="pointer-events-none"
            >
              <BracesIcon className="size-3.5" />
              {label}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {t("chains.templateCreate.requiresNewMaster")}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export default function ChainsPage() {
  const { t } = useI18n();
  const isDesktop = useIsDesktop();
  const chains = useChains();
  const servers = useServers();
  const templates = useChainTemplates();

  const [form, setForm] = useState<{
    mode: "create" | "edit";
    chain?: Chain;
  } | null>(null);
  const [templateFormOpen, setTemplateFormOpen] = useState(false);
  const [templateUnsupported, setTemplateUnsupported] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Chain | null>(null);
  const [topologyChain, setTopologyChain] = useState<Chain | null>(null);
  const [topologyFullscreen, setTopologyFullscreen] = useState(false);

  const items = chains.data ?? [];
  const showError = chains.isError && !chains.data;
  const isEmpty = chains.data !== undefined && !chains.isError && items.length === 0;
  const loadError = errorText(chains.error, t("chains.loadError"));
  const templatesError = templates.isError
    ? errorText(templates.error, t("chains.templateCreate.templateLoadError"))
    : null;

  function renderChainName(chain: Chain, compact = false) {
    const blockedReason = chain.blocked_reason?.trim();
    return (
      <div
        className={cn(
          "flex min-w-0",
          compact ? "items-center gap-1.5" : "flex-col gap-1",
        )}
      >
        {/* 表格行（compact）里名字与徽标同排，行高保持在 40px 基线；
            移动端卡片空间宽裕，仍让名字独占一行，徽标换行排列。 */}
        <span
          className={cn(
            "truncate font-medium",
            compact && "max-w-40 shrink-0",
          )}
          title={chain.name}
        >
          {chain.name}
        </span>
        <div
          className={cn(
            "flex min-w-0 items-center gap-1",
            !compact && "flex-wrap",
          )}
        >
            {chain.source === "user" ? (
              <Badge
                variant="outline"
                className="h-4 shrink-0 border-border/80 bg-muted/40 px-1.5 type-micro font-normal text-muted-foreground"
                title={t("chains.list.userSourceTitle")}
              >
                {t("chains.list.userSource")}
              </Badge>
            ) : null}
            {chain.path_mode === "single" ? (
              <Badge
                variant="outline"
                className="h-4 shrink-0 border-primary/40 bg-primary/10 px-1.5 type-micro font-normal text-primary"
              >
                {pathModeBadge("single", t)}
              </Badge>
            ) : null}
            {blockedReason ? (
              <span
                role="img"
                aria-label={blockedReason}
                title={blockedReason}
                data-blocked="true"
                className="inline-flex shrink-0 text-warning"
              >
                <TriangleAlertIcon
                  className="size-3.5"
                  aria-hidden="true"
                />
              </span>
            ) : null}
            <EngineBadge
              engine={chain.engine}
              realmUnavailable={chainServersMissingRealm(
                chain,
                servers.data ?? [],
              )}
            />
            <TunnelSecurityBadge
              engine={chain.engine}
              security={chain.tunnel_security}
            />
            <ProtocolBadge
              protocol={chain.protocol}
              legacyUdp={chain.udp}
            />
            <ProxyProtocolBadge value={chain.proxy_protocol} />
          {isTlsTransport(chain.transport) ? <TlsBadge /> : null}
        </div>
      </div>
    );
  }

  function renderChainGroups(
    chain: Chain,
    alignEnd = false,
    compact = false,
  ) {
    const summary = chainGroupSummary(chain.groups);
    const countLabel = t(
      groupCountKey(summary.groups, summary.members),
      {
        groups: summary.groups,
        members: summary.members,
      },
    );
    const ordered = orderGroups(chain.groups);
    const badges = ordered.map((group) => (
      <StrategyBadge
        key={group.id || group.seq}
        strategy={group.strategy}
      />
    ));

    // 表格行：跳数 + 策略徽标同一行，行高不因组数增加而翻倍。
    // 超过 2 组时只铺前两个徽标，其余收成 +N（完整策略在 title 里），
    // 避免长链把「可用率 / 启用」列挤到横向滚动区外。
    if (compact) {
      const MAX_VISIBLE_BADGES = 2;
      const hiddenCount = Math.max(0, badges.length - MAX_VISIBLE_BADGES);
      const strategyTitle = ordered
        .map((group) =>
          t(
            isChainStrategy(group.strategy)
              ? `chains.strategy.${group.strategy}.label`
              : "chains.strategy.unknown.label",
          ),
        )
        .join(" · ");
      return (
        <div
          className="flex items-center gap-1.5"
          title={[countLabel, strategyTitle].filter(Boolean).join(" · ")}
        >
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {countLabel}
          </span>
          <div className="flex items-center gap-1">
            {badges.slice(0, MAX_VISIBLE_BADGES)}
            {hiddenCount > 0 ? (
              <Badge
                variant="outline"
                className="h-5 px-1.5 type-micro font-normal text-muted-foreground"
              >
                +{hiddenCount}
              </Badge>
            ) : null}
          </div>
        </div>
      );
    }

    return (
      <div
        className={cn(
          "flex flex-col gap-1",
          alignEnd && "items-end",
        )}
      >
        <span className="text-xs tabular-nums text-muted-foreground">
          {countLabel}
        </span>
        <div
          className={cn(
            "flex flex-wrap gap-1",
            alignEnd && "justify-end",
          )}
        >
          {badges}
        </div>
      </div>
    );
  }

  function renderChainEntry(chain: Chain) {
    const entryGroup = orderGroups(chain.groups)[0];
    const entry = entryMember(chain.groups);
    return entry ? (
      <span
        className="break-all font-mono text-xs"
        title={
          entryGroup?.public_port == null
            ? t("chains.list.entryHint")
            : `${t("chains.list.entryHint")} · ${t(
                "chains.list.portPairHint",
              )}`
        }
      >
        {entry.server_name.trim()}:
        {portPairLabel(entry.listen_port, entryGroup?.public_port)}
      </span>
    ) : (
      <span className="text-xs text-muted-foreground">
        {t("chains.list.noEntry")}
      </span>
    );
  }

  function renderChainTarget(chain: Chain) {
    const target = formatForwardTarget(chain.target_host, chain.target_port);
    return (
      <span
        className="break-all font-mono text-xs text-muted-foreground"
        title={target}
      >
        {target}
      </span>
    );
  }

  function renderChainActions(chain: Chain) {
    return (
      <div className="flex items-center gap-0.5">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("chains.list.topologyAria", { name: chain.name })}
        title={t("chains.list.topology")}
        onClick={() => setTopologyChain(chain)}
      >
        <WaypointsIcon className="size-4" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("chains.actionsAria", {
              name: chain.name,
            })}
          >
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-36">
          <DropdownMenuItem
            onSelect={() => setForm({ mode: "edit", chain })}
          >
            <PencilIcon className="size-3.5" />
            {t("common.edit")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setDeleteTarget(chain)}
          >
            <Trash2Icon className="size-3.5" />
            {t("common.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      </div>
    );
  }

  function renderRow(chain: Chain) {
    return (
      <TableRow key={chain.id}>
          <TableCell sticky="left" className="px-4">
            {renderChainName(chain, true)}
          </TableCell>
          <TableCell className="px-4">
            {renderChainGroups(chain, false, true)}
          </TableCell>
          <TableCell className="px-4">
            {renderChainEntry(chain)}
          </TableCell>
          <TableCell className="px-4">
            {renderChainTarget(chain)}
          </TableCell>
          <TableCell className="px-4">
            <ChainStatusCell chain={chain} />
          </TableCell>
          <TableCell className="px-4 text-right">
            <AvailabilityCell chain={chain} />
          </TableCell>
          <TableCell className="px-4">
            <ChainEnabledSwitch chain={chain} />
          </TableCell>
          <TableCell sticky="right" className="px-4">
            {renderChainActions(chain)}
          </TableCell>
      </TableRow>
    );
  }

  function renderCard(chain: Chain) {
    return (
      <MobileDataCard
        key={chain.id}
        title={renderChainName(chain)}
        actions={renderChainActions(chain)}
        fields={[
          {
            label: t("chains.list.columns.groups"),
            value: renderChainGroups(chain, true),
          },
          {
            label: t("chains.list.columns.entry"),
            value: renderChainEntry(chain),
          },
          {
            label: t("chains.list.columns.target"),
            value: renderChainTarget(chain),
          },
          {
            label: t("chains.list.columns.status"),
            value: <ChainStatusCell chain={chain} />,
          },
          {
            label: t("chains.list.columns.availability"),
            value: <AvailabilityCell chain={chain} />,
          },
          {
            label: t("chains.list.columns.enabled"),
            value: <ChainEnabledSwitch chain={chain} />,
          },
        ]}
      />
    );
  }


  return (
    <div className="animate-enter space-y-6">
      <PageHeader
        title={t("chains.title")}
        description={t("chains.subtitle")}
      />

      <Card className="gap-0 overflow-hidden">
        <CardHeader className="border-b border-border">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              {t("chains.list.title")}
              {chains.data ? (
                <Badge
                  variant="secondary"
                  className="font-mono type-micro font-normal text-muted-foreground"
                >
                  {items.length}
                </Badge>
              ) : null}
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void chains.refetch()}
                disabled={chains.isFetching}
              >
                <RefreshCwIcon
                  className={cn(
                    "size-3.5",
                    chains.isFetching && "animate-spin",
                  )}
                />
                {t("common.refresh")}
              </Button>
              {isEmpty ? null : (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setForm({ mode: "create" })}
                    disabled={servers.isPending}
                  >
                    <PlusIcon className="size-3.5" />
                    {t("chains.list.add")}
                  </Button>
                  <FromTemplateButton
                    disabled={templateUnsupported}
                    onOpen={() => setTemplateFormOpen(true)}
                  />
                </>
              )}
            </div>
          </div>
          <CardDescription className="text-xs">
            {t("chains.list.desc")}
          </CardDescription>
          <div className="mt-2 flex items-start gap-1.5 type-micro leading-normal text-muted-foreground">
            <InfoIcon className="mt-px size-3 shrink-0" aria-hidden="true" />
            <span>{t("chains.relayNote")}</span>
          </div>
        </CardHeader>

        <CardContent className="p-0" aria-busy={chains.isPending}>
          {chains.isPending && isDesktop ? (
            <SkeletonTable rows={4} columns={CHAIN_COLUMN_COUNT} />
          ) : null}
          {chains.isPending && !isDesktop ? (
            <div className="space-y-3 p-3">
              {Array.from({ length: 3 }).map((_, index) => (
                <SkeletonCard key={index} lines={5} />
              ))}
            </div>
          ) : null}
          {isDesktop ? (
          <div className={cn(chains.isPending && "hidden")}>
          <Table className="min-w-[960px]">
            <TableCaption className="sr-only">
              {t("chains.list.tableCaption")}
            </TableCaption>
            <TableHeader className="bg-muted/30">
              <TableRow>
                {[
                  t("chains.list.columns.name"),
                  t("chains.list.columns.groups"),
                  t("chains.list.columns.entry"),
                  t("chains.list.columns.target"),
                  t("chains.list.columns.status"),
                  t("chains.list.columns.availability"),
                  t("chains.list.columns.enabled"),
                  t("common.actions"),
                ].map((label, index, columns) => (
                  <TableHead
                    key={label}
                    sticky={
                      index === 0
                        ? "left"
                        : index === columns.length - 1
                          ? "right"
                          : undefined
                    }
                    className={cn(
                      HEAD_CLASS,
                      // 可用率是百分比列：与数字同侧右对齐。
                      index === 5 && "text-right",
                    )}
                  >
                    {label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {showError ? (
                <ListErrorRow
                  colSpan={CHAIN_COLUMN_COUNT}
                  title={t("chains.list.loadFailed")}
                  message={loadError}
                  retrying={chains.isFetching}
                  onRetry={() => void chains.refetch()}
                />
              ) : items.length === 0 ? (
                <EmptyRow
                  title={t("chains.list.emptyTitle")}
                  description={t("chains.list.emptyDesc")}
                  actions={
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      <Button
                        size="sm"
                        onClick={() => setForm({ mode: "create" })}
                      >
                        <PlusIcon className="size-3.5" />
                        {t("chains.list.emptyAction")}
                      </Button>
                      <FromTemplateButton
                        disabled={templateUnsupported}
                        onOpen={() => setTemplateFormOpen(true)}
                      />
                    </div>
                  }
                />
              ) : (
                items.map(renderRow)
              )}
            </TableBody>
          </Table>
          </div>
          ) : null}

          {!chains.isPending && !isDesktop ? (
            <div className="space-y-3 p-3">
              {showError ? (
                <Card size="sm" className="py-0">
                  <ListError
                    title={t("chains.list.loadFailed")}
                    message={loadError}
                    retrying={chains.isFetching}
                    onRetry={() => void chains.refetch()}
                  />
                </Card>
              ) : items.length === 0 ? (
                <EmptyState
                  size="sm"
                  icon={WorkflowIcon}
                  title={t("chains.list.emptyTitle")}
                  description={t("chains.list.emptyDesc")}
                  action={
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      <Button
                        size="sm"
                        onClick={() => setForm({ mode: "create" })}
                      >
                        <PlusIcon className="size-3.5" />
                        {t("chains.list.emptyAction")}
                      </Button>
                      <FromTemplateButton
                        disabled={templateUnsupported}
                        onOpen={() => setTemplateFormOpen(true)}
                      />
                    </div>
                  }
                />
              ) : (
                items.map(renderCard)
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>

        <Dialog
        open={topologyChain !== null}
        onOpenChange={(open) => {
          if (!open) {
            setTopologyChain(null);
            setTopologyFullscreen(false);
          }
        }}
      >
        <DialogContent
          className={cn(
            "sm:max-w-5xl",
            topologyFullscreen && "max-w-[95vw] sm:max-w-[95vw]",
          )}
        >
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-1.5 pr-16">
              <span className="truncate">{topologyChain?.name}</span>
              {topologyChain?.path_mode === "single" ? (
                <Badge
                  variant="outline"
                  className="h-4 border-primary/40 bg-primary/10 px-1.5 type-micro font-normal text-primary"
                >
                  {t("chains.detail.currentPath")}
                </Badge>
              ) : null}
              <Badge
                variant="outline"
                className="h-4 px-1.5 type-micro font-normal text-muted-foreground"
              >
                {protocolBadge(topologyChain?.protocol)}
              </Badge>
            </DialogTitle>
          </DialogHeader>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute top-2 right-10"
            aria-label={t(
              topologyFullscreen
                ? "chains.detail.exitFullscreen"
                : "chains.detail.fullscreen",
            )}
            aria-pressed={topologyFullscreen}
            title={t(
              topologyFullscreen
                ? "chains.detail.exitFullscreen"
                : "chains.detail.fullscreen",
            )}
            onClick={() => setTopologyFullscreen((value) => !value)}
          >
            {topologyFullscreen ? <MinimizeIcon /> : <MaximizeIcon />}
          </Button>
          {topologyChain ? (
            <div
              className={cn(
                "min-h-0 overflow-y-auto overscroll-contain transition-[max-height] duration-200",
                topologyFullscreen ? "max-h-[90vh]" : "max-h-[70vh]",
              )}
            >
              <ChainGroupsDetail chain={topologyChain} />
              <div className="mt-3">
                <ChainProbeHealth key={`probe-${topologyChain.id}`} chain={topologyChain} />
              </div>
              <div className="mt-3">
                <ChainLatencyTrend
                  key={topologyChain.id}
                  chainId={topologyChain.id}
                />
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {form ? (
      <ChainFormDialog
          key={`${form.mode}-${form.chain?.id ?? "new"}`}
          open
          mode={form.mode}
          chain={form.chain}
          servers={servers.data ?? []}
          loadingServers={servers.isPending}
          onOpenChange={(open) => {
            if (!open) setForm(null);
          }}
        />
      ) : null}

      {templateFormOpen ? (
        <ChainFromTemplateDialog
          open
          templates={templates.data ?? []}
          loadingTemplates={templates.isPending}
          templatesError={templatesError}
          onUnsupported={() => setTemplateUnsupported(true)}
          onOpenChange={(open) => {
            if (!open) setTemplateFormOpen(false);
          }}
        />
      ) : null}

      {deleteTarget ? (
        <DeleteChainDialog
          key={deleteTarget.id}
          open
          chain={deleteTarget}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
        />
      ) : null}
    </div>
  );
}
