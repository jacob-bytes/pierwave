import {
  ArrowRightIcon,
  ChevronRightIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  formatRestoreValue,
  hasRestorePreviewContent,
  isRestoreFlagKey,
  restoreSettingLabel,
  type RestorePreview,
} from "@/lib/restoreDiff";
import { pickBilingual } from "@/lib/updates";
import { useI18n } from "@/i18n";

/**
 * 恢复调度成功后、重启前的「会发生什么」提示。
 *
 * 两块内容都只在有数据时渲染，且默认折叠：
 * - 将回退的设置：key 走 i18n 可读名，未知 key 原样显示；secret 行只提示
 *   被重置，任何值都不进入 DOM；
 * - 需要刷新 token 的服务器：一行警告 + 可展开的名称。
 *
 * 两者都没有时返回 `null`，不留空壳。
 */
export function RestorePreviewNotice({ preview }: { preview: RestorePreview }) {
  const { t, locale } = useI18n();

  if (!hasRestorePreviewContent(preview)) return null;

  const { settingsDiff, serversNeedingTokenRefresh } = preview;

  const valueText = (key: string, value: unknown): string => {
    if (isRestoreFlagKey(key)) {
      if (value === true || value === 1) return t("common.enabled");
      if (value === false || value === 0) return t("common.disabled");
    }
    const text = formatRestoreValue(value, {
      on: t("common.enabled"),
      off: t("common.disabled"),
      none: "—",
    });
    // public_status_servers 是中英双语串（「公开 2 台 / 2 public」），
    // 跟随当前语言取一半；其它值保持后端原样。
    return key === "public_status_servers"
      ? pickBilingual(text, locale)
      : text;
  };

  return (
    <div className="space-y-2">
      {settingsDiff.length > 0 ? (
        <details className="group rounded-lg border bg-background/60">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon
              className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-open:rotate-90"
              aria-hidden="true"
            />
            <span>{t("settings.backup.restoreDiff.title")}</span>
            <span className="tabular-nums text-muted-foreground">
              ({settingsDiff.length})
            </span>
          </summary>
          <ul className="space-y-1.5 border-t px-3 py-2">
            {settingsDiff.map((entry) => (
              <li
                key={entry.key}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs"
              >
                <span className="min-w-0 break-words font-medium">
                  {restoreSettingLabel(entry.key, t)}
                </span>
                {entry.secret ? (
                  <span className="text-muted-foreground">
                    {t("settings.backup.restoreDiff.secretReset")}
                  </span>
                ) : (
                  <span className="flex min-w-0 flex-wrap items-center gap-1 tabular-nums text-muted-foreground">
                    <span className="break-all">
                      {valueText(entry.key, entry.before)}
                    </span>
                    <ArrowRightIcon
                      className="size-3 shrink-0"
                      aria-hidden="true"
                    />
                    <span className="break-all font-medium text-foreground">
                      {valueText(entry.key, entry.after)}
                    </span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {serversNeedingTokenRefresh.count > 0 ? (
        <details className="group rounded-lg border border-warning/25 bg-warning/10 text-warning">
          <summary
            className={cn(
              "flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium [&::-webkit-details-marker]:hidden",
              serversNeedingTokenRefresh.names.length === 0 && "cursor-default",
            )}
          >
            <TriangleAlertIcon className="size-3.5 shrink-0" />
            <span>
              {t("settings.backup.restoreDiff.servers.title", {
                n: serversNeedingTokenRefresh.count,
              })}
            </span>
            {serversNeedingTokenRefresh.names.length > 0 ? (
              <ChevronRightIcon
                className="ml-auto size-3.5 shrink-0 transition-transform duration-150 group-open:rotate-90"
                aria-hidden="true"
              />
            ) : null}
          </summary>
          {serversNeedingTokenRefresh.names.length > 0 ? (
            <div className="border-t border-warning/20 px-3 py-2">
              <p className="text-xs text-warning/80">
                {t("settings.backup.restoreDiff.servers.desc")}
              </p>
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {serversNeedingTokenRefresh.names.map((name) => (
                  <li
                    key={name}
                    className="max-w-full truncate rounded-md border border-warning/25 bg-background/40 px-1.5 py-0.5 text-xs"
                    title={name}
                  >
                    {name}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}
