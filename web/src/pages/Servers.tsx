import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  CheckIcon,
  CopyIcon,
  InfoIcon,
  KeyRoundIcon,
  Loader2Icon,
  NetworkIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerOffIcon,
  TriangleAlertIcon,
} from "lucide-react";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import type { CreateServerResponse, Server } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { errorText } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { useCreateServer, useServers } from "@/lib/queries";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";

const COLUMN_COUNT = 10;
/** 心跳超过这个时长没有更新就不该再当作实时数据。 */
const HEARTBEAT_STALE_MS = 90_000;
const HEAD_CLASS =
  "h-9 px-4 text-xs font-medium tracking-wide text-muted-foreground";

const xrayModeLabels: Record<string, string> = {
  external: "外置",
  embedded: "内联",
};

function isServiceDown(server: Server): boolean {
  return server.status === "online" && server.xray_running === false;
}

type XrayState = "running" | "stopped" | "unknown";

const xrayMeta: Record<
  XrayState,
  { label: string; dot: string; text: string; tone: DetailTone }
> = {
  running: {
    label: "运行中",
    dot: "bg-primary",
    text: "text-primary",
    tone: "primary",
  },
  stopped: {
    label: "已停止",
    dot: "bg-destructive",
    text: "text-destructive",
    tone: "destructive",
  },
  unknown: {
    label: "未知",
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
  if (server.status !== "online") return "服务器离线，无法获取实时 Xray 状态";
  if (state === "unknown") return "Agent 尚未上报 Xray 状态";
  return state === "running" ? "Xray 正在运行" : "Agent 在线，但 Xray 已停止";
}

function StatusBadge({ server }: { server: Server }) {
  const online = server.status === "online";
  const serviceDown = isServiceDown(server);

  return (
    <Badge
      variant="outline"
      title={serviceDown ? "Agent 在线，但 Xray 服务已停止" : undefined}
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
      {serviceDown ? "服务异常" : online ? "在线" : "离线"}
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
      {meta.label}
    </span>
  );
}

function agentVersionLabel(server: Server): string {
  const version = server.agent_version;
  if (!version) return "—";
  return version.toLowerCase().startsWith("v") ? version : `v${version}`;
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
      text: "暂无心跳",
      stale: false,
      title: "Agent 尚未上报心跳",
    };
  }

  const stale = Date.now() - healthAt * 1_000 > HEARTBEAT_STALE_MS;
  const absolute = formatAbsoluteTime(healthAt);
  return {
    text: formatRelativeTime(healthAt),
    stale,
    title: stale
      ? `最后心跳：${absolute}（超过 90 秒未更新）`
      : `最后心跳：${absolute}`,
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
        title="Agent 尚未上报内存"
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
        aria-label={`内存占用 ${Math.round(percent)}%`}
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

  return (
    <div className="flex flex-col gap-0.5">
      <span
        className={cn(
          "font-mono text-xs",
          !version && "text-muted-foreground",
        )}
        title={version ? "Agent 版本" : "Agent 尚未上报版本"}
      >
        {agentVersionLabel(server)}
      </span>
      <span className="font-mono text-[11px] text-muted-foreground">
        配置 v{server.config_version}
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
          aria-label={`查看 ${server.name} 的详情`}
        >
          <InfoIcon className="size-3.5" />
          详情
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
            label="Agent 版本"
            value={agentVersionLabel(server)}
            tone={server.agent_version ? "default" : "muted"}
          />
          <DetailRow label="配置版本" value={`v${server.config_version}`} />
          <DetailRow
            label="状态"
            value={serviceDown ? "服务异常" : online ? "在线" : "离线"}
            tone={serviceDown ? "destructive" : online ? "primary" : "muted"}
          />
          <DetailRow
            label="Xray"
            value={xrayMeta[state].label}
            tone={xrayMeta[state].tone}
          />
          <DetailRow
            label="负载（1 分钟）"
            value={server.load1 === null ? "未上报" : server.load1.toFixed(2)}
            tone={server.load1 === null ? "muted" : "default"}
          />
          <DetailRow
            label="内存"
            value={
              percent === null
                ? "未上报"
                : `${Math.round(percent)}% · ${formatBytes(server.mem_used)} / ${formatBytes(server.mem_total)}`
            }
            tone={percent === null ? "muted" : "default"}
          />
          <DetailRow
            label="最后心跳"
            value={heartbeat.text}
            tone={heartbeat.stale ? "warning" : "default"}
          />
          <DetailRow
            label="最后在线"
            value={formatRelativeTime(server.last_seen_at)}
          />
        </dl>
      </PopoverContent>
    </Popover>
  );
}

function LoadingRows() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, index) => (
        <TableRow key={index} className="hover:bg-transparent">
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
            <p className="text-sm font-medium">还没有服务器</p>
            <p className="mt-1 text-xs text-muted-foreground">
              添加第一台服务器后，Agent 会自动连入主控。
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={onCreate}>
            <PlusIcon className="size-3.5" />
            添加服务器
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
            <p className="text-sm font-medium">服务器列表加载失败</p>
            <p className="mt-1 text-xs text-muted-foreground">{message}</p>
          </div>
          <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
            <RefreshCwIcon
              className={cn("size-3.5", retrying && "animate-spin")}
            />
            重试
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

export default function ServersPage() {
  const servers = useServers();
  const create = useCreateServer();

  const [createOpen, setCreateOpen] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [created, setCreated] = useState<CreateServerResponse | null>(null);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [xrayMode, setXrayMode] = useState("external");
  const [copied, setCopied] = useState<"token" | "command" | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  const items = servers.data ?? [];
  const onlineCount = items.filter((server) => server.status === "online").length;
  const serviceDownCount = items.filter(isServiceDown).length;
  const showError = servers.isError && !servers.data;
  const errorMessage = errorText(
    servers.error,
    "加载服务器列表失败，请检查网络后重试",
  );
  const createError = create.isError
    ? errorText(create.error, "创建服务器失败，请稍后重试")
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
          toast.success(`服务器「${data.server.name}」已创建`);
        },
        onError: (error) => {
          toast.error(errorText(error, "创建服务器失败，请稍后重试"));
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
      toast.error(`${label}复制失败，请手动选择文本复制`);
      return;
    }

    setCopied(field);
    toast.success(`${label}已复制`);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 1_500);
  }

  return (
    <div className="animate-in space-y-6 fade-in-0 slide-in-from-bottom-1 duration-150">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">服务器</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            管理接入主控的 Agent 节点。
          </p>
        </div>
        <Button onClick={openCreateDialog}>
          <PlusIcon className="size-4" />
          添加服务器
        </Button>
      </div>

      <Card className="gap-0 overflow-hidden">
        <CardHeader className="border-b border-border">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              服务器列表
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
                  在线 {onlineCount} / {items.length}
                </span>
              ) : null}
              {serviceDownCount > 0 ? (
                <Badge
                  variant="outline"
                  title="Agent 在线，但 Xray 服务已停止"
                  className="gap-1 border-transparent bg-destructive/10 font-normal text-destructive"
                >
                  <TriangleAlertIcon className="size-3" />
                  服务异常 {serviceDownCount}
                </Badge>
              ) : null}
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
                刷新
              </Button>
            </div>
          </div>
          <CardDescription className="text-xs">
            Agent 主动连入主控，无需开放入站端口；列表每 15 秒自动刷新。在线但 Xray 停止会标红，窄屏可在「详情」查看负载与内存。
          </CardDescription>
        </CardHeader>

        <CardContent className="p-0">
          <Table
            className="min-w-[760px] xl:min-w-[980px]"
            aria-busy={servers.isPending}
          >
            <TableCaption className="sr-only">服务器列表</TableCaption>
            <TableHeader className="bg-muted/30">
              <TableRow>
                <TableHead className={HEAD_CLASS}>名称</TableHead>
                <TableHead className={cn(HEAD_CLASS, "hidden lg:table-cell")}>
                  地址
                </TableHead>
                <TableHead className={cn(HEAD_CLASS, "hidden lg:table-cell")}>
                  模式
                </TableHead>
                <TableHead className={HEAD_CLASS}>状态</TableHead>
                <TableHead className={HEAD_CLASS}>Xray</TableHead>
                <TableHead className={HEAD_CLASS}>最后心跳</TableHead>
                <TableHead
                  className={cn(HEAD_CLASS, "hidden xl:table-cell")}
                  title="Agent 版本 / 配置版本"
                >
                  版本
                </TableHead>
                <TableHead className={cn(HEAD_CLASS, "hidden xl:table-cell")}>
                  负载
                </TableHead>
                <TableHead className={cn(HEAD_CLASS, "hidden xl:table-cell")}>
                  内存
                </TableHead>
                <TableHead className={HEAD_CLASS}>操作</TableHead>
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

                  return (
                    <TableRow
                      key={server.id}
                      className={cn(
                        serviceDown &&
                          "bg-destructive/5 hover:bg-destructive/10",
                      )}
                    >
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
                        {xrayModeLabels[server.xray_mode] ?? server.xray_mode}
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
                        title="1 分钟平均负载"
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
                          <Button variant="ghost" size="sm" asChild>
                            <Link
                              to={`/servers/${server.id}/nodes`}
                              aria-label={`管理 ${server.name} 的节点`}
                            >
                              <NetworkIcon className="size-3.5" />
                              节点
                            </Link>
                          </Button>
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
            <DialogTitle>添加服务器</DialogTitle>
            <DialogDescription>
              创建后会生成一次性配对 token，Agent 用它反向连入主控。
            </DialogDescription>
          </DialogHeader>

          <form
            id="create-server-form"
            className="space-y-4"
            onSubmit={handleCreate}
          >
            <div className="space-y-2">
              <Label htmlFor="server-name">名称</Label>
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
              <Label htmlFor="server-address">地址</Label>
              <Input
                id="server-address"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                placeholder="1.2.3.4 或 node.example.com"
                autoComplete="off"
                disabled={create.isPending}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="server-mode">Xray 模式</Label>
              <Select
                value={xrayMode}
                onValueChange={setXrayMode}
                disabled={create.isPending}
              >
                <SelectTrigger id="server-mode" className="w-full">
                  <SelectValue placeholder="选择模式" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="external">外置（external）</SelectItem>
                  <SelectItem value="embedded">内联（embedded）</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                外置模式要求服务器已自行安装并运行 Xray；内联模式由 Agent 托管。
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
              取消
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
              {create.isPending ? "创建中…" : "创建服务器"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={tokenOpen} onOpenChange={handleTokenOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRoundIcon className="size-4 text-primary" />
              服务器已创建
            </DialogTitle>
            <DialogDescription>
              {created
                ? `「${created.server.name}」的配对凭据如下。token 只显示这一次，请立即保存。`
                : "token 只显示这一次，请立即保存。"}
            </DialogDescription>
          </DialogHeader>

          {created ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground">
                    配对 token
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
                    {copied === "token" ? "已复制" : "复制"}
                  </Button>
                </div>
                <code className="mt-2 block font-mono text-xs break-all">
                  {created.token}
                </code>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label>安装命令</Label>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() =>
                      void handleCopy(
                        "command",
                        created.install_command,
                        "安装命令",
                      )
                    }
                  >
                    {copied === "command" ? (
                      <CheckIcon className="text-primary" />
                    ) : (
                      <CopyIcon />
                    )}
                    {copied === "command" ? "已复制" : "复制"}
                  </Button>
                </div>
                <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
                  {created.install_command}
                </pre>
              </div>

              <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                <p>
                  请在 Agent 主机上以 root 执行安装命令。token
                  泄露后请删除服务器并重新创建。
                </p>
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                if (created) {
                  void handleCopy("command", created.install_command, "安装命令");
                }
              }}
            >
              <CopyIcon className="size-3.5" />
              复制安装命令
            </Button>
            <Button onClick={() => setTokenOpen(false)}>我已保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
