import { useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import type { ReactNode } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  ArrowUpCircleIcon,
  Link2Icon,
  RefreshCwIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { FormField, FormRootError } from "@/components/FormField";
import {
  CopyButton,
  InfoNote,
  InfoNoteRow,
  ListError,
  ScrollFade,
  SkeletonCard,
} from "@/components/common";
import { AlertsCard } from "@/components/settings/AlertsCard";
import { ApiTokensCard } from "@/components/settings/ApiTokensCard";
import { BackupCard } from "@/components/settings/BackupCard";
import { RemoteBackupCard } from "@/components/settings/RemoteBackupCard";
import { CertificatesPanel } from "@/components/settings/CertificatesPanel";
import { PublicStatusCard } from "@/components/settings/PublicStatusCard";
import { RuleTemplatesPanel } from "@/components/settings/RuleTemplatesPanel";
import { SettingsSecretRecovery } from "@/components/settings/SettingsSecretRecovery";
import { SubscriptionTemplatesPanel } from "@/components/settings/SubscriptionTemplatesPanel";
import {
  SettingsGroup,
  SETTINGS_FULL_ROW,
} from "@/components/settings/SettingsGroup";
import {
  SettingsFormShell,
  SettingsSaveBar,
} from "@/components/settings/SettingsSaveBar";
import { UpdatesSection } from "@/components/settings/UpdatesSection";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { ApiError, type Settings } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { exampleUrls } from "@/lib/publicBase";
import {
  flagSettingValue,
  settingsFlag,
} from "@/lib/publicStatusSettings";
import { useSettings, useUpdateSettings } from "@/lib/queries";
import { secretRecoveryFromSettings } from "@/lib/settingsSecrets";
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
import { DEFAULT_UPDATE_INTERVAL_HOURS } from "@/lib/updates";
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
    agent_base_url: items.agent_base_url ?? "",
    subscription_base_url: items.subscription_base_url ?? "",
    // 版本更新的两个设置项；旧后端缺键时与卡片原先的默认值一致。
    update_check_enabled: items.update_check_enabled ?? true,
    update_check_interval_hours:
      items.update_check_interval_hours == null
        ? String(DEFAULT_UPDATE_INTERVAL_HOURS)
        : String(items.update_check_interval_hours),
    // 公开状态页：总开关默认开启（与后端默认一致）；账期隐私开关是新增键，
    // 旧后端不返回时也按默认开启展示，但保存时不会提交（见 onSubmit）。
    public_status_enabled: settingsFlag(items.public_status_enabled, true),
    public_billing_visible: settingsFlag(items.public_billing_visible, true),
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

function SettingsSkeleton({
  cards = 2,
  lines = 3,
}: {
  cards?: number;
  lines?: number;
}) {
  return (
    <div className="space-y-6" aria-busy="true">
      {Array.from({ length: cards }, (_, index) => (
        <SkeletonCard key={index} lines={lines} />
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
  lines,
  children,
}: {
  query: SettingsQuery;
  cards: number;
  lines?: number;
  children: (items: Settings) => ReactNode;
}) {
  if (query.isPending) return <SettingsSkeleton cards={cards} lines={lines} />;
  if (query.isError) {
    return (
      <Card className="py-0">
        <CardContent>
          <ListError
            title={t("settings.loadFailed")}
            message={settingsErrorText(query.error, t("settings.loadError"))}
            retrying={query.isFetching}
            onRetry={() => void query.refetch()}
          />
        </CardContent>
      </Card>
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

  // 实时预览：跟随输入框的当前值（含尚未保存的编辑），
  // 空值或非法值用占位域名，不回退到当前访问地址。
  const agentBaseInput = form.watch("agent_base_url");
  const subscriptionBaseInput = form.watch("subscription_base_url");
  const examples = exampleUrls(agentBaseInput, subscriptionBaseInput);

  // 新设置项只有后端 GET 已经返回时才提交：旧后端会把未知键整单拒绝
  // （settings.unknown_key），不能让「公开状态页」卡拖垮常规表单的保存。
  const billingSupported = initial.public_billing_visible !== undefined;

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors("root");
    try {
      // 只 PATCH 常规 tab 的键：不提交整份对象，避免覆盖安全 tab 刚存的值。
      // 版本更新与公开状态页的设置项也并在这里，由底部同一条保存栏一次提交。
      const items = await updateSettings.mutateAsync({
        panel_name: values.panel_name.trim(),
        agent_upgrade_concurrency: Number(values.agent_upgrade_concurrency),
        agent_base_url: values.agent_base_url.trim(),
        subscription_base_url: values.subscription_base_url.trim(),
        update_check_enabled: values.update_check_enabled,
        update_check_interval_hours: Number(values.update_check_interval_hours),
        public_status_enabled: flagSettingValue(values.public_status_enabled),
        ...(billingSupported
          ? {
              public_billing_visible: flagSettingValue(
                values.public_billing_visible,
              ),
            }
          : {}),
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
    <SettingsFormShell
      footer={
        <SettingsSaveBar
          formId="settings-general-form"
          pending={updateSettings.isPending}
          dirty={form.formState.isDirty}
          hint={t("settings.saveHint")}
          dirtyHint={t("settings.saveHint")}
          saveLabel={t("common.save")}
          savingLabel={t("settings.saving")}
        />
      }
    >
      <form
        id="settings-general-form"
        className="grid grid-cols-1 gap-6 md:grid-cols-2 md:items-stretch"
        onSubmit={onSubmit}
      >
        {/*
          顺序固定为：面板 → 版本更新 → 对外地址 → Agent 升级 → 公开状态页，
          桌面端与 390 单列完全一致，不为并排调整卡片顺序。
          ≥768px 时只把语义相邻、高度接近的「版本更新 + 对外地址」并排
          （正文 222/221px < 260px；整卡 316/311px，并排后等高，差 5px）；
          其余卡片保持整宽：面板、Agent 升级各占一行，公开状态页内部已经是
          双列，外层再并排会过窄。
          版本更新的两个设置项也在这里，由底部同一条保存栏统一提交。
        */}
        <SettingsGroup
          icon={SlidersHorizontalIcon}
          title={t("settings.panel.title")}
          description={t("settings.panel.desc")}
          className="md:col-span-2"
        >
          <FormField
            label={t("settings.panel.name")}
            htmlFor="settings-panel-name"
            required
            hint={t("settings.panel.nameHint")}
            error={form.formState.errors.panel_name?.message}
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
        </SettingsGroup>

        <UpdatesSection
          form={form}
          saving={updateSettings.isPending}
          className="h-full md:col-start-1 md:row-start-2"
        />

        <SettingsGroup
          icon={Link2Icon}
          title={t("settings.publicBase.title")}
          description={t("settings.publicBase.desc")}
          className="h-full md:col-start-2 md:row-start-2"
        >
          <FormField
            label={t("settings.publicBase.agent")}
            htmlFor="settings-agent-base-url"
            hint={t("settings.publicBase.agentHint")}
            error={form.formState.errors.agent_base_url?.message}
          >
            <Input
              id="settings-agent-base-url"
              autoComplete="off"
              placeholder={t("settings.publicBase.agentPlaceholder")}
              disabled={updateSettings.isPending}
              aria-invalid={Boolean(form.formState.errors.agent_base_url)}
              {...form.register("agent_base_url")}
            />
          </FormField>

          <FormField
            label={t("settings.publicBase.subscription")}
            htmlFor="settings-subscription-base-url"
            hint={t("settings.publicBase.subscriptionHint")}
            error={form.formState.errors.subscription_base_url?.message}
          >
            <Input
              id="settings-subscription-base-url"
              autoComplete="off"
              placeholder={t("settings.publicBase.subscriptionPlaceholder")}
              disabled={updateSettings.isPending}
              aria-invalid={Boolean(
                form.formState.errors.subscription_base_url,
              )}
              {...form.register("subscription_base_url")}
            />
          </FormField>

          {/* 示例链接是只读参考，不是输入项：独占一整行，用提示块与表单字段区分。 */}
          <InfoNote
            className={SETTINGS_FULL_ROW}
            title={t("settings.publicBase.examples")}
          >
            <InfoNoteRow
              label={t("settings.publicBase.agentPreview")}
              code={examples.installCommand}
              action={
                <CopyButton
                  value={examples.installCommand}
                  label={t("settings.publicBase.agentPreview")}
                />
              }
            />
            <InfoNoteRow
              label={t("settings.publicBase.subscriptionPreview")}
              code={examples.subscriptionLink}
              action={
                <CopyButton
                  value={examples.subscriptionLink}
                  label={t("settings.publicBase.subscriptionPreview")}
                />
              }
            />
          </InfoNote>
        </SettingsGroup>

        <SettingsGroup
          icon={ArrowUpCircleIcon}
          title={t("settings.agentUpgrade.title")}
          description={t("settings.agentUpgrade.desc")}
          className="md:col-span-2"
        >
          <FormField
            label={t("settings.agentUpgrade.concurrency")}
            htmlFor="settings-agent-upgrade-concurrency"
            required
            hint={concurrencyHint}
            error={form.formState.errors.agent_upgrade_concurrency?.message}
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
        </SettingsGroup>

        {/*
          公开状态页：总开关、公开节点白名单、账期隐私开关。后两组只在总开关
          开启时可编辑；白名单有独立对话框与 PUT，其余两项随底部保存栏提交。
        */}
        <PublicStatusCard
          form={form}
          saving={updateSettings.isPending}
          billingSupported={billingSupported}
          className="md:col-span-2"
        />

        {form.formState.errors.root?.message ? (
          <div className="md:col-span-2">
            <FormRootError message={form.formState.errors.root.message} />
          </div>
        ) : null}

      </form>
    </SettingsFormShell>
  );
}

function SecurityForm({
  initial,
  before,
}: {
  initial: Settings;
  /** 安全卡上方的 API 访问卡；跟表单一起滚动，底条才能固定在底部。 */
  before?: ReactNode;
}) {
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
    <SettingsFormShell
      footer={
        <SettingsSaveBar
          formId="settings-security-form"
          pending={updateSettings.isPending}
          dirty={form.formState.isDirty}
          hint={t("settings.saveHint")}
          dirtyHint={t("settings.saveHint")}
          saveLabel={t("common.save")}
          savingLabel={t("settings.saving")}
        />
      }
    >
      {before ? <div className="mb-4">{before}</div> : null}
      <form
        id="settings-security-form"
        className="space-y-6"
        onSubmit={onSubmit}
      >
        {/* 与常规 tab 同一套布局：每个分组一张独立卡片，组内两列、字段内部上下堆叠。 */}
        <SettingsGroup
          icon={ShieldCheckIcon}
          title={t("settings.security.title")}
          description={t("settings.security.desc")}
        >
          {/* 失败上限与锁定时长是同一套登录限流策略，并排；会话有效期是另一件事，独占一行。 */}
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
              aria-invalid={Boolean(form.formState.errors.login_max_attempts)}
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

          {/* 会话有效期与登录限流是两件事：不并排，自己占一行（右列留空）。 */}
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
        </SettingsGroup>

        <FormRootError message={form.formState.errors.root?.message} />
      </form>
    </SettingsFormShell>
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
  {
    value: "templates",
    labelKey: "settings.tabs.templates",
    descKey: "settings.tabs.templatesDesc",
  },
  {
    value: "subscription-templates",
    labelKey: "settings.tabs.subscriptionTemplates",
    descKey: "settings.tabs.subscriptionTemplatesDesc",
  },
  {
    value: "certificates",
    labelKey: "settings.tabs.certificates",
    descKey: "settings.tabs.certificatesDesc",
  },
] as const satisfies readonly {
  value: SettingsTabId;
  labelKey: string;
  descKey: string;
}[];

export default function SettingsPage() {
  useI18n();
  const settings = useSettings();
  // 后端始终 200：秘密解不开通过顶层 secret_errors 暴露（已在 useSettings
  // 合并到 items 上），不再走 isError 分支。
  const secretFailure = secretRecoveryFromSettings(settings.data);
  const [searchParams, setSearchParams] = useSearchParams();
  // URL 是 tab 的唯一来源：刷新、前进/后退、外部链接都保持在同一个 tab。
  const tab = resolveSettingsTab(searchParams.get("tab"));
  // 常规 / 安全 / 通知有页面级保存条：这三个 tab 使用「滚动内容 + 固定条」。
  const fillTab =
    tab === "general" || tab === "security" || tab === "alerts";

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
    <div
      className={cn(
        "animate-in space-y-6 fade-in-0 slide-in-from-bottom-1 duration-150",
        fillTab && "flex h-full min-h-0 flex-col",
      )}
    >
      <div>
        <h1 className="text-xl leading-tight font-semibold tracking-tight">
          {t("settings.title")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.subtitle")}
        </p>
      </div>

      {secretFailure ? (
        <SettingsSecretRecovery
          failure={secretFailure}
          onRetried={() => void settings.refetch()}
        />
      ) : null}

      <Tabs
        value={tab}
        onValueChange={handleTabChange}
        className={cn("gap-4", fillTab && "flex min-h-0 flex-1 flex-col")}
      >
        <ScrollFade className="max-w-full">
          <TabsList
            aria-label={t("settings.tabs.ariaLabel")}
            className="w-max max-w-none"
          >
            {SETTINGS_TABS.map((option) => (
              <TabsTrigger key={option.value} value={option.value}>
                {t(option.labelKey)}
              </TabsTrigger>
            ))}
          </TabsList>
        </ScrollFade>

        {/*
          forceMount：切走再切回时表单内容与告警/备份卡片的结果都保留，
          也不会重复拉取数据；非激活面板由 data-[state=inactive] 隐藏。
        */}
        <TabsContent
          value="general"
          forceMount
          aria-label={t("settings.tabs.regular")}
          className="flex min-h-0 flex-1 flex-col gap-4 data-[state=inactive]:hidden"
        >
          <p className="text-xs text-muted-foreground">
            {t("settings.tabs.regularDesc")}
          </p>
          {/* 版本更新卡由 GeneralForm 内部渲染，两个设置项随同一份表单提交。 */}
          <SettingsPanelState query={settings} cards={1} lines={8}>
            {(items) => <GeneralForm initial={items} />}
          </SettingsPanelState>
        </TabsContent>

        <TabsContent
          value="security"
          forceMount
          aria-label={t("settings.tabs.security")}
          className="flex min-h-0 flex-1 flex-col gap-4 data-[state=inactive]:hidden"
        >
          <p className="text-xs text-muted-foreground">
            {t("settings.tabs.securityDesc")}
          </p>
          {/* 设置未就绪时仍单独展示 API 卡；就绪后让它随安全表单一起滚动。 */}
          {!settings.isPending &&
          !settings.isError &&
          settings.data &&
          Object.keys(settings.data).length > 0 ? null : (
            <ApiTokensCard />
          )}
          <SettingsPanelState query={settings} cards={1}>
            {(items) => (
              <SecurityForm initial={items} before={<ApiTokensCard />} />
            )}
          </SettingsPanelState>
        </TabsContent>

        <TabsContent
          value="alerts"
          forceMount
          aria-label={t("settings.tabs.alerts")}
          className="flex min-h-0 flex-1 flex-col gap-4 data-[state=inactive]:hidden"
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
          {/* 异地备份（WebDAV）：独立卡片，自己拉设置与远端状态。 */}
          <RemoteBackupCard />
        </TabsContent>

        <TabsContent
          value="templates"
          forceMount
          aria-label={t("settings.tabs.templates")}
          className="space-y-4 data-[state=inactive]:hidden"
        >
          <p className="text-xs text-muted-foreground">
            {t("settings.tabs.templatesDesc")}
          </p>
          {/* 原 /rules 页：列表、对话框与四态整体搬进 tab，内部逻辑不变。 */}
          <RuleTemplatesPanel />
        </TabsContent>

        <TabsContent
          value="subscription-templates"
          forceMount
          aria-label={t("settings.tabs.subscriptionTemplates")}
          className="space-y-4 data-[state=inactive]:hidden"
        >
          <p className="text-xs text-muted-foreground">
            {t("settings.tabs.subscriptionTemplatesDesc")}
          </p>
          <SubscriptionTemplatesPanel />
        </TabsContent>

        <TabsContent
          value="certificates"
          forceMount
          aria-label={t("settings.tabs.certificates")}
          className="space-y-4 data-[state=inactive]:hidden"
        >
          <p className="text-xs text-muted-foreground">
            {t("settings.tabs.certificatesDesc")}
          </p>
          {/* 原 /certificates 页：列表、对话框与四态整体搬进 tab，内部逻辑不变。 */}
          <CertificatesPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
