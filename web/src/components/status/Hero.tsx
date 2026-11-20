import type { ReactNode } from "react";
import {
  AVAILABILITY_BAR_CLASS,
  AVAILABILITY_TEXT_CLASS,
} from "@/components/status/Availability";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/i18n";
import type { PublicStatusServer, PublicStatusSummary } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { rateParts } from "@/lib/netRate";
import {
  availabilityFill,
  availabilityPercent,
  availabilityTone,
  averageUptime24h,
  busiestServer,
  statusHeadline,
  statusHeadlineKey,
  totalOnlineRate,
} from "@/lib/publicStatus";
import { cn } from "@/lib/utils";

/**
 * 公开页顶部的总结区：一句结论 + 三个大数字 + 一条脚注。
 *
 * 它替代旧的 `Summary` 四块卡，而不是并列出现：
 * - 在线 x/y 只在这里出现（旧汇总卡已删除）；
 * - 平均可用率只在这里出现（带三档色阶与填充条）；
 * - 当前总速率是新增数字，由在线机器的上下行速率现算；
 * - 旧汇总卡里的「最忙服务器」「累计流量 / 今日」没有被重复的数值，
 *   收进脚注，信息不丢、也不和三个大数字抢视觉。
 *
 * 卡片与点阵完全沿用 `ServerCard`，这里只负责页面顶部。
 */

/** 三个大数字共用一个骨架，保证标签、数值、条/占位在同一基线上。 */
function Stat({
  label,
  children,
  foot,
}: {
  label: string;
  children: ReactNode;
  /** 进度条或等高占位；空着也保留 4px 高度，三个数字底部不会错位。 */
  foot?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="mt-1.5 flex h-8 items-baseline gap-1 whitespace-nowrap sm:h-9">
        {children}
      </div>
      <div className="mt-2 h-1">{foot}</div>
    </div>
  );
}

export function Hero({
  summary,
  servers,
}: {
  summary: PublicStatusSummary;
  servers: PublicStatusServer[];
}) {
  const { t } = useI18n();

  const headline = statusHeadline(servers);
  const headlineText = statusHeadlineKey(headline);
  // 只有「全部在线且可用率都达标」才是安静的呼吸点；部分离线或可用率
  // 偏低转 warning，全部离线按设计规范用 muted（离线不是错误）。
  const calm =
    headline.kind === "all-online" && headline.lowAvailability === 0;
  const dotTone = calm
    ? "bg-primary"
    : headline.kind === "all-offline" || headline.kind === "empty"
      ? "bg-muted-foreground"
      : "bg-warning";

  // 平均可用率：没有一台有采样时是 null，大数字显示 —，不写成 0%。
  const averageUptime = averageUptime24h(servers);
  const averagePercent = availabilityPercent(averageUptime);
  const averageTone = availabilityTone(averageUptime);
  const averageFill = availabilityFill(averageUptime);

  // 当前总速率：所有在线机器的上下行之和；没有任何读数时 null → —。
  const rate = rateParts(totalOnlineRate(servers));

  const busiest = busiestServer(servers);
  const busiestLoad =
    busiest && busiest.load1 !== null && Number.isFinite(busiest.load1)
      ? busiest.load1.toFixed(2)
      : null;

  return (
    <Card
      role="group"
      aria-label={t("publicStatus.hero.aria")}
      className="min-w-0 gap-0 rounded-xl p-4 [--card-spacing:--spacing(4)] sm:p-5"
    >
      <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-center lg:justify-between lg:gap-8">
        {/* 结论是这一屏的主句：左对齐、允许换行，永远不截断成看不懂的半句。 */}
        <div className="flex min-w-0 items-start gap-2.5 lg:flex-1">
          <span
            aria-hidden="true"
            className={cn(
              "mt-[0.45rem] size-2 shrink-0 rounded-full",
              dotTone,
              calm && "status-breathe",
            )}
          />
          <p className="min-w-0 text-lg leading-snug font-medium tracking-tight text-pretty sm:text-xl">
            {t(headlineText.key, headlineText.values)}
          </p>
        </div>

        {/* 三个大数字：手机上三等分（390 下每列约 100px），桌面靠右固定宽度。 */}
        <div className="grid min-w-0 grid-cols-3 gap-3 border-t border-border pt-4 sm:gap-5 lg:w-[34rem] lg:shrink-0 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-8">
          <Stat label={t("publicStatus.hero.onlineRate")}>
            {headline.total === 0 ? (
              <span className="text-xl leading-none font-semibold text-muted-foreground sm:text-3xl">
                —
              </span>
            ) : (
              <span className="tnum text-xl leading-none font-semibold sm:text-3xl">
                {headline.online} / {headline.total}
              </span>
            )}
          </Stat>

          <Stat
            label={t("publicStatus.hero.averageUptime")}
            foot={
              averagePercent === null ? null : (
                <div
                  aria-hidden="true"
                  className="h-1 w-full overflow-hidden rounded-full bg-muted-foreground/20"
                >
                  <div
                    className={cn(
                      "h-full rounded-full",
                      AVAILABILITY_BAR_CLASS[averageTone],
                    )}
                    style={{
                      width: `${averageFill}%`,
                      minWidth: averageFill > 0 ? 2 : undefined,
                    }}
                  />
                </div>
              )
            }
          >
            <span
              className={cn(
                "tnum text-xl leading-none font-semibold sm:text-3xl",
                averagePercent === null
                  ? "text-muted-foreground"
                  : AVAILABILITY_TEXT_CLASS[averageTone],
              )}
            >
              {averagePercent === null ? "—" : `${averagePercent}%`}
            </span>
          </Stat>

          <Stat label={t("publicStatus.hero.totalRate")}>
            {rate === null ? (
              <span className="text-xl leading-none font-semibold text-muted-foreground sm:text-3xl">
                —
              </span>
            ) : (
              <>
                <span className="tnum text-xl leading-none font-semibold sm:text-3xl">
                  {rate.value}
                </span>
                <span className="text-xs text-muted-foreground">
                  {rate.unit}
                </span>
              </>
            )}
          </Stat>
        </div>
      </div>

      {/* 脚注承接旧汇总卡里不重复的两项：最忙服务器与流量。 */}
      <div className="mt-4 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border pt-3 text-xs text-muted-foreground">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span className="shrink-0">
            {t("publicStatus.summary.busiest")}
          </span>
          {busiest ? (
            <>
              <span
                className="max-w-40 truncate text-foreground"
                title={busiest.name}
              >
                {busiest.name}
              </span>
              {busiestLoad === null ? null : (
                <span className="tnum shrink-0">
                  · {t("publicStatus.hero.load", { value: busiestLoad })}
                </span>
              )}
            </>
          ) : (
            <span className="truncate">
              {t("publicStatus.summary.busiestHint")}
            </span>
          )}
        </span>

        <span
          aria-hidden="true"
          className="hidden h-3 w-px shrink-0 bg-border sm:block"
        />

        <span className="tnum inline-flex items-center gap-1.5">
          <span>{t("publicStatus.summary.monthTraffic")}</span>
          <span className="text-foreground">
            {formatBytes(summary.traffic_month)}
          </span>
        </span>

        <span
          aria-hidden="true"
          className="hidden h-3 w-px shrink-0 bg-border sm:block"
        />

        <span className="tnum">
          {t("publicStatus.summary.today", {
            value: formatBytes(summary.traffic_today),
          })}
        </span>
      </div>
    </Card>
  );
}
