import { useForm } from "react-hook-form";
import type { ReactNode } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import {
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

/** 设置接口与后端并行开发：404/403 给中文说明，不写 mock 数据。 */
function settingsErrorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return "设置接口尚未就绪（后端可能还在部署），请稍后重试";
    }
    if (error.status === 403) {
      return "只有管理员可以查看或修改设置";
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
  if (secs % 3600 === 0) return `${secs / 3600} 小时`;
  if (secs % 60 === 0) return `${secs / 60} 分钟`;
  return `${secs} 秒`;
}

/** 锁定时长说明：能换算时补原始秒数，本身就按秒展示时不重复。 */
function lockHintText(secs: number | null): string {
  if (secs === null) return "触发限流后的锁定时长，范围 60–86400 秒。";
  const human = lockDurationText(secs);
  const detail = human === `${secs} 秒` ? human : `${human}（${secs} 秒）`;
  return `锁定 ${detail}；期间该账号与来源 IP 都无法登录。`;
}

/** 小时 → 人话：超过一天时补上「天」，让 720 小时不再难读。 */
function sessionDurationText(hours: number): string {
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  if (days === 0) return `${hours} 小时`;
  if (rest === 0) return `${hours} 小时（${days} 天）`;
  return `${hours} 小时（${days} 天 ${rest} 小时）`;
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
  const updateSettings = useUpdateSettings();
  const form = useForm<SettingsFormValues>({
    resolver: zodResolver(settingsFormSchema),
    defaultValues: toFormValues(initial),
  });

  const attempts = parseIntInRange(form.watch("login_max_attempts"), 1, 20);
  const lockSecs = parseIntInRange(form.watch("login_lock_secs"), 60, 86400);
  const ttlHours = parseIntInRange(form.watch("session_ttl_hours"), 1, 720);

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors("root");
    try {
      const items = await updateSettings.mutateAsync({
        panel_name: values.panel_name.trim(),
        login_max_attempts: Number(values.login_max_attempts),
        login_lock_secs: Number(values.login_lock_secs),
        session_ttl_hours: Number(values.session_ttl_hours),
      });
      // PATCH 返回的 items 是权威值：回填表单（同时清掉脏标记），缓存已由 hook 更新。
      form.reset(toFormValues(items));
      toast.success("已保存");
    } catch (error) {
      const message = settingsErrorText(error, "保存设置失败，请稍后重试");
      form.setError("root", { message });
      toast.error(message);
    }
  });

  const attemptsHint =
    attempts && lockSecs
      ? `连续失败 ${attempts} 次后锁定 ${lockDurationText(lockSecs)}。`
      : "触发限流前允许的连续失败次数，范围 1–20。";

  const lockHint = lockHintText(lockSecs);

  const sessionHint = ttlHours
    ? `会话有效期 ${sessionDurationText(ttlHours)}，过期后需要重新登录。`
    : "登录会话的有效期，范围 1–720 小时。";

  return (
    <form className="space-y-6" onSubmit={onSubmit}>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <SlidersHorizontalIcon className="size-4 text-muted-foreground" />
            面板
          </CardTitle>
          <CardDescription className="text-xs">
            显示在登录页与页面标题中的面板名称。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FormField
            label="面板名称"
            htmlFor="settings-panel-name"
            required
            hint="最多 64 个字符；保存后刷新页面即可看到新名称。"
            error={form.formState.errors.panel_name?.message}
            className="max-w-md"
          >
            <Input
              id="settings-panel-name"
              autoComplete="off"
              placeholder="mmrust"
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
            安全
          </CardTitle>
          <CardDescription className="text-xs">
            登录限流与会话过期策略，保存后对新的登录立即生效。
          </CardDescription>
        </CardHeader>
        <CardContent className="max-w-2xl space-y-5">
          <FormField
            label="失败次数上限"
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
            label="锁定时长（秒）"
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
            label="会话有效期（小时）"
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

      <div className="flex flex-wrap items-center justify-end gap-3">
        <p className="text-xs text-muted-foreground">
          修改后点击保存才会生效。
        </p>
        <Button type="submit" disabled={updateSettings.isPending}>
          {updateSettings.isPending ? (
            <Loader2Icon className="animate-spin" />
          ) : (
            <SaveIcon />
          )}
          {updateSettings.isPending ? "保存中…" : "保存"}
        </Button>
      </div>
    </form>
  );
}

export default function SettingsPage() {
  const settings = useSettings();

  return (
    <div className="animate-in space-y-6 fade-in-0 slide-in-from-bottom-1 duration-150">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">设置</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          面板名称、登录限流与会话有效期；只有管理员可以修改。
        </p>
      </div>

      {settings.isPending ? (
        <SettingsSkeleton />
      ) : settings.isError ? (
        <StateCard
          icon={TriangleAlertIcon}
          tone="destructive"
          title="设置加载失败"
          description={settingsErrorText(
            settings.error,
            "无法加载设置，请检查网络或主控是否已启动",
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
              重试
            </Button>
          }
        />
      ) : !settings.data || Object.keys(settings.data).length === 0 ? (
        <StateCard
          icon={SlidersHorizontalIcon}
          title="还没有可显示的设置项"
          description="后端暂时没有返回任何设置键。稍后重试，或确认主控版本是否包含设置接口。"
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
              重试
            </Button>
          }
        />
      ) : (
        <SettingsForm initial={settings.data} />
      )}
    </div>
  );
}
