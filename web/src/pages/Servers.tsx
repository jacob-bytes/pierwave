import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";
import {
  CheckIcon,
  CopyIcon,
  KeyRoundIcon,
  Loader2Icon,
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
import { useCreateServer, useServers } from "@/lib/queries";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";

const COLUMN_COUNT = 6;

const xrayModeLabels: Record<string, string> = {
  external: "外置",
  embedded: "内联",
};

function StatusBadge({ status }: { status: Server["status"] }) {
  const online = status === "online";

  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 border-transparent font-normal",
        online
          ? "bg-primary/10 text-primary"
          : "bg-muted text-muted-foreground",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          online
            ? "bg-primary motion-safe:animate-pulse"
            : "bg-muted-foreground/40",
        )}
      />
      {online ? "在线" : "离线"}
    </Badge>
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
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-32" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-10" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-5 w-16 rounded-full" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-20" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-8" />
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
            <div className="flex items-center gap-3">
              {servers.data ? (
                <span className="text-xs text-muted-foreground">
                  在线 {onlineCount} / {items.length}
                </span>
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
            Agent 主动连入主控，无需开放入站端口；列表每 15 秒自动刷新。
          </CardDescription>
        </CardHeader>

        <CardContent className="p-0">
          <Table aria-busy={servers.isPending}>
            <TableCaption className="sr-only">服务器列表</TableCaption>
            <TableHeader className="bg-muted/30">
              <TableRow>
                <TableHead className="h-9 px-4 text-xs font-medium tracking-wide text-muted-foreground">
                  名称
                </TableHead>
                <TableHead className="h-9 px-4 text-xs font-medium tracking-wide text-muted-foreground">
                  地址
                </TableHead>
                <TableHead className="h-9 px-4 text-xs font-medium tracking-wide text-muted-foreground">
                  模式
                </TableHead>
                <TableHead className="h-9 px-4 text-xs font-medium tracking-wide text-muted-foreground">
                  状态
                </TableHead>
                <TableHead className="h-9 px-4 text-xs font-medium tracking-wide text-muted-foreground">
                  最后在线
                </TableHead>
                <TableHead className="h-9 px-4 text-xs font-medium tracking-wide text-muted-foreground">
                  配置版本
                </TableHead>
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
                items.map((server) => (
                  <TableRow key={server.id}>
                    <TableCell className="max-w-56 px-4 py-2.5">
                      <div className="truncate font-medium">{server.name}</div>
                    </TableCell>
                    <TableCell className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                      {server.address}
                    </TableCell>
                    <TableCell className="px-4 py-2.5 text-xs text-muted-foreground">
                      {xrayModeLabels[server.xray_mode] ?? server.xray_mode}
                    </TableCell>
                    <TableCell className="px-4 py-2.5">
                      <StatusBadge status={server.status} />
                    </TableCell>
                    <TableCell className="px-4 py-2.5 text-xs text-muted-foreground">
                      <span title={formatAbsoluteTime(server.last_seen_at)}>
                        {formatRelativeTime(server.last_seen_at)}
                      </span>
                    </TableCell>
                    <TableCell className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                      v{server.config_version}
                    </TableCell>
                  </TableRow>
                ))
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
