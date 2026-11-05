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
import { t, useI18n } from "@/i18n";

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
            <p className="text-sm font-medium">{t("nodes.emptyTitle")}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("nodes.emptyDesc")}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={onCreate}>
            <PlusIcon className="size-3.5" />
            {t("nodes.emptyAction")}
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
            <p className="text-sm font-medium">{t("nodes.loadFailed")}</p>
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
    t("nodes.loadError"),
  );

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

  return (
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
          <h1 className="mt-1 flex min-w-0 items-center gap-2 text-xl font-semibold tracking-tight">
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
                className="font-mono text-[11px] font-normal text-muted-foreground"
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
              {t("common.refresh")}
            </Button>
          </div>
          <CardDescription className="text-xs">
            {t("nodes.desc")}
          </CardDescription>
        </CardHeader>

        <CardContent className="p-0">
          <Table className="min-w-[760px]" aria-busy={nodes.isPending}>
            <TableCaption className="sr-only">{t("nodes.tableCaption")}</TableCaption>
            <TableHeader className="bg-muted/30">
              <TableRow>
                {[
                  t("nodes.columns.name"),
                  t("nodes.columns.protocol"),
                  t("nodes.columns.port"),
                  t("nodes.columns.enabled"),
                  t("nodes.columns.updatedAt"),
                  t("nodes.columns.actions"),
                ].map(
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
