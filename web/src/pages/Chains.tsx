import { Fragment, useState } from "react";
import { toast } from "sonner";
import {
  ArrowDownIcon,
  ArrowRightIcon,
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
  MobileDataCard,
  PageHeader,
  ProtocolBadge,
  SkeletonCard,
  SkeletonTable,
  TlsBadge,
} from "@/components/common";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ChainFormDialog } from "@/components/chains/ChainFormDialog";
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
  formatMemberEndpoint,
  groupIsDegraded,
  groupKind,
  hopListeningState,
  hopTargetState,
  orderGroups,
  orderMembers,
  type ChainStatus,
  type HopListeningState,
  type HopTargetState,
} from "@/lib/chains";
import {
  hopLatencyLabel,
  hopLatencyTone,
  memberInUse,
  pathModeBadge,
  protocolBadge,
  totalLatencyLabel,
  type HopLatencyTone,
} from "@/lib/chainTopology";
import { isTlsTransport, tlsErrorKey } from "@/lib/chainTls";
import {
  chainEngineMissing,
  chainServersMissingRealm,
  engineMissing,
} from "@/lib/engines";
import { errorText } from "@/lib/errors";
import { formatForwardTarget } from "@/lib/forwards";
import { useChains, useServers, useUpdateChain } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { useIsDesktop } from "@/lib/useIsDesktop";

const CHAIN_COLUMN_COUNT = 7;
const HEAD_CLASS =
  "h-9 px-4 text-xs font-medium tracking-wide text-muted-foreground";

/** 延迟三档 + 无数据的文字色；色值全部走 CSS 变量。 */
const LATENCY_TONE_CLASS: Record<HopLatencyTone, string> = {
  default: "text-foreground",
  warning: "text-warning",
  destructive: "text-destructive",
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
      <div className="flex items-center text-muted-foreground">
        <span
          className="hidden h-px w-2.5 bg-border lg:block"
          aria-hidden="true"
        />
        <ArrowDownIcon className="size-3.5 lg:hidden" aria-hidden="true" />
        <ArrowRightIcon
          className="hidden size-3.5 lg:block"
          aria-hidden="true"
        />
        <span
          className="hidden h-px w-2.5 bg-border lg:block"
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
 * 整链状态列。降级时逐条列出「第 N 组 组名」，
 * 不用展开就能看到坏在哪一组；展开行的成员卡片给出同样的信息与错误原文。
 *
 * realm 链报「realm 未安装」时链本身未必降级（target_ok 没失败），
 * 所以额外用 warning 提示「引擎缺失」，避免把环境问题看成链路健康。
 */
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

  return (
    <div className="flex max-w-64 flex-col gap-0.5">
      <span
        className={cn("inline-flex items-center gap-1.5 text-xs", main.text)}
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
      {status === "degraded" ? (
        <span className="flex flex-col gap-0.5">
          {failing.length > 0 ? (
            failing.map((group) => (
              <span
                key={group.id || group.seq}
                className="truncate type-micro text-warning"
                title={t("chains.list.degradedHint")}
              >
                {t("chains.list.degradedGroup", {
                  seq: group.seq + 1,
                  name: group.name?.trim() || t("chains.detail.unnamedGroup"),
                })}
              </span>
            ))
          ) : (
            <span className="type-micro text-warning">
              {t("chains.list.degradedHint")}
            </span>
          )}
        </span>
      ) : null}
      {missingEngine ? (
        <span
          className="truncate type-micro text-warning"
          title={t("chains.engine.missingTitle")}
        >
          {t("chains.engine.missingHint")}
        </span>
      ) : null}
    </div>
  );
}

function GroupMemberRow({
  member,
  index,
  inUse,
}: {
  member: ChainGroupMember;
  index: number;
  inUse: boolean;
}) {
  const { t } = useI18n();
  const endpoint = formatMemberEndpoint(member);
  const error = member.error.trim();
  const tlsError = tlsErrorKey(member.target_error);
  const degraded = Boolean(member.degraded);

  return (
    <div
      className={cn(
        "rounded-md border px-2 py-1.5 transition-colors duration-150",
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
          <MemberListeningStatus member={member} />
          <MemberTargetStatus member={member} />
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
      {tlsError ? (
        <p
          className="mt-1 flex items-center gap-1 type-micro text-destructive"
          title={member.target_error ?? undefined}
        >
          <TriangleAlertIcon className="size-3 shrink-0" aria-hidden="true" />
          {t(tlsError)}
        </p>
      ) : null}
    </div>
  );
}

/** 一张组卡片：组名 + 策略徽标 + 成员（服务器:端口 + 逐成员状态）。 */
function GroupCard({
  group,
  isEntry,
  pathMode,
  highlight,
}: {
  group: ChainGroup;
  isEntry: boolean;
  pathMode: string;
  highlight: boolean;
}) {
  const { t } = useI18n();
  const members = orderMembers(group.members);
  const degraded = groupIsDegraded(group);
  const kind = groupKind(group);
  const single = kind === "single";
  const inUse = memberInUse(pathMode, members.length);
  const name = group.name?.trim() || t("chains.detail.unnamedGroup");

  return (
    <div
      className={cn(
        "min-w-0 flex-1 rounded-md border bg-card/70 px-2.5 py-2 transition-colors duration-150",
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
                  pathMode={pathMode}
                  highlight={singlePath}
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

function ErrorRow({
  message,
  onRetry,
  retrying,
}: {
  message: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  const { t } = useI18n();

  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={CHAIN_COLUMN_COUNT} className="px-4 py-16">
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 text-center">
          <div className="grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
            <TriangleAlertIcon className="size-5" />
          </div>
          <div>
            <p className="text-sm font-medium">{t("chains.list.loadFailed")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{message}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            disabled={retrying}
          >
            <RefreshCwIcon
              className={cn("size-3.5", retrying && "animate-spin")}
            />
            {t("common.retry")}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function EmptyRow({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={CHAIN_COLUMN_COUNT} className="px-4 py-8">
        <EmptyState
          size="sm"
          icon={WorkflowIcon}
          title={title}
          description={description}
          action={
            <Button variant="outline" size="sm" onClick={onAction}>
              <PlusIcon className="size-3.5" />
              {actionLabel}
            </Button>
          }
        />
      </TableCell>
    </TableRow>
  );
}

export default function ChainsPage() {
  const { t } = useI18n();
  const isDesktop = useIsDesktop();
  const chains = useChains();
  const servers = useServers();

  const [form, setForm] = useState<{
    mode: "create" | "edit";
    chain?: Chain;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Chain | null>(null);
  const [topologyChain, setTopologyChain] = useState<Chain | null>(null);

  const items = chains.data ?? [];
  const showError = chains.isError && !chains.data;
  const loadError = errorText(chains.error, t("chains.loadError"));

  function renderChainName(chain: Chain) {
    const blockedReason = chain.blocked_reason?.trim();
    return (
      <div className="flex items-center gap-1">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-medium" title={chain.name}>
              {chain.name}
            </span>
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
            <ProtocolBadge
              protocol={chain.protocol}
              legacyUdp={chain.udp}
            />
            {isTlsTransport(chain.transport) ? <TlsBadge /> : null}
          </div>
        </div>
      </div>
    );
  }

  function renderChainGroups(chain: Chain, alignEnd = false) {
    const summary = chainGroupSummary(chain.groups);
    return (
      <div
        className={cn(
          "flex flex-col gap-1",
          alignEnd && "items-end",
        )}
      >
        <span className="text-xs tabular-nums text-muted-foreground">
          {t(
            groupCountKey(summary.groups, summary.members),
            {
              groups: summary.groups,
              members: summary.members,
            },
          )}
        </span>
        <div
          className={cn(
            "flex flex-wrap gap-1",
            alignEnd && "justify-end",
          )}
        >
          {orderGroups(chain.groups).map((group) => (
            <StrategyBadge
              key={group.id || group.seq}
              strategy={group.strategy}
            />
          ))}
        </div>
      </div>
    );
  }

  function renderChainEntry(chain: Chain) {
    const entry = entryMember(chain.groups);
    return entry ? (
      <span className="break-all font-mono text-xs" title={t("chains.list.entryHint")}>
        {formatMemberEndpoint(entry)}
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
          <TableCell sticky="left" className="max-w-60 px-4 py-2.5">
            {renderChainName(chain)}
          </TableCell>
          <TableCell className="px-4 py-2.5">
            {renderChainGroups(chain)}
          </TableCell>
          <TableCell className="px-4 py-2.5">
            {renderChainEntry(chain)}
          </TableCell>
          <TableCell className="px-4 py-2.5">
            {renderChainTarget(chain)}
          </TableCell>
          <TableCell className="px-4 py-2.5">
            <ChainStatusCell chain={chain} />
          </TableCell>
          <TableCell className="px-4 py-2.5">
            <ChainEnabledSwitch chain={chain} />
          </TableCell>
          <TableCell sticky="right" className="px-4 py-2.5">
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
              <Button
                variant="outline"
                size="sm"
                onClick={() => setForm({ mode: "create" })}
                disabled={servers.isPending}
              >
                <PlusIcon className="size-3.5" />
                {t("chains.list.add")}
              </Button>
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
          <Table className="min-w-[880px]">
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
                    className={HEAD_CLASS}
                  >
                    {label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {showError ? (
                <ErrorRow
                  message={loadError}
                  onRetry={() => void chains.refetch()}
                  retrying={chains.isFetching}
                />
              ) : items.length === 0 ? (
                <EmptyRow
                  title={t("chains.list.emptyTitle")}
                  description={t("chains.list.emptyDesc")}
                  actionLabel={t("chains.list.emptyAction")}
                  onAction={() => setForm({ mode: "create" })}
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
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setForm({ mode: "create" })}
                    >
                      <PlusIcon className="size-3.5" />
                      {t("chains.list.emptyAction")}
                    </Button>
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
          if (!open) setTopologyChain(null);
        }}
      >
        <DialogContent className="sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-1.5">
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
          {topologyChain ? <ChainGroupsDetail chain={topologyChain} /> : null}
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
