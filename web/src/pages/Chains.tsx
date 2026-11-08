import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  ArrowRightIcon,
  ChevronRightIcon,
  InfoIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
  WorkflowIcon,
} from "lucide-react";
import { ChainFormDialog } from "@/components/chains/ChainFormDialog";
import { DeleteChainDialog } from "@/components/chains/DeleteChainDialog";
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
import { Skeleton } from "@/components/ui/skeleton";
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
import type { Chain, ChainHop } from "@/lib/api";
import {
  chainStatus,
  degradedHops,
  entryHop,
  formatHopEndpoint,
  hopListeningState,
  hopTargetState,
  orderHops,
  type ChainStatus,
  type HopListeningState,
  type HopTargetState,
} from "@/lib/chains";
import { errorText } from "@/lib/errors";
import { formatForwardTarget } from "@/lib/forwards";
import {
  useChains,
  useServers,
  useUpdateChain,
} from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";

const CHAIN_COLUMN_COUNT = 7;
const HEAD_CLASS =
  "h-9 px-4 text-xs font-medium tracking-wide text-muted-foreground";

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
 * 每跳的监听状态：`listening=true` 才写「监听中」；
 * `null` 是「未上报」，不是失败。
 */
const HOP_LISTENING_META: Record<
  HopListeningState,
  { labelKey: string; dot: string; text: string }
> = {
  listening: {
    labelKey: "chains.hop.listening",
    dot: "bg-primary",
    text: "text-primary",
  },
  failed: {
    labelKey: "chains.hop.listeningFailed",
    dot: "bg-destructive",
    text: "text-destructive",
  },
  unreported: {
    labelKey: "chains.hop.listeningUnreported",
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
  },
};

/** 每跳的目标探测状态：`target_ok=false` 写「目标不可达」（destructive）。 */
const HOP_TARGET_META: Record<
  HopTargetState,
  { labelKey: string; dot: string; text: string }
> = {
  reachable: {
    labelKey: "chains.hop.targetReachable",
    dot: "bg-primary",
    text: "text-primary",
  },
  unreachable: {
    labelKey: "chains.hop.targetUnreachable",
    dot: "bg-destructive",
    text: "text-destructive",
  },
  unprobed: {
    labelKey: "chains.hop.targetUnprobed",
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

function HopListeningStatus({ hop }: { hop: ChainHop }) {
  const { t } = useI18n();
  const state = hopListeningState(hop.listening);
  const meta = HOP_LISTENING_META[state];
  const title =
    state === "listening"
      ? t("chains.hop.listeningTitle", {
          server: hop.server_name,
          port: hop.listen_port,
        })
      : state === "failed"
        ? t("chains.hop.listeningFailedTitle", {
            error: hop.error.trim() || t("chains.hop.noError"),
          })
        : t("chains.hop.listeningUnreportedTitle");

  return (
    <span
      className={cn("inline-flex items-center gap-1 text-[11px]", meta.text)}
      title={title}
    >
      <StatusDot
        className={cn(
          meta.dot,
          state === "listening" && "motion-safe:animate-pulse",
        )}
      />
      {t(meta.labelKey)}
    </span>
  );
}

function HopTargetStatus({ hop }: { hop: ChainHop }) {
  const { t } = useI18n();
  const state = hopTargetState(hop.target_ok);
  const meta = HOP_TARGET_META[state];
  const title =
    state === "reachable"
      ? t("chains.hop.targetReachableTitle")
      : state === "unreachable"
        ? t("chains.hop.targetUnreachableTitle")
        : t("chains.hop.targetUnprobedTitle");

  return (
    <span
      className={cn("inline-flex items-center gap-1 text-[11px]", meta.text)}
      title={title}
    >
      <StatusDot className={meta.dot} />
      {t(meta.labelKey)}
    </span>
  );
}

/**
 * 整链状态列。降级时在徽章下方逐条列出「第 N 跳 服务器:端口」，
 * 不用展开就能看到坏在哪一跳；展开行的逐跳卡片给出同样的信息与错误原文。
 */
function ChainStatusCell({ chain }: { chain: Chain }) {
  const { t } = useI18n();
  const status = chainStatus(chain.enabled, chain.degraded);
  const meta = CHAIN_STATUS_META[status];
  const failing = degradedHops(chain.hops);

  return (
    <div className="flex max-w-64 flex-col gap-0.5">
      <span
        className={cn("inline-flex items-center gap-1.5 text-xs", meta.text)}
        title={t(meta.titleKey)}
      >
        <StatusDot
          className={cn(
            meta.dot,
            status === "degraded" && "motion-safe:animate-pulse",
          )}
        />
        {t(meta.labelKey)}
      </span>
      {status === "degraded" ? (
        <span className="flex flex-col gap-0.5">
          {failing.length > 0 ? (
            failing.map((hop) => (
              <span
                key={hop.seq}
                className="truncate text-[11px] text-warning"
                title={t("chains.list.degradedHint")}
              >
                {t("chains.list.degradedHop", {
                  seq: hop.seq + 1,
                  endpoint: formatHopEndpoint(hop),
                })}
              </span>
            ))
          ) : (
            <span className="text-[11px] text-warning">
              {t("chains.list.degradedHint")}
            </span>
          )}
        </span>
      ) : null}
    </div>
  );
}

function HopCard({ hop, isEntry }: { hop: ChainHop; isEntry?: boolean }) {
  const { t } = useI18n();
  const endpoint = formatHopEndpoint(hop);
  const error = hop.error.trim();

  return (
    <div
      className={cn(
        "min-w-40 flex-1 rounded-md border bg-card/70 px-2.5 py-2 transition-colors duration-150",
        hop.degraded ? "border-warning/45" : "border-border",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span>{t("chains.detail.hop", { seq: hop.seq + 1 })}</span>
          {isEntry ? (
            <Badge
              variant="secondary"
              className="h-4 px-1.5 text-[10px] font-normal"
            >
              {t("chains.detail.entryBadge")}
            </Badge>
          ) : null}
        </span>
        {hop.degraded ? (
          <Badge
            variant="outline"
            className="h-4 border-warning/40 px-1.5 text-[10px] font-normal text-warning"
          >
            {t("chains.hop.degradedBadge")}
          </Badge>
        ) : null}
      </div>
      <div
        className="mt-0.5 truncate font-mono text-xs"
        title={endpoint}
      >
        {endpoint}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
        <HopListeningStatus hop={hop} />
        <HopTargetStatus hop={hop} />
      </div>
      {error ? (
        <p
          className="mt-1 truncate text-[11px] text-destructive"
          title={t("chains.hop.errorTitle", { error })}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** 展开行：按 seq 从左到右画出整条链，最后一站是链目标。 */
function ChainHopsRow({ chain }: { chain: Chain }) {
  const { t } = useI18n();
  const hops = orderHops(chain.hops);
  const target = formatForwardTarget(chain.target_host, chain.target_port);

  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={CHAIN_COLUMN_COUNT} className="px-4 pb-3 pt-0">
        <div className="rounded-lg border border-border bg-muted/25 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t("chains.detail.title")}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {t("chains.detail.hint")}
            </span>
          </div>
          {hops.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("chains.detail.empty")}
            </p>
          ) : (
            <div className="flex flex-col gap-1.5 sm:flex-row sm:items-stretch">
              {hops.map((hop, index) => (
                <Fragment key={hop.seq}>
                  <HopCard hop={hop} isEntry={index === 0} />
                  <div className="hidden shrink-0 items-center text-muted-foreground/60 sm:flex">
                    <ArrowRightIcon className="size-3.5" aria-hidden="true" />
                  </div>
                </Fragment>
              ))}
              <div className="min-w-40 flex-1 rounded-md border border-primary/25 bg-primary/5 px-2.5 py-2">
                <span className="text-[11px] text-muted-foreground">
                  {t("chains.detail.targetBadge")}
                </span>
                <div
                  className="mt-0.5 truncate font-mono text-xs text-foreground"
                  title={target}
                >
                  {target}
                </div>
              </div>
            </div>
          )}
        </div>
      </TableCell>
    </TableRow>
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

function LoadingRows({ rows = 4 }: { rows?: number }) {
  const widths = ["w-24", "w-12", "w-28", "w-32", "w-16", "w-14", "w-12"];

  return (
    <>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <TableRow key={rowIndex} className="hover:bg-transparent">
          {Array.from({ length: CHAIN_COLUMN_COUNT }).map(
            (__, columnIndex) => (
              <TableCell key={columnIndex} className="px-4 py-3">
                <Skeleton
                  className={cn(
                    "h-3.5",
                    widths[columnIndex % widths.length],
                  )}
                />
              </TableCell>
            ),
          )}
        </TableRow>
      ))}
    </>
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
  icon,
  title,
  description,
  actionLabel,
  onAction,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={CHAIN_COLUMN_COUNT} className="px-4 py-16">
        <div className="mx-auto flex max-w-sm flex-col items-center gap-3 text-center">
          <div className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
            {icon}
          </div>
          <div>
            <p className="text-sm font-medium">{title}</p>
            <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          </div>
          <Button variant="outline" size="sm" onClick={onAction}>
            <PlusIcon className="size-3.5" />
            {actionLabel}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

export default function ChainsPage() {
  const { t } = useI18n();
  const chains = useChains();
  const servers = useServers();

  const [form, setForm] = useState<{
    mode: "create" | "edit";
    chain?: Chain;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Chain | null>(null);
  /** 展开的行；降级链在首次出现时自动展开，用户收起后不再强行打开。 */
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const autoExpanded = useRef<Set<string>>(new Set());

  const items = chains.data ?? [];
  const showError = chains.isError && !chains.data;
  const loadError = errorText(chains.error, t("chains.loadError"));

  useEffect(() => {
    if (!chains.data) return;

    const newlyDegraded = chains.data
      .filter(
        (chain) => chain.degraded && !autoExpanded.current.has(chain.id),
      )
      .map((chain) => chain.id);
    if (newlyDegraded.length === 0) return;

    for (const id of newlyDegraded) autoExpanded.current.add(id);
    setExpandedIds((previous) => {
      const next = new Set(previous);
      for (const id of newlyDegraded) next.add(id);
      return next;
    });
  }, [chains.data]);

  function toggleExpanded(id: string) {
    setExpandedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <div className="animate-in space-y-6 fade-in-0 slide-in-from-bottom-1 duration-150">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">
            {t("chains.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("chains.subtitle")}
          </p>
        </div>
      </div>

      <Card className="gap-0 overflow-hidden">
        <CardHeader className="border-b border-border">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              {t("chains.list.title")}
              {chains.data ? (
                <Badge
                  variant="secondary"
                  className="font-mono text-[11px] font-normal text-muted-foreground"
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
          <div className="mt-2 flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <InfoIcon className="mt-px size-3 shrink-0" aria-hidden="true" />
            <span>{t("chains.relayNote")}</span>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          <Table className="min-w-[880px]" aria-busy={chains.isPending}>
            <TableCaption className="sr-only">
              {t("chains.list.tableCaption")}
            </TableCaption>
            <TableHeader className="bg-muted/30">
              <TableRow>
                {[
                  t("chains.list.columns.name"),
                  t("chains.list.columns.hops"),
                  t("chains.list.columns.entry"),
                  t("chains.list.columns.target"),
                  t("chains.list.columns.status"),
                  t("chains.list.columns.enabled"),
                  t("common.actions"),
                ].map((label) => (
                  <TableHead key={label} className={HEAD_CLASS}>
                    {label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {chains.isPending ? (
                <LoadingRows />
              ) : showError ? (
                <ErrorRow
                  message={loadError}
                  onRetry={() => void chains.refetch()}
                  retrying={chains.isFetching}
                />
              ) : items.length === 0 ? (
                <EmptyRow
                  icon={<WorkflowIcon className="size-5" />}
                  title={t("chains.list.emptyTitle")}
                  description={t("chains.list.emptyDesc")}
                  actionLabel={t("chains.list.emptyAction")}
                  onAction={() => setForm({ mode: "create" })}
                />
              ) : (
                items.map((chain) => {
                  const target = formatForwardTarget(
                    chain.target_host,
                    chain.target_port,
                  );
                  const entry = entryHop(chain.hops);
                  const expanded = expandedIds.has(chain.id);

                  return (
                    <Fragment key={chain.id}>
                      <TableRow
                        className={cn(expanded && "bg-muted/20")}
                      >
                        <TableCell className="max-w-60 px-4 py-2.5">
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="size-6 shrink-0"
                              aria-expanded={expanded}
                              aria-label={t(
                                expanded
                                  ? "chains.list.collapseAria"
                                  : "chains.list.expandAria",
                                { name: chain.name },
                              )}
                              onClick={() => toggleExpanded(chain.id)}
                            >
                              <ChevronRightIcon
                                className={cn(
                                  "size-3.5 transition-transform duration-150",
                                  expanded && "rotate-90",
                                )}
                              />
                            </Button>
                            <div className="min-w-0">
                              <div className="truncate font-medium">
                                {chain.name}
                              </div>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="px-4 py-2.5 text-xs tabular-nums text-muted-foreground">
                          {t("chains.list.hopCount", {
                            count: chain.hops.length,
                          })}
                        </TableCell>
                        <TableCell className="px-4 py-2.5 font-mono text-xs">
                          {entry ? (
                            <span
                              className="break-all"
                              title={t("chains.list.entryHint")}
                            >
                              {formatHopEndpoint(entry)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">
                              {t("chains.list.noEntry")}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                          <span className="break-all" title={target}>
                            {target}
                          </span>
                        </TableCell>
                        <TableCell className="px-4 py-2.5">
                          <ChainStatusCell chain={chain} />
                        </TableCell>
                        <TableCell className="px-4 py-2.5">
                          <ChainEnabledSwitch chain={chain} />
                        </TableCell>
                        <TableCell className="px-4 py-2.5">
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
                                onSelect={() =>
                                  setForm({ mode: "edit", chain })
                                }
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
                        </TableCell>
                      </TableRow>
                      {expanded ? <ChainHopsRow chain={chain} /> : null}
                    </Fragment>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

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
