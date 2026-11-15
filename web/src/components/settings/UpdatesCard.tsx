import {
  ArrowRightIcon,
  ArrowUpCircleIcon,
  Loader2Icon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import { FormField } from "@/components/FormField";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ApiError } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { useCheckUpdates, useUpdates } from "@/lib/queries";
import type { SettingsGeneralValues } from "@/lib/schemas";
import {
  checkedAtText,
  DEFAULT_UPDATE_INTERVAL_HOURS,
  formatVersion,
  hasUpdate,
  parseUpdateInterval,
  pickBilingual,
  updateErrorText,
  type AgentUpdateView,
  type MasterUpdateView,
} from "@/lib/updates";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

/**
 * P17：版本更新卡片。
 *
 * 数据来自 `GET /api/v1/updates`（管理员）；三个设置项属于「常规」表单，
 * 由页面底部同一条保存栏随整份表单一次提交，卡片内不再有自己的保存按钮。
 * 版本源只有 GitHub Releases；检测失败时卡片保留上一次成功的最新版本，
 * 只把失败原因画出来，不把整张卡变成错误态。
 */

/** 设置接口的错误文案：403/404 给可操作说明，其余走后端错误码翻译。 */
function cardErrorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return t("settings.updates.notReady404");
    if (error.status === 403) return t("settings.updates.forbidden");
  }
  return errorText(error, fallback);
}

function UpdatesSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <Skeleton className="h-20 w-full" />
      <div className="space-y-2">
        <Skeleton className="h-3 w-32" />
        <div className="flex gap-2">
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-7 w-24" />
        </div>
      </div>
    </div>
  );
}

export function UpdatesCard({
  form,
  saving,
}: {
  form: UseFormReturn<SettingsGeneralValues>;
  saving: boolean;
}) {
  useI18n();
  const updates = useUpdates(true);
  const check = useCheckUpdates();

  const interval = form.watch("update_check_interval_hours");
  const intervalError =
    form.formState.errors.update_check_interval_hours?.message ??
    (interval.trim() !== "" && parseUpdateInterval(interval) === null
      ? t("settings.updates.intervalInvalid")
      : undefined);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <ArrowUpCircleIcon className="size-4 text-muted-foreground" />
          {t("settings.updates.title")}
        </CardTitle>
        <CardDescription className="text-xs">
          {t("settings.updates.desc")}
        </CardDescription>
      </CardHeader>
      <CardContent className="max-w-2xl space-y-5">
        {updates.isPending ? (
          <UpdatesSkeleton />
        ) : updates.isError || !updates.data ? (
          <div className="space-y-3">
            <Alert
              variant="destructive"
              className="border-destructive/25 bg-destructive/10"
            >
              <TriangleAlertIcon />
              <AlertTitle>{t("settings.updates.loadFailed")}</AlertTitle>
              <AlertDescription>
                {cardErrorText(updates.error, t("settings.updates.loadError"))}
              </AlertDescription>
            </Alert>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void updates.refetch()}
              disabled={updates.isFetching}
            >
              <RefreshCwIcon
                className={cn(
                  "size-3.5",
                  updates.isFetching && "animate-spin",
                )}
              />
              {t("common.retry")}
            </Button>
          </div>
        ) : (
          <UpdatesSummary
            master={updates.data.master}
            agents={updates.data.agents}
          />
        )}

        <Separator />

        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="settings-update-enabled" className="font-normal">
            {t("settings.updates.enabled")}
          </Label>
          <Switch
            id="settings-update-enabled"
            checked={form.watch("update_check_enabled")}
            disabled={saving}
            onCheckedChange={(next) => {
              form.setValue("update_check_enabled", next === true, {
                shouldDirty: true,
                shouldTouch: true,
              });
            }}
          />
        </div>

        <FormField
          label={t("settings.updates.interval")}
          htmlFor="settings-update-interval"
          required
          hint={t("settings.updates.intervalHint")}
          error={intervalError}
          className="max-w-md"
        >
          <Input
            id="settings-update-interval"
            inputMode="numeric"
            placeholder={String(DEFAULT_UPDATE_INTERVAL_HOURS)}
            className="max-w-40"
            disabled={saving}
            aria-invalid={Boolean(intervalError)}
            {...form.register("update_check_interval_hours")}
          />
        </FormField>

        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="settings-update-notify" className="font-normal">
            {t("settings.updates.notify")}
          </Label>
          <Switch
            id="settings-update-notify"
            checked={form.watch("update_check_notify")}
            disabled={saving}
            onCheckedChange={(next) => {
              form.setValue("update_check_notify", next === true, {
                shouldDirty: true,
                shouldTouch: true,
              });
            }}
          />
        </div>

        {check.isError ? (
          <p className="text-xs break-words text-destructive">
            {cardErrorText(check.error, t("settings.updates.checkFailed"))}
          </p>
        ) : null}

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            check.mutate(undefined, {
              onSuccess: () => toast.success(t("settings.updates.checked")),
              onError: (error) =>
                toast.error(
                  cardErrorText(error, t("settings.updates.checkFailed")),
                ),
            });
          }}
          disabled={check.isPending || saving}
        >
          {check.isPending ? (
            <Loader2Icon className="animate-spin" />
          ) : (
            <RefreshCwIcon />
          )}
          {check.isPending
            ? t("settings.updates.checking")
            : t("settings.updates.check")}
        </Button>
      </CardContent>
    </Card>
  );
}

function UpdatesSummary({
  master,
  agents,
}: {
  master: MasterUpdateView;
  agents: AgentUpdateView;
}) {
  const { locale } = useI18n();
  const updateAvailable =
    master.update_available && hasUpdate(master.latest, master.current);
  const failure = updateErrorText(master.error);
  const failureText = failure ? pickBilingual(failure, locale) : null;
  const releaseUrl = master.release_url?.trim() || null;

  return (
    <>
      <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="text-muted-foreground">
            {t("settings.updates.current")}
          </span>
          <span className="font-mono">{formatVersion(master.current)}</span>
          <ArrowRightIcon
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="text-muted-foreground">
            {t("settings.updates.latest")}
          </span>
          <span
            className={cn("font-mono", updateAvailable && "text-primary")}
          >
            {master.latest
              ? formatVersion(master.latest)
              : t("settings.updates.notChecked")}
          </span>
          {updateAvailable ? (
            <Badge>{t("settings.updates.updateAvailable")}</Badge>
          ) : master.checked_at !== null && !failure ? (
            <Badge variant="secondary">
              {t("settings.updates.upToDate")}
            </Badge>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          <span>
            {t("settings.updates.lastChecked", {
              time: checkedAtText(master.checked_at),
            })}
          </span>
          {releaseUrl ? (
            <>
              <span aria-hidden="true">·</span>
              <a
                href={releaseUrl}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline-offset-2 hover:underline"
              >
                {t("settings.updates.release")}
              </a>
            </>
          ) : null}
        </div>

        {failureText ? (
          <p className="text-xs break-words text-destructive">
            {t("settings.updates.failed", { error: failureText })}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-medium">
            {t("settings.updates.agents")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("settings.updates.protocol", {
              current: agents.current_protocol,
              min: agents.min_supported,
            })}
          </p>
        </div>
        {agents.versions.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {agents.versions.map((row) => (
              <span
                key={row.version}
                className="rounded-md border bg-muted/30 px-2 py-1 font-mono text-xs"
              >
                {formatVersion(row.version)} × {row.count}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t("settings.updates.agentsEmpty")}
          </p>
        )}
      </div>
    </>
  );
}
