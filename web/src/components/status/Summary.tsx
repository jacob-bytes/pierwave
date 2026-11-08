import type { KeyboardEvent, ReactNode } from "react";
import {
  ActivityIcon,
  ArrowDownUpIcon,
  GaugeIcon,
  ListFilterIcon,
  ServerIcon,
  type LucideIcon,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/i18n";
import type { PublicStatusServer, PublicStatusSummary } from "@/lib/api";
import {
  availabilityPercent,
  averageUptime24h,
  busiestServer,
  type StatusFilter,
} from "@/lib/publicStatus";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * 顶部四块汇总，版式与参考项目的 `Summary` 对齐：
 * 图标 + 标签一行、大号数字一行、脚注贴底，四块等高 86px。
 *
 * 参考项目是「节点 x/y、最忙节点、累计流量、实时网速」；公开 API 没有实时
 * 网速，第四块换成语义对应的「平均可用率」，其余三块按我们能拿到的字段映射。
 */
function Tile({
  icon: Icon,
  label,
  children,
  onOpen,
  pressed,
  title,
}: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
  /** 只有能带用户去列表的块才是按钮。 */
  onOpen?: () => void;
  pressed?: boolean;
  title?: string;
}) {
  return (
    <Card
      className={cn(
        "h-[86px] gap-0 rounded-xl p-3 transition [--card-spacing:--spacing(3)]",
        // 可筛选的卡不是普通 KPI：hover / active 都要有明确反馈，触屏用户也能看到按压态。
        onOpen &&
          "cursor-pointer hover:border-primary/50 hover:bg-muted/40 hover:ring-primary/40 active:scale-[0.99] active:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
        onOpen && pressed && "border-primary/50 ring-primary/50",
      )}
      {...(onOpen
        ? {
            role: "button" as const,
            tabIndex: 0,
            title,
            ...(pressed === undefined ? {} : { "aria-pressed": pressed }),
            onClick: onOpen,
            onKeyDown: (event: KeyboardEvent) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              onOpen();
            },
          }
        : {})}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
        {onOpen ? (
          <ListFilterIcon
            className="ml-auto size-3 shrink-0 text-primary"
            aria-hidden="true"
          />
        ) : null}
      </div>
      {children}
    </Card>
  );
}

export function Summary({
  summary,
  servers,
  filter,
  onFilter,
}: {
  summary: PublicStatusSummary;
  /** 逐台的负载与可用率，用于「最忙节点」和「平均可用率」两块。 */
  servers: PublicStatusServer[];
  filter: StatusFilter;
  onFilter: (filter: StatusFilter) => void;
}) {
  const { t } = useI18n();
  const offline = Math.max(0, summary.servers_total - summary.servers_online);
  const offlineActive = filter === "offline";
  const canFilter = offline > 0;

  // 最忙节点只看在线机器的实时负载；离线机器的心跳残留不参与。
  const busiest = busiestServer(servers);
  const busiestLoad =
    busiest && busiest.load1 !== null && Number.isFinite(busiest.load1)
      ? busiest.load1.toFixed(2)
      : null;

  // 没有一台有采样时是 null：脚注说明原因，大号数字显示 —，不写成 0%。
  const averageUptime = averageUptime24h(servers);
  const averagePercent = availabilityPercent(averageUptime);

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Tile
        icon={ServerIcon}
        label={t("publicStatus.summary.servers")}
        onOpen={
          canFilter
            ? () => onFilter(offlineActive ? "all" : "offline")
            : undefined
        }
        pressed={canFilter ? offlineActive : undefined}
        title={
          canFilter
            ? offlineActive
              ? t("publicStatus.toolbar.clearFilters")
              : t("publicStatus.filter.offline")
            : undefined
        }
      >
        <div className="tnum mt-0.5 text-xl leading-7 font-semibold">
          {summary.servers_online} / {summary.servers_total}
        </div>
        <div className="mt-auto flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground">
          {summary.servers_total === 0 ? (
            <span className="truncate">
              {t("publicStatus.summary.noServers")}
            </span>
          ) : offline > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1.5 text-destructive">
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-full bg-destructive"
              />
              {t("publicStatus.summary.offlineCount", { n: offline })}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-full bg-primary"
              />
              {t("publicStatus.summary.allOnline")}
            </span>
          )}
        </div>
      </Tile>

      <Tile icon={ActivityIcon} label={t("publicStatus.summary.busiest")}>
        <div
          className={cn(
            "tnum mt-0.5 text-xl leading-7 font-semibold",
            busiestLoad === null && "text-muted-foreground",
          )}
        >
          {busiestLoad ?? "—"}
        </div>
        <div
          className="mt-auto truncate text-xs text-muted-foreground"
          title={busiest?.name}
        >
          {busiest?.name ?? t("publicStatus.summary.busiestHint")}
        </div>
      </Tile>

      <Tile icon={ArrowDownUpIcon} label={t("publicStatus.summary.monthTraffic")}>
        <div className="tnum mt-0.5 text-xl leading-7 font-semibold">
          {formatBytes(summary.traffic_month)}
        </div>
        {/* 只有「今日总量」一个数，没有下行 / 上行的拆分，就只写一个数。 */}
        <div className="tnum mt-auto truncate text-xs text-muted-foreground">
          {t("publicStatus.summary.today", {
            value: formatBytes(summary.traffic_today),
          })}
        </div>
      </Tile>

      <Tile icon={GaugeIcon} label={t("publicStatus.summary.averageUptime")}>
        <div
          className={cn(
            "tnum mt-0.5 text-xl leading-7 font-semibold",
            averagePercent === null && "text-muted-foreground",
          )}
        >
          {averagePercent === null ? "—" : `${averagePercent}%`}
        </div>
        <div className="mt-auto truncate text-xs text-muted-foreground">
          {averagePercent === null
            ? t("publicStatus.summary.noSamples")
            : t("publicStatus.summary.uptime24hHint")}
        </div>
      </Tile>
    </div>
  );
}
