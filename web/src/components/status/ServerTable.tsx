import { useNavigate } from "react-router-dom";
import { useI18n } from "@/i18n";
import type { PublicStatusServer } from "@/lib/api";
import { formatBytePair } from "@/lib/format";
import {
  resourcePercent,
  serverOsLine,
  serverPlatformLine,
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
      <span className="tnum truncate type-micro text-muted-foreground">
        {pair ?? "—"}
      </span>
    </div>
  );
}

function loadText(load: number | null): string | null {
  return load !== null && Number.isFinite(load) ? load.toFixed(2) : null;
}

/**
 * 行内这些元素自己处理点击 / 回车时，整行跳转必须让路。
 *
 * 目前列表行里没有别的可点元素；这条守卫是给以后加的筛选、复制按钮留的：
 * 只要命中其中一个，行点击就返回，不把「点复制」变成「进详情」。
 */
const ROW_INTERACTIVE =
  'a,button,input,select,textarea,label,[role="button"],[role="menuitem"],[role="link"]';

/** 行内命中可交互后代？行本身的 `role="link"` 不算（`closest` 会命中自己）。 */
function interactiveDescendant(
  target: EventTarget | null,
  row: Element,
): boolean {
  if (!(target instanceof Element)) return false;
  const hit = target.closest(ROW_INTERACTIVE);
  return hit !== null && hit !== row;
}

/**
 * 列表视图：与卡片同一批数据，一列一项，方便竖着读。
 *
 * 列的顺序照参考项目的 `NodeTable`：身份、环境、三个资源、可用率、最后心跳。
 * 「环境」来自公开列表接口本来就返回的 `os_name` / `os_version` / `virt` /
 * `arch`，不为了补这一列去逐台调详情接口（那会是 N+1）。公开 API 没有地址、
 * 地区以外的主机信息，这里就不画那些列。
 *
 * 整行是一个链接：鼠标点任意位置、键盘聚焦后按 Enter 都进 `/status/:id`；
 * hover / 聚焦有背景反馈，行内未来出现的按钮等元素按 `ROW_INTERACTIVE` 让路。
 */
export function ServerTable({
  servers,
}: {
  servers: PublicStatusServer[];
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const openDetail = (id: string) =>
    navigate(`/status/${encodeURIComponent(id)}`);

  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-card">
      <table className="w-full min-w-[1140px] table-fixed border-collapse text-sm">
        <caption className="sr-only">{t("publicStatus.table.caption")}</caption>
        <colgroup>
          <col style={{ width: "250px" }} />
          <col style={{ width: "220px" }} />
          <col style={{ width: "90px" }} />
          <col style={{ width: "170px" }} />
          <col style={{ width: "170px" }} />
          <col style={{ width: "110px" }} />
          <col style={{ width: "130px" }} />
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
              {t("publicStatus.table.environment")}
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
            // 环境两行：发行版 / `虚拟化 · 架构`；任一为空都写成 `—`，
            // 绝不拼空字符串（否则第二行会只剩一个 ` · `）。
            const os = serverOsLine(server);
            const platform = serverPlatformLine(server);
            const specTitle =
              [os, platform].filter(Boolean).join(" · ") || undefined;

            return (
              <tr
                key={server.id}
                role="link"
                tabIndex={0}
                aria-label={t("publicStatus.detail.open", { name: server.name })}
                onClick={(event) => {
                  if (event.defaultPrevented) return;
                  if (interactiveDescendant(event.target, event.currentTarget)) {
                    return;
                  }
                  openDetail(server.id);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.defaultPrevented) return;
                  event.preventDefault();
                  openDetail(server.id);
                }}
                className="cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-muted/40 focus-visible:bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
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
                  <div className="flex min-w-0 flex-col gap-0.5" title={specTitle}>
                    <span
                      className={cn(
                        "truncate text-[13px] leading-tight",
                        os === null && "text-muted-foreground",
                      )}
                    >
                      {os ?? "—"}
                    </span>
                    <span className="truncate type-micro leading-tight text-muted-foreground">
                      {platform ?? "—"}
                    </span>
                  </div>
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
                    <span className="truncate type-micro text-muted-foreground">
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
