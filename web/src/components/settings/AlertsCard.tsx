import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  BellRingIcon,
  CircleCheckIcon,
  CircleXIcon,
  EyeIcon,
  EyeOffIcon,
  Loader2Icon,
  RefreshCwIcon,
  SaveIcon,
  SendIcon,
  TimerIcon,
  TriangleAlertIcon,
  WebhookIcon,
} from "lucide-react";
import { toast } from "sonner";
import { FormField, FormRootError } from "@/components/FormField";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, type Settings } from "@/lib/api";
import {
  ALERT_EVENTS,
  DEFAULT_ALERT_COOLDOWN_SECS,
  alertTestOutcome,
  hasConfiguredAlertChannel,
  isTelegramIncomplete,
  maskSecret,
  normalizeAlertTestResults,
  parseAlertEvents,
  serializeAlertEvents,
  type AlertChannelConfig,
  type AlertEvent,
  type AlertTestResult,
} from "@/lib/alerts";
import { errorText } from "@/lib/errors";
import { useSettings, useTestAlerts, useUpdateSettings } from "@/lib/queries";
import {
  alertsSettingsSchema,
  type AlertsFormValues,
} from "@/lib/alertsSchema";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

/**
 * P13：告警通知设置，见 docs/PLAN.md「P13：告警通知」。
 *
 * 与「备份与恢复」一样独立于主设置表单：自己拉 `GET /api/v1/settings`、
 * 自己保存（只 PATCH 告警相关键），并自己发测试消息。后端可能暂时 404
 * 或还不认识这些键，这里按中文错误态兜底，不写 mock 数据。
 */

/**
 * 后端会把校验失败映射成稳定 code；这里转成卡片内的双语文案，
 * 免得英文界面里直接露出后端中文报错。本卡只提交 `alert_cooldown_secs`
 * 一个整数，所以 `settings.int_out_of_range` 可以安全地指到去抖提示。
 */
const ALERT_SETTINGS_ERROR_KEYS: Record<string, string> = {
  "settings.telegram_bot_token_invalid": "settings.alerts.validation.token",
  "settings.telegram_chat_id_invalid": "settings.alerts.validation.chatId",
  "settings.webhook_url_invalid": "settings.alerts.validation.webhookUrl",
  "settings.alert_events_invalid": "settings.alerts.validation.events",
  "settings.int_out_of_range": "settings.alerts.validation.cooldown",
};

/** 设置接口与后端并行开发：404/403 与「未知键」都给出可操作的中文说明。 */
function alertsSettingsErrorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return t("settings.alerts.notReady404");
    if (error.status === 403) return t("settings.alerts.forbidden");
    // 旧后端会回 settings.unknown_key：接口在，但白名单还没加这些键。
    if (error.code === "settings.unknown_key") {
      return t("settings.alerts.notReady");
    }
    if (error.code) {
      const key = ALERT_SETTINGS_ERROR_KEYS[error.code];
      if (key) return t(key);
    }
  }
  return errorText(error, fallback);
}

function alertsTestErrorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return t("settings.alerts.test.notReady404");
    if (error.status === 403) return t("settings.alerts.forbidden");
  }
  return errorText(error, fallback);
}

function channelLabel(channel: string): string {
  if (channel === "telegram") return t("settings.alerts.channels.telegram");
  if (channel === "webhook") return t("settings.alerts.channels.webhook");
  return t("settings.alerts.channels.unknownWith", { channel });
}

function toAlertFormValues(items: Settings): AlertsFormValues {
  return {
    telegram_bot_token: items.telegram_bot_token ?? "",
    telegram_chat_id: items.telegram_chat_id ?? "",
    webhook_url: items.webhook_url ?? "",
    alert_events: parseAlertEvents(items.alert_events),
    alert_cooldown_secs:
      items.alert_cooldown_secs == null
        ? String(DEFAULT_ALERT_COOLDOWN_SECS)
        : String(items.alert_cooldown_secs),
  };
}

function channelConfig(items: Settings): AlertChannelConfig {
  return {
    telegramBotToken: items.telegram_bot_token,
    telegramChatId: items.telegram_chat_id,
    webhookUrl: items.webhook_url,
  };
}

function AlertsSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true">
      {[0, 1].map((index) => (
        <div key={index} className="space-y-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-8 w-full max-w-md" />
          <Skeleton className="h-3 w-56" />
        </div>
      ))}
      <div className="grid gap-2 sm:grid-cols-2">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-16 w-full" />
        ))}
      </div>
    </div>
  );
}

/** 按渠道展示测试结果：成功用 primary，失败用 destructive，未知渠道原样兜底。 */
function TestResults({ results }: { results: AlertTestResult[] }) {
  return (
    <div className="space-y-2 rounded-lg border bg-muted/20 p-3" aria-live="polite">
      <p className="text-xs font-medium">
        {t("settings.alerts.test.resultsTitle")}
      </p>
      {results.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("settings.alerts.test.noResults")}
        </p>
      ) : (
        <ul className="space-y-2">
          {results.map((result) => (
            <li key={result.channel} className="flex items-start gap-2 text-xs">
              {result.ok ? (
                <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-primary" />
              ) : (
                <CircleXIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
              )}
              <div className="min-w-0 space-y-0.5">
                <p
                  className={cn(
                    "font-medium",
                    result.ok ? "text-primary" : "text-destructive",
                  )}
                >
                  {channelLabel(result.channel)}
                  <span className="mx-1 text-muted-foreground">·</span>
                  {result.ok
                    ? t("settings.alerts.test.ok")
                    : t("settings.alerts.test.failed")}
                </p>
                {result.ok ? null : (
                  <p className="break-words text-muted-foreground">
                    {result.error || t("settings.alerts.test.unknownError")}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AlertsForm({ initial }: { initial: Settings }) {
  const { t: translate } = useI18n();
  const updateSettings = useUpdateSettings();
  const testAlerts = useTestAlerts();
  const schema = useMemo(() => alertsSettingsSchema(translate), [translate]);
  const form = useForm<AlertsFormValues>({
    resolver: zodResolver(schema),
    defaultValues: toAlertFormValues(initial),
  });

  /** 默认掩码；用户主动点击眼睛图标才切到明文。 */
  const [showToken, setShowToken] = useState(false);
  /** 已保存的渠道配置：决定「已保存掩码」与是否允许发送测试。 */
  const [savedConfig, setSavedConfig] = useState<AlertChannelConfig>(() =>
    channelConfig(initial),
  );
  const [testResults, setTestResults] = useState<AlertTestResult[] | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  // 切换语言后重新校验，让已经显示的错误跟着换语言。
  useEffect(() => {
    if (form.formState.isSubmitted) void form.trigger();
  }, [translate, form]);

  const events = form.watch("alert_events") ?? [];
  const telegramIncomplete = isTelegramIncomplete({
    telegramBotToken: form.watch("telegram_bot_token"),
    telegramChatId: form.watch("telegram_chat_id"),
  });
  const savedHasChannel = hasConfiguredAlertChannel(savedConfig);
  const savedTokenHint = (() => {
    const masked = maskSecret(savedConfig.telegramBotToken ?? "");
    return masked
      ? t("settings.alerts.telegram.savedMask", { masked })
      : t("settings.alerts.telegram.tokenHint");
  })();
  const dirty = form.formState.isDirty;

  const toggleEvent = (event: AlertEvent, checked: boolean) => {
    const next = new Set(form.getValues("alert_events") ?? []);
    if (checked) next.add(event);
    else next.delete(event);
    form.setValue(
      "alert_events",
      ALERT_EVENTS.filter((kind) => next.has(kind)),
      { shouldDirty: true, shouldValidate: true },
    );
  };

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors("root");
    try {
      const items = await updateSettings.mutateAsync({
        telegram_bot_token: values.telegram_bot_token,
        telegram_chat_id: values.telegram_chat_id,
        webhook_url: values.webhook_url,
        alert_events: serializeAlertEvents(values.alert_events),
        alert_cooldown_secs: Number(values.alert_cooldown_secs),
      });
      // PATCH 返回的 items 是权威值：回填表单并清掉脏标记。
      form.reset(toAlertFormValues(items));
      setSavedConfig(channelConfig(items));
      // 配置变了，旧测试结果不再有参考价值。
      setTestResults(null);
      setTestError(null);
      toast.success(t("settings.alerts.saved"));
    } catch (error) {
      const message = alertsSettingsErrorText(
        error,
        t("settings.alerts.saveError"),
      );
      form.setError("root", { message });
      toast.error(message);
    }
  });

  /**
   * 测试走已保存的配置（后端只读数据库里的设置），未保存的修改不会生效。
   * 按渠道展示返回结果，并用 toast 做一次汇总反馈。
   */
  const handleTest = () => {
    setTestError(null);
    setTestResults(null);
    testAlerts.mutate(undefined, {
      onSuccess: (payload) => {
        const results = normalizeAlertTestResults(payload);
        setTestResults(results);
        const outcome = alertTestOutcome(results);
        if (outcome === "ok") {
          toast.success(t("settings.alerts.test.successToast"));
        } else if (outcome === "empty") {
          toast.warning(t("settings.alerts.test.emptyToast"));
        } else if (outcome === "partial") {
          toast.error(t("settings.alerts.test.partialToast"));
        } else {
          toast.error(t("settings.alerts.test.failedToast"));
        }
      },
      onError: (error) => {
        const message = alertsTestErrorText(
          error,
          t("settings.alerts.test.error"),
        );
        setTestError(message);
        toast.error(message);
      },
    });
  };

  return (
    <form className="space-y-5" onSubmit={onSubmit}>
      <div className="space-y-4">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <SendIcon className="size-4 text-muted-foreground" />
            {t("settings.alerts.telegram.title")}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("settings.alerts.telegram.desc")}
          </p>
        </div>

        <FormField
          label={t("settings.alerts.telegram.token")}
          htmlFor="settings-alert-telegram-token"
          hint={savedTokenHint}
          error={form.formState.errors.telegram_bot_token?.message}
          className="max-w-md"
        >
          <div className="relative">
            <Input
              id="settings-alert-telegram-token"
              type={showToken ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              placeholder="123456789:AA..."
              className="pr-10"
              disabled={updateSettings.isPending}
              aria-invalid={Boolean(
                form.formState.errors.telegram_bot_token,
              )}
              {...form.register("telegram_bot_token")}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="absolute top-1/2 right-1 -translate-y-1/2"
              aria-label={
                showToken
                  ? t("settings.alerts.telegram.hideToken")
                  : t("settings.alerts.telegram.showToken")
              }
              aria-pressed={showToken}
              title={
                showToken
                  ? t("settings.alerts.telegram.hideToken")
                  : t("settings.alerts.telegram.showToken")
              }
              disabled={updateSettings.isPending}
              onClick={() => setShowToken((current) => !current)}
            >
              {showToken ? <EyeOffIcon /> : <EyeIcon />}
            </Button>
          </div>
        </FormField>

        <FormField
          label={t("settings.alerts.telegram.chatId")}
          htmlFor="settings-alert-telegram-chat-id"
          hint={t("settings.alerts.telegram.chatIdHint")}
          error={form.formState.errors.telegram_chat_id?.message}
          className="max-w-md"
        >
          <Input
            id="settings-alert-telegram-chat-id"
            autoComplete="off"
            spellCheck={false}
            placeholder="-1001234567890"
            disabled={updateSettings.isPending}
            aria-invalid={Boolean(form.formState.errors.telegram_chat_id)}
            {...form.register("telegram_chat_id")}
          />
        </FormField>

        {telegramIncomplete ? (
          <div className="flex max-w-md items-start gap-2 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-xs text-warning">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            <p>{t("settings.alerts.telegram.incomplete")}</p>
          </div>
        ) : null}
      </div>

      <Separator />

      <div className="space-y-4">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <WebhookIcon className="size-4 text-muted-foreground" />
            {t("settings.alerts.webhook.title")}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("settings.alerts.webhook.desc")}
          </p>
        </div>

        <FormField
          label={t("settings.alerts.webhook.url")}
          htmlFor="settings-alert-webhook-url"
          hint={t("settings.alerts.webhook.urlHint")}
          error={form.formState.errors.webhook_url?.message}
          className="max-w-md"
        >
          <Input
            id="settings-alert-webhook-url"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={t("settings.alerts.webhook.placeholder")}
            disabled={updateSettings.isPending}
            aria-invalid={Boolean(form.formState.errors.webhook_url)}
            {...form.register("webhook_url")}
          />
        </FormField>
      </div>

      <Separator />

      <fieldset className="space-y-3">
        <legend className="flex items-center gap-2 text-sm font-medium">
          <BellRingIcon className="size-4 text-muted-foreground" />
          {t("settings.alerts.events.title")}
        </legend>
        <p className="text-xs text-muted-foreground">
          {t("settings.alerts.events.desc")}
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {ALERT_EVENTS.map((event) => {
            const id = `settings-alert-event-${event}`;
            const checked = events.includes(event);
            return (
              <div
                key={event}
                className="flex items-start gap-2 rounded-lg border bg-muted/20 p-3 transition-colors duration-100 hover:bg-muted/40"
              >
                <Checkbox
                  id={id}
                  className="mt-0.5"
                  checked={checked}
                  disabled={updateSettings.isPending}
                  onCheckedChange={(next) => toggleEvent(event, next === true)}
                />
                <div className="min-w-0 space-y-0.5">
                  <Label
                    htmlFor={id}
                    className="cursor-pointer text-sm font-medium"
                  >
                    {t(`settings.alerts.events.${event}`)}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t(`settings.alerts.events.${event}Desc`)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </fieldset>

      <Separator />

      <FormField
        label={t("settings.alerts.cooldown")}
        htmlFor="settings-alert-cooldown"
        required
        hint={t("settings.alerts.cooldownHint")}
        error={form.formState.errors.alert_cooldown_secs?.message}
        className="max-w-md"
      >
        <div className="flex items-center gap-2">
          <Input
            id="settings-alert-cooldown"
            inputMode="numeric"
            placeholder="600"
            className="max-w-40"
            disabled={updateSettings.isPending}
            aria-invalid={Boolean(
              form.formState.errors.alert_cooldown_secs,
            )}
            {...form.register("alert_cooldown_secs")}
          />
          <TimerIcon className="size-4 text-muted-foreground" aria-hidden="true" />
        </div>
      </FormField>

      <Separator />

      <div className="space-y-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <SendIcon className="size-4 text-muted-foreground" />
            {t("settings.alerts.test.title")}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("settings.alerts.test.desc")}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleTest}
            disabled={
              testAlerts.isPending ||
              updateSettings.isPending ||
              !savedHasChannel
            }
          >
            {testAlerts.isPending ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <SendIcon />
            )}
            {testAlerts.isPending
              ? t("settings.alerts.test.sending")
              : t("settings.alerts.test.action")}
          </Button>
          {savedHasChannel ? null : (
            <p className="text-xs text-muted-foreground">
              {t("settings.alerts.test.empty")}
            </p>
          )}
        </div>

        {testError ? (
          <Alert
            variant="destructive"
            className="border-destructive/25 bg-destructive/10"
          >
            <TriangleAlertIcon />
            <AlertDescription>{testError}</AlertDescription>
          </Alert>
        ) : null}

        {testResults ? <TestResults results={testResults} /> : null}
      </div>

      <FormRootError message={form.formState.errors.root?.message} />

      <Separator />

      <div className="flex flex-wrap items-center justify-end gap-3">
        <p
          className={cn(
            "mr-auto text-xs",
            dirty ? "text-warning" : "text-muted-foreground",
          )}
        >
          {dirty ? t("settings.alerts.dirtyHint") : t("settings.alerts.saveHint")}
        </p>
        <Button type="submit" disabled={updateSettings.isPending}>
          {updateSettings.isPending ? (
            <Loader2Icon className="animate-spin" />
          ) : (
            <SaveIcon />
          )}
          {updateSettings.isPending
            ? t("settings.alerts.saving")
            : t("settings.alerts.save")}
        </Button>
      </div>
    </form>
  );
}

/**
 * 告警通知卡片：独立四态（加载 / 空 / 错误 / 正常）。
 *
 * 设置查询与主表单共用 `["settings"]` 缓存，所以不会多打一次请求；
 * 但卡的加载与错误态独立呈现，后端暂时 404 时也能单独重试。
 */
export function AlertsCard() {
  useI18n();
  const settings = useSettings();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <BellRingIcon className="size-4 text-muted-foreground" />
          {t("settings.alerts.title")}
        </CardTitle>
        <CardDescription className="text-xs">
          {t("settings.alerts.desc")}
        </CardDescription>
      </CardHeader>
      <CardContent className="max-w-2xl space-y-5">
        {settings.isPending ? (
          <AlertsSkeleton />
        ) : settings.isError ? (
          <div className="space-y-3">
            <Alert
              variant="destructive"
              className="border-destructive/25 bg-destructive/10"
            >
              <TriangleAlertIcon />
              <AlertTitle>{t("settings.alerts.loadFailed")}</AlertTitle>
              <AlertDescription>
                {alertsSettingsErrorText(
                  settings.error,
                  t("settings.alerts.loadError"),
                )}
              </AlertDescription>
            </Alert>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void settings.refetch()}
              disabled={settings.isFetching}
            >
              <RefreshCwIcon
                className={settings.isFetching ? "animate-spin" : undefined}
              />
              {t("common.retry")}
            </Button>
          </div>
        ) : !settings.data || Object.keys(settings.data).length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <div className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
              <BellRingIcon className="size-5" />
            </div>
            <div>
              <p className="text-sm font-medium">
                {t("settings.alerts.emptyTitle")}
              </p>
              <p className="mt-1 max-w-md text-xs text-muted-foreground">
                {t("settings.alerts.emptyDesc")}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void settings.refetch()}
              disabled={settings.isFetching}
            >
              <RefreshCwIcon
                className={settings.isFetching ? "animate-spin" : undefined}
              />
              {t("common.retry")}
            </Button>
          </div>
        ) : (
          <AlertsForm initial={settings.data} />
        )}
      </CardContent>
    </Card>
  );
}
