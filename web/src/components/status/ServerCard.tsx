import {
  ArrowDownIcon,
  ArrowDownToLineIcon,
  ArrowUpIcon,
  ArrowUpToLineIcon,
  CalendarClockIcon,
  CoinsIcon,
  GlobeIcon,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Meter } from "@/components/status/Meter";
import { AvailabilityStrip, AvailabilityValue } from "@/components/status/Availability";
import { useI18n } from "@/i18n";
import type { PublicStatusServer } from "@/lib/api";
import {
  countryCodeToFlag,
  countryDisplayName,
  normalizeCountryCode,
} from "@/lib/country";
import { formatBytePair } from "@/lib/format";
import { formatRate, formatTrafficTotal } from "@/lib/netRate";
import {
  availabilityPercent,
  availabilityTone,
  expiryLabel,
  publicBilling,
  reportedLatency,
  resourcePercent,
  serverSpecLine,
  serverState,
  statusLabelKey,
  uptimeLabelKey,
  uptimeParts,
  type PublicBilling,
  type ServerState,
} from "@/lib/publicStatus";
import { cn } from "@/lib/utils";

/**
 * 三种状态各自的圆点与 chip 表面。状态不只靠颜色：在线是实心带光晕，
 * 离线是空心灰环，异常是实心红色 —— 即使分不清红绿，形状也不同。
 */
const STATE_META: Record<ServerState, { dot: string; chip: string }> = {
  online: {
    dot: "bg-primary ring-2 ring-primary/25",
    chip: "border-border bg-card text-foreground",
  },
  offline: {
    dot: "border-2 border-muted-foreground/70 bg-transparent",
    chip: "border-border bg-card text-muted-foreground",
  },
  abnormal: {
    dot: "bg-destructive ring-2 ring-destructive/25",
    chip: "border-border bg-card text-foreground",
  },
};

/** 状态点单独给列表视图用；卡片里再和文字焊成一个 chip。 */
export function StatusDot({
  state,
  className,
}: {
  state: ServerState;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        STATE_META[state].dot,
        // 只有在线（活着）的状态点呼吸；离线空心环与异常红点保持静止。
        state === "online" && "status-breathe",
        className,
      )}
    />
  );
}

/**
 * 标题行右侧的状态 pill：小圆点 + 状态 + 已在线时长，和参考项目一样焊在
 * 一个 chip 里。离线时不给时长 —— `uptime_secs` 是掉线前最后一次心跳的值，
 * 写在「离线」旁边会被读成「已经离线了这么久」。
 */
export function StatusChip({
  state,
  uptime,
  className,
}: {
  state: ServerState;
  /** 已经格式化好的「141 天 1 小时」；没有数据时为 null。 */
  uptime?: string | null;
  className?: string;
}) {
  const { t } = useI18n();
  const meta = STATE_META[state];

  return (
    <Badge
      variant="outline"
      title={
        state === "abnormal"
          ? t("publicStatus.server.abnormalTitle")
          : undefined
      }
      className={cn(
        "tnum h-5 shrink-0 gap-1 overflow-visible rounded-full px-1.5 type-micro font-normal whitespace-nowrap",
        meta.chip,
        className,
      )}
    >
      <StatusDot state={state} />
      {t(statusLabelKey(state))}
      {uptime ? <span className="text-muted-foreground">{uptime}</span> : null}
    </Badge>
  );
}

/** 实时速率 / 累计流量的一个值；图标区分「方向」与「当前还是累计」。 */
function TrafficCell({
  icon: Icon,
  label,
  value,
  hint,
  muted,
}: {
  icon: LucideIcon;
  /** 无障碍名称（下行 / 下行累计流量）；图标本身对读屏隐藏。 */
  label: string;
  value: string | null;
  hint: string;
  /** 累计值用次要色；速率只有缺数据时才转次要色。 */
  muted?: boolean;
}) {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-x-2 text-xs">
      <Icon
        className="size-3 shrink-0 self-center text-muted-foreground"
        aria-hidden="true"
      />
      <span className="sr-only">{label}</span>
      <span
        className={cn(
          "tnum min-w-0 truncate",
          muted || value === null ? "text-muted-foreground" : "text-foreground",
        )}
        title={hint}
      >
        {value ?? "—"}
      </span>
    </span>
  );
}

/**
 * 到期日：`27 天后到期`，已过期转 warning；没有日期显示「未配置」。
 *
 * hover 给出后端原始的 `YYYY-MM-DD`（UTC+8 业务日），不用相对天数猜日期。
 * 图标保持 muted，颜色只落在文字上 —— 一个染色的图标会把整格变成警报。
 */
function BillingExpiry({ billing }: { billing: PublicBilling }) {
  const { t } = useI18n();
  const label = billing.days === null ? null : expiryLabel(billing.days);
  const expired = billing.days !== null && billing.days < 0;

  return (
    <span
      className="inline-flex min-w-0 items-baseline gap-x-2 text-xs"
      title={billing.paidUntil ?? undefined}
    >
      <CalendarClockIcon
        className="size-3 shrink-0 self-center text-muted-foreground"
        aria-hidden="true"
      />
      <span className="sr-only">{t("publicStatus.server.expiry")}</span>
      <span
        className={cn(
          "truncate",
          expired ? "text-warning" : "text-muted-foreground",
        )}
      >
        {label
          ? t(label.key, label.values)
          : t("publicStatus.server.notSet")}
      </span>
    </span>
  );
}

/**
 * 价格与周期：`¥268.00 / 月`；币种符号由 `formatPrice` 决定，这里只拼周期。
 *
 * 价格 / 周期各自缺失时只把那半边写成「未配置」，整行仍然占位；
 * 两项都缺失时只写一个「未配置」，不重复两次。
 */
function BillingPrice({ billing }: { billing: PublicBilling }) {
  const { t } = useI18n();
  const notSet = t("publicStatus.server.notSet");
  const cycle = billing.cycleKey === null ? null : t(billing.cycleKey);
  const text =
    billing.price !== null && cycle !== null
      ? `${billing.price} / ${cycle}`
      : billing.price !== null
        ? `${billing.price} / ${notSet}`
        : cycle !== null
          ? `${notSet} / ${cycle}`
          : notSet;

  return (
    <span className="inline-flex min-w-0 items-baseline gap-x-2 text-xs" title={text}>
      <CoinsIcon
        className="size-3 shrink-0 self-center text-muted-foreground"
        aria-hidden="true"
      />
      <span className="sr-only">{t("publicStatus.server.price")}</span>
      <span className="tnum min-w-0 truncate text-muted-foreground">{text}</span>
    </span>
  );
}

/**
 * 实时速率、累计流量与到期/价格（`↓ 速率 ↓ 累计 / ↑ 速率 ↑ 累计 / 到期 · 价格`）。
 *
 * 数据来源见 `docs/TELEMETRY.md`：速率是两次心跳的累计字节差 / 时间差；
 * 累计值是 Agent 自开机以来的非 lo 网卡计数（主机重启会归零）。
 * 没有数据一律显示 `—`，绝不用 0 冒充。
 *
 * 离线时速率不显示：`servers.net_rx_bps` 是掉线前最后一次算出的值，
 * 写在「离线」卡片上会被读成实时读数。累计值仍保留（它是历史计数）。
 *
 * 版式照参考卡片读下去是三列：速率、累计流量、到期与价格。md 以上三列并排，
 * 第三列略宽（`¥1,111.00 / 年` 是最长的内容）；`<md` 收敛成两列，到期与价格
 * 整组换到第三行并横跨两列，390 下不会把前两列挤扁。
 * 第三列**永远存在**：账期四项缺哪项就显示「未配置」，不整组消失 —— 否则
 * 网格会从三列塌成两列，和上方标题、右侧内容都错位。
 */
function TrafficFooter({ server }: { server: PublicStatusServer }) {
  const { t } = useI18n();
  const online = serverState(server) !== "offline";
  const rateHint = t("publicStatus.server.rateHint");
  const totalHint = t("publicStatus.server.trafficTotalHint");
  const rxRate = formatRate(online ? server.net_rx_bps : null);
  const txRate = formatRate(online ? server.net_tx_bps : null);
  const rxTotal = formatTrafficTotal(server.net_rx_bytes);
  const txTotal = formatTrafficTotal(server.net_tx_bytes);
  const billing = publicBilling(server);

  const rxLabel = t("publicStatus.server.trafficRx");
  const txLabel = t("publicStatus.server.trafficTx");
  const totalLabel = t("publicStatus.server.trafficTotal");

  return (
    <div className="mt-4 border-t border-border pt-2.5">
      <div
        role="group"
        aria-label={t("publicStatus.server.trafficGroup")}
        className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.35fr)] md:gap-y-2"
      >
        <div className="flex min-w-0 flex-col gap-y-1.5">
          <TrafficCell
            icon={ArrowDownIcon}
            label={rxLabel}
            value={rxRate}
            hint={rateHint}
          />
          <TrafficCell
            icon={ArrowUpIcon}
            label={txLabel}
            value={txRate}
            hint={rateHint}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-y-1.5">
          <TrafficCell
            icon={ArrowDownToLineIcon}
            label={`${rxLabel} ${totalLabel}`}
            value={rxTotal}
            hint={totalHint}
            muted
          />
          <TrafficCell
            icon={ArrowUpToLineIcon}
            label={`${txLabel} ${totalLabel}`}
            value={txTotal}
            hint={totalHint}
            muted
          />
        </div>

        <div
          className="col-span-2 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 md:col-span-1 md:flex-col md:items-start md:gap-y-1.5"
          role="group"
          aria-label={t("publicStatus.server.billingGroup")}
        >
          <BillingExpiry billing={billing} />
          <BillingPrice billing={billing} />
        </div>
      </div>
    </div>
  );
}

export function ServerCard({ server }: { server: PublicStatusServer }) {
  const { t, locale } = useI18n();
  const state = serverState(server);

  // 在线（含异常）才有可展示的运行时长；离线时 pill 只留状态。
  const uptimeDuration = (() => {
    if (state === "offline") return null;
    const parts = uptimeParts(server.uptime_secs);
    return parts ? t(uptimeLabelKey(parts), parts) : null;
  })();

  // 延迟同理：null / 探测失败整项不显示，绝不用 0 ms 占位；
  // 离线时保留的是掉线前最后一次心跳的旧值，也不当作实时质量展示。
  const latency =
    state === "offline" ? null : reportedLatency(server.latency_ms);

  const load =
    server.load1 !== null && Number.isFinite(server.load1)
      ? server.load1
      : null;
  const memPercent = resourcePercent(server.mem_used, server.mem_total);
  const diskPercent = resourcePercent(server.disk_used, server.disk_total);
  const memPair = formatBytePair(server.mem_used, server.mem_total);
  const diskPair = formatBytePair(server.disk_used, server.disk_total);
  const uptime24h = availabilityPercent(server.uptime_24h);
  // 国旗三态：合法代码 → emoji；未设置 / 非法 → 地球图标（保持标题行对齐，
  // 也不猜测国家）。国家名用 Intl.DisplayNames 本地化，失败回落代码。
  const normalizedCountry = normalizeCountryCode(server.country_code);
  const flag = countryCodeToFlag(server.country_code);
  const countryTitle = normalizedCountry
    ? t("publicStatus.server.countryTitle", {
        name:
          countryDisplayName(normalizedCountry, locale) ?? normalizedCountry,
        code: normalizedCountry,
      })
    : t("publicStatus.server.countryUnset");
  // 发行版 · 虚拟化 · 架构；缺哪项跳哪项，全缺返回 null（整行不渲染）。
  const spec = serverSpecLine(server);

  return (
    <Card
      className={cn(
        "h-full min-w-0 gap-0 rounded-xl p-4 transition-[box-shadow,background-color] duration-150 [--card-spacing:--spacing(4)] hover:ring-1 hover:ring-primary/70 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:shadow-sm focus-visible:outline-none",
        state !== "online" && "bg-muted/40",
      )}
    >
      {/* 标题行：名称在左，状态 pill 在右。名称让位、pill 不换行，
          长主机名在省略号处截断，而不是把状态挤出卡片。 */}
      <div className="flex min-w-0 items-center gap-2">
        <h3 className="truncate text-sm leading-tight font-medium" title={server.name}>
          {server.name}
        </h3>
        {/* 国旗永远占位：合法代码显示 emoji，否则显示中性地球。
            旗帜是装饰性的，国家名与代码在 title / aria-label 里。 */}
        <span
          role="img"
          aria-label={countryTitle}
          title={countryTitle}
          className="shrink-0"
        >
          {flag ? (
            <span
              aria-hidden="true"
              className="text-sm leading-none select-none"
            >
              {flag}
            </span>
          ) : (
            <GlobeIcon
              aria-hidden="true"
              className="icon-sm text-muted-foreground"
            />
          )}
        </span>
        <StatusChip state={state} uptime={uptimeDuration} className="ml-auto" />
      </div>

      {/* 副行：发行版 版本 · 虚拟化 · 架构（缺失项跳过）。延迟在最右，
          用 truncate 吃掉 OS 的一段，不把整行顶成两行。 */}
      {spec || latency !== null ? (
        <p
          className="mt-1 flex min-w-0 items-baseline gap-x-1 text-xs text-muted-foreground"
          title={
            [spec, latency !== null ? `${latency} ms` : null]
              .filter(Boolean)
              .join(" · ") || undefined
          }
        >
          {spec ? <span className="truncate">{spec}</span> : null}
          {latency !== null ? (
            <>
              <span aria-hidden="true">·</span>
              <span
                className="tnum shrink-0"
                title={t("publicStatus.server.latencyHint")}
              >
                {t("publicStatus.server.latency", { ms: latency })}
              </span>
            </>
          ) : null}
        </p>
      ) : null}

      {/* 2×2 指标，顺序照参考卡：负载 / 内存，硬盘 / 24h 可用率。
          内存与硬盘有真实总量，画百分比条；可用率用图例的色阶；
          负载没有可归一化的分母（API 不公开核数），只给原始值。 */}
      <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4">
        <Meter
          label={t("publicStatus.server.load")}
          value={load === null ? "—" : load.toFixed(2)}
          muted={load === null}
          foot={
            load === null
              ? t("publicStatus.server.notReported")
              : t("publicStatus.server.loadHint")
          }
          emptyLabel={t("publicStatus.server.notReported")}
        />
        <Meter
          label={t("publicStatus.server.memory")}
          percent={memPercent}
          foot={memPair ?? t("publicStatus.server.notReported")}
          footTitle={memPair ?? undefined}
          emptyLabel={t("publicStatus.server.notReported")}
        />
        <Meter
          label={t("publicStatus.server.disk")}
          percent={diskPercent}
          foot={diskPair ?? t("publicStatus.server.notReported")}
          footTitle={diskPair ?? undefined}
          emptyLabel={t("publicStatus.server.notReported")}
        />
        <Meter
          label={t("publicStatus.server.availability24h")}
          percent={uptime24h}
          tone={availabilityTone(server.uptime_24h)}
          foot={t("publicStatus.server.availability24hHint")}
          footTitle={
            uptime24h === null
              ? t("publicStatus.server.noSample")
              : undefined
          }
          emptyLabel={t("publicStatus.server.noSample")}
        />
      </div>

      {/* 实时速率紧跟四个指标。它和点阵之间用卡片里同一条 border-t 分开，
          不引入新的边框样式。 */}
      <TrafficFooter server={server} />

      {/* 点阵是卡片最后一块：先分隔线，再点阵；7 天可用率跟着点阵走，
          单独一行，不和点阵并排。 */}
      <div className="mt-3 border-t border-border" aria-hidden="true" />
      <div className="mt-auto pt-3">
        <AvailabilityStrip server={server} />
        <div className="mt-2 flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
          <span>{t("publicStatus.server.availability7d")}</span>
          <AvailabilityValue ratio={server.uptime_7d} />
        </div>
      </div>
    </Card>
  );
}
