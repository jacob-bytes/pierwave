import { useI18n } from "@/i18n";
import type { PublicStatusServer } from "@/lib/api";
import { formatBytePair } from "@/lib/format";
import {
  resourcePercent,
  serverState,
  statusLabelKey,
} from "@/lib/publicStatus";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { AvailabilityValue } from "@/components/status/Availability";
import { StatusDot } from "@/components/status/ServerCard";

/** 百分比与一条细进度；参考项目的 `NodeTable.Bar` 的公开页版本。 */
function Bar({
  percent,
  pair,
  ariaLabel,
}: {
  percent: number | null;
  pair: string | null;
  ariaLabel: string;
}) {
  const { t } = useI18n();
  if (percent === null) {
    return (
      <span
        className="text-xs text-muted-foreground"
        title={t("publicStatus.server.notReported")}
      >
        —
      </span>
    );
  }

  const filled = Math.min(100, Math.max(0, percent));
  const text = `${filled < 10 ? filled.toFixed(1) : filled.toFixed(0)}%`;

  return (
    <div className="flex min-w-0 flex-col gap-1" title={pair ?? undefined}>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="tnum w-9 shrink-0 text-right text-xs">{text}</span>
        <span
          role="progressbar"
          aria-label={ariaLabel}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(filled)}
          aria-valuetext={text}
          className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted-foreground/20"
        >
          <span
            className={cn(
              "block h-full rounded-full",
              filled >= 90
                ? "bg-destructive"
                : filled >= 75
                  ? "bg-warning"
                  : "bg-primary",
            )}
            style={{
              width: `${filled}%`,
              minWidth: filled > 0 ? 3 : undefined,
            }}
          />
        </span>
      </div>
      <span className="tnum truncate text-micro text-muted-foreground">
        {pair ?? "—"}
      </span>
    </div>
  );
}

function loadText(load: number | null): string | null {
  return load !== null && Number.isFinite(load) ? load.toFixed(2) : null;
}

/**
 * 列表视图：与卡片同一批数据，一列一项，方便竖着读。
 *
 * 列的顺序照参考项目的 `NodeTable`：身份、三个资源、可用率、最后心跳。
 * 公开 API 没有地址、系统、地区、到期或实时网速，这里就不画那些列。
 */
export function ServerTable({
  servers,
}: {
  servers: PublicStatusServer[];
}) {
  const { t } = useI18n();

  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-card">
      <table className="w-full min-w-[1060px] table-fixed border-collapse text-sm">
        <caption className="sr-only">{t("publicStatus.table.caption")}</caption>
        <colgroup>
          <col style={{ width: "280px" }} />
          <col style={{ width: "100px" }} />
          <col style={{ width: "200px" }} />
          <col style={{ width: "200px" }} />
          <col style={{ width: "120px" }} />
          <col style={{ width: "160px" }} />
        </colgroup>
        <thead>
          <tr className="border-b border-border">
            <th
              scope="col"
              className="px-3 py-2.5 text-left text-xs font-normal whitespace-nowrap text-muted-foreground"
            >
              {t("publicStatus.table.server")}
            </th>
            <th
              scope="col"
              className="px-3 py-2.5 text-left text-xs font-normal whitespace-nowrap text-muted-foreground"
            >
              {t("publicStatus.server.load")}
            </th>
            <th
              scope="col"
              className="px-3 py-2.5 text-left text-xs font-normal whitespace-nowrap text-muted-foreground"
            >
              {t("publicStatus.server.memory")}
            </th>
            <th
              scope="col"
              className="px-3 py-2.5 text-left text-xs font-normal whitespace-nowrap text-muted-foreground"
            >
              {t("publicStatus.server.disk")}
            </th>
            <th
              scope="col"
              className="px-3 py-2.5 text-left text-xs font-normal whitespace-nowrap text-muted-foreground"
            >
              {t("publicStatus.server.availability24h")}
            </th>
            <th
              scope="col"
              className="px-3 py-2.5 text-left text-xs font-normal whitespace-nowrap text-muted-foreground"
            >
              {t("publicStatus.table.lastHeartbeat")}
            </th>
          </tr>
        </thead>
        <tbody>
          {servers.map((server) => {
            const state = serverState(server);
            const load = loadText(server.load1);
            const memPercent = resourcePercent(
              server.mem_used,
              server.mem_total,
            );
            const diskPercent = resourcePercent(
              server.disk_used,
              server.disk_total,
            );
            const memPair = formatBytePair(server.mem_used, server.mem_total);
            const diskPair = formatBytePair(server.disk_used, server.disk_total);
            const hasHeartbeat = server.last_seen !== null;
            const heartbeat = hasHeartbeat
              ? formatRelativeTime(server.last_seen)
              : t("publicStatus.server.neverSeen");

            return (
              <tr
                key={server.id}
                className="border-b border-border transition-colors last:border-0 hover:bg-muted/40"
              >
                <td className="overflow-hidden px-3 py-2.5">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <StatusDot state={state} />
                    <span
                      className="truncate font-medium"
                      title={server.name}
                    >
                      {server.name}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {t(statusLabelKey(state))}
                    </span>
                  </span>
                </td>
                <td className="overflow-hidden px-3 py-2.5">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span
                      className={cn(
                        "tnum text-xs",
                        load === null && "text-muted-foreground",
                      )}
                      title={
                        load === null
                          ? t("publicStatus.server.notReported")
                          : t("publicStatus.server.loadHint")
                      }
                    >
                      {load ?? "—"}
                    </span>
                    <span className="truncate text-micro text-muted-foreground">
                      {load === null
                        ? t("publicStatus.server.notReported")
                        : t("publicStatus.server.loadHint")}
                    </span>
                  </div>
                </td>
                <td className="overflow-hidden px-3 py-2.5">
                  <Bar
                    percent={memPercent}
                    pair={memPair}
                    ariaLabel={t("publicStatus.server.memory")}
                  />
                </td>
                <td className="overflow-hidden px-3 py-2.5">
                  <Bar
                    percent={diskPercent}
                    pair={diskPair}
                    ariaLabel={t("publicStatus.server.disk")}
                  />
                </td>
                <td className="overflow-hidden px-3 py-2.5">
                  <AvailabilityValue ratio={server.uptime_24h} />
                </td>
                <td className="overflow-hidden px-3 py-2.5">
                  <span
                    className="tnum block truncate text-xs text-muted-foreground"
                    title={
                      hasHeartbeat
                        ? formatAbsoluteTime(server.last_seen)
                        : t("publicStatus.server.neverSeen")
                    }
                  >
                    {heartbeat}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
