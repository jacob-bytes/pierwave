import { KeyRoundIcon, PackageIcon, TriangleAlertIcon } from "lucide-react";
import { EmptyState } from "@/components/common";
import { UsageBar } from "@/components/UsageBar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatBytes } from "@/lib/format";
import { OVERVIEW_TEXT_CLASS } from "@/lib/meOverview";
import { formatDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import type { OverviewCardProps } from "./types";

const RING_RADIUS = 52;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * 右下角的次要账号区：`修改密码` 是原「更多信息」里唯一保留的操作，
 * 入口变小声即可，不另开卡片。
 */
function AccountFooter({
  username,
  onChangePassword,
}: Pick<OverviewCardProps, "username" | "onChangePassword">) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
      <p className="text-xs text-muted-foreground">
        {t("me.currentAccount")}{" "}
        <span className="font-mono text-foreground/80">{username}</span>
      </p>
      <Button
        variant="ghost"
        size="xs"
        className="-mr-2 text-muted-foreground hover:text-foreground"
        onClick={onChangePassword}
      >
        <KeyRoundIcon className="size-3" aria-hidden="true" />
        {t("me.changePassword")}
      </Button>
    </div>
  );
}

/**
 * 概览卡：环形指标。
 *
 * 左侧环形按「剩余占比」填充，环心只放剩余流量；右侧三块次要信息
 * （到期 / 套餐名 / 今日与日均用量）只靠间距分组，与环形垂直居中。
 * 窄屏竖排，sm 起铺成三列填满右侧，避免卡片右侧留白。
 * 环下方是已用流量进度条；右下角只留账号与修改密码这类次要信息。
 * 低于阈值时环和数字一起切换到 warning / destructive，颜色仍只用现有 token。
 */
export default function OverviewCardA({
  plan,
  usage,
  overQuota,
  usedPercent,
  remainingTone,
  expiryTone,
  todayBytes,
  dailyAverageBytes,
  username,
  onChangePassword,
}: OverviewCardProps) {
  const { t } = useI18n();

  if (!plan) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            icon={PackageIcon}
            title={t("me.overview.noPackage")}
            description={t("me.overview.noPackageDesc")}
          />
          <div className="border-t border-border pt-3">
            <AccountFooter
              username={username}
              onChangePassword={onChangePassword}
            />
          </div>
        </CardContent>
      </Card>
    );
  }

  const days = usage.days_left;
  const remainingRatio =
    usedPercent === null ? 1 : Math.max(0, 100 - usedPercent) / 100;
  const ringTone =
    remainingTone === "default"
      ? "text-primary"
      : OVERVIEW_TEXT_CLASS[remainingTone];

  return (
    <Card>
      <CardContent>
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center sm:gap-8">
          <div className="relative grid size-36 shrink-0 place-items-center">
            <svg
              viewBox="0 0 120 120"
              className="absolute inset-0 size-full -rotate-90"
              aria-hidden="true"
            >
              <circle
                cx="60"
                cy="60"
                r={RING_RADIUS}
                fill="none"
                strokeWidth="10"
                stroke="currentColor"
                className="text-muted"
              />
              <circle
                cx="60"
                cy="60"
                r={RING_RADIUS}
                fill="none"
                strokeWidth="10"
                strokeLinecap="round"
                stroke="currentColor"
                className={cn(
                  "transition-[stroke-dashoffset] duration-200",
                  ringTone,
                )}
                style={{
                  strokeDasharray: RING_CIRCUMFERENCE,
                  strokeDashoffset:
                    RING_CIRCUMFERENCE * (1 - remainingRatio),
                }}
              />
            </svg>
            <div className="flex max-w-24 flex-col items-center text-center">
              <span
                className={cn(
                  "text-2xl leading-none font-semibold tracking-tight tabular-nums",
                  OVERVIEW_TEXT_CLASS[remainingTone],
                )}
              >
                {usage.remaining_bytes === null
                  ? t("me.overview.unlimited")
                  : formatBytes(usage.remaining_bytes)}
              </span>
              <span className="mt-1.5 text-xs text-muted-foreground">
                {t("me.overview.remainingTraffic")}
              </span>
            </div>
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-4 sm:grid sm:grid-cols-3 sm:items-start sm:gap-6">
            <div className="flex flex-col gap-4">
              <div>
                <p className="text-xs text-muted-foreground">
                  {t("me.overview.expiresAt")}
                </p>
                <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span
                    className={cn(
                      "text-3xl leading-none font-semibold tracking-tight tabular-nums",
                      OVERVIEW_TEXT_CLASS[expiryTone],
                    )}
                  >
                    {days === null ? t("me.overview.longTerm") : days}
                  </span>
                  {days === null ? null : (
                    <span className="text-sm text-muted-foreground">
                      {t("me.overview.dayUnit")}
                    </span>
                  )}
                  {plan.expires_at === null ? null : (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {formatDate(plan.expires_at)}
                    </span>
                  )}
                </div>
              </div>

              <p className="truncate text-sm text-muted-foreground">
                {plan.name}
              </p>
            </div>

            {todayBytes === null && dailyAverageBytes === null ? null : (
              <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 sm:contents">
                {todayBytes === null ? null : (
                  <div>
                    <p className="text-xs text-muted-foreground">
                      {t("me.overview.todayUsage")}
                    </p>
                    <p className="mt-1 font-mono text-sm tabular-nums">
                      {formatBytes(todayBytes)}
                    </p>
                  </div>
                )}
                {dailyAverageBytes === null ? null : (
                  <div>
                    <p className="text-xs text-muted-foreground">
                      {t("me.overview.dailyAverage")}
                    </p>
                    <p className="mt-1 font-mono text-sm tabular-nums">
                      {formatBytes(dailyAverageBytes)}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {overQuota ? (
          <p className="mt-4 flex items-center gap-1.5 text-xs text-warning">
            <TriangleAlertIcon className="size-3.5" aria-hidden="true" />
            {t("me.overview.overQuota")}
          </p>
        ) : null}

        {/* 已用流量进度条与账号/改密都属于次要信息，统一收在环下方，
            不再单独开一张可折叠卡片。 */}
        <div className="mt-5 space-y-3 border-t border-border pt-4">
          <UsageBar
            usedBytes={usage.used_bytes}
            quotaBytes={plan.traffic_limit}
            zeroAsUnlimited
            overTone="warning"
            label={t("me.overview.usage")}
          />
          <AccountFooter
            username={username}
            onChangePassword={onChangePassword}
          />
        </div>
      </CardContent>
    </Card>
  );
}
