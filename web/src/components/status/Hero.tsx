import type { ReactNode } from "react";
import { ArrowDownIcon, ArrowUpIcon, type LucideIcon } from "lucide-react";
import {
  AVAILABILITY_BAR_CLASS,
  AVAILABILITY_TEXT_CLASS,
} from "@/components/status/Availability";
import { HeroSparkline } from "@/components/status/HeroSparkline";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/i18n";
import type {
  PublicStatusSeries,
  PublicStatusServer,
  PublicStatusSummary,
} from "@/lib/api";
import { formatBytes } from "@/lib/format";
import {
  heroLatencySeries,
  heroRateSeries,
  heroUptimeSeries,
  type HeroLineSeries,
  type HeroRateSeries,
} from "@/lib/heroSeries";
import { formatRatePairText, rateParts } from "@/lib/netRate";
import {
  availabilityFill,
  availabilityPercent,
  availabilityTone,
  averageLatency,
  averageUptime24h,
  busiestServer,
  onlineRateByDirection,
  statusHeadline,
  statusHeadlineKey,
  type OnlineRate,
} from "@/lib/publicStatus";
import { cn } from "@/lib/utils";

/**
 * 公开页顶部的总结区：一句结论 + 三个大数字 + 一条脚注。
 *
 * 它替代旧的 `Summary` 四块卡，而不是并列出现：
 * - 在线 x/y 只在这里出现（旧汇总卡已删除）；
 * - 平均可用率只在这里出现（带三档色阶与填充条）；
 * - 当前总速率是新增数字，由在线机器的上下行速率现算；
 * - 旧汇总卡里的「最忙节点」「累计流量 / 今日」没有被重复的数值，
 *   收进脚注，信息不丢、也不和三个大数字抢视觉。
 *
 * 卡片与点阵完全沿用 `ServerCard`，这里只负责页面顶部。
 *
 * 三个大数字下方各有一张 40–56px 高的迷你图：延迟与速率来自后端 `series`，
 * 可用率由每台机器的 `buckets_24h` 现算。迷你图无坐标轴 / 网格 / 图例，
 * 没有数据时画虚线基线而不是 0 的平线（详见 `HeroSparkline`）。
 */

/**
 * 三个大数字共用一个骨架，保证标签、数值、条/占位与迷你图在同一基线上。
 *
 * 宽屏是竖排（标签 → 数字 → 条 → 图）；<md 时三列堆叠成三行，图移到
 * 数字右侧、只占 42% 宽度，一行就能读完「标题 + 数字 + 趋势」，也不横滚。
 */
function Stat({
  label,
  children,
  foot,
  chart,
}: {
  label: string;
  children: ReactNode;
  /** 进度条或等高占位；空着也保留 4px 高度，三个数字底部不会错位。 */
  foot?: ReactNode;
  /** KPI 下方的迷你图；无数据时由 `HeroSparkline` 自己画空态。 */
  chart: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 py-3 first:pt-0 last:pb-0 md:block md:py-0">
      <div className="min-w-0 flex-1 md:flex-none">
        <div className="truncate text-xs text-muted-foreground">{label}</div>
        {/* `min-h` 而不是固定高度：速率要放上下两个数字，窄屏换行时让它自然长高，
            另外两个数字仍从同一基线开始，底部的条不会错位。 */}
        <div className="mt-1.5 flex min-h-8 flex-wrap items-baseline gap-1 whitespace-nowrap sm:min-h-9">
          {children}
        </div>
        <div className="mt-2 h-1">{foot}</div>
      </div>
      <div className="w-[42%] max-w-44 shrink-0 md:mt-2.5 md:w-full md:max-w-none">
        {chart}
      </div>
    </div>
  );
}

/**
 * 一个方向的当前速率：`↓ 12.3 MB/s`。
 *
 * 数值变化时用 `key` 重挂载一次 `value-settle`（150ms 透明度 0.55→1），
 * 只在这一格真的变了才播；20 秒轮询拿回同样的数字时 key 不变，不会闪。
 */
function RateValue({
  icon: Icon,
  label,
  bps,
}: {
  icon: LucideIcon;
  /** 无障碍名称（下行 / 上行）；图标本身对读屏隐藏。 */
  label: string;
  bps: number | null;
}) {
  const parts = rateParts(bps);

  return (
    <span className="inline-flex min-w-0 items-baseline gap-1">
      <Icon
        className="size-3 shrink-0 self-center text-muted-foreground"
        aria-hidden="true"
      />
      <span className="sr-only">{label}</span>
      {parts === null ? (
        <span className="text-base leading-none font-semibold text-muted-foreground">
          —
        </span>
      ) : (
        <span
          key={`${parts.value} ${parts.unit}`}
          className="value-settle tnum inline-flex items-baseline gap-1 text-base leading-none font-semibold"
        >
          {parts.value}
          <span className="text-xs font-normal text-muted-foreground">
            {parts.unit}
          </span>
        </span>
      )}
    </span>
  );
}

/**
 * 当前总速率拆成上下行：`↓ 12.3 MB/s  ↑ 3.1 MB/s`。
 *
 * 两个方向都有数据才并列（桌面）；390 下每列只有约 100px，flex 自动换行成
 * 两行，不会把数字截断。两个方向都没有读数时整组只画一个 `—` —— 0 是
 * 「确实没有流量」，`—` 是「不知道」，两者不能混。
 */
function RateFlow({ rate }: { rate: OnlineRate | null }) {
  const { t } = useI18n();

  if (rate === null) {
    return (
      <span className="text-xl leading-none font-semibold text-muted-foreground sm:text-3xl">
        —
      </span>
    );
  }

  return (
    <div
      className="flex min-w-0 flex-wrap items-baseline gap-x-1 gap-y-0.5"
      title={formatRatePairText(rate.rx, rate.tx) ?? undefined}
    >
      <RateValue
        icon={ArrowDownIcon}
        label={t("publicStatus.server.trafficRx")}
        bps={rate.rx}
      />
      <RateValue
        icon={ArrowUpIcon}
        label={t("publicStatus.server.trafficTx")}
        bps={rate.tx}
      />
    </div>
  );
}

/** 没有 `series` 时传给迷你图的稳定空数据（避免每次渲染都造新对象）。 */
const EMPTY_LINE_SERIES: HeroLineSeries = { ts: [], values: [] };
const EMPTY_RATE_SERIES: HeroRateSeries = { ts: [], rx: [], tx: [] };

export function Hero({
  summary,
  servers,
  series,
}: {
  summary: PublicStatusSummary;
  servers: PublicStatusServer[];
  /**
   * 最近一小时的趋势序列；旧后端不返回。缺失时延迟 / 速率两张图进空态，
   * 可用率图仍由 `buckets_24h` 现算。
   */
  series?: PublicStatusSeries | null;
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

  // 平均延迟只算在线机器；没有读数时是 null，大数字显示 —，不写成 0 ms。
  const averageLatencyMs = averageLatency(servers);

  // 平均可用率：没有一台有采样时是 null，大数字显示 —，不写成 0%。
  const averageUptime = averageUptime24h(servers);
  const averagePercent = availabilityPercent(averageUptime);
  const averageTone = availabilityTone(averageUptime);
  const averageFill = availabilityFill(averageUptime);

  // 当前总速率：所有在线机器的上下行分别求和；没有任何读数时 null → —。
  const rate = onlineRateByDirection(servers);

  // 三张迷你图的数据：延迟 / 速率来自后端 series，可用率由 24 个桶现算。
  const latencyChart = heroLatencySeries(series) ?? EMPTY_LINE_SERIES;
  const rateChart = heroRateSeries(series) ?? EMPTY_RATE_SERIES;
  const uptimeChart = heroUptimeSeries(servers);

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
      <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-center lg:gap-8">
        {/* 结论是这一屏的主句：左对齐、允许换行，永远不截断成看不懂的半句。
            宽屏只按内容占宽（上限 24rem），剩余宽度全部让给右侧三列指标。 */}
        <div className="flex min-w-0 items-start gap-2.5 lg:max-w-[24rem] lg:shrink-0">
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

        {/* 三个大数字：<md 堆叠成三行（标题 + 数字 + 迷你图），md 起三列等宽；
            宽屏用 `flex-1` 吃掉结论以外的全部宽度，列均分，和左侧用竖线分隔。 */}
        <div className="grid min-w-0 grid-cols-1 divide-y divide-border border-t border-border pt-4 md:grid-cols-3 md:gap-5 md:divide-y-0 lg:flex-1 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-8">
          <Stat
            label={t("publicStatus.hero.averageLatency")}
            chart={
              <HeroSparkline kind="latency" data={latencyChart} />
            }
          >
            {averageLatencyMs === null ? (
              <span className="text-xl leading-none font-semibold text-muted-foreground sm:text-3xl">
                —
              </span>
            ) : (
              <span className="tnum inline-flex items-baseline gap-1 text-xl leading-none font-semibold sm:text-3xl">
                {averageLatencyMs}
                <span className="text-xs font-normal text-muted-foreground">
                  ms
                </span>
              </span>
            )}
          </Stat>

          <Stat
            label={t("publicStatus.hero.averageUptime")}
            chart={
              <HeroSparkline
                kind="uptime"
                data={uptimeChart}
                tone={averageTone}
              />
            }
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

          <Stat
            label={t("publicStatus.hero.totalRate")}
            chart={<HeroSparkline kind="rate" data={rateChart} />}
          >
            <RateFlow rate={rate} />
          </Stat>
        </div>
      </div>

      {/* 脚注承接旧汇总卡里不重复的两项：最忙节点与流量。 */}
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
