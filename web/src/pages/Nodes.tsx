import { useState } from "react";
import { Link, useParams } from "react-router-dom";
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
import { DeleteNodeDialog } from "@/components/nodes/DeleteNodeDialog";
import { NodeFormDialog } from "@/components/nodes/NodeFormDialog";
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
import type { Node } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { nodeSummary } from "@/lib/protocols";
import {
  useApplyServer,
  useNodes,
  useServers,
  useUpdateNode,
} from "@/lib/queries";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";

const COLUMN_COUNT = 6;

function nodeChangedAt(node: Node): number {
  return node.updated_at ?? node.created_at;
}

function LoadingRows() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, index) => (
        <TableRow key={index} className="hover:bg-transparent">
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="mt-1.5 h-2.5 w-20" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-5 w-40 rounded-full" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-10" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-4 w-8 rounded-full" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-16" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="size-7 rounded-md" />
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
            <NetworkIcon className="size-5" />
          </div>
          <div>
            <p className="text-sm font-medium">还没有节点</p>
            <p className="mt-1 text-xs text-muted-foreground">
              添加第一个节点并应用配置后，Xray 才会在这台服务器上开出入站。
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={onCreate}>
            <PlusIcon className="size-3.5" />
            添加第一个节点
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
            <p className="text-sm font-medium">节点列表加载失败</p>
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
        aria-label={`${enabled ? "停用" : "启用"}节点 ${node.name}`}
        onCheckedChange={(checked) => {
          update.mutate(
            { id: node.id, input: { enabled: checked } },
            {
              onSuccess: () => {
                toast.success(
                  checked
                    ? `已启用「${node.name}」`
                    : `已停用「${node.name}」`,
                );
              },
              onError: (error) => {
                toast.error(
                  errorText(error, "切换节点状态失败，请稍后重试"),
                );
              },
            },
          );
        }}
      />
      <span className="text-xs text-muted-foreground">
        {enabled ? "启用" : "停用"}
      </span>
    </div>
  );
}

export default function NodesPage() {
  const { id: serverId = "" } = useParams();
  const servers = useServers();
  const nodes = useNodes(serverId);
  const apply = useApplyServer(serverId);

  const [formState, setFormState] = useState<{
    mode: "create" | "edit";
    node?: Node;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Node | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const server = servers.data?.find((item) => item.id === serverId);
  const items = nodes.data ?? [];
  const showError = nodes.isError && !nodes.data;
  const errorMessage = errorText(
    nodes.error,
    "加载节点列表失败，请检查网络后重试",
  );

  function handleApply() {
    if (!serverId || apply.isPending) return;

    apply.mutate(undefined, {
      onSuccess: (result) => {
        const nextWarnings = Array.isArray(result.warnings)
          ? result.warnings.filter((warning) => warning.trim().length > 0)
          : [];
        setWarnings(nextWarnings);
        toast.success(`已下发 v${result.config_version}`, {
          description:
            nextWarnings.length > 0
              ? `有 ${nextWarnings.length} 条警告，请查看页面提示`
              : undefined,
        });
      },
      onError: (error) => {
        toast.error(errorText(error, "应用配置失败，请稍后重试"));
      },
    });
  }

  return (
    <div className="animate-in space-y-6 fade-in-0 slide-in-from-bottom-1 duration-150">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <Link
            to="/servers"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
          >
            <ArrowLeftIcon className="size-3" />
            服务器
          </Link>
          <h1 className="mt-1 flex min-w-0 items-center gap-2 text-xl font-semibold tracking-tight">
            <span className="shrink-0">节点</span>
            <span className="text-muted-foreground">·</span>
            {servers.isPending ? (
              <Skeleton className="h-5 w-32" />
            ) : (
              <span className="truncate">{server?.name ?? "未知服务器"}</span>
            )}
            {server ? (
              <Badge
                variant="secondary"
                className="font-mono text-[11px] font-normal text-muted-foreground"
              >
                v{server.config_version}
              </Badge>
            ) : null}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            节点保存后不会立即生效，点击「应用配置」才会下发到 Agent。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setFormState({ mode: "create" })}
            disabled={!serverId}
          >
            <PlusIcon className="size-4" />
            添加节点
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
            {apply.isPending ? "下发中…" : "应用配置"}
          </Button>
        </div>
      </div>

      {warnings.length > 0 ? (
        <Alert className="border-warning/40 bg-warning/5 text-warning">
          <TriangleAlertIcon />
          <AlertTitle>
            配置已下发，但有 {warnings.length} 条警告
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
              aria-label="关闭警告"
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
              节点列表
              {nodes.data ? (
                <Badge
                  variant="secondary"
                  className="font-mono text-[11px] font-normal text-muted-foreground"
                >
                  {items.length}
                </Badge>
              ) : null}
            </CardTitle>
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
              刷新
            </Button>
          </div>
          <CardDescription className="text-xs">
            开关会直接保存启用状态；停用的节点不会被写入下发的配置。
          </CardDescription>
        </CardHeader>

        <CardContent className="p-0">
          <Table className="min-w-[760px]" aria-busy={nodes.isPending}>
            <TableCaption className="sr-only">节点列表</TableCaption>
            <TableHeader className="bg-muted/30">
              <TableRow>
                {["名称", "协议", "端口", "启用", "更新时间", "操作"].map(
                  (label) => (
                    <TableHead
                      key={label}
                      className="h-9 px-4 text-xs font-medium tracking-wide text-muted-foreground"
                    >
                      {label}
                    </TableHead>
                  ),
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {nodes.isPending ? (
                <LoadingRows />
              ) : showError ? (
                <ErrorRow
                  message={errorMessage}
                  retrying={nodes.isFetching}
                  onRetry={() => void nodes.refetch()}
                />
              ) : items.length === 0 ? (
                <EmptyRow onCreate={() => setFormState({ mode: "create" })} />
              ) : (
                items.map((node) => (
                  <TableRow key={node.id}>
                    <TableCell className="max-w-56 px-4 py-2.5">
                      <div className="truncate font-medium">{node.name}</div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {node.tag}
                      </div>
                    </TableCell>
                    <TableCell className="px-4 py-2.5">
                      <Badge
                        variant="outline"
                        className="font-mono text-[11px] font-normal text-muted-foreground"
                      >
                        {nodeSummary(
                          node.protocol,
                          node.transport,
                          node.security,
                        )}
                      </Badge>
                    </TableCell>
                    <TableCell className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                      {node.port}
                    </TableCell>
                    <TableCell className="px-4 py-2.5">
                      <NodeEnabledSwitch serverId={serverId} node={node} />
                    </TableCell>
                    <TableCell className="px-4 py-2.5 text-xs text-muted-foreground">
                      <span title={formatAbsoluteTime(nodeChangedAt(node))}>
                        {formatRelativeTime(nodeChangedAt(node))}
                      </span>
                    </TableCell>
                    <TableCell className="px-4 py-2.5">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`操作 ${node.name}`}
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
                            编辑
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => setDeleteTarget(node)}
                          >
                            <Trash2Icon className="size-3.5" />
                            删除
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {formState ? (
        <NodeFormDialog
          key={`${formState.mode}-${formState.node?.id ?? "new"}`}
          open
          serverId={serverId}
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
    </div>
  );
}
