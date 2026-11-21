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
  SendIcon,
  TimerIcon,
  Trash2Icon,
  TriangleAlertIcon,
  WebhookIcon,
} from "lucide-react";
import { toast } from "sonner";
import { ListError } from "@/components/common";
import { FormField, FormRootError } from "@/components/FormField";
import {
  SettingsGroup,
  SETTINGS_FULL_ROW,
} from "@/components/settings/SettingsGroup";
import {
  SettingsFormShell,
  SettingsSaveBar,
} from "@/components/settings/SettingsSaveBar";
import {
  Alert,
  AlertDescription,
} from "@/components/ui/alert";
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
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, type Settings } from "@/lib/api";
import {
  ALERT_EVENTS,
  DEFAULT_ALERT_COOLDOWN_SECS,
  alertTestOutcome,
  buildAlertSettingsPatch,
  clearWebhookPatch,
  hasConfiguredAlertChannel,
  isTelegramIncomplete,
  normalizeAlertTestResults,
  parseAlertEvents,
  toggleAlertEvent,
  webhookFieldState,
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
    telegramBotTokenSaved: items.telegram_bot_has_token === true,
    telegramChatId: items.telegram_chat_id,
    webhookUrl: items.webhook_url,
    webhookHasUrl: items.webhook_has_url === true,
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
      {/* 5 个事件占位（服务器离线 / 用户断流 / 转发链降级 / 升级失败 / 发现新版本）。 */}
      <div className="grid gap-2 sm:grid-cols-2">
        {[0, 1, 2, 3, 4].map((index) => (
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
  /** 清除 Webhook 是独立于保存的显式动作：确认后才发 `null`。 */
  const [clearOpen, setClearOpen] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  // 切换语言后重新校验，让已经显示的错误跟着换语言。
  useEffect(() => {
    if (form.formState.isSubmitted) void form.trigger();
  }, [translate, form]);

  const events = form.watch("alert_events") ?? [];
  const tokenInput = form.watch("telegram_bot_token") ?? "";
  /** 后端只回 has_token；已保存但输入框为空时，凭据仍然是完整的。 */
  const savedHasToken = savedConfig.telegramBotTokenSaved === true;
  const savedTokenHint = savedHasToken
    ? t("settings.alerts.telegram.savedHint")
    : t("settings.alerts.telegram.tokenHint");
  const telegramIncomplete = isTelegramIncomplete({
    telegramBotToken: tokenInput,
    telegramBotTokenSaved: savedHasToken,
    telegramChatId: form.watch("telegram_chat_id"),
  });
  const savedHasChannel = hasConfiguredAlertChannel(savedConfig);
  const savedHasWebhook = webhookFieldState(savedConfig) === "saved";
  const dirty = form.formState.isDirty;

  const toggleEvent = (event: AlertEvent, checked: boolean) => {
    form.setValue(
      "alert_events",
      toggleAlertEvent(form.getValues("alert_events") ?? [], event, checked),
      { shouldDirty: true, shouldValidate: true },
    );
  };

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors("root");
    try {
      const items = await updateSettings.mutateAsync(
        buildAlertSettingsPatch(values),
      );
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
   * 显式清除 Webhook：只有这里会发 `null`。
   *
   * 不走整表单保存，避免把用户还没保存的其它修改一起提交；成功后再用
   * PATCH 返回的权威值刷新 `webhook_has_url`，输入框/占位提示立即切回未配置。
   */
  const handleClearWebhook = async () => {
    setClearError(null);
    try {
      const items = await updateSettings.mutateAsync(clearWebhookPatch());
      setSavedConfig(channelConfig(items));
      form.setValue("webhook_url", "", {
        shouldDirty: false,
        shouldValidate: true,
      });
      setTestResults(null);
      setTestError(null);
      setClearOpen(false);
      toast.success(t("settings.alerts.webhook.cleared"));
    } catch (error) {
      const message = alertsSettingsErrorText(
        error,
        t("settings.alerts.webhook.clearError"),
      );
      setClearError(message);
      toast.error(message);
    }
  };

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
    <SettingsFormShell
      footer={
        <SettingsSaveBar
          formId="settings-alerts-form"
          pending={updateSettings.isPending}
          dirty={dirty}
          hint={t("settings.alerts.saveHint")}
          dirtyHint={t("settings.alerts.dirtyHint")}
          saveLabel={t("settings.alerts.save")}
          savingLabel={t("settings.alerts.saving")}
        />
      }
    >
      <form
        id="settings-alerts-form"
        className="space-y-6"
        onSubmit={onSubmit}
      >
        <SettingsGroup
        icon={SendIcon}
        title={t("settings.alerts.telegram.title")}
        description={t("settings.alerts.telegram.desc")}
      >
        <FormField
          label={t("settings.alerts.telegram.token")}
          htmlFor="settings-alert-telegram-token"
          hint={savedTokenHint}
          error={form.formState.errors.telegram_bot_token?.message}
        >
          <div className="relative">
            <Input
              id="settings-alert-telegram-token"
              type={showToken ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              placeholder={
                savedHasToken && tokenInput.trim() === ""
                  ? t("settings.alerts.telegram.savedPlaceholder")
                  : "123456789:AA..."
              }
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
          <div
            className={cn(
              SETTINGS_FULL_ROW,
              "flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-xs text-warning",
            )}
          >
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            <p>{t("settings.alerts.telegram.incomplete")}</p>
          </div>
        ) : null}
      </SettingsGroup>

      <SettingsGroup
        icon={WebhookIcon}
        title={t("settings.alerts.webhook.title")}
        description={t("settings.alerts.webhook.desc")}
      >
        <FormField
          label={t("settings.alerts.webhook.url")}
          htmlFor="settings-alert-webhook-url"
          hint={
            savedHasWebhook ? (
              <span className="flex items-start gap-1.5">
                <CircleCheckIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
                <span>{t("settings.alerts.webhook.savedHint")}</span>
              </span>
            ) : (
              t("settings.alerts.webhook.urlHint")
            )
          }
          error={form.formState.errors.webhook_url?.message}
        >
          <Input
            id="settings-alert-webhook-url"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={
              savedHasWebhook
                ? t("settings.alerts.webhook.savedPlaceholder")
                : t("settings.alerts.webhook.placeholder")
            }
            disabled={updateSettings.isPending}
            aria-invalid={Boolean(form.formState.errors.webhook_url)}
            {...form.register("webhook_url")}
          />
        </FormField>

        {/* 清空必须显式：空串在契约里是「不改动」，不能拿来清除已保存地址。 */}
        {savedHasWebhook ? (
          <div
            className={cn(
              SETTINGS_FULL_ROW,
              "flex flex-wrap items-center justify-end gap-2",
            )}
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => {
                setClearError(null);
                setClearOpen(true);
              }}
              disabled={updateSettings.isPending}
            >
              <Trash2Icon />
              {t("settings.alerts.webhook.clear")}
            </Button>
          </div>
        ) : null}
      </SettingsGroup>

      <AlertDialog
        open={clearOpen}
        onOpenChange={(next) => {
          if (!next && updateSettings.isPending) return;
          if (!next) setClearError(null);
          setClearOpen(next);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <Trash2Icon className="size-5" />
            </AlertDialogMedia>
            <AlertDialogTitle>
              {t("settings.alerts.webhook.clearTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.alerts.webhook.clearDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {clearError ? (
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertDescription>{clearError}</AlertDescription>
            </Alert>
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={updateSettings.isPending}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={updateSettings.isPending}
              onClick={(event) => {
                event.preventDefault();
                void handleClearWebhook();
              }}
            >
              {updateSettings.isPending ? (
                <Loader2Icon className="animate-spin" />
              ) : null}
              {updateSettings.isPending
                ? t("settings.alerts.webhook.clearing")
                : t("settings.alerts.webhook.clearConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <SettingsGroup
        icon={BellRingIcon}
        title={t("settings.alerts.events.title")}
        description={t("settings.alerts.events.desc")}
      >
        <fieldset className={cn(SETTINGS_FULL_ROW, "space-y-2")}>
          <legend className="sr-only">
            {t("settings.alerts.events.title")}
          </legend>
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
                    onCheckedChange={(next) =>
                      toggleEvent(event, next === true)
                    }
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

        <FormField
          label={t("settings.alerts.cooldown")}
          htmlFor="settings-alert-cooldown"
          required
          hint={t("settings.alerts.cooldownHint")}
          error={form.formState.errors.alert_cooldown_secs?.message}
          className={SETTINGS_FULL_ROW}
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
            <TimerIcon
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
          </div>
        </FormField>
      </SettingsGroup>

      <SettingsGroup
        icon={SendIcon}
        title={t("settings.alerts.test.title")}
        description={t("settings.alerts.test.desc")}
      >
        <div
          className={cn(
            SETTINGS_FULL_ROW,
            "flex flex-wrap items-center gap-3",
          )}
        >
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
            className={cn(
              SETTINGS_FULL_ROW,
              "border-destructive/25 bg-destructive/10",
            )}
          >
            <TriangleAlertIcon />
            <AlertDescription>{testError}</AlertDescription>
          </Alert>
        ) : null}

        {testResults ? (
          <div className={SETTINGS_FULL_ROW}>
            <TestResults results={testResults} />
          </div>
        ) : null}
      </SettingsGroup>

        <FormRootError message={form.formState.errors.root?.message} />
      </form>
    </SettingsFormShell>
  );
}

/**
 * 通知设置：独立四态（加载 / 空 / 错误 / 正常）。
 *
 * 设置查询与主表单共用 `["settings"]` 缓存，所以不会多打一次请求；
 * 但加载与错误态独立呈现，后端暂时 404 时也能单独重试。正常态下每个分组
 * 是一张独立卡片（Telegram / Webhook / 事件 / 测试），底部一条保存栏。
 */
export function AlertsCard() {
  useI18n();
  const settings = useSettings();

  if (settings.isPending) {
    return (
      <Card>
        <CardContent>
          <AlertsSkeleton />
        </CardContent>
      </Card>
    );
  }

  if (settings.isError) {
    return (
      <Card>
        <CardContent>
          <ListError
            title={t("settings.alerts.loadFailed")}
            message={alertsSettingsErrorText(
              settings.error,
              t("settings.alerts.loadError"),
            )}
            retrying={settings.isFetching}
            onRetry={() => void settings.refetch()}
          />
        </CardContent>
      </Card>
    );
  }

  if (!settings.data || Object.keys(settings.data).length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
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
        </CardContent>
      </Card>
    );
  }

  return <AlertsForm initial={settings.data} />;
}
