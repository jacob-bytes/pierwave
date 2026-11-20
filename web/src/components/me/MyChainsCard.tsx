import { useState } from "react";
import { toast } from "sonner";
import {
  BracesIcon,
  CopyIcon,
  InfoIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  TriangleAlertIcon,
  WaypointsIcon,
} from "lucide-react";
import { EmptyState, ListError } from "@/components/common";
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
import { chainEntryLabel, chainPath } from "@/lib/myChains";
import { createGate, type CreateBlocker } from "@/lib/myForwards";
import { useDeleteMyChain, useMyChains, useMyChainTemplates } from "@/lib/queries";
import { t, useI18n } from "@/i18n";
import { MyChainEditDialog } from "@/components/me/MyChainEditDialog";
import { MyChainFormDialog } from "@/components/me/MyChainFormDialog";

/**
 * 与自助转发同一套 `CreateBlocker`，只是文案换成转发链的说法。
 */
const BLOCKER_KEYS: Record<CreateBlocker, { title: string; desc: string }> = {
  unsupported: {
    title: "me.chains.unsupportedTitle",
    desc: "me.chains.unsupportedDesc",
  },
  stock: {
    title: "me.chains.stockTitle",
    desc: "me.chains.stockDesc",
  },
  exhausted: {
    title: "me.chains.exhaustedTitle",
    desc: "me.chains.exhaustedDesc",
  },
  "no-availability": {
    title: "me.chains.noTemplateTitle",
    desc: "me.chains.noTemplateDesc",
  },
};

const CREATE_REASON_ID = "my-chains-create-reason";

/** 配额徽章：`3 / 5 条`；存量态改写为「存量 2 条」，不出现 `2 / 0`。 */
function ChainQuotaBadge({
  quota,
  kind,
  itemCount,
}: {
  quota: MeChainQuota;
  kind: "ratio" | "stock";
  itemCount: number;
}) {
  const { t } = useI18n();

  if (kind === "stock") {
    return (
      <Badge
        variant="secondary"
        className="font-mono type-micro font-normal tabular-nums"
        aria-label={t("me.chains.quotaStockAria", { used: itemCount })}
      >
        {t("me.chains.quotaStock", { used: itemCount })}
      </Badge>
    );
  }

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
        {t("me.chains.quotaValue", {
          used: quota.used,
          limit: quota.limit,
        })}
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

function ChainRow({
  chain,
  onEdit,
  onDelete,
}: {
  chain: MeChain;
  onEdit: () => void;
  onDelete: () => void;
}) {
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
          {!chain.enabled ? (
            <Badge variant="secondary" className="font-normal">
              {t("me.chains.statusDisabled")}
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
          aria-label={t("me.chains.editAria", { address })}
          title={t("common.edit")}
          onClick={onEdit}
        >
          <PencilIcon className="size-3.5 text-muted-foreground" />
        </Button>
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
 * 「我的转发链」区块：列表 + 配额 + 新建 / 删除。
 *
 * 配额状态机与自助转发完全一致（`createGate`）：套餐不再支持新建时保留
 * 存量列表、只禁用新建；有配额但没有模板时在卡片内联说明原因。
 */
export function MyChainsCard() {
  useI18n();
  const chains = useMyChains();
  const templates = useMyChainTemplates();
  const remove = useDeleteMyChain();
  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<MeChain | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MeChain | null>(null);

  const data = chains.data;
  const items = data?.items ?? [];
  const quota = data?.quota ?? templates.data?.quota ?? null;
  const availableTemplates = templates.data?.items ?? [];
  // 模板请求未完成时传 null，避免加载中误报「没有可用模板」。
  const templateCount = templates.isPending ? null : availableTemplates.length;
  const gate = createGate({
    quota,
    itemCount: items.length,
    availableCount: templateCount,
  });
  const creatable = gate.creatable && !templates.isPending;
  const reason = gate.blocker ? BLOCKER_KEYS[gate.blocker] : null;
  const reasonText = reason ? t(reason.desc) : null;

  const loadError = isNotFound(chains.error)
    ? t("me.apiNotReady")
    : errorText(chains.error, t("me.chains.loadError"));

  return (
    <Card className="gap-4">
      <CardHeader className="card-header-stack">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <WaypointsIcon className="size-4 text-muted-foreground" />
          {t("me.chains.title")}
        </CardTitle>
        <CardDescription className="text-xs">
          {t("me.chains.desc")}
        </CardDescription>
        {/* <sm 时动作换到标题下方，标题 / 说明保持整宽（U2）。 */}
        <CardAction className="flex flex-wrap items-center gap-2">
          {data && quota && gate.badge ? (
            <ChainQuotaBadge
              quota={quota}
              kind={gate.badge}
              itemCount={items.length}
            />
          ) : null}
          {chains.isPending ? (
            <Skeleton className="h-8 w-24" />
          ) : gate.blocker === "unsupported" ? null : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setFormOpen(true)}
              disabled={!creatable}
              aria-describedby={
                gate.creatable ? undefined : CREATE_REASON_ID
              }
              title={gate.creatable ? undefined : (reasonText ?? undefined)}
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
          <ListError
            title={t("me.chains.loadFailed")}
            message={loadError}
            retrying={chains.isFetching}
            onRetry={() => void chains.refetch()}
          />
        ) : gate.blocker === "unsupported" ? (
          <EmptyState
            icon={BracesIcon}
            title={t("me.chains.unsupportedTitle")}
            description={t("me.chains.unsupportedDesc")}
          />
        ) : items.length === 0 ? (
          gate.blocker && reason ? (
            <div id={CREATE_REASON_ID}>
              <EmptyState
                icon={BracesIcon}
                tone="muted"
                title={t(reason.title)}
                description={t(reason.desc)}
              />
            </div>
          ) : (
            <EmptyState
              icon={BracesIcon}
              tone="primary"
              title={t("me.chains.emptyTitle")}
              description={t("me.chains.emptyDesc")}
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
              {items.map((chain) => (
                <ChainRow
                  key={chain.id}
                  chain={chain}
                  onEdit={() => setEditTarget(chain)}
                  onDelete={() => setDeleteTarget(chain)}
                />
              ))}
            </ul>
          </div>
        )}
      </CardContent>

      {editTarget ? (
        <MyChainEditDialog
          key={editTarget.id}
          open
          chain={editTarget}
          onOpenChange={(next) => {
            if (!next) setEditTarget(null);
          }}
        />
      ) : null}

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
