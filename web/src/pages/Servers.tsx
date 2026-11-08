import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  ArrowRightLeftIcon,
  ArrowUpCircleIcon,
  CheckIcon,
  CopyIcon,
  HistoryIcon,
  InfoIcon,
  KeyRoundIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  NetworkIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerOffIcon,
  TriangleAlertIcon,
  WaypointsIcon,
  WorkflowIcon,
} from "lucide-react";
import { AgentBatchUpgradeBar } from "@/components/servers/AgentBatchUpgradeBar";
import { AgentBatchUpgradeConfirmDialog } from "@/components/servers/AgentBatchUpgradeConfirmDialog";
import { AgentBatchUpgradeProgressDialog } from "@/components/servers/AgentBatchUpgradeProgressDialog";
import { AgentUpgradeDialog } from "@/components/servers/AgentUpgradeDialog";
import { AgentUpgradeHistoryDialog } from "@/components/servers/AgentUpgradeHistoryDialog";
import { ServerEditDialog } from "@/components/servers/ServerEditDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { CreateServerResponse, Server } from "@/lib/api";
import {
  displayAgentVersion,
  hasPendingAgentUpgrade,
} from "@/lib/agentUpgrade";
import {
  batchSelectionState,
  canSelectForBatchUpgrade,
  pruneBatchSelection,
  selectableServerIds,
  toggleBatchSelection,
  type BatchSelectionState,
} from "@/lib/agentUpgradeBatch";
import { copyText } from "@/lib/clipboard";
import { errorText } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { useAllNodes, useCreateServer, useServers } from "@/lib/queries";
import { isSpeedLimited } from "@/lib/speed";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

const COLUMN_COUNT = 11;
/** 心跳超过这个时长没有更新就不该再当作实时数据。 */
const HEARTBEAT_STALE_MS = 90_000;
const HEAD_CLASS =
  "h-9 px-4 text-xs font-medium tracking-wide text-muted-foreground";

function xrayModeLabel(mode: string): string {
  if (mode === "external") return t("servers.mode.external");
  if (mode === "embedded") return t("servers.mode.embedded");
  return mode;
}

function isServiceDown(server: Server): boolean {
  return server.status === "online" && server.xray_running === false;
}

type XrayState = "running" | "stopped" | "unknown";

const xrayMeta: Record<
  XrayState,
  { labelKey: string; dot: string; text: string; tone: DetailTone }
> = {
  running: {
    labelKey: "servers.xray.running",
    dot: "bg-primary",
    text: "text-primary",
    tone: "primary",
  },
  stopped: {
    labelKey: "servers.xray.stopped",
    dot: "bg-destructive",
    text: "text-destructive",
    tone: "destructive",
  },
  unknown: {
    labelKey: "servers.xray.unknown",
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
    tone: "muted",
  },
};

function xrayState(server: Server): XrayState {
  // 离线时健康数据是最后一次心跳的旧值，不再当作实时状态展示。
  if (server.status !== "online") return "unknown";
  if (server.xray_running === null) return "unknown";
  return server.xray_running ? "running" : "stopped";
}

function xrayTitle(server: Server, state: XrayState): string {
  if (server.status !== "online") return t("servers.xray.offlineTitle");
  if (state === "unknown") return t("servers.xray.unknownTitle");
  return state === "running"
    ? t("servers.xray.runningTitle")
    : t("servers.xray.stoppedTitle");
}

function StatusBadge({ server }: { server: Server }) {
  const online = server.status === "online";
  const serviceDown = isServiceDown(server);

  return (
    <Badge
      variant="outline"
      title={serviceDown ? t("servers.serviceAbnormalTitle") : undefined}
      className={cn(
        "gap-1.5 border-transparent font-normal",
        serviceDown
          ? "bg-destructive/10 text-destructive"
          : online
            ? "bg-primary/10 text-primary"
            : "bg-muted text-muted-foreground",
      )}
    >
      {serviceDown ? (
        <TriangleAlertIcon className="size-3" aria-hidden="true" />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 rounded-full",
            online
              ? "bg-primary motion-safe:animate-pulse"
              : "bg-muted-foreground/40",
          )}
        />
      )}
      {serviceDown
        ? t("servers.statusServiceDown")
        : online
          ? t("servers.statusOnline")
          : t("servers.statusOffline")}
    </Badge>
  );
}

function XrayStatus({ server }: { server: Server }) {
  const state = xrayState(server);
  const meta = xrayMeta[state];

  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-xs", meta.text)}
      title={xrayTitle(server, state)}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          meta.dot,
          state === "running" && "motion-safe:animate-pulse",
        )}
      />
      {t(meta.labelKey)}
    </span>
  );
}

function agentVersionLabel(server: Server): string {
  return displayAgentVersion(server.agent_version) || "—";
}

function targetVersionLabel(server: Server): string {
  return displayAgentVersion(server.agent_target_version) || "—";
}

function memoryPercent(server: Server): number | null {
  if (
    server.mem_used === null ||
    server.mem_total === null ||
    server.mem_total <= 0
  ) {
    return null;
  }
  return Math.min(100, Math.max(0, (server.mem_used / server.mem_total) * 100));
}

type HeartbeatInfo = { text: string; stale: boolean; title: string };

function heartbeatInfo(healthAt: number | null): HeartbeatInfo {
  if (healthAt === null) {
    return {
      text: t("servers.heartbeatNone"),
      stale: false,
      title: t("servers.heartbeatNoneTitle"),
    };
  }

  const stale = Date.now() - healthAt * 1_000 > HEARTBEAT_STALE_MS;
  const absolute = formatAbsoluteTime(healthAt);
  return {
    text: formatRelativeTime(healthAt),
    stale,
    title: stale
      ? t("servers.heartbeatStale", { time: absolute })
      : t("servers.heartbeatLast", { time: absolute }),
  };
}

function HeartbeatText({ healthAt }: { healthAt: number | null }) {
  const info = heartbeatInfo(healthAt);

  return (
    <span
      className={cn("inline-flex items-center gap-1", info.stale && "text-warning")}
      title={info.title}
    >
      {info.stale ? (
        <TriangleAlertIcon className="size-3" aria-hidden="true" />
      ) : null}
      {info.text}
    </span>
  );
}

function MemoryCell({ server }: { server: Server }) {
  const percent = memoryPercent(server);

  if (percent === null) {
    return (
      <span
        className="text-xs text-muted-foreground"
        title={t("servers.memoryNotReported")}
      >
        —
      </span>
    );
  }

  return (
    <div
      className="flex items-center gap-2"
      title={`${formatBytes(server.mem_used)} / ${formatBytes(server.mem_total)}`}
    >
      <Progress
        value={percent}
        aria-label={t("servers.memoryAria", {
          percent: Math.round(percent),
        })}
        className="h-1.5 w-20"
      />
      <span className="font-mono text-xs tabular-nums text-muted-foreground">
        {Math.round(percent)}%
      </span>
    </div>
  );
}

function VersionCell({ server }: { server: Server }) {
  const version = server.agent_version;
  const pending = hasPendingAgentUpgrade(server);
  const latency = server.latency_ms;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={cn(
            "font-mono text-xs",
            !version && "text-muted-foreground",
          )}
          title={
            version ? t("servers.agentVersion") : t("servers.agentVersionMissing")
          }
        >
          {agentVersionLabel(server)}
        </span>
        {pending ? (
          <Badge
            variant="outline"
            className="gap-1 border-transparent bg-warning/10 px-1.5 py-0 text-[11px] font-normal text-warning"
            title={t("servers.agentUpgrade.pendingTitle", {
              version: targetVersionLabel(server),
            })}
          >
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-warning motion-safe:animate-pulse"
            />
            {t("servers.agentUpgrade.pendingBadge")}
          </Badge>
        ) : null}
      </div>
      <span className="font-mono text-[11px] text-muted-foreground">
        {t("servers.configVersion", { version: server.config_version })}
        {latency !== null ? (
          <>
            {" · "}
            <span
              className="tnum"
              title={t("servers.detail.latencyHint")}
            >
              {t("servers.latencyValue", { ms: latency })}
            </span>
          </>
        ) : null}
      </span>
    </div>
  );
}

type DetailTone = "default" | "primary" | "warning" | "destructive" | "muted";

function DetailRow({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: DetailTone;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "text-right text-foreground",
          tone === "primary" && "text-primary",
          tone === "warning" && "text-warning",
          tone === "destructive" && "text-destructive",
          tone === "muted" && "text-muted-foreground",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * 服务器详情里的「已限速节点数」。
 *
 * 放在 PopoverContent 内部：只有展开详情时才挂载并发起全局节点查询，
 * 避免每次进入 /servers 都多拉一份全量节点。接口失败时静默省略该行。
 */
function LimitedNodesRow({ serverId }: { serverId: string }) {
  const nodes = useAllNodes();
  if (!nodes.data) return null;

  const count = nodes.data.filter(
    (node) =>
      node.server_id === serverId && isSpeedLimited(node.bandwidth_kbps),
  ).length;

  return (
    <DetailRow
      label={t("nodes.limitedNodes")}
      value={String(count)}
      tone={count > 0 ? "default" : "muted"}
    />
  );
}

/** 窄屏折叠列的内容入口；xl 以上所有列都已展开，不再显示。 */
function ServerDetailsPopover({ server }: { server: Server }) {
  const state = xrayState(server);
  const percent = memoryPercent(server);
  const heartbeat = heartbeatInfo(server.health_at);
  const online = server.status === "online";
  const serviceDown = isServiceDown(server);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="xl:hidden"
          aria-label={t("servers.detailsAria", { name: server.name })}
        >
          <InfoIcon className="size-3.5" />
          {t("common.details")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <PopoverHeader>
          <PopoverTitle className="text-sm">{server.name}</PopoverTitle>
          <PopoverDescription className="truncate font-mono text-xs">
            {server.address}
          </PopoverDescription>
        </PopoverHeader>
        <dl className="flex flex-col gap-2 text-xs">
          <DetailRow
            label={t("servers.agentVersion")}
            value={agentVersionLabel(server)}
            tone={server.agent_version ? "default" : "muted"}
          />
          {hasPendingAgentUpgrade(server) ? (
            <DetailRow
              label={t("servers.upgradeDialog.target")}
              value={targetVersionLabel(server)}
              tone="warning"
            />
          ) : null}
          <DetailRow
            label={t("servers.detail.configVersion")}
            value={`v${server.config_version}`}
          />
          <DetailRow
            label={t("servers.detail.status")}
            value={
              serviceDown
                ? t("servers.statusServiceDown")
                : online
                  ? t("servers.statusOnline")
                  : t("servers.statusOffline")
            }
            tone={serviceDown ? "destructive" : online ? "primary" : "muted"}
          />
          <DetailRow
            label="Xray"
            value={t(xrayMeta[state].labelKey)}
            tone={xrayMeta[state].tone}
          />
          <DetailRow
            label={t("servers.detail.load")}
            value={
              server.load1 === null
                ? t("common.notReported")
                : server.load1.toFixed(2)
            }
            tone={server.load1 === null ? "muted" : "default"}
          />
          <DetailRow
            label={t("servers.detail.latency")}
            value={
              server.latency_ms === null
                ? t("common.notReported")
                : t("servers.latencyValue", { ms: server.latency_ms })
            }
            tone={server.latency_ms === null ? "muted" : "default"}
          />
          <DetailRow
            label={t("servers.detail.memory")}
            value={
              percent === null
                ? t("common.notReported")
                : `${Math.round(percent)}% · ${formatBytes(server.mem_used)} / ${formatBytes(server.mem_total)}`
            }
            tone={percent === null ? "muted" : "default"}
          />
          <LimitedNodesRow serverId={server.id} />
          <DetailRow
            label={t("servers.detail.lastHeartbeat")}
            value={heartbeat.text}
            tone={heartbeat.stale ? "warning" : "default"}
          />
          <DetailRow
            label={t("servers.detail.lastSeen")}
            value={formatRelativeTime(server.last_seen_at)}
          />
        </dl>
      </PopoverContent>
    </Popover>
  );
}

/** 表头复选框：三态，只对「已开启允许下发升级」的行生效。 */
function SelectAllCheckbox({
  state,
  disabled,
  onCheckedChange,
}: {
  state: BatchSelectionState;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Checkbox
            checked={
              state === "all"
                ? true
                : state === "some"
                  ? "indeterminate"
                  : false
            }
            disabled={disabled}
            // 禁用时让 hover 落到外层 span，Tooltip 才能显示说明。
            className={disabled ? "pointer-events-none" : undefined}
            onCheckedChange={(checked) => onCheckedChange(checked === true)}
            aria-label={t("servers.batch.selectAllAria")}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>{t("servers.batch.selectAllHint")}</TooltipContent>
    </Tooltip>
  );
}

/**
 * 行内复选框。
 *
 * 未开启「允许下发升级」的行不可勾选：复选框禁用并置灰，
 * 外面套一层 Tooltip 解释原因（禁用元素本身收不到 hover，所以包在 span 上）。
 */
function ServerSelectCheckbox({
  server,
  checked,
  onCheckedChange,
}: {
  server: Server;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  if (!canSelectForBatchUpgrade(server)) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex cursor-not-allowed">
            <Checkbox
              checked={false}
              disabled
              className="pointer-events-none"
              aria-label={t("servers.batch.disabledHint")}
            />
          </span>
        </TooltipTrigger>
        <TooltipContent>{t("servers.batch.disabledHint")}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Checkbox
      checked={checked}
      onCheckedChange={(next) => onCheckedChange(next === true)}
      aria-label={t("servers.batch.selectAria", { name: server.name })}
    />
  );
}

function LoadingRows() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, index) => (
        <TableRow key={index} className="hover:bg-transparent">
          <TableCell className="w-10 px-4 py-3">
            <Skeleton className="size-4 rounded-[4px]" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-28" />
          </TableCell>
          <TableCell className="hidden px-4 py-3 lg:table-cell">
            <Skeleton className="h-3.5 w-32" />
          </TableCell>
          <TableCell className="hidden px-4 py-3 lg:table-cell">
            <Skeleton className="h-3.5 w-10" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-5 w-16 rounded-full" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-14" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-20" />
          </TableCell>
          <TableCell className="hidden px-4 py-3 xl:table-cell">
            <Skeleton className="h-7 w-20" />
          </TableCell>
          <TableCell className="hidden px-4 py-3 xl:table-cell">
            <Skeleton className="h-3.5 w-10" />
          </TableCell>
          <TableCell className="hidden px-4 py-3 xl:table-cell">
            <Skeleton className="h-3.5 w-20" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-7 w-16 rounded-md" />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

function EmptyRow({ onCreate }: { onCreate: () => void }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={COLUMN_COUNT} className="px-4 py-16">
        <div className="mx-auto flex max-w-sm flex-col items-center gap-3 text-center">
          <div className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
            <ServerOffIcon className="size-5" />
          </div>
          <div>
            <p className="text-sm font-medium">{t("servers.emptyTitle")}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("servers.emptyDesc")}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={onCreate}>
            <PlusIcon className="size-3.5" />
            {t("servers.emptyAction")}
          </Button>
        </div>
      </TableCell>
    </TableRow>
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
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={COLUMN_COUNT} className="px-4 py-16">
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 text-center">
          <div className="grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
            <TriangleAlertIcon className="size-5" />
          </div>
          <div>
            <p className="text-sm font-medium">{t("servers.loadFailed")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{message}</p>
          </div>
          <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
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

export default function ServersPage() {
  useI18n();
  const servers = useServers();
  const create = useCreateServer();

  const [createOpen, setCreateOpen] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [created, setCreated] = useState<CreateServerResponse | null>(null);
  const [editServerId, setEditServerId] = useState<string | null>(null);
  const [upgradeServerId, setUpgradeServerId] = useState<string | null>(null);
  const [historyServerId, setHistoryServerId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [xrayMode, setXrayMode] = useState("external");
  const [copied, setCopied] = useState<"token" | "command" | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // P5：批量升级的多选与弹窗状态。selection 可能短暂保留已失效的 id，
  // 渲染时统一用 selectedIds（已按当前可选集合过滤）作为唯一事实来源。
  const [selection, setSelection] = useState<string[]>([]);
  const [batchConfirm, setBatchConfirm] = useState<{
    serverIds: string[];
    version: string;
  } | null>(null);
  const [batchProgressOpen, setBatchProgressOpen] = useState(false);
  /** null = 打开「最近一次批次」；有值时直接看指定批次。 */
  const [batchProgressId, setBatchProgressId] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  const items = useMemo(() => servers.data ?? [], [servers.data]);
  const eligibleIds = useMemo(() => selectableServerIds(items), [items]);
  // 列表刷新后可能有关掉「允许下发升级」的行：从这里起就丢掉失效 id，
  // 不复用 effect，避免多一轮渲染。
  const selectedIds = useMemo(
    () => pruneBatchSelection(selection, eligibleIds),
    [selection, eligibleIds],
  );
  const selectAllState = batchSelectionState(selectedIds, eligibleIds);

  function handleSelectAll(checked: boolean) {
    setSelection(checked ? [...eligibleIds] : []);
  }

  function handleToggleServer(id: string) {
    setSelection(toggleBatchSelection(selectedIds, id));
  }

  function openBatchConfirm(version: string) {
    const serverIds = pruneBatchSelection(selectedIds, eligibleIds);
    if (serverIds.length === 0) return;
    setBatchConfirm({ serverIds, version });
  }

  function openLatestBatch() {
    setBatchProgressId(null);
    setBatchProgressOpen(true);
  }

  const editServer = items.find((server) => server.id === editServerId) ?? null;
  const upgradeServer =
    items.find((server) => server.id === upgradeServerId) ?? null;
  const historyServer =
    items.find((server) => server.id === historyServerId) ?? null;
  const onlineCount = items.filter((server) => server.status === "online").length;
  const serviceDownCount = items.filter(isServiceDown).length;
  const showError = servers.isError && !servers.data;
  const errorMessage = errorText(
    servers.error,
    t("servers.loadError"),
  );
  const createError = create.isError
    ? errorText(create.error, t("servers.createError"))
    : null;

  function openCreateDialog() {
    create.reset();
    setCreateOpen(true);
  }

  function handleCreateOpenChange(open: boolean) {
    setCreateOpen(open);
    if (!open) create.reset();
  }

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (create.isPending || !name.trim() || !address.trim()) return;

    create.mutate(
      {
        name: name.trim(),
        address: address.trim(),
        xray_mode: xrayMode,
      },
      {
        onSuccess: (data) => {
          setCreateOpen(false);
          setName("");
          setAddress("");
          setCreated(data);
          setTokenOpen(true);
          toast.success(t("servers.createdToast", { name: data.server.name }));
        },
        onError: (error) => {
          toast.error(errorText(error, t("servers.createError")));
        },
      },
    );
  }

  function handleTokenOpenChange(open: boolean) {
    setTokenOpen(open);
    if (!open) setCopied(null);
  }

  async function handleCopy(
    field: "token" | "command",
    text: string,
    label: string,
  ) {
    const ok = await copyText(text);
    if (!ok) {
      toast.error(t("servers.tokenDialog.copyFailed", { label }));
      return;
    }

    setCopied(field);
    toast.success(t("servers.tokenDialog.copiedLabel", { label }));
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 1_500);
  }

  // TooltipProvider 放在这个页面里而不是 main.tsx：整套 Radix Tooltip + floating-ui
  // 只被本页用到，挂在应用根部会把 ~47kB 顶进首屏入口 chunk。
  return (
    <TooltipProvider delayDuration={200}>
    <div className="animate-in space-y-6 fade-in-0 slide-in-from-bottom-1 duration-150">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t("servers.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("servers.subtitle")}
          </p>
        </div>
        <Button onClick={openCreateDialog}>
          <PlusIcon className="size-4" />
          {t("servers.add")}
        </Button>
      </div>

      <Card className="gap-0 overflow-hidden">
        <CardHeader className="border-b border-border">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              {t("servers.list")}
              {servers.data ? (
                <Badge
                  variant="secondary"
                  className="font-mono text-[11px] font-normal text-muted-foreground"
                >
                  {items.length}
                </Badge>
              ) : null}
            </CardTitle>
            <div className="flex flex-wrap items-center gap-3">
              {servers.data ? (
                <span className="text-xs text-muted-foreground">
                  {t("servers.onlineCount", {
                    online: onlineCount,
                    total: items.length,
                  })}
                </span>
              ) : null}
              {serviceDownCount > 0 ? (
                <Badge
                  variant="outline"
                  title={t("servers.serviceAbnormalTitle")}
                  className="gap-1 border-transparent bg-destructive/10 font-normal text-destructive"
                >
                  <TriangleAlertIcon className="size-3" />
                  {t("servers.serviceAbnormal", { n: serviceDownCount })}
                </Badge>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                onClick={openLatestBatch}
                title={t("servers.batch.progressAction")}
              >
                <HistoryIcon className="size-3.5" />
                {t("servers.batch.progressAction")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void servers.refetch()}
                disabled={servers.isFetching}
              >
                <RefreshCwIcon
                  className={cn(
                    "size-3.5",
                    servers.isFetching && "animate-spin",
                  )}
                />
                {t("common.refresh")}
              </Button>
            </div>
          </div>
          <CardDescription className="text-xs">
            {t("servers.desc")}
          </CardDescription>
        </CardHeader>

        {selectedIds.length > 0 ? (
          <AgentBatchUpgradeBar
            selectedCount={selectedIds.length}
            onStart={openBatchConfirm}
            onClear={() => setSelection([])}
          />
        ) : null}

        <CardContent className="p-0">
          <Table
            className="min-w-[780px] xl:min-w-[1140px]"
            aria-busy={servers.isPending}
          >
            <TableCaption className="sr-only">{t("servers.tableCaption")}</TableCaption>
            <TableHeader className="bg-muted/30">
              <TableRow>
                <TableHead className={cn(HEAD_CLASS, "w-10 pr-0")}>
                  <SelectAllCheckbox
                    state={selectAllState}
                    disabled={eligibleIds.length === 0}
                    onCheckedChange={handleSelectAll}
                  />
                </TableHead>
                <TableHead className={HEAD_CLASS}>{t("common.name")}</TableHead>
                <TableHead className={cn(HEAD_CLASS, "hidden lg:table-cell")}>
                  {t("common.address")}
                </TableHead>
                <TableHead className={cn(HEAD_CLASS, "hidden lg:table-cell")}>
                  {t("servers.mode.column")}
                </TableHead>
                <TableHead className={HEAD_CLASS}>{t("common.status")}</TableHead>
                <TableHead className={HEAD_CLASS}>Xray</TableHead>
                <TableHead className={HEAD_CLASS}>{t("servers.detail.lastHeartbeat")}</TableHead>
                <TableHead
                  className={cn(HEAD_CLASS, "hidden xl:table-cell")}
                  title={t("servers.detail.configVersion")}
                >
                  {t("servers.agentVersion")}
                </TableHead>
                <TableHead className={cn(HEAD_CLASS, "hidden xl:table-cell")}>
                  {t("servers.detail.load")}
                </TableHead>
                <TableHead className={cn(HEAD_CLASS, "hidden xl:table-cell")}>
                  {t("servers.detail.memory")}
                </TableHead>
                <TableHead className={HEAD_CLASS}>{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {servers.isPending ? (
                <LoadingRows />
              ) : showError ? (
                <ErrorRow
                  message={errorMessage}
                  retrying={servers.isFetching}
                  onRetry={() => void servers.refetch()}
                />
              ) : items.length === 0 ? (
                <EmptyRow onCreate={openCreateDialog} />
              ) : (
                items.map((server) => {
                  const serviceDown = isServiceDown(server);
                  const selected = selectedIds.includes(server.id);

                  return (
                    <TableRow
                      key={server.id}
                      data-state={selected ? "selected" : undefined}
                      className={cn(
                        serviceDown &&
                          "bg-destructive/5 hover:bg-destructive/10",
                      )}
                    >
                      <TableCell className="w-10 px-4 py-2.5">
                        <ServerSelectCheckbox
                          server={server}
                          checked={selected}
                          onCheckedChange={() => handleToggleServer(server.id)}
                        />
                      </TableCell>
                      <TableCell className="max-w-56 px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <span
                            aria-hidden="true"
                            className={cn(
                              "h-4 w-0.5 shrink-0 rounded-full",
                              serviceDown ? "bg-destructive" : "bg-transparent",
                            )}
                          />
                          <div className="truncate font-medium">
                            {server.name}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="hidden px-4 py-2.5 font-mono text-xs text-muted-foreground lg:table-cell">
                        {server.address}
                      </TableCell>
                      <TableCell className="hidden px-4 py-2.5 text-xs text-muted-foreground lg:table-cell">
                        {xrayModeLabel(server.xray_mode)}
                        {server.xray_mode === "embedded" ? (
                          <span
                            className="ml-1.5 rounded bg-warning/10 px-1.5 py-0.5 text-[11px] text-warning"
                            title={t("servers.mode.deprecatedHint")}
                          >
                            {t("servers.mode.deprecated")}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="px-4 py-2.5">
                        <StatusBadge server={server} />
                      </TableCell>
                      <TableCell className="px-4 py-2.5">
                        <XrayStatus server={server} />
                      </TableCell>
                      <TableCell className="px-4 py-2.5 text-xs text-muted-foreground">
                        <HeartbeatText healthAt={server.health_at} />
                      </TableCell>
                      <TableCell className="hidden px-4 py-2.5 xl:table-cell">
                        <VersionCell server={server} />
                      </TableCell>
                      <TableCell
                        className="hidden px-4 py-2.5 font-mono text-xs tabular-nums xl:table-cell"
                        title={t("servers.loadTitle")}
                      >
                        {server.load1 === null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          server.load1.toFixed(2)
                        )}
                      </TableCell>
                      <TableCell className="hidden px-4 py-2.5 xl:table-cell">
                        <MemoryCell server={server} />
                      </TableCell>
                      <TableCell className="px-4 py-2.5">
                        <div className="flex items-center gap-1">
                          <ServerDetailsPopover server={server} />
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            asChild
                            title={t("servers.nodes")}
                          >
                            <Link
                              to={`/servers/${server.id}/nodes`}
                              aria-label={t("servers.manageNodesAria", { name: server.name })}
                            >
                              <NetworkIcon className="size-4" />
                            </Link>
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t(
                                  "servers.agentUpgrade.actionsAria",
                                  { name: server.name },
                                )}
                              >
                                <MoreHorizontalIcon className="size-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-52">
                              <DropdownMenuItem
                                disabled={!Boolean(server.allow_agent_upgrade)}
                                title={
                                  Boolean(server.allow_agent_upgrade)
                                    ? t("servers.agentUpgrade.action")
                                    : t("servers.agentUpgrade.disabledHint")
                                }
                                onSelect={() => setUpgradeServerId(server.id)}
                              >
                                <ArrowUpCircleIcon className="size-3.5" />
                                {t("servers.agentUpgrade.action")}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem asChild>
                                <Link
                                  to={`/servers/${server.id}/outbounds`}
                                  aria-label={t("servers.manageOutboundsAria", {
                                    name: server.name,
                                  })}
                                >
                                  <WaypointsIcon className="size-3.5" />
                                  {t("servers.outbounds")}
                                </Link>
                              </DropdownMenuItem>
                              <DropdownMenuItem asChild>
                                <Link
                                  to={`/servers/${server.id}/forwards`}
                                  aria-label={t("forwards.manageAria", {
                                    name: server.name,
                                  })}
                                >
                                  <ArrowRightLeftIcon className="size-3.5" />
                                  {t("forwards.menuLabel")}
                                </Link>
                              </DropdownMenuItem>
                              <DropdownMenuItem asChild>
                                <Link
                                  to="/chains"
                                  aria-label={t("servers.openChainsAria")}
                                >
                                  <WorkflowIcon className="size-3.5" />
                                  {t("servers.chains")}
                                </Link>
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() => setHistoryServerId(server.id)}
                              >
                                <HistoryIcon className="size-3.5" />
                                {t("servers.agentUpgrade.history")}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onSelect={() => setEditServerId(server.id)}
                              >
                                <PencilIcon className="size-3.5" />
                                {t("servers.agentUpgrade.edit")}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={handleCreateOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("servers.createDialog.title")}</DialogTitle>
            <DialogDescription>
              {t("servers.createDialog.desc")}
            </DialogDescription>
          </DialogHeader>

          <form
            id="create-server-form"
            className="space-y-4"
            onSubmit={handleCreate}
          >
            <div className="space-y-2">
              <Label htmlFor="server-name">{t("servers.createDialog.name")}</Label>
              <Input
                id="server-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="hk-1"
                autoComplete="off"
                disabled={create.isPending}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="server-address">{t("servers.createDialog.address")}</Label>
              <Input
                id="server-address"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                placeholder={t("servers.createDialog.addressPlaceholder")}
                autoComplete="off"
                disabled={create.isPending}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="server-mode">{t("servers.createDialog.mode")}</Label>
              <Select
                value={xrayMode}
                onValueChange={setXrayMode}
                disabled={create.isPending}
              >
                <SelectTrigger id="server-mode" className="w-full">
                  <SelectValue placeholder={t("servers.mode.placeholder")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="external">
                    {t("servers.mode.externalOption")}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t("servers.mode.hint")}
              </p>
            </div>

            {createError ? (
              <p
                role="alert"
                aria-live="polite"
                className="text-xs text-destructive"
              >
                {createError}
              </p>
            ) : null}
          </form>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={create.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              form="create-server-form"
              disabled={
                create.isPending || !name.trim() || !address.trim()
              }
            >
              {create.isPending ? (
                <Loader2Icon className="animate-spin" />
              ) : null}
              {create.isPending
                ? t("servers.createDialog.submitting")
                : t("servers.createDialog.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={tokenOpen} onOpenChange={handleTokenOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRoundIcon className="size-4 text-primary" />
              {t("servers.tokenDialog.title")}
            </DialogTitle>
            <DialogDescription>
              {created
                ? t("servers.tokenDialog.desc", { name: created.server.name })
                : t("servers.tokenDialog.descNoName")}
            </DialogDescription>
          </DialogHeader>

          {created ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground">
                    {t("servers.tokenDialog.token")}
                  </span>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() =>
                      void handleCopy("token", created.token, "Token")
                    }
                  >
                    {copied === "token" ? (
                      <CheckIcon className="text-primary" />
                    ) : (
                      <CopyIcon />
                    )}
                    {copied === "token" ? t("common.copied") : t("common.copy")}
                  </Button>
                </div>
                <code className="mt-2 block font-mono text-xs break-all">
                  {created.token}
                </code>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label>{t("servers.tokenDialog.installCommand")}</Label>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() =>
                      void handleCopy(
                        "command",
                        created.install_command,
                        t("servers.tokenDialog.installCommand"),
                      )
                    }
                  >
                    {copied === "command" ? (
                      <CheckIcon className="text-primary" />
                    ) : (
                      <CopyIcon />
                    )}
                    {copied === "command" ? t("common.copied") : t("common.copy")}
                  </Button>
                </div>
                <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
                  {created.install_command}
                </pre>
              </div>

              <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                <p>
                  {t("servers.tokenDialog.rootWarning")}
                </p>
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                if (created) {
                  void handleCopy(
                    "command",
                    created.install_command,
                    t("servers.tokenDialog.installCommand"),
                  );
                }
              }}
            >
              <CopyIcon className="size-3.5" />
              {t("servers.tokenDialog.copyCommand")}
            </Button>
            <Button onClick={() => setTokenOpen(false)}>
              {t("servers.tokenDialog.saved")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {editServer ? (
        <ServerEditDialog
          open
          server={editServer}
          onOpenChange={(open) => {
            if (!open) setEditServerId(null);
          }}
        />
      ) : null}

      {upgradeServer ? (
        <AgentUpgradeDialog
          open
          server={upgradeServer}
          onOpenChange={(open) => {
            if (!open) setUpgradeServerId(null);
          }}
        />
      ) : null}

      {historyServer ? (
        <AgentUpgradeHistoryDialog
          open
          server={historyServer}
          onOpenChange={(open) => {
            if (!open) setHistoryServerId(null);
          }}
        />
      ) : null}

      {batchConfirm ? (
        <AgentBatchUpgradeConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setBatchConfirm(null);
          }}
          serverIds={batchConfirm.serverIds}
          version={batchConfirm.version}
          onCreated={(batch) => {
            setSelection([]);
            setBatchProgressId(batch.id);
            setBatchProgressOpen(true);
          }}
        />
      ) : null}

      <AgentBatchUpgradeProgressDialog
        open={batchProgressOpen}
        onOpenChange={setBatchProgressOpen}
        batchId={batchProgressId}
      />
    </div>
    </TooltipProvider>
  );
}
