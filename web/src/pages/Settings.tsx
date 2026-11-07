import { useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import type { ReactNode } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  ArrowUpCircleIcon,
  Loader2Icon,
  RefreshCwIcon,
  SaveIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { FormField, FormRootError } from "@/components/FormField";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, type Settings } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { useSettings, useUpdateSettings } from "@/lib/queries";
import {
  settingsFormSchema,
  type SettingsFormValues,
} from "@/lib/schemas";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

/** 设置接口与后端并行开发：404/403 给中文说明，不写 mock 数据。 */
function settingsErrorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return t("settings.notReady404");
    }
    if (error.status === 403) {
      return t("settings.forbidden");
    }
  }
  return errorText(error, fallback);
}

function toFormValues(items: Settings): SettingsFormValues {
  return {
    panel_name: items.panel_name ?? "",
    login_max_attempts:
      items.login_max_attempts == null ? "" : String(items.login_max_attempts),
    login_lock_secs:
      items.login_lock_secs == null ? "" : String(items.login_lock_secs),
    session_ttl_hours:
      items.session_ttl_hours == null ? "" : String(items.session_ttl_hours),
    // 旧版后端还没有这个键：默认一次一台，而不是让输入框空着。
    agent_upgrade_concurrency:
      items.agent_upgrade_concurrency == null
        ? "1"
        : String(items.agent_upgrade_concurrency),
  };
}

/** 输入过程中的即时预览：只有落在后端范围内才换算，避免误导。 */
function parseIntInRange(value: string, min: number, max: number) {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return parsed >= min && parsed <= max ? parsed : null;
}

/** 秒 → 人话：整小时说小时，整分钟说分钟，否则保留秒。 */
function lockDurationText(secs: number): string {
  if (secs % 3600 === 0)
    return t("settings.duration.hours", { n: secs / 3600 });
  if (secs % 60 === 0) return t("settings.duration.minutes", { n: secs / 60 });
  return t("settings.duration.seconds", { n: secs });
}

/** 锁定时长说明：能换算时补原始秒数，本身就按秒展示时不重复。 */
function lockHintText(secs: number | null): string {
  if (secs === null) return t("settings.security.lockHintDefault");
  const human = lockDurationText(secs);
  const secondsText = t("settings.duration.seconds", { n: secs });
  const detail =
    human === secondsText
      ? human
      : t("settings.security.lockDetail", {
          human,
          seconds: secondsText,
        });
  return t("settings.security.lockHintWith", { detail });
}

/** 小时 → 人话：超过一天时补上「天」，让 720 小时不再难读。 */
function sessionDurationText(hours: number): string {
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  if (days === 0) return t("settings.duration.hours", { n: hours });
  if (rest === 0)
    return t(
      days === 1
        ? "settings.duration.hoursWithOneDay"
        : "settings.duration.hoursWithDays",
      { hours, days },
    );
  return t("settings.duration.hoursWithDaysRest", { hours, days, rest });
}

function SettingsSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <Card>
        <CardHeader>
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-3 w-64" />
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-8 w-full max-w-md" />
          <Skeleton className="h-3 w-52" />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-3 w-72" />
        </CardHeader>
        <CardContent className="space-y-5">
          {[0, 1, 2].map((index) => (
            <div key={index} className="space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-8 w-full max-w-md" />
              <Skeleton className="h-3 w-64" />
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-3 w-80" />
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-8 w-full max-w-md" />
          <Skeleton className="h-3 w-72" />
        </CardContent>
      </Card>
    </div>
  );
}

function StateCard({
  icon: Icon,
  title,
  description,
  action,
  tone = "muted",
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action: ReactNode;
  tone?: "muted" | "destructive";
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
        <div
          className={cn(
            "grid size-10 place-items-center rounded-full",
            tone === "destructive"
              ? "bg-destructive/10 text-destructive"
              : "bg-muted text-muted-foreground",
          )}
        >
          <Icon className="size-5" />
        </div>
        <div>
          <p className="text-sm font-medium">{title}</p>
          <p className="mt-1 max-w-md text-xs text-muted-foreground">
            {description}
          </p>
        </div>
        {action}
      </CardContent>
    </Card>
  );
}

function SettingsForm({ initial }: { initial: Settings }) {
  const { t: translate } = useI18n();
  const updateSettings = useUpdateSettings();
  const schema = useMemo(() => settingsFormSchema(translate), [translate]);
  const form = useForm<SettingsFormValues>({
    resolver: zodResolver(schema),
    defaultValues: toFormValues(initial),
  });

  // 切换语言后重新校验，让已经显示的错误跟着换语言。
  useEffect(() => {
    if (form.formState.isSubmitted) void form.trigger();
  }, [translate, form]);

  const attempts = parseIntInRange(form.watch("login_max_attempts"), 1, 20);
  const lockSecs = parseIntInRange(form.watch("login_lock_secs"), 60, 86400);
  const ttlHours = parseIntInRange(form.watch("session_ttl_hours"), 1, 720);
  const concurrency = parseIntInRange(
    form.watch("agent_upgrade_concurrency"),
    1,
    5,
  );

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors("root");
    try {
      const items = await updateSettings.mutateAsync({
        panel_name: values.panel_name.trim(),
        login_max_attempts: Number(values.login_max_attempts),
        login_lock_secs: Number(values.login_lock_secs),
        session_ttl_hours: Number(values.session_ttl_hours),
        agent_upgrade_concurrency: Number(values.agent_upgrade_concurrency),
      });
      // PATCH 返回的 items 是权威值：回填表单（同时清掉脏标记），缓存已由 hook 更新。
      form.reset(toFormValues(items));
      toast.success(t("settings.saved"));
    } catch (error) {
      const message = settingsErrorText(error, t("settings.saveError"));
      form.setError("root", { message });
      toast.error(message);
    }
  });

  const attemptsHint =
    attempts && lockSecs
      ? t("settings.security.attemptsHintWith", {
          n: attempts,
          duration: lockDurationText(lockSecs),
        })
      : t("settings.security.attemptsHint");

  const lockHint = lockHintText(lockSecs);

  const sessionHint = ttlHours
    ? t("settings.security.sessionHintWith", {
        duration: sessionDurationText(ttlHours),
      })
    : t("settings.security.sessionHintDefault");

  const concurrencyHint = concurrency
    ? t("settings.agentUpgrade.concurrencyHintWith", { n: concurrency })
    : t("settings.agentUpgrade.concurrencyHintDefault");

  return (
    <form className="space-y-6" onSubmit={onSubmit}>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <SlidersHorizontalIcon className="size-4 text-muted-foreground" />
            {t("settings.panel.title")}
          </CardTitle>
          <CardDescription className="text-xs">
            {t("settings.panel.desc")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FormField
            label={t("settings.panel.name")}
            htmlFor="settings-panel-name"
            required
            hint={t("settings.panel.nameHint")}
            error={form.formState.errors.panel_name?.message}
            className="max-w-md"
          >
            <Input
              id="settings-panel-name"
              autoComplete="off"
              placeholder={t("settings.panel.namePlaceholder")}
              disabled={updateSettings.isPending}
              aria-invalid={Boolean(form.formState.errors.panel_name)}
              {...form.register("panel_name")}
            />
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheckIcon className="size-4 text-muted-foreground" />
            {t("settings.security.title")}
          </CardTitle>
          <CardDescription className="text-xs">
            {t("settings.security.desc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="max-w-2xl space-y-5">
          <FormField
            label={t("settings.security.attempts")}
            htmlFor="settings-login-max-attempts"
            required
            hint={attemptsHint}
            error={form.formState.errors.login_max_attempts?.message}
          >
            <Input
              id="settings-login-max-attempts"
              inputMode="numeric"
              placeholder="5"
              disabled={updateSettings.isPending}
              aria-invalid={Boolean(
                form.formState.errors.login_max_attempts,
              )}
              {...form.register("login_max_attempts")}
            />
          </FormField>

          <FormField
            label={t("settings.security.lock")}
            htmlFor="settings-login-lock-secs"
            required
            hint={lockHint}
            error={form.formState.errors.login_lock_secs?.message}
          >
            <Input
              id="settings-login-lock-secs"
              inputMode="numeric"
              placeholder="900"
              disabled={updateSettings.isPending}
              aria-invalid={Boolean(form.formState.errors.login_lock_secs)}
              {...form.register("login_lock_secs")}
            />
          </FormField>

          <FormField
            label={t("settings.security.session")}
            htmlFor="settings-session-ttl-hours"
            required
            hint={sessionHint}
            error={form.formState.errors.session_ttl_hours?.message}
          >
            <Input
              id="settings-session-ttl-hours"
              inputMode="numeric"
              placeholder="24"
              disabled={updateSettings.isPending}
              aria-invalid={Boolean(form.formState.errors.session_ttl_hours)}
              {...form.register("session_ttl_hours")}
            />
          </FormField>

          <FormRootError message={form.formState.errors.root?.message} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <ArrowUpCircleIcon className="size-4 text-muted-foreground" />
            {t("settings.agentUpgrade.title")}
          </CardTitle>
          <CardDescription className="text-xs">
            {t("settings.agentUpgrade.desc")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FormField
            label={t("settings.agentUpgrade.concurrency")}
            htmlFor="settings-agent-upgrade-concurrency"
            required
            hint={concurrencyHint}
            error={form.formState.errors.agent_upgrade_concurrency?.message}
            className="max-w-md"
          >
            <Input
              id="settings-agent-upgrade-concurrency"
              inputMode="numeric"
              placeholder="1"
              disabled={updateSettings.isPending}
              aria-invalid={Boolean(
                form.formState.errors.agent_upgrade_concurrency,
              )}
              {...form.register("agent_upgrade_concurrency")}
            />
          </FormField>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-3">
        <p className="text-xs text-muted-foreground">
          {t("settings.saveHint")}
        </p>
        <Button type="submit" disabled={updateSettings.isPending}>
          {updateSettings.isPending ? (
            <Loader2Icon className="animate-spin" />
          ) : (
            <SaveIcon />
          )}
          {updateSettings.isPending
            ? t("settings.saving")
            : t("common.save")}
        </Button>
      </div>
    </form>
  );
}

export default function SettingsPage() {
  useI18n();
  const settings = useSettings();

  return (
    <div className="animate-in space-y-6 fade-in-0 slide-in-from-bottom-1 duration-150">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t("settings.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.subtitle")}
        </p>
      </div>

      {settings.isPending ? (
        <SettingsSkeleton />
      ) : settings.isError ? (
        <StateCard
          icon={TriangleAlertIcon}
          tone="destructive"
          title={t("settings.loadFailed")}
          description={settingsErrorText(
            settings.error,
            t("settings.loadError"),
          )}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void settings.refetch()}
              disabled={settings.isFetching}
            >
              <RefreshCwIcon
                className={cn(
                  "size-3.5",
                  settings.isFetching && "animate-spin",
                )}
              />
              {t("common.retry")}
            </Button>
          }
        />
      ) : !settings.data || Object.keys(settings.data).length === 0 ? (
        <StateCard
          icon={SlidersHorizontalIcon}
          title={t("settings.emptyTitle")}
          description={t("settings.emptyDesc")}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void settings.refetch()}
              disabled={settings.isFetching}
            >
              <RefreshCwIcon
                className={cn(
                  "size-3.5",
                  settings.isFetching && "animate-spin",
                )}
              />
              {t("common.retry")}
            </Button>
          }
        />
      ) : (
        <SettingsForm initial={settings.data} />
      )}
    </div>
  );
}
