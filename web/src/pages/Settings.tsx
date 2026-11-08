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
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { FormField, FormRootError } from "@/components/FormField";
import { AlertsCard } from "@/components/settings/AlertsCard";
import { BackupCard } from "@/components/settings/BackupCard";
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
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { ApiError, type Settings } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { useSettings, useUpdateSettings } from "@/lib/queries";
import {
  settingsGeneralSchema,
  settingsSecuritySchema,
  type SettingsGeneralValues,
  type SettingsSecurityValues,
} from "@/lib/schemas";
import {
  resolveSettingsTab,
  settingsTabParam,
  type SettingsTabId,
} from "@/lib/settingsTabs";
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

/** 常规 tab 的表单值：只含本 tab 提交的键。 */
function toGeneralFormValues(items: Settings): SettingsGeneralValues {
  return {
    panel_name: items.panel_name ?? "",
    // 旧版后端还没有这个键：默认一次一台，而不是让输入框空着。
    agent_upgrade_concurrency:
      items.agent_upgrade_concurrency == null
        ? "1"
        : String(items.agent_upgrade_concurrency),
  };
}

/** 安全 tab 的表单值：只含本 tab 提交的键。 */
function toSecurityFormValues(items: Settings): SettingsSecurityValues {
  return {
    login_max_attempts:
      items.login_max_attempts == null ? "" : String(items.login_max_attempts),
    login_lock_secs:
      items.login_lock_secs == null ? "" : String(items.login_lock_secs),
    session_ttl_hours:
      items.session_ttl_hours == null ? "" : String(items.session_ttl_hours),
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

function SettingsSkeleton({ cards = 2 }: { cards?: number }) {
  return (
    <div className="space-y-6" aria-busy="true">
      {Array.from({ length: cards }, (_, index) => (
        <Card key={index}>
          <CardHeader>
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-64" />
          </CardHeader>
          <CardContent className="space-y-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-8 w-full max-w-md" />
            <Skeleton className="h-3 w-52" />
          </CardContent>
        </Card>
      ))}
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

type SettingsQuery = ReturnType<typeof useSettings>;

function RetryButton({ query }: { query: SettingsQuery }) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => void query.refetch()}
      disabled={query.isFetching}
    >
      <RefreshCwIcon
        className={cn("size-3.5", query.isFetching && "animate-spin")}
      />
      {t("common.retry")}
    </Button>
  );
}

/**
 * 常规 / 安全两个 tab 共用同一份设置查询，但各自渲染四态。
 * 告警与备份卡片自己拉数据，不走这里。
 */
function SettingsPanelState({
  query,
  cards,
  children,
}: {
  query: SettingsQuery;
  cards: number;
  children: (items: Settings) => ReactNode;
}) {
  if (query.isPending) return <SettingsSkeleton cards={cards} />;
  if (query.isError) {
    return (
      <StateCard
        icon={TriangleAlertIcon}
        tone="destructive"
        title={t("settings.loadFailed")}
        description={settingsErrorText(query.error, t("settings.loadError"))}
        action={<RetryButton query={query} />}
      />
    );
  }
  if (!query.data || Object.keys(query.data).length === 0) {
    return (
      <StateCard
        icon={SlidersHorizontalIcon}
        title={t("settings.emptyTitle")}
        description={t("settings.emptyDesc")}
        action={<RetryButton query={query} />}
      />
    );
  }
  return <>{children(query.data)}</>;
}

/** 每个 tab 自己的保存条；提交键只由所在表单决定。 */
function SaveBar({ pending }: { pending: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-3">
      <p className="text-xs text-muted-foreground">{t("settings.saveHint")}</p>
      <Button type="submit" disabled={pending}>
        {pending ? (
          <Loader2Icon className="animate-spin" />
        ) : (
          <SaveIcon />
        )}
        {pending ? t("settings.saving") : t("common.save")}
      </Button>
    </div>
  );
}

function GeneralForm({ initial }: { initial: Settings }) {
  const { t: translate } = useI18n();
  const updateSettings = useUpdateSettings();
  const schema = useMemo(() => settingsGeneralSchema(translate), [translate]);
  const form = useForm<SettingsGeneralValues>({
    resolver: zodResolver(schema),
    defaultValues: toGeneralFormValues(initial),
  });

  // 切换语言后重新校验，让已经显示的错误跟着换语言。
  useEffect(() => {
    if (form.formState.isSubmitted) void form.trigger();
  }, [translate, form]);

  const concurrency = parseIntInRange(
    form.watch("agent_upgrade_concurrency"),
    1,
    5,
  );

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors("root");
    try {
      // 只 PATCH 常规 tab 的键：不提交整份对象，避免覆盖安全 tab 刚存的值。
      const items = await updateSettings.mutateAsync({
        panel_name: values.panel_name.trim(),
        agent_upgrade_concurrency: Number(values.agent_upgrade_concurrency),
      });
      // PATCH 返回的 items 是权威值：回填表单（同时清掉脏标记），缓存已由 hook 更新。
      form.reset(toGeneralFormValues(items));
      toast.success(t("settings.general.saved"));
    } catch (error) {
      const message = settingsErrorText(error, t("settings.saveError"));
      form.setError("root", { message });
      toast.error(message);
    }
  });

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

      <FormRootError message={form.formState.errors.root?.message} />

      <SaveBar pending={updateSettings.isPending} />
    </form>
  );
}

function SecurityForm({ initial }: { initial: Settings }) {
  const { t: translate } = useI18n();
  const updateSettings = useUpdateSettings();
  const schema = useMemo(() => settingsSecuritySchema(translate), [translate]);
  const form = useForm<SettingsSecurityValues>({
    resolver: zodResolver(schema),
    defaultValues: toSecurityFormValues(initial),
  });

  // 切换语言后重新校验，让已经显示的错误跟着换语言。
  useEffect(() => {
    if (form.formState.isSubmitted) void form.trigger();
  }, [translate, form]);

  const attempts = parseIntInRange(form.watch("login_max_attempts"), 1, 20);
  const lockSecs = parseIntInRange(form.watch("login_lock_secs"), 60, 86400);
  const ttlHours = parseIntInRange(form.watch("session_ttl_hours"), 1, 720);

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors("root");
    try {
      // 只 PATCH 安全 tab 的键：不提交整份对象，避免覆盖常规 tab 刚存的值。
      const items = await updateSettings.mutateAsync({
        login_max_attempts: Number(values.login_max_attempts),
        login_lock_secs: Number(values.login_lock_secs),
        session_ttl_hours: Number(values.session_ttl_hours),
      });
      // PATCH 返回的 items 是权威值：回填表单（同时清掉脏标记），缓存已由 hook 更新。
      form.reset(toSecurityFormValues(items));
      toast.success(t("settings.security.saved"));
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

  return (
    <form className="space-y-6" onSubmit={onSubmit}>
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

      <SaveBar pending={updateSettings.isPending} />
    </form>
  );
}

/** tab 顺序即 URL 回落的顺序（第一个是默认 tab）。 */
const SETTINGS_TABS = [
  {
    value: "general",
    labelKey: "settings.tabs.regular",
    descKey: "settings.tabs.regularDesc",
  },
  {
    value: "security",
    labelKey: "settings.tabs.security",
    descKey: "settings.tabs.securityDesc",
  },
  {
    value: "alerts",
    labelKey: "settings.tabs.alerts",
    descKey: "settings.tabs.alertsDesc",
  },
  {
    value: "backup",
    labelKey: "settings.tabs.backup",
    descKey: "settings.tabs.backupDesc",
  },
] as const satisfies readonly {
  value: SettingsTabId;
  labelKey: string;
  descKey: string;
}[];

export default function SettingsPage() {
  useI18n();
  const settings = useSettings();
  const [searchParams, setSearchParams] = useSearchParams();
  // URL 是 tab 的唯一来源：刷新、前进/后退、外部链接都保持在同一个 tab。
  const tab = resolveSettingsTab(searchParams.get("tab"));

  function handleTabChange(value: string) {
    const next = new URLSearchParams(searchParams);
    const param = settingsTabParam(resolveSettingsTab(value));
    if (param === null) next.delete("tab");
    else next.set("tab", param);
    // 默认 tab 不写参数；`?tab=bogus` 这类非法值也在切换时被清掉。
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }

  return (
    <div className="animate-in space-y-6 fade-in-0 slide-in-from-bottom-1 duration-150">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          {t("settings.title")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.subtitle")}
        </p>
      </div>

      <Tabs value={tab} onValueChange={handleTabChange} className="gap-4">
        <TabsList
          aria-label={t("settings.tabs.ariaLabel")}
          className="max-w-full overflow-x-auto"
        >
          {SETTINGS_TABS.map((option) => (
            <TabsTrigger key={option.value} value={option.value}>
              {t(option.labelKey)}
            </TabsTrigger>
          ))}
        </TabsList>

        {/*
          forceMount：切走再切回时表单内容与告警/备份卡片的结果都保留，
          也不会重复拉取数据；非激活面板由 data-[state=inactive] 隐藏。
        */}
        <TabsContent
          value="general"
          forceMount
          aria-label={t("settings.tabs.regular")}
          className="space-y-4 data-[state=inactive]:hidden"
        >
          <p className="text-xs text-muted-foreground">
            {t("settings.tabs.regularDesc")}
          </p>
          <SettingsPanelState query={settings} cards={2}>
            {(items) => <GeneralForm initial={items} />}
          </SettingsPanelState>
        </TabsContent>

        <TabsContent
          value="security"
          forceMount
          aria-label={t("settings.tabs.security")}
          className="space-y-4 data-[state=inactive]:hidden"
        >
          <p className="text-xs text-muted-foreground">
            {t("settings.tabs.securityDesc")}
          </p>
          <SettingsPanelState query={settings} cards={1}>
            {(items) => <SecurityForm initial={items} />}
          </SettingsPanelState>
        </TabsContent>

        <TabsContent
          value="alerts"
          forceMount
          aria-label={t("settings.tabs.alerts")}
          className="space-y-4 data-[state=inactive]:hidden"
        >
          <p className="text-xs text-muted-foreground">
            {t("settings.tabs.alertsDesc")}
          </p>
          {/* P13：告警通知独立于主表单，自己拉设置、保存并发送测试消息。 */}
          <AlertsCard />
        </TabsContent>

        <TabsContent
          value="backup"
          forceMount
          aria-label={t("settings.tabs.backup")}
          className="space-y-4 data-[state=inactive]:hidden"
        >
          <p className="text-xs text-muted-foreground">
            {t("settings.tabs.backupDesc")}
          </p>
          {/* P7：备份与恢复独立于设置表单，自己拉 info 并处理四态。 */}
          <BackupCard />
        </TabsContent>
      </Tabs>
    </div>
  );
}
