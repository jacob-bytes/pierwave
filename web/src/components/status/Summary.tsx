import type { KeyboardEvent, ReactNode } from "react";
import {
  ArrowDownIcon,
  CalendarClockIcon,
  NetworkIcon,
  ServerIcon,
  type LucideIcon,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/i18n";
import type { PublicStatusSummary } from "@/lib/api";
import type { StatusFilter } from "@/lib/publicStatus";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * 顶部四块汇总，版式与参考项目的 `Summary` 对齐：
 * 图标 + 标签一行、大号数字一行、脚注贴底，四块等高 86px。
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
        "h-[86px] gap-0 rounded-xl p-3 [--card-spacing:--spacing(3)]",
        onOpen &&
          "cursor-pointer transition hover:ring-primary/40 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
        onOpen && pressed && "ring-primary/50",
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
      </div>
      {children}
    </Card>
  );
}

export function Summary({
  summary,
  abnormal,
  filter,
  onFilter,
}: {
  summary: PublicStatusSummary;
  /** 在线但 Xray 未运行的台数；用于解释「在线」标签与汇总数的关系。 */
  abnormal: number;
  filter: StatusFilter;
  onFilter: (filter: StatusFilter) => void;
}) {
  const { t } = useI18n();
  const offline = Math.max(
    0,
    summary.servers_total - summary.servers_online,
  );
  const offlineActive = filter === "offline";
  const canFilter = offline > 0;

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
        <div className="mt-auto flex min-w-0 items-center gap-2 overflow-hidden text-xs text-muted-foreground">
          {summary.servers_total === 0 ? (
            <span className="truncate">
              {t("publicStatus.summary.noServers")}
            </span>
          ) : (
            <>
              {offline > 0 ? (
                <span className="inline-flex shrink-0 items-center gap-1.5 text-destructive">
                  <span
                    aria-hidden="true"
                    className="size-1.5 shrink-0 rounded-full bg-destructive"
                  />
                  {t("publicStatus.summary.offlineCount", { n: offline })}
                </span>
              ) : null}
              {abnormal > 0 ? (
                <span
                  className="inline-flex min-w-0 items-center gap-1.5 text-warning"
                  title={t("publicStatus.server.abnormalTitle")}
                >
                  <span
                    aria-hidden="true"
                    className="size-1.5 shrink-0 rounded-full bg-warning"
                  />
                  <span className="truncate">
                    {t("publicStatus.summary.abnormalIncluded", {
                      n: abnormal,
                    })}
                  </span>
                </span>
              ) : null}
              {offline === 0 && abnormal === 0 ? (
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="size-1.5 shrink-0 rounded-full bg-primary"
                  />
                  {t("publicStatus.summary.allOnline")}
                </span>
              ) : null}
            </>
          )}
        </div>
      </Tile>

      <Tile icon={NetworkIcon} label={t("publicStatus.summary.nodes")}>
        <div className="tnum mt-0.5 text-xl leading-7 font-semibold">
          {summary.nodes_total}
        </div>
        <div className="mt-auto truncate text-xs text-muted-foreground">
          {t("publicStatus.summary.nodesHint")}
        </div>
      </Tile>

      <Tile icon={ArrowDownIcon} label={t("publicStatus.summary.todayTraffic")}>
        <div className="tnum mt-0.5 text-xl leading-7 font-semibold">
          {formatBytes(summary.traffic_today)}
        </div>
        <div className="mt-auto truncate text-xs text-muted-foreground">
          {t("publicStatus.summary.trafficHint")}
        </div>
      </Tile>

      <Tile
        icon={CalendarClockIcon}
        label={t("publicStatus.summary.monthTraffic")}
      >
        <div className="tnum mt-0.5 text-xl leading-7 font-semibold">
          {formatBytes(summary.traffic_month)}
        </div>
        <div className="mt-auto truncate text-xs text-muted-foreground">
          {t("publicStatus.summary.trafficHint")}
        </div>
      </Tile>
    </div>
  );
}
