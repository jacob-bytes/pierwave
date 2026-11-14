import { useState } from "react";
import { toast } from "sonner";
import {
  BracesIcon,
  CopyIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
  WaypointsIcon,
} from "lucide-react";
import { EmptyState } from "@/components/common";
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
import type { MeChain, MeChainQuota } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { errorText, isNotFound } from "@/lib/errors";
import {
  canCreateChain,
  chainEntryLabel,
  chainPath,
  chainQuotaState,
} from "@/lib/myChains";
import { useDeleteMyChain, useMyChains, useMyChainTemplates } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";
import { MyChainFormDialog } from "@/components/me/MyChainFormDialog";

function ChainQuotaBadge({ quota }: { quota: MeChainQuota }) {
  const { t } = useI18n();
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {t("me.chains.quotaLabel")}
      <Badge
        variant="secondary"
        className="font-mono type-micro font-normal tabular-nums"
        aria-label={t("me.chains.quotaAria", {
          used: quota.used,
          limit: quota.limit,
        })}
      >
        {quota.used} / {quota.limit}
      </Badge>
    </span>
  );
}

async function copyAddress(address: string) {
  if (await copyText(address)) {
    toast.success(t("me.chains.copied"));
  } else {
    toast.error(t("me.chains.copyError"));
  }
}

function ChainRow({ chain, onDelete }: { chain: MeChain; onDelete: () => void }) {
  const { t } = useI18n();
  const address = chainEntryLabel(chain);
  const path = chainPath(chain);

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
            aria-label={t("me.chains.copyAria", { address })}
            title={t("common.copy")}
            disabled={address === "—"}
            onClick={() => void copyAddress(address)}
          >
            <CopyIcon className="size-3.5" />
          </Button>
          {chain.template_name ? (
            <Badge variant="outline" className="font-normal text-muted-foreground">
              {chain.template_name}
            </Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            {t("me.chains.target")}{" "}
            <span className="font-mono text-foreground/80">
              {chain.target_host}:{chain.target_port}
            </span>
          </span>
          <span className="min-w-0 truncate font-mono" title={path}>
            {path}
          </span>
        </div>
        {chain.blocked_reason ? (
          <p className="text-xs text-warning">{chain.blocked_reason}</p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("me.chains.removeAria", { address })}
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
 * 「我的链路」区块：列表 + 配额 + 新建 / 删除。
 *
 * 四态：skeleton / 空态（没有配额或没有链）/ 错误 / 正常。
 * 配额为 0 时整块只保留「当前套餐不支持自助建链」空态并隐藏新建按钮；
 * 用尽时保留列表，新建按钮禁用。
 */
export function MyChainsCard() {
  useI18n();
  const chains = useMyChains();
  const templates = useMyChainTemplates();
  const remove = useDeleteMyChain();
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MeChain | null>(null);

  const data = chains.data;
  const items = data?.items ?? [];
  const quota = data?.quota ?? templates.data?.quota ?? null;
  const availableTemplates = templates.data?.items ?? [];
  const state = chainQuotaState(quota);
  const creatable = canCreateChain(quota) && availableTemplates.length > 0;

  const loadError = isNotFound(chains.error)
    ? t("me.apiNotReady")
    : errorText(chains.error, t("me.chains.loadError"));

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <WaypointsIcon className="size-4 text-muted-foreground" />
          {t("me.chains.title")}
        </CardTitle>
        <CardDescription className="text-xs">
          {t("me.chains.desc")}
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          {data && quota ? <ChainQuotaBadge quota={quota} /> : null}
          {chains.isPending ? (
            <Skeleton className="h-8 w-24" />
          ) : state === "none" ? null : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setFormOpen(true)}
              disabled={!creatable}
              title={
                creatable
                  ? undefined
                  : availableTemplates.length === 0
                    ? t("me.chains.noTemplateDesc")
                    : t("me.chains.exhaustedDesc")
              }
            >
              <PlusIcon className="size-3.5" />
              {t("me.chains.add")}
            </Button>
          )}
        </CardAction>
      </CardHeader>

      <CardContent aria-busy={chains.isPending}>
        {chains.isPending ? (
          <div className="space-y-3">
            {[0, 1].map((index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        ) : chains.isError ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <div className="grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
              <TriangleAlertIcon className="size-5" />
            </div>
            <div>
              <p className="text-sm font-medium">{t("me.chains.loadFailed")}</p>
              <p className="mt-1 text-xs text-muted-foreground">{loadError}</p>
            </div>
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
              {t("common.retry")}
            </Button>
          </div>
        ) : state === "none" ? (
          <EmptyState
            icon={BracesIcon}
            title={t("me.chains.unsupportedTitle")}
            description={t("me.chains.unsupportedDesc")}
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={BracesIcon}
            tone={creatable ? "primary" : "muted"}
            title={
              creatable
                ? t("me.chains.emptyTitle")
                : availableTemplates.length === 0
                  ? t("me.chains.noTemplateTitle")
                  : t("me.chains.exhaustedTitle")
            }
            description={
              creatable
                ? t("me.chains.emptyDesc")
                : availableTemplates.length === 0
                  ? t("me.chains.noTemplateDesc")
                  : t("me.chains.exhaustedDesc")
            }
            action={
              creatable ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setFormOpen(true)}
                >
                  <PlusIcon className="size-3.5" />
                  {t("me.chains.add")}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="space-y-3">
            {state === "exhausted" ? (
              <Alert className="border-warning/25 bg-warning/10 text-warning">
                <TriangleAlertIcon />
                <AlertTitle>{t("me.chains.exhaustedTitle")}</AlertTitle>
                <AlertDescription className="text-warning/90">
                  {t("me.chains.exhaustedDesc")}
                </AlertDescription>
              </Alert>
            ) : null}
            <ul className="divide-y divide-border">
              {items.map((chain) => (
                <ChainRow
                  key={chain.id}
                  chain={chain}
                  onDelete={() => setDeleteTarget(chain)}
                />
              ))}
            </ul>
          </div>
        )}
      </CardContent>

      {formOpen ? (
        <MyChainFormDialog
          open
          onOpenChange={setFormOpen}
          templates={availableTemplates}
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
              <AlertDialogTitle>{t("me.chains.deleteTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("me.chains.deleteDesc")}
                <span className="mt-2 block font-mono text-xs text-foreground/80">
                  {chainEntryLabel(deleteTarget)}
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
                      toast.success(t("me.chains.deleted"));
                      setDeleteTarget(null);
                    },
                    onError: (error) => {
                      toast.error(
                        errorText(error, t("me.chains.deleteError")),
                      );
                    },
                  });
                }}
              >
                {t("me.chains.deleteAction")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </Card>
  );
}
