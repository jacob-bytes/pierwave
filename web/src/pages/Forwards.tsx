import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import {
  ArrowLeftIcon,
  ArrowRightLeftIcon,
  InfoIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SendIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { EmptyState, EngineBadge, SkeletonTable } from "@/components/common";
import { DeleteForwardDialog } from "@/components/forwards/DeleteForwardDialog";
import { ForwardFormDialog } from "@/components/forwards/ForwardFormDialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import type { Forward } from "@/lib/api";
import { forwardEngineMissing, realmMissingOnServer } from "@/lib/engines";
import { errorText } from "@/lib/errors";
import {
  formatForwardTarget,
  forwardRuntimeError,
  forwardStatus,
  type ForwardStatus,
} from "@/lib/forwards";
import {
  useApplyServer,
  useForwards,
  useServers,
  useUpdateForward,
} from "@/lib/queries";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

const FORWARD_COLUMN_COUNT = 6;
const HEAD_CLASS =
  "h-9 px-4 text-xs font-medium tracking-wide text-muted-foreground";

/**
 * 四种状态各自的视觉：停用/未上报走 muted，监听中走主色（在线态），
 * 失败走 destructive。颜色只取 token，不写死。
 */
const FORWARD_STATUS_META: Record<
  ForwardStatus,
  { labelKey: string; dot: string; text: string }
> = {
  disabled: {
    labelKey: "forwards.status.disabled",
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
  },
  unknown: {
    labelKey: "forwards.status.unknown",
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
  },
  listening: {
    labelKey: "forwards.status.listening",
    dot: "bg-primary",
    text: "text-primary",
  },
  failed: {
    labelKey: "forwards.status.failed",
    dot: "bg-destructive",
    text: "text-destructive",
  },
};

/**
 * 状态列。语义按「停用 → 未上报 → 监听中 → 失败」判定；
 * 失败时把 `runtime.error` 放在徽章下方的副行，并同时挂到 title 上，
 * 窄屏截断也能看到完整原因。
 *
 * 例外：realm 规则报「未安装」时，主标签改成「引擎缺失」并用 warning 色，
 * 与真正的配置 / 端口错误区分开——装好 realm 会自行恢复，不需要改规则。
 */
function ForwardStatusCell({ forward }: { forward: Forward }) {
  const { t } = useI18n();
  const status = forwardStatus(forward.enabled, forward.runtime);
  const meta = FORWARD_STATUS_META[status];
  const runtimeError = forwardRuntimeError(forward.runtime);
  const target = formatForwardTarget(forward.target_host, forward.target_port);
  const engineMissing = status === "failed" && forwardEngineMissing(forward);

  const title = engineMissing
    ? t("forwards.engine.missingTitle", {
        error: runtimeError ?? t("forwards.status.noError"),
      })
    : status === "disabled"
      ? t("forwards.status.disabledTitle")
      : status === "unknown"
        ? t("forwards.status.unknownTitle")
        : status === "listening"
          ? t("forwards.status.listeningTitle", {
              port: forward.listen_port,
              target,
            })
          : t("forwards.status.failedTitle", {
              error: runtimeError ?? t("forwards.status.noError"),
            });

  return (
    <div className="flex max-w-56 flex-col gap-0.5">
      <span
        className={cn(
          "inline-flex items-center gap-1.5 text-xs",
          engineMissing ? "text-warning" : meta.text,
        )}
        title={title}
      >
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 rounded-full",
            engineMissing ? "bg-warning" : meta.dot,
            status === "listening" && "motion-safe:animate-pulse",
          )}
        />
        {engineMissing ? t("forwards.engine.missing") : t(meta.labelKey)}
      </span>
      {status === "failed" ? (
        <span
          className={cn(
            "truncate type-micro",
            engineMissing ? "text-warning" : "text-destructive",
          )}
          title={
            engineMissing
              ? title
              : runtimeError
                ? t("forwards.status.errorTitle", { error: runtimeError })
                : t("forwards.status.noError")
          }
        >
          {engineMissing
            ? t("forwards.engine.missingHint")
            : (runtimeError ?? t("forwards.status.noError"))}
        </span>
      ) : null}
    </div>
  );
}

function ForwardEnabledSwitch({
  serverId,
  forward,
}: {
  serverId: string;
  forward: Forward;
}) {
  const { t } = useI18n();
  const update = useUpdateForward(serverId);
  const enabled = Boolean(forward.enabled);

  return (
    <div className="flex items-center gap-2">
      <Switch
        size="sm"
        checked={enabled}
        disabled={update.isPending}
        aria-label={t("forwards.toggleAria", {
          action: enabled
            ? t("forwards.disableAction")
            : t("forwards.enableAction"),
          name: forward.name,
        })}
        onCheckedChange={(checked) => {
          update.mutate(
            { id: forward.id, input: { enabled: checked } },
            {
              onSuccess: () => {
                toast.success(
                  checked
                    ? t("forwards.enabledToast", { name: forward.name })
                    : t("forwards.disabledToast", { name: forward.name }),
                );
              },
              onError: (error) => {
                toast.error(errorText(error, t("forwards.toggleError")));
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
      <TableCell colSpan={FORWARD_COLUMN_COUNT} className="px-4 py-16">
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 text-center">
          <div className="grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
            <TriangleAlertIcon className="size-5" />
          </div>
          <div>
            <p className="text-sm font-medium">
              {t("forwards.list.loadFailed")}
            </p>
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
      <TableCell colSpan={FORWARD_COLUMN_COUNT} className="px-4 py-8">
        <EmptyState
          size="sm"
          icon={ArrowRightLeftIcon}
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

export default function ForwardsPage() {
  useI18n();
  const { id: serverId = "" } = useParams();
  const servers = useServers();
  const forwards = useForwards(serverId);
  const apply = useApplyServer(serverId);

  const [form, setForm] = useState<{
    mode: "create" | "edit";
    forward?: Forward;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Forward | null>(null);

  const server = servers.data?.find((item) => item.id === serverId);
  const items = forwards.data ?? [];
  const showError = forwards.isError && !forwards.data;
  const loadError = errorText(forwards.error, t("forwards.loadError"));

  function handleApply() {
    if (!serverId || apply.isPending) return;

    apply.mutate(undefined, {
      onSuccess: (result) => {
        toast.success(
          t("forwards.applySuccess", { version: result.config_version }),
        );
      },
      onError: (error) => {
        toast.error(errorText(error, t("forwards.applyError")));
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
            {t("forwards.backServers")}
          </Link>
          <h1 className="mt-1 flex min-w-0 items-center gap-2 text-xl leading-tight font-semibold tracking-tight">
            <span className="shrink-0">{t("forwards.title")}</span>
            <span className="text-muted-foreground">·</span>
            {servers.isPending ? (
              <Skeleton className="h-5 w-32" />
            ) : (
              <span className="truncate">
                {server?.name ?? t("forwards.unknownServer")}
              </span>
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
            {t("forwards.subtitle")}
          </p>
        </div>
      </div>

      <Alert className="items-center">
        <InfoIcon />
        <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <AlertTitle>{t("forwards.applyHint")}</AlertTitle>
            <AlertDescription>{t("forwards.applyHintDesc")}</AlertDescription>
          </div>
          <Button
            size="sm"
            className="shrink-0"
            onClick={handleApply}
            disabled={!serverId || apply.isPending}
          >
            {apply.isPending ? (
              <RefreshCwIcon className="animate-spin" />
            ) : (
              <SendIcon />
            )}
            {apply.isPending ? t("forwards.applying") : t("forwards.apply")}
          </Button>
        </div>
      </Alert>

      <Card className="gap-0 overflow-hidden">
        <CardHeader className="border-b border-border">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              {t("forwards.list.title")}
              {forwards.data ? (
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
                onClick={() => void forwards.refetch()}
                disabled={forwards.isFetching}
              >
                <RefreshCwIcon
                  className={cn(
                    "size-3.5",
                    forwards.isFetching && "animate-spin",
                  )}
                />
                {t("common.refresh")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setForm({ mode: "create" })}
                disabled={!serverId}
              >
                <PlusIcon className="size-3.5" />
                {t("forwards.list.add")}
              </Button>
            </div>
          </div>
          <CardDescription className="text-xs">
            {t("forwards.list.desc")}
          </CardDescription>
          <div className="mt-2 flex items-start gap-1.5 type-micro leading-normal text-muted-foreground">
            <InfoIcon className="mt-px size-3 shrink-0" aria-hidden="true" />
            <span>{t("forwards.relayNote")}</span>
          </div>
        </CardHeader>

        <CardContent className="p-0" aria-busy={forwards.isPending}>
          {forwards.isPending ? (
            <SkeletonTable rows={4} columns={FORWARD_COLUMN_COUNT} />
          ) : null}
          <Table
            className={cn("min-w-[760px]", forwards.isPending && "hidden")}
          >
            <TableCaption className="sr-only">
              {t("forwards.list.tableCaption")}
            </TableCaption>
            <TableHeader className="bg-muted/30">
              <TableRow>
                {[
                  t("forwards.list.columns.name"),
                  t("forwards.list.columns.listenPort"),
                  t("forwards.list.columns.target"),
                  t("forwards.list.columns.status"),
                  t("forwards.list.columns.enabled"),
                  t("common.actions"),
                ].map((label) => (
                  <TableHead key={label} className={HEAD_CLASS}>
                    {label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {showError ? (
                <ErrorRow
                  message={loadError}
                  onRetry={() => void forwards.refetch()}
                  retrying={forwards.isFetching}
                />
              ) : items.length === 0 ? (
                <EmptyRow
                  title={t("forwards.list.emptyTitle")}
                  description={t("forwards.list.emptyDesc")}
                  actionLabel={t("forwards.list.emptyAction")}
                  onAction={() => setForm({ mode: "create" })}
                />
              ) : (
                items.map((forward) => {
                  const target = formatForwardTarget(
                    forward.target_host,
                    forward.target_port,
                  );

                  return (
                    <TableRow key={forward.id}>
                      <TableCell className="max-w-56 px-4 py-2.5">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate font-medium">
                            {forward.name}
                          </span>
                          <EngineBadge
                            engine={forward.engine}
                            realmUnavailable={realmMissingOnServer(
                              forward.engine,
                              server,
                            )}
                          />
                        </div>
                      </TableCell>
                      <TableCell className="px-4 py-2.5 font-mono text-xs tabular-nums">
                        {forward.listen_port}
                      </TableCell>
                      <TableCell className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                        <span className="break-all" title={target}>
                          {target}
                        </span>
                      </TableCell>
                      <TableCell className="px-4 py-2.5">
                        <ForwardStatusCell forward={forward} />
                      </TableCell>
                      <TableCell className="px-4 py-2.5">
                        <ForwardEnabledSwitch
                          serverId={serverId}
                          forward={forward}
                        />
                      </TableCell>
                      <TableCell className="px-4 py-2.5">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t("forwards.actionsAria", {
                                name: forward.name,
                              })}
                            >
                              <MoreHorizontalIcon className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-36">
                            <DropdownMenuItem
                              onSelect={() =>
                                setForm({ mode: "edit", forward })
                              }
                            >
                              <PencilIcon className="size-3.5" />
                              {t("common.edit")}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={() => setDeleteTarget(forward)}
                            >
                              <Trash2Icon className="size-3.5" />
                              {t("common.delete")}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {form ? (
        <ForwardFormDialog
          key={`${form.mode}-${form.forward?.id ?? "new"}`}
          open
          serverId={serverId}
          server={server}
          mode={form.mode}
          forward={form.forward}
          onOpenChange={(open) => {
            if (!open) setForm(null);
          }}
        />
      ) : null}

      {deleteTarget ? (
        <DeleteForwardDialog
          key={deleteTarget.id}
          open
          serverId={serverId}
          forward={deleteTarget}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
        />
      ) : null}
    </div>
  );
}
