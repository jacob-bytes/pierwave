import { useState } from "react";
import { toast } from "sonner";
import {
  CopyIcon,
  InfoIcon,
  Link2Icon,
  QrCodeIcon,
  RotateCcwIcon,
  ServerIcon,
} from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useMeShellSummary } from "@/lib/meShell";
import { EmptyState } from "@/components/common";
import { SubscriptionQrDialog } from "@/components/subscriptions/SubscriptionQrDialog";
import type { MeSummary } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { errorText } from "@/lib/errors";
import { absoluteSubscriptionUrl } from "@/lib/meSubscription";
import { useResetSubscription } from "@/lib/queries";
import {
  DEFAULT_SUBSCRIPTION_FORMAT,
  SUBSCRIPTION_FORMAT_DESCRIPTIONS,
  SUBSCRIPTION_FORMATS,
  withSubscriptionFormat,
  type SubscriptionFormat,
} from "@/lib/subscriptionFormats";
import { formatAbsoluteTime } from "@/lib/time";
import { useI18n, t } from "@/i18n";

function SubscriptionCard({
  summary,
  onReset,
}: {
  summary: MeSummary;
  onReset: () => void;
}) {
  useI18n();
  const [format, setFormat] = useState<SubscriptionFormat>(
    DEFAULT_SUBSCRIPTION_FORMAT,
  );
  const [qrOpen, setQrOpen] = useState(false);
  const baseUrl = absoluteSubscriptionUrl(summary);
  const url = withSubscriptionFormat(baseUrl, format);

  async function handleCopy() {
    if (await copyText(url)) {
      toast.success(t("me.subscription.copied"));
    } else {
      toast.error(t("me.subscription.copyError"));
    }
  }

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Link2Icon className="size-4 text-muted-foreground" />
          {t("me.subscription.title")}
        </CardTitle>
        <CardDescription className="text-xs">
          {t("me.subscription.desc")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">
              {t("me.subscription.format")}
            </span>
            <Select
              value={format}
              onValueChange={(value) => setFormat(value as SubscriptionFormat)}
            >
              <SelectTrigger
                size="sm"
                className="h-8 w-[150px] text-xs"
                aria-label={t("me.subscription.formatAria")}
                title={t("me.subscription.formatHint")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                {SUBSCRIPTION_FORMATS.map((item) => {
                  const description = SUBSCRIPTION_FORMAT_DESCRIPTIONS[item];
                  return (
                    <SelectItem
                      key={item}
                      value={item}
                      className="text-xs"
                      title={description ? t(description) : undefined}
                    >
                      {t(`subscriptions.formats.${item}`)}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("me.subscription.updatedAt", {
              time: formatAbsoluteTime(summary.subscription?.updated_at),
            })}
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <code
            className="min-w-0 flex-1 truncate rounded-md bg-muted px-2.5 py-2 font-mono text-xs text-muted-foreground"
            title={url}
          >
            {url}
          </code>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void handleCopy()}>
              <CopyIcon className="size-3.5" />
              {t("me.subscription.copy")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setQrOpen(true)}
            >
              <QrCodeIcon className="size-3.5" />
              {t("me.subscription.qr")}
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
            {t("me.subscription.hint")}
          </p>
          <Button variant="outline" size="sm" onClick={onReset}>
            <RotateCcwIcon className="size-3.5" />
            {t("me.subscription.reset")}
          </Button>
        </div>
      </CardContent>

      {qrOpen ? (
        <SubscriptionQrDialog
          open={qrOpen}
          onOpenChange={setQrOpen}
          username={summary.user.username}
          url={url}
        />
      ) : null}
    </Card>
  );
}

function NodesCard({ summary }: { summary: MeSummary }) {
  useI18n();
  // 断流/过期时授权集合为空：空态文案要说明「恢复后才有」，不能只说「没有套餐」。
  const unavailable = ["exhausted", "expired", "disabled"].includes(
    summary.usage.status,
  );

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <ServerIcon className="size-4 text-muted-foreground" />
          {t("me.nodes.title")}
        </CardTitle>
        <CardDescription className="text-xs">
          {t("me.nodes.desc")}
        </CardDescription>
        <CardAction>
          <Badge
            variant="secondary"
            className="font-mono type-micro font-normal text-muted-foreground"
          >
            {summary.nodes.length}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {summary.nodes.length === 0 ? (
          <EmptyState
            icon={ServerIcon}
            title={
              unavailable ? t("me.nodes.unavailable") : t("me.nodes.empty")
            }
            description={
              unavailable
                ? t("me.nodes.unavailableDesc")
                : t("me.nodes.emptyDesc")
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {summary.nodes.map((node) => (
              <li
                key={node.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0"
              >
                <span className="min-w-0 truncate text-sm font-medium">
                  {node.name}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <Badge
                    variant="outline"
                    className="border-transparent bg-primary/10 font-mono type-micro font-normal text-primary"
                  >
                    {node.protocol}
                  </Badge>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <ServerIcon className="size-3.5" />
                    {node.server_name || "—"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ResetSubscriptionDialog({
  open,
  onOpenChange,
  username,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  username: string;
}) {
  useI18n();
  const reset = useResetSubscription();

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && reset.isPending) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-warning/10 text-warning">
            <RotateCcwIcon className="size-5" />
          </AlertDialogMedia>
          <AlertDialogTitle>
            {t("me.subscription.resetTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("me.subscription.resetDesc")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={reset.isPending}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={reset.isPending}
            onClick={(event) => {
              event.preventDefault();
              reset.mutate(undefined, {
                onSuccess: () => {
                  toast.success(t("me.subscription.resetSuccess", { username }));
                  onOpenChange(false);
                },
                onError: (error) => {
                  toast.error(
                    errorText(error, t("me.subscription.resetError")),
                  );
                },
              });
            }}
          >
            {t("me.subscription.resetAction")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** 我的订阅：订阅链接（格式 / 复制 / 二维码 / 重置）+ 节点数 + 最近更新。 */
export default function MeSubscriptionPage() {
  useI18n();
  const summary = useMeShellSummary();
  const [resetOpen, setResetOpen] = useState(false);

  return (
    <div className="space-y-4">
      <SubscriptionCard summary={summary} onReset={() => setResetOpen(true)} />
      <NodesCard summary={summary} />
      <ResetSubscriptionDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        username={summary.user.username}
      />
    </div>
  );
}
