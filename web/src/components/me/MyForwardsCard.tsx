import { useState } from "react";
import { toast } from "sonner";
import {
  ArrowRightLeftIcon,
  CopyIcon,
  InfoIcon,
  PlusIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { EmptyState, ListError, ProtocolBadge } from "@/components/common";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import type {
  MeForward,
  MeForwardQuota,
  MeForwardServer,
  MeForwardsResponse,
  MeSummary,
} from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { errorText, isNotFound } from "@/lib/errors";
import { formatForwardTarget } from "@/lib/forwards";
import {
  createGate,
  entryLabel,
  forwardServersReason,
  type CreateBlocker,
} from "@/lib/myForwards";
import {
  useDeleteMyForward,
  useMyForwards,
  useUpdateMyForward,
} from "@/lib/queries";
import { t, useI18n } from "@/i18n";
import { MyForwardFormDialog } from "@/components/me/MyForwardFormDialog";

/**
 * 允许自助转发的服务器来源。
 *
 * 契约主路径是 `/me/summary` 的 `forward_servers`；后端若把它放在
 * 列表响应的 `servers` / `available_servers` 里也能工作。字段存在但为
 * 空数组时视为「一个都不允许」，不再回落到另一个来源。
 */
function allowedServers(
  summary: MeSummary,
  list: MeForwardsResponse | undefined,
): MeForwardServer[] {
  if (Array.isArray(summary.forward_servers)) return summary.forward_servers;
  if (Array.isArray(list?.servers)) return list.servers;
  if (Array.isArray(list?.available_servers)) return list.available_servers;
  return [];
}

async function copyEntryAddress(address: string) {
  if (await copyText(address)) {
    toast.success(t("me.forwards.copied"));
  } else {
    toast.error(t("me.forwards.copyError"));
  }
}

/**
 * 新建被拦下时的标题 / 说明键；与 `CreateBlocker` 一一对应，
 * 让「禁用按钮」和「卡片内联说明」永远用同一句话。
 */
const BLOCKER_KEYS: Record<CreateBlocker, { title: string; desc: string }> = {
  unsupported: {
    title: "me.forwards.unsupportedTitle",
    desc: "me.forwards.unsupportedDesc",
  },
  stock: {
    title: "me.forwards.stockTitle",
    desc: "me.forwards.stockDesc",
  },
  exhausted: {
    title: "me.forwards.exhaustedTitle",
    desc: "me.forwards.exhaustedDesc",
  },
  "no-availability": {
    title: "me.forwards.noServersTitle",
    desc: "me.forwards.noServersDesc",
  },
};

const CREATE_REASON_ID = "my-forwards-create-reason";

/**
 * 配额徽章：`3 / 5 条`；`limit <= 0` 的存量态改写为「存量 2 条」，
 * 绝不出现 `2 / 0`。单位由词典给出（英文 `3 of 5`）。
 */
function QuotaBadge({
  quota,
  kind,
  itemCount,
}: {
  quota: MeForwardQuota;
  kind: "ratio" | "stock";
  itemCount: number;
}) {
  const { t } = useI18n();

  if (kind === "stock") {
    return (
      <Badge
        variant="secondary"
        className="font-mono type-micro font-normal tabular-nums"
        aria-label={t("me.forwards.quotaStockAria", { used: itemCount })}
      >
        {t("me.forwards.quotaStock", { used: itemCount })}
      </Badge>
    );
  }

  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {t("me.forwards.quotaLabel")}
      <Badge
        variant="secondary"
        className="font-mono type-micro font-normal tabular-nums"
        aria-label={t("me.forwards.quotaAria", {
          used: quota.used,
          limit: quota.limit,
        })}
      >
        {t("me.forwards.quotaValue", {
          used: quota.used,
          limit: quota.limit,
        })}
      </Badge>
    </span>
  );
}

function ForwardRow({
  forward,
  onDelete,
}: {
  forward: MeForward;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const update = useUpdateMyForward();
  const address = entryLabel(forward);
  const enabled = Boolean(forward.enabled);
  const countTraffic = Boolean(forward.count_traffic);
  const target = formatForwardTarget(forward.target_host, forward.target_port);

  return (
    <li className="flex flex-col gap-2.5 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <code
            className="max-w-full truncate rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground/90"
            title={address}
          >
            {address}
          </code>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("me.forwards.copyAria", { address })}
            title={t("common.copy")}
            disabled={address === "—"}
            onClick={() => void copyEntryAddress(address)}
          >
            <CopyIcon className="size-3.5" />
          </Button>
          <ProtocolBadge protocol={forward.protocol} />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            {t("me.forwards.target")}{" "}
            <span className="font-mono text-foreground/80" title={target}>
              {target}
            </span>
          </span>
          <span className="truncate">{forward.server_name || "—"}</span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Switch
          size="sm"
          className="after:-inset-x-3.5 after:-inset-y-3.5"
          checked={enabled}
          disabled={update.isPending}
          aria-label={t("me.forwards.toggleAria", {
            action: enabled
              ? t("me.forwards.disableAction")
              : t("me.forwards.enableAction"),
            address,
          })}
          onCheckedChange={(checked) => {
            update.mutate(
              { id: forward.id, enabled: checked },
              {
                onSuccess: () => {
                  toast.success(
                    checked
                      ? t("me.forwards.enabledToast", { address })
                      : t("me.forwards.disabledToast", { address }),
                  );
                },
                onError: (error) => {
                  toast.error(
                    errorText(error, t("me.forwards.toggleError")),
                  );
                },
              },
            );
          }}
        />
        <span className="w-8 text-xs text-muted-foreground">
          {enabled ? t("common.enabled") : t("common.disabled")}
        </span>
        <div
          className="flex items-center gap-1.5"
          title={t("me.forwards.countTrafficHint")}
        >
          <Switch
            size="sm"
            className="after:-inset-x-3.5 after:-inset-y-3.5"
            checked={countTraffic}
            disabled={update.isPending}
            aria-label={t(
              countTraffic
                ? "me.forwards.countTrafficOffAria"
                : "me.forwards.countTrafficOnAria",
              { address },
            )}
            onCheckedChange={(checked) => {
              update.mutate(
                { id: forward.id, count_traffic: checked },
                {
                  onSuccess: () => {
                    toast.success(
                      checked
                        ? t("me.forwards.countTrafficOnToast", { address })
                        : t("me.forwards.countTrafficOffToast", { address }),
                    );
                  },
                  onError: (error) => {
                    toast.error(
                      errorText(error, t("me.forwards.countTrafficError")),
                    );
                  },
                },
              );
            }}
          />
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            {countTraffic
              ? t("me.forwards.countTrafficOn")
              : t("me.forwards.countTrafficOff")}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("me.forwards.removeAria", { address })}
          title={t("common.delete")}
          onClick={onDelete}
        >
          <Trash2Icon className="size-3.5 text-muted-foreground" />
        </Button>
      </div>
    </li>
  );
}

/**
 * 「我的转发」区块：列表 + 配额 + 新建 / 启停 / 删除。
 *
 * 四态：skeleton / 空态 / 错误 / 正常，但「空」不是一刀切：
 * - 套餐不支持（limit <= 0）且没有存量：只给不支持空态并隐藏新建；
 * - 套餐不支持但还有存量：保留列表，只禁用新建，徽章改成「存量 N 条」；
 * - 有配额但没有授权服务器：禁用新建并在卡片内联说明原因；
 * - 配额用尽：保留列表，新建禁用并说明删除后可再建。
 */
export function MyForwardsCard({ summary }: { summary: MeSummary }) {
  useI18n();
  const forwards = useMyForwards();
  const remove = useDeleteMyForward();
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MeForward | null>(null);

  const data = forwards.data;
  const items = data?.items ?? [];
  const quota = data?.quota ?? null;
  const servers = allowedServers(summary, data);
  /*
   * 空 `forward_servers` 的解释：新后端返回 `forward_servers_reason`
   * （`forward_servers_empty` / `forward_limit_zero`），旧后端没有该字段。
   * 读到 `forward_limit_zero` 时即使旧列表里还残留服务器也按「不可新建」处理；
   * 读不到就回落 U1 的 `servers.length`。
   */
  const serversReason = forwardServersReason(summary.forward_servers_reason);
  const availableCount =
    serversReason === "no-limit" ? 0 : servers.length;
  const gate = createGate({
    quota,
    itemCount: items.length,
    availableCount,
  });
  const reason = gate.blocker ? BLOCKER_KEYS[gate.blocker] : null;
  const reasonText = reason ? t(reason.desc) : null;

  const loadError = isNotFound(forwards.error)
    ? t("me.apiNotReady")
    : errorText(forwards.error, t("me.forwards.loadError"));

  return (
    <Card className="gap-4">
      <CardHeader className="card-header-stack">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <ArrowRightLeftIcon className="size-4 text-muted-foreground" />
          {t("me.forwards.title")}
        </CardTitle>
        <CardDescription className="text-xs">
          {t("me.forwards.desc")}
        </CardDescription>
        {/* <sm 时动作换到标题下方，标题 / 说明保持整宽（U2）。 */}
        <CardAction className="flex flex-wrap items-center gap-2">
          {data && quota && gate.badge ? (
            <QuotaBadge
              quota={quota}
              kind={gate.badge}
              itemCount={items.length}
            />
          ) : null}
          {forwards.isPending ? (
            <Skeleton className="h-8 w-24" />
          ) : gate.blocker === "unsupported" ? null : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setFormOpen(true)}
              disabled={!gate.creatable}
              aria-describedby={
                gate.creatable ? undefined : CREATE_REASON_ID
              }
              title={gate.creatable ? undefined : (reasonText ?? undefined)}
            >
              <PlusIcon className="size-3.5" />
              {t("me.forwards.add")}
            </Button>
          )}
        </CardAction>
      </CardHeader>

      <CardContent aria-busy={forwards.isPending}>
        {forwards.isPending ? (
          <div className="space-y-3">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        ) : forwards.isError ? (
          <ListError
            title={t("me.forwards.loadFailed")}
            message={loadError}
            retrying={forwards.isFetching}
            onRetry={() => void forwards.refetch()}
          />
        ) : gate.blocker === "unsupported" ? (
          <EmptyState
            icon={ArrowRightLeftIcon}
            title={t("me.forwards.unsupportedTitle")}
            description={t("me.forwards.unsupportedDesc")}
          />
        ) : items.length === 0 ? (
          gate.blocker && reason ? (
            // 用 id 关联禁用按钮；空态本身就是那句「为什么不能建」。
            <div id={CREATE_REASON_ID}>
              <EmptyState
                icon={ArrowRightLeftIcon}
                tone="muted"
                title={t(reason.title)}
                description={t(reason.desc)}
              />
            </div>
          ) : (
            <EmptyState
              icon={ArrowRightLeftIcon}
              tone="primary"
              title={t("me.forwards.emptyTitle")}
              description={t("me.forwards.emptyDesc")}
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setFormOpen(true)}
                >
                  <PlusIcon className="size-3.5" />
                  {t("me.forwards.add")}
                </Button>
              }
            />
          )
        ) : (
          <div className="space-y-3">
            {gate.blocker && reason ? (
              gate.blocker === "exhausted" ? (
                <Alert
                  id={CREATE_REASON_ID}
                  className="border-warning/25 bg-warning/10 text-warning"
                >
                  <TriangleAlertIcon />
                  <AlertTitle>{t(reason.title)}</AlertTitle>
                  <AlertDescription className="text-warning/90">
                    {t(reason.desc)}
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert id={CREATE_REASON_ID}>
                  <InfoIcon />
                  <AlertTitle>{t(reason.title)}</AlertTitle>
                  <AlertDescription>{t(reason.desc)}</AlertDescription>
                </Alert>
              )
            ) : null}
            <ul className="divide-y divide-border">
              {items.map((forward) => (
                <ForwardRow
                  key={forward.id}
                  forward={forward}
                  onDelete={() => setDeleteTarget(forward)}
                />
              ))}
            </ul>
          </div>
        )}
      </CardContent>

      {formOpen ? (
        <MyForwardFormDialog
          open
          onOpenChange={setFormOpen}
          servers={servers}
        />
      ) : null}

      {deleteTarget ? (
        <AlertDialog
          open
          onOpenChange={(next) => {
            if (!next && remove.isPending) return;
            if (!next) setDeleteTarget(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogMedia className="bg-destructive/10 text-destructive">
                <Trash2Icon className="size-5" />
              </AlertDialogMedia>
              <AlertDialogTitle>
                {t("me.forwards.deleteTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("me.forwards.deleteDesc")}
                <span className="mt-2 block font-mono text-xs text-foreground/80">
                  {entryLabel(deleteTarget)}
                </span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={remove.isPending}>
                {t("common.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={remove.isPending}
                onClick={(event) => {
                  event.preventDefault();
                  remove.mutate(deleteTarget.id, {
                    onSuccess: () => {
                      toast.success(t("me.forwards.deleted"));
                      setDeleteTarget(null);
                    },
                    onError: (error) => {
                      toast.error(
                        errorText(error, t("me.forwards.deleteError")),
                      );
                    },
                  });
                }}
              >
                {t("me.forwards.deleteAction")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </Card>
  );
}
