import { useEffect, useState } from "react";
import {
  ArrowRightIcon,
  ArrowUpCircleIcon,
  Loader2Icon,
  RefreshCwIcon,
  SaveIcon,
  TriangleAlertIcon,
} from "lucide-react";
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
import { ApiError, type Settings } from "@/lib/api";
import { errorText } from "@/lib/errors";
import {
  useCheckUpdates,
  useSettings,
  useUpdateSettings,
  useUpdates,
} from "@/lib/queries";
import {
  checkedAtText,
  formatVersion,
  hasUpdate,
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
 * 数据来自 `GET /api/v1/updates`（管理员），设置项复用 `PATCH /api/v1/settings`。
 * 版本源只有 GitHub Releases；检测失败时卡片保留上一次成功的最新版本，
 * 只把失败原因画出来，不把整张卡变成错误态。
 */

const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 168;
const DEFAULT_INTERVAL_HOURS = 6;

interface UpdateFormValues {
  enabled: boolean;
  interval: string;
  notify: boolean;
}

function toFormValues(items: Settings): UpdateFormValues {
  return {
    enabled: items.update_check_enabled ?? true,
    interval: String(
      items.update_check_interval_hours ?? DEFAULT_INTERVAL_HOURS,
    ),
    notify: items.update_check_notify ?? true,
  };
}

function sameValues(a: UpdateFormValues, b: UpdateFormValues): boolean {
  return (
    a.enabled === b.enabled &&
    a.notify === b.notify &&
    a.interval.trim() === b.interval.trim()
  );
}

function parseInterval(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= MIN_INTERVAL_HOURS && value <= MAX_INTERVAL_HOURS
    ? value
    : null;
}

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
      <Skeleton className="h-9 w-full max-w-md" />
    </div>
  );
}

export function UpdatesCard() {
  useI18n();
  const settings = useSettings();
  const updates = useUpdates(true);
  const updateSettings = useUpdateSettings();
  const check = useCheckUpdates();
  const [values, setValues] = useState<UpdateFormValues | null>(null);

  // 首次拿到设置时初始化表单；之后不再覆盖，避免后台刷新把用户的修改冲掉。
  useEffect(() => {
    if (values === null && settings.data) {
      setValues(toFormValues(settings.data));
    }
  }, [settings.data, values]);

  const pending = settings.isPending || updates.isPending;
  const failed = settings.isError || updates.isError;

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
        {pending || (!values && !failed) ? (
          <UpdatesSkeleton />
        ) : failed || !settings.data || !updates.data || !values ? (
          <div className="space-y-3">
            <Alert
              variant="destructive"
              className="border-destructive/25 bg-destructive/10"
            >
              <TriangleAlertIcon />
              <AlertTitle>{t("settings.updates.loadFailed")}</AlertTitle>
              <AlertDescription>
                {cardErrorText(
                  settings.error ?? updates.error,
                  t("settings.updates.loadError"),
                )}
              </AlertDescription>
            </Alert>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void settings.refetch();
                void updates.refetch();
              }}
              disabled={settings.isFetching || updates.isFetching}
            >
              <RefreshCwIcon
                className={cn(
                  "size-3.5",
                  (settings.isFetching || updates.isFetching) && "animate-spin",
                )}
              />
              {t("common.retry")}
            </Button>
          </div>
        ) : (
          <UpdatesBody
            master={updates.data.master}
            agents={updates.data.agents}
            values={values}
            initial={toFormValues(settings.data)}
            onChange={setValues}
            checkPending={check.isPending}
            checkError={check.isError ? check.error : null}
            onCheck={() => {
              check.mutate(undefined, {
                onSuccess: () => toast.success(t("settings.updates.checked")),
                onError: (error) =>
                  toast.error(
                    cardErrorText(error, t("settings.updates.checkFailed")),
                  ),
              });
            }}
            saving={updateSettings.isPending}
            onSave={(next) => {
              updateSettings.mutate(
                {
                  update_check_enabled: next.enabled,
                  update_check_interval_hours: parseInterval(next.interval),
                  update_check_notify: next.notify,
                },
                {
                  onSuccess: (items) => {
                    setValues(toFormValues(items));
                    toast.success(t("settings.updates.saved"));
                  },
                  onError: (error) =>
                    toast.error(
                      cardErrorText(error, t("settings.updates.saveError")),
                    ),
                },
              );
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

function UpdatesBody({
  master,
  agents,
  values,
  initial,
  onChange,
  checkPending,
  checkError,
  onCheck,
  saving,
  onSave,
}: {
  master: MasterUpdateView;
  agents: AgentUpdateView;
  values: UpdateFormValues;
  initial: UpdateFormValues;
  onChange: (next: UpdateFormValues) => void;
  checkPending: boolean;
  checkError: unknown;
  onCheck: () => void;
  saving: boolean;
  onSave: (next: UpdateFormValues) => void;
}) {
  const { t: translate, locale } = useI18n();
  const interval = parseInterval(values.interval);
  const intervalError =
    values.interval.trim() !== "" && interval === null
      ? translate("settings.updates.intervalInvalid")
      : undefined;
  const dirty = !sameValues(values, initial);
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

      <Separator />

      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (interval === null) return;
          onSave({ ...values, interval: String(interval) });
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="settings-update-enabled" className="font-normal">
            {t("settings.updates.enabled")}
          </Label>
          <Switch
            id="settings-update-enabled"
            checked={values.enabled}
            disabled={saving}
            onCheckedChange={(next) =>
              onChange({ ...values, enabled: next === true })
            }
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
            placeholder={String(DEFAULT_INTERVAL_HOURS)}
            className="max-w-40"
            disabled={saving}
            aria-invalid={Boolean(intervalError)}
            value={values.interval}
            onChange={(event) =>
              onChange({ ...values, interval: event.target.value })
            }
          />
        </FormField>

        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="settings-update-notify" className="font-normal">
            {t("settings.updates.notify")}
          </Label>
          <Switch
            id="settings-update-notify"
            checked={values.notify}
            disabled={saving}
            onCheckedChange={(next) =>
              onChange({ ...values, notify: next === true })
            }
          />
        </div>

        {checkError ? (
          <p className="text-xs break-words text-destructive">
            {cardErrorText(checkError, t("settings.updates.checkFailed"))}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onCheck}
            disabled={checkPending || saving}
          >
            {checkPending ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <RefreshCwIcon />
            )}
            {checkPending
              ? t("settings.updates.checking")
              : t("settings.updates.check")}
          </Button>

          <div className="flex items-center gap-3">
            <p
              className={cn(
                "text-xs",
                dirty ? "text-warning" : "text-muted-foreground",
              )}
            >
              {dirty ? t("settings.updates.dirtyHint") : t("settings.updates.saveHint")}
            </p>
            <Button
              type="submit"
              size="sm"
              disabled={!dirty || interval === null || saving}
            >
              {saving ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <SaveIcon />
              )}
              {saving ? t("settings.updates.saving") : t("settings.updates.save")}
            </Button>
          </div>
        </div>
      </form>
    </>
  );
}
