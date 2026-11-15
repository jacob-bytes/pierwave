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
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  SettingsGroup,
  SETTINGS_FULL_ROW,
} from "@/components/settings/SettingsGroup";
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
 * 常规 tab 的「版本更新」卡片。
 *
 * 数据来自 `GET /api/v1/updates`（管理员）；两个设置项属于「常规」表单，
 * 由页面底部同一条保存栏随整份表单一次提交，这里不再有自己的保存按钮。
 * 组头只放标题与说明；只读信息占用内容网格的第一行两列——左列是 master
 * 的当前 / 最新与检测状态，右列是 Agent 版本分布，与下面的设置项字段对齐。
 * 设置项是「标签在上、控件在下」的两列网格，「立即检测」是自己右对齐的操作行。
 * 版本源只有 GitHub Releases，检测失败时保留上一次成功的最新版本，
 * 只把失败原因画在 master 列，不把整个分组变成错误态、也不影响右列。
 *
 * 「发现新版本时通知」不在这里：它是通知页事件列表里的一个事件
 * （`update_available`），与其它告警事件共用同一份开关。
 */

/** 设置接口的错误文案：403/404 给可操作说明，其余走后端错误码翻译。 */
function cardErrorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return t("settings.updates.notReady404");
    if (error.status === 403) return t("settings.updates.forbidden");
  }
  return errorText(error, fallback);
}

/** 只读信息占位：与最终内容同高，避免加载完成后网格跳动。 */
function SummarySkeleton() {
  return (
    <div className="space-y-2" aria-busy="true">
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-4 w-44" />
      <Skeleton className="h-3 w-32" />
    </div>
  );
}

/** Agent 分布占位：标签、版本标签、协议行各一条。 */
function AgentsSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true">
      <Skeleton className="h-4 w-24" />
      <div className="flex flex-wrap gap-1.5">
        <Skeleton className="h-6 w-20" />
        <Skeleton className="h-6 w-20" />
      </div>
      <Skeleton className="h-3 w-32" />
    </div>
  );
}

export function UpdatesSection({
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
    <SettingsGroup
      icon={ArrowUpCircleIcon}
      title={t("settings.updates.title")}
      description={t("settings.updates.desc")}
    >
      {updates.isPending ? (
        <>
          <SummarySkeleton />
          <AgentsSkeleton />
        </>
      ) : updates.isError || !updates.data ? (
        <div className={cn(SETTINGS_FULL_ROW, "space-y-3")} role="group">
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
        <>
          {/* 只读信息占据网格第一行：左列对齐字段标签，右列对齐第二列。 */}
          <UpdatesSummary master={updates.data.master} />
          <AgentsInfo agents={updates.data.agents} />
        </>
      )}

      {/* 检测间隔与自动检测是同一件事（怎么检测 / 检不检），并排。 */}
      <FormField
        label={t("settings.updates.interval")}
        htmlFor="settings-update-interval"
        required
        hint={t("settings.updates.intervalHint")}
        error={intervalError}
      >
        <Input
          id="settings-update-interval"
          inputMode="numeric"
          placeholder={String(DEFAULT_UPDATE_INTERVAL_HOURS)}
          disabled={saving}
          aria-invalid={Boolean(intervalError)}
          {...form.register("update_check_interval_hours")}
        />
      </FormField>

      <FormField
        label={t("settings.updates.enabled")}
        htmlFor="settings-update-enabled"
      >
        <div className="flex h-8 items-center">
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
      </FormField>

      {/* 立即检测是操作，不是设置项：右对齐单独一行。 */}
      <div
        className={cn(
          SETTINGS_FULL_ROW,
          "flex flex-col items-start gap-2 lg:flex-row lg:items-center lg:justify-end lg:gap-3",
        )}
      >
        {check.isError ? (
          <p className="text-xs break-words text-destructive lg:max-w-md lg:text-right">
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
      </div>
    </SettingsGroup>
  );
}

/** 左列：master 的当前 / 最新、状态徽标、上次检测与失败原因。 */
function UpdatesSummary({ master }: { master: MasterUpdateView }) {
  const { locale } = useI18n();
  const updateAvailable =
    master.update_available && hasUpdate(master.latest, master.current);
  const failure = updateErrorText(master.error);
  const failureText = failure ? pickBilingual(failure, locale) : null;
  const releaseUrl = master.release_url?.trim() || null;

  return (
    <div className="space-y-2">
      <p className="text-sm leading-tight font-medium">
        {t("settings.updates.currentVersion")}
      </p>

      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="sr-only">{t("settings.updates.current")}</span>
          <span className="font-mono">{formatVersion(master.current)}</span>
          <ArrowRightIcon
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="sr-only">{t("settings.updates.latest")}</span>
          <span className={cn("font-mono", updateAvailable && "text-primary")}>
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
    </div>
  );
}

/**
 * 右列：Agent 版本分布与协议范围。
 *
 * 与左列的版本摘要并列，属于只读信息而不是设置项，所以不占用表单的
 * label + 控件结构；标签与左列「当前版本」同一字号，两列基线对齐。
 */
function AgentsInfo({ agents }: { agents: AgentUpdateView }) {
  return (
    <div className="space-y-2">
      <p className="text-sm leading-tight font-medium">
        {t("settings.updates.agents")}
      </p>

      <div className="space-y-1.5">
        {agents.versions.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
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

        <p className="text-xs text-muted-foreground">
          {t("settings.updates.protocol", {
            current: agents.current_protocol,
            min: agents.min_supported,
          })}
        </p>
      </div>
    </div>
  );
}
