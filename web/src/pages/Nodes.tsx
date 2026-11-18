import { lazy, Suspense, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import {
  ArrowLeftIcon,
  MoreHorizontalIcon,
  NetworkIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SendIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { EmptyState, ListErrorRow, SkeletonTable } from "@/components/common";
import { DeleteNodeDialog } from "@/components/nodes/DeleteNodeDialog";
import { NodeFormDialog } from "@/components/nodes/NodeFormDialog";
import {
  NodeTcpingAction,
  NodeTcpingResult,
} from "@/components/nodes/NodeTcping";
import { SsMethodBadge } from "@/components/nodes/SsMethodBadge";
import { SpeedLimitBadge } from "@/components/SpeedLimitBadge";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
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
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApiError, type Node, type NodeTraffic } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { nodeSummary } from "@/lib/protocols";
import { portPairLabel } from "@/lib/publicPort";
import {
  clampNodePage,
  hasNodeFilters,
  NODE_PAGE_SIZE,
  nodePageCount,
  nodePageSummary,
  parseNodeFilters,
  serializeNodeFilters,
} from "@/lib/nodeFilters";
import {
  useApplyServer,
  useNodePage,
  useNodeTraffic,
  useServers,
  useTcpingNode,
  useUpdateNode,
} from "@/lib/queries";
import {
  beginTcping,
  failTcping,
  isTcpingLoading,
  settleTcping,
  type TcpingState,
} from "@/lib/tcping";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

const COLUMN_COUNT = 7;
const TRAFFIC_DAYS = 7;
/** 空状态；每行结果由页面级 map 保留，筛选/刷新列表都不会丢。 */
const IDLE_TCPING: TcpingState = { status: "idle" };

/** 详情 Sheet 含趋势图，按需加载，避免图表进入节点列表的同步依赖。 */
const NodeTrafficSheet = lazy(() =>
  import("@/components/nodes/NodeTrafficSheet").then((module) => ({
    default: module.NodeTrafficSheet,
  })),
);

function nodeChangedAt(node: Node): number {
  return node.updated_at ?? node.created_at;
}

/**
 * 节点名称单元格的 title：名称 + 标签 / 地区 / 额外标签。
 *
 * 40px 行高里只保留名称与 tag 可见，地区与额外标签收进这里，
 * 不额外占一行（信息仍可悬停查看）。
 */
function nodeMetaTitle(node: Node): string {
  return [node.name, node.tag, node.region, ...(node.tags ?? [])]
    .filter((part): part is string => Boolean(part && String(part).trim()))
    .join(" · ");
}

/** 列表里的「7 天流量」单元格：点击打开详情 Sheet。 */
function NodeTrafficCell({
  node,
  traffic,
  loading,
  errorTitle,
  onOpen,
}: {
  node: Node;
  traffic?: NodeTraffic;
  loading: boolean;
  errorTitle?: string;
  onOpen: () => void;
}) {
  if (loading) {
    return (
      <div className="flex flex-col gap-1.5 px-2 py-1">
        <Skeleton className="h-3.5 w-14" />
        <Skeleton className="h-2.5 w-24" />
      </div>
    );
  }

  const weighted = traffic?.weighted ?? 0;
  const hasTraffic = weighted > 0;
  const title = errorTitle
    ? errorTitle
    : hasTraffic && traffic
      ? `${t("trafficChart.downlink")} ${formatBytes(traffic.downlink)} · ${t("trafficChart.uplink")} ${formatBytes(traffic.uplink)}`
      : t("nodes.traffic.noTraffic");

  return (
    <button
      type="button"
      title={title}
      aria-label={t("nodes.traffic.openAria", { name: node.name })}
      onClick={onOpen}
      className="-mx-2 ml-auto flex items-center justify-end gap-1.5 rounded-md px-2 py-1 text-right transition-colors duration-150 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <span
        className={cn(
          "font-mono text-xs tabular-nums",
          hasTraffic ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {hasTraffic ? formatBytes(weighted) : "—"}
      </span>
      {hasTraffic && traffic ? (
        <span className="font-mono type-micro whitespace-nowrap text-muted-foreground">
          ↓ {formatBytes(traffic.downlink)} · ↑ {formatBytes(traffic.uplink)}
        </span>
      ) : null}
    </button>
  );
}

function EmptyRow({ onCreate }: { onCreate: () => void }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={COLUMN_COUNT} className="px-4 py-8">
        <EmptyState
          size="sm"
          icon={NetworkIcon}
          title={t("nodes.emptyTitle")}
          description={t("nodes.emptyDesc")}
          action={
            <Button variant="outline" size="sm" onClick={onCreate}>
              <PlusIcon className="size-3.5" />
              {t("nodes.emptyAction")}
            </Button>
          }
        />
      </TableCell>
    </TableRow>
  );
}

function NodeEnabledSwitch({
  serverId,
  node,
}: {
  serverId: string;
  node: Node;
}) {
  const update = useUpdateNode(serverId);
  const enabled = Boolean(node.enabled);

  return (
    <div className="flex items-center gap-2">
      <Switch
        size="sm"
        checked={enabled}
        disabled={update.isPending}
        aria-label={t("nodes.toggleAria", {
          action: enabled
            ? t("nodes.disableAction")
            : t("nodes.enableAction"),
          name: node.name,
        })}
        onCheckedChange={(checked) => {
          update.mutate(
            { id: node.id, input: { enabled: checked } },
            {
              onSuccess: () => {
                toast.success(
                  checked
                    ? t("nodes.enabledToast", { name: node.name })
                    : t("nodes.disabledToast", { name: node.name }),
                );
              },
              onError: (error) => {
                toast.error(
                  errorText(error, t("nodes.toggleError")),
                );
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

export default function NodesPage() {
  useI18n();
  const { id: serverId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const servers = useServers();
  // 筛选与页码都放在 URL 里：可收藏、刷新保持；`?tag=&region=&page=`。
  const filters = parseNodeFilters(searchParams);
  // 输入框 → 300ms 防抖 → 请求；页码变化不带防抖（翻页要立刻响应）。
  const [debouncedTag, setDebouncedTag] = useState(filters.tag);
  const [debouncedRegion, setDebouncedRegion] = useState(filters.region);
  const nodes = useNodePage(serverId, {
    tag: debouncedTag,
    region: debouncedRegion,
    page: filters.page,
    perPage: NODE_PAGE_SIZE,
  });
  const traffic = useNodeTraffic(serverId, TRAFFIC_DAYS);
  const apply = useApplyServer(serverId);

  const [formState, setFormState] = useState<{
    mode: "create" | "edit";
    node?: Node;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Node | null>(null);
  const [trafficTarget, setTrafficTarget] = useState<Node | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  // TCPing 结果不落库、不轮询；按节点 id 保留到下次刷新页面。
  const [tcpingStates, setTcpingStates] = useState<Record<string, TcpingState>>(
    {},
  );
  const tcping = useTcpingNode();

  const server = servers.data?.find((item) => item.id === serverId);
  const items = nodes.data?.items ?? [];
  const total = nodes.data?.total ?? 0;
  const pages = nodePageCount(total, NODE_PAGE_SIZE);
  const pageSummary = nodePageSummary(filters.page, NODE_PAGE_SIZE, total);
  const filtersActive = hasNodeFilters(filters);
  const showError = nodes.isError && !nodes.data;
  const errorMessage = errorText(
    nodes.error,
    t("nodes.loadError"),
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedTag(filters.tag);
      setDebouncedRegion(filters.region);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [filters.tag, filters.region]);

  // 数据变化后纠偏页码：删除节点 / 收窄筛选导致当前页越界时回到最后一页。
  useEffect(() => {
    if (!nodes.data) return;
    const lastPage = nodePageCount(nodes.data.total, NODE_PAGE_SIZE);
    if (filters.page > lastPage) {
      setSearchParams(
        serializeNodeFilters({ ...filters, page: lastPage }),
        { replace: true },
      );
    }
  }, [nodes.data, filters.page, filters.tag, filters.region, setSearchParams]);

  function updateFilters(next: Partial<typeof filters>) {
    setSearchParams(
      serializeNodeFilters({
        tag: next.tag ?? filters.tag,
        region: next.region ?? filters.region,
        page: next.page ?? filters.page,
      }),
      { replace: true },
    );
  }

  function clearFilters() {
    setDebouncedTag("");
    setDebouncedRegion("");
    setSearchParams(serializeNodeFilters({ tag: "", region: "", page: 1 }), {
      replace: true,
    });
  }

  function goToPage(nextPage: number) {
    setSearchParams(
      serializeNodeFilters({
        ...filters,
        page: clampNodePage(nextPage, total, NODE_PAGE_SIZE),
      }),
    );
  }

  const trafficByNode = new Map<string, NodeTraffic>(
    (traffic.data ?? []).map((item) => [item.node_id, item]),
  );
  const trafficErrorTitle = traffic.isError
    ? traffic.error instanceof ApiError && traffic.error.status === 404
      ? t("nodes.traffic.notReady")
      : errorText(traffic.error, t("nodes.traffic.loadError"))
    : undefined;

  function handleTcping(node: Node) {
    const current = tcpingStates[node.id] ?? IDLE_TCPING;
    if (isTcpingLoading(current)) return;

    setTcpingStates((previous) => ({
      ...previous,
      [node.id]: beginTcping(previous[node.id] ?? IDLE_TCPING),
    }));
    tcping.mutate(node.id, {
      onSuccess: (result) => {
        // 不可达也是正常 200 结果，统一走 settle，不会误报成请求失败。
        setTcpingStates((previous) => ({
          ...previous,
          [node.id]: settleTcping(result),
        }));
      },
      onError: (error) => {
        setTcpingStates((previous) => ({
          ...previous,
          [node.id]: failTcping(
            errorText(error, t("nodes.tcping.failureFallback")),
          ),
        }));
      },
    });
  }

  function handleApply() {
    if (!serverId || apply.isPending) return;

    apply.mutate(undefined, {
      onSuccess: (result) => {
        const nextWarnings = Array.isArray(result.warnings)
          ? result.warnings.filter((warning) => warning.trim().length > 0)
          : [];
        setWarnings(nextWarnings);
        toast.success(t("nodes.applySuccess", { version: result.config_version }), {
          description:
            nextWarnings.length > 0
              ? t("nodes.applyWarnings", { n: nextWarnings.length })
              : undefined,
        });
      },
      onError: (error) => {
        toast.error(errorText(error, t("nodes.applyError")));
      },
    });
  }

  // TooltipProvider 只在本页：Radix Tooltip 不进入应用根部，避免首屏 chunk 变大。
  return (
    <TooltipProvider delayDuration={200}>
    <div className="animate-in space-y-6 fade-in-0 slide-in-from-bottom-1 duration-150">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <Link
            to="/servers"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
          >
            <ArrowLeftIcon className="size-3" />
            {t("nodes.backServers")}
          </Link>
          <h1 className="mt-1 flex min-w-0 items-center gap-2 text-xl leading-tight font-semibold tracking-tight">
            <span className="shrink-0">{t("nodes.title")}</span>
            <span className="text-muted-foreground">·</span>
            {servers.isPending ? (
              <Skeleton className="h-5 w-32" />
            ) : (
              <span className="truncate">{server?.name ?? t("nodes.unknownServer")}</span>
            )}
            {server ? (
              <Badge
                variant="secondary"
                className="font-mono type-micro font-normal text-muted-foreground"
              >
                v{server.config_version}
              </Badge>
            ) : null}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("nodes.subtitle")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setFormState({ mode: "create" })}
            disabled={!serverId}
          >
            <PlusIcon className="size-4" />
            {t("nodes.add")}
          </Button>
          <Button
            onClick={handleApply}
            disabled={!serverId || apply.isPending}
          >
            {apply.isPending ? (
              <RefreshCwIcon className="animate-spin" />
            ) : (
              <SendIcon />
            )}
            {apply.isPending ? t("nodes.applying") : t("nodes.apply")}
          </Button>
        </div>
      </div>

      {warnings.length > 0 ? (
        <Alert className="border-warning/40 bg-warning/5 text-warning">
          <TriangleAlertIcon />
          <AlertTitle>
            {t("nodes.warningsTitle", { n: warnings.length })}
          </AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4 text-warning/90">
              {warnings.map((warning, index) => (
                <li key={`${index}-${warning}`}>{warning}</li>
              ))}
            </ul>
          </AlertDescription>
          <AlertAction>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("nodes.closeWarning")}
              onClick={() => setWarnings([])}
            >
              <XIcon />
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      <Card className="gap-0 overflow-hidden">
        <CardHeader className="border-b border-border">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              {t("nodes.list")}
              {nodes.data ? (
                <Badge
                  variant="secondary"
                  className="font-mono type-micro font-normal text-muted-foreground"
                  title={t("nodes.listTotalTitle")}
                >
                  {total}
                </Badge>
              ) : null}
              {nodes.data && !showError ? (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {t("nodes.pageStatus", {
                    page: pageSummary.page,
                    pages: pageSummary.pages,
                  })}
                </span>
              ) : null}
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={filters.tag}
                onChange={(event) => updateFilters({ tag: event.target.value, page: 1 })}
                placeholder={t("nodes.filterTagPlaceholder")}
                aria-label={t("nodes.filterTag")}
                className="h-8 w-32"
              />
              <Input
                value={filters.region}
                onChange={(event) =>
                  updateFilters({ region: event.target.value, page: 1 })
                }
                placeholder={t("nodes.filterRegionPlaceholder")}
                aria-label={t("nodes.filterRegion")}
                className="h-8 w-28"
              />
              {filtersActive ? (
                <Button variant="ghost" size="sm" onClick={clearFilters}>
                  <XIcon className="size-3.5" />
                  {t("nodes.clearFilters")}
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void nodes.refetch()}
                disabled={nodes.isFetching}
              >
                <RefreshCwIcon
                  className={cn(
                    "size-3.5",
                    nodes.isFetching && "animate-spin",
                  )}
                />
                {t("common.refresh")}
              </Button>
            </div>
          </div>
          <CardDescription className="text-xs">
            {t("nodes.desc")}
          </CardDescription>
        </CardHeader>

        <CardContent className="p-0" aria-busy={nodes.isPending}>
          {nodes.isPending ? (
            <SkeletonTable rows={5} columns={COLUMN_COUNT} />
          ) : null}
          <Table
            className={cn("min-w-[900px]", nodes.isPending && "hidden")}
          >
            <TableCaption className="sr-only">{t("nodes.tableCaption")}</TableCaption>
            <TableHeader className="bg-muted/30">
              <TableRow>
                {[
                  { label: t("nodes.columns.name") },
                  { label: t("nodes.columns.protocol") },
                  { label: t("nodes.columns.port") },
                  {
                    label: t("nodes.traffic.column"),
                    title: t("nodes.traffic.columnHint"),
                  },
                  { label: t("nodes.columns.enabled") },
                  { label: t("nodes.columns.updatedAt") },
                  { label: t("nodes.columns.actions") },
                ].map(({ label, title }, index) => (
                  <TableHead
                    key={label}
                    title={title}
                    className={cn(
                      "h-9 px-4 text-xs font-medium tracking-wide text-muted-foreground",
                      // 端口与 7 天流量是数值列：与数字同侧右对齐。
                      (index === 2 || index === 3) && "text-right",
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
                  colSpan={COLUMN_COUNT}
                  title={t("nodes.loadFailed")}
                  message={errorMessage}
                  retrying={nodes.isFetching}
                  onRetry={() => void nodes.refetch()}
                />
              ) : items.length === 0 ? (
                filtersActive ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={COLUMN_COUNT} className="px-4 py-8">
                      <EmptyState
                        size="sm"
                        icon={NetworkIcon}
                        title={t("nodes.filteredEmptyTitle")}
                        description={t("nodes.filteredEmptyDesc")}
                        action={
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={clearFilters}
                          >
                            {t("nodes.clearFilters")}
                          </Button>
                        }
                      />
                    </TableCell>
                  </TableRow>
                ) : (
                  <EmptyRow onCreate={() => setFormState({ mode: "create" })} />
                )
              ) : (
                items.map((node) => (
                  <TableRow key={node.id}>
                    <TableCell className="max-w-72 px-4">
                      {/* 40px 基线：名称 / 标签 / 徽标 / 探测按钮同一行；
                          地区与额外标签收进 title，不再各占一行。 */}
                      <div className="flex min-w-0 items-center gap-1.5">
                        <div
                          className="min-w-0 shrink truncate font-medium"
                          title={nodeMetaTitle(node)}
                        >
                          {node.name}
                        </div>
                        <SsMethodBadge node={node} />
                        <SpeedLimitBadge kbps={node.bandwidth_kbps} />
                        <span className="hidden shrink-0 truncate font-mono type-micro text-muted-foreground md:inline">
                          {node.tag}
                        </span>
                        <NodeTcpingAction
                          node={node}
                          state={tcpingStates[node.id] ?? IDLE_TCPING}
                          onProbe={() => handleTcping(node)}
                          className="shrink-0"
                        />
                      </div>
                      {/* 移动端行内空间不足：tag / 地区 / 额外标签与探测结果放到下一行，
                          md 以上收进同一行或 title，保持 40px 行高。 */}
                      <div className="mt-0.5 flex items-center gap-1 font-mono type-micro text-muted-foreground md:hidden">
                        <span className="truncate">{node.tag}</span>
                        {node.region ? (
                          <Badge
                            variant="outline"
                            className="h-4 border-border/70 px-1 font-mono text-[10px] font-normal"
                          >
                            {node.region}
                          </Badge>
                        ) : null}
                        {(node.tags ?? []).map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full bg-muted px-1.5 text-[10px]"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                      <NodeTcpingResult
                        state={tcpingStates[node.id] ?? IDLE_TCPING}
                        className="mt-0.5 md:hidden"
                      />
                    </TableCell>
                    <TableCell className="px-4">
                      <Badge
                        variant="outline"
                        className="font-mono type-micro font-normal text-muted-foreground"
                      >
                        {nodeSummary(
                          node.protocol,
                          node.transport,
                          node.security,
                        )}
                      </Badge>
                    </TableCell>
                    <TableCell className="px-4 text-right font-mono text-xs tabular-nums text-muted-foreground">
                      <span
                        title={
                          node.public_port == null
                            ? undefined
                            : t("nodes.portPairTitle")
                        }
                      >
                        {portPairLabel(node.port, node.public_port)}
                      </span>
                    </TableCell>
                    <TableCell className="px-4 text-right">
                      <NodeTrafficCell
                        node={node}
                        traffic={trafficByNode.get(node.id)}
                        loading={traffic.isPending}
                        errorTitle={trafficErrorTitle}
                        onOpen={() => setTrafficTarget(node)}
                      />
                    </TableCell>
                    <TableCell className="px-4">
                      <NodeEnabledSwitch serverId={serverId} node={node} />
                    </TableCell>
                    <TableCell className="px-4 text-xs text-muted-foreground">
                      <span title={formatAbsoluteTime(nodeChangedAt(node))}>
                        {formatRelativeTime(nodeChangedAt(node))}
                      </span>
                    </TableCell>
                    <TableCell className="px-4">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("nodes.actionsAria", { name: node.name })}
                          >
                            <MoreHorizontalIcon className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-36">
                          <DropdownMenuItem
                            onSelect={() =>
                              setFormState({ mode: "edit", node })
                            }
                          >
                            <PencilIcon className="size-3.5" />
                            {t("common.edit")}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => setDeleteTarget(node)}
                          >
                            <Trash2Icon className="size-3.5" />
                            {t("common.delete")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          {nodes.data && !showError ? (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4">
              <p className="text-xs text-muted-foreground tabular-nums">
                {t("nodes.pageRange", {
                  from: pageSummary.from,
                  to: pageSummary.to,
                  total: pageSummary.total,
                })}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => goToPage(pageSummary.page - 1)}
                  disabled={pageSummary.page <= 1 || nodes.isFetching}
                >
                  {t("nodes.pagePrev")}
                </Button>
                <span className="min-w-16 text-center text-xs text-muted-foreground tabular-nums">
                  {t("nodes.pageStatus", {
                    page: pageSummary.page,
                    pages: pageSummary.pages,
                  })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => goToPage(pageSummary.page + 1)}
                  disabled={pageSummary.page >= pages || nodes.isFetching}
                >
                  {t("nodes.pageNext")}
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {formState ? (
        <NodeFormDialog
          key={`${formState.mode}-${formState.node?.id ?? "new"}`}
          open
          serverId={serverId}
          server={server}
          mode={formState.mode}
          node={formState.node}
          onOpenChange={(open) => {
            if (!open) setFormState(null);
          }}
        />
      ) : null}

      {deleteTarget ? (
        <DeleteNodeDialog
          key={deleteTarget.id}
          open
          serverId={serverId}
          node={deleteTarget}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
        />
      ) : null}

      {trafficTarget ? (
        <Suspense fallback={null}>
          <NodeTrafficSheet
            key={trafficTarget.id}
            open
            node={trafficTarget}
            serverName={server?.name}
            onOpenChange={(open) => {
              if (!open) setTrafficTarget(null);
            }}
          />
        </Suspense>
      ) : null}
    </div>
    </TooltipProvider>
  );
}
