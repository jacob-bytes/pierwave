import { Link, Navigate, useSearchParams } from "react-router-dom";
import {
  ArrowRightIcon,
  NetworkIcon,
  RefreshCwIcon,
  ServerOffIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { EmptyState, SkeletonCard } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { Server } from "@/lib/api";
import { errorText } from "@/lib/errors";
import {
  nodeSummary,
  protocolChips,
  sortedServers,
  type NodeSummary,
} from "@/lib/nodeServerCards";
import { normalizeGroupName } from "@/lib/serverGroups";
import { useServers } from "@/lib/queries";
import { formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

function LoadingCards() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }).map((_, index) => (
        <SkeletonCard key={index} lines={1} />
      ))}
    </div>
  );
}

/** 统计行三态：还没有节点 / 全部启用 / N 个停用。 */
function summaryText(summary: NodeSummary): string {
  if (summary.state === "empty") return t("nodes.index.noNodes");

  const total =
    summary.total === 1
      ? t("nodes.index.nodeCountOne", { n: summary.total })
      : t("nodes.index.nodeCount", { n: summary.total });
  if (summary.state === "allEnabled") {
    return `${total} · ${t("nodes.index.allEnabled")}`;
  }

  const disabled =
    summary.disabled === 1
      ? t("nodes.index.disabledCountOne", { n: summary.disabled })
      : t("nodes.index.disabledCount", { n: summary.disabled });
  return `${total} · ${disabled}`;
}

function ServerCard({ server }: { server: Server }) {
  const online = server.status === "online";
  const summary = nodeSummary(server);
  const chips = protocolChips(server.node_protocols);
  const group = normalizeGroupName(server.group_name);

  return (
    <Link
      to={`/servers/${server.id}/nodes`}
      className="group flex h-full flex-col rounded-xl border border-border bg-card p-4 transition-colors duration-150 hover:border-primary/40 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <NetworkIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{server.name}</span>
        </div>
        <Badge
          variant="outline"
          className={cn(
            "shrink-0 gap-1.5 border-transparent font-normal",
            online
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 rounded-full",
              online ? "bg-primary" : "bg-muted-foreground/40",
            )}
          />
          {online ? t("nodes.index.online") : t("nodes.index.offline")}
        </Badge>
      </div>

      <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
        {server.address}
      </p>

      {group !== null || chips.protocols.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {group !== null ? (
            <span
              title={t("nodes.index.group")}
              aria-label={t("nodes.index.groupAria", { name: group })}
              className="max-w-40 truncate rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            >
              {group}
            </span>
          ) : null}
          {chips.protocols.map((protocol) => (
            <Badge
              key={protocol}
              variant="outline"
              className="h-5 border-border/70 px-1.5 font-mono text-[10px] font-normal tracking-wide text-muted-foreground"
            >
              {protocol}
            </Badge>
          ))}
          {chips.overflow > 0 ? (
            <span
              aria-label={t("nodes.index.moreProtocols", { n: chips.overflow })}
              className="text-xs text-muted-foreground"
            >
              {t("nodes.index.protocolOverflow", { n: chips.overflow })}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="mt-auto flex items-end justify-between gap-3 pt-4">
        <div className="min-w-0 space-y-0.5">
          <p
            className={cn(
              "truncate text-xs",
              summary.state === "empty"
                ? "text-muted-foreground"
                : "text-foreground/80",
            )}
          >
            {summaryText(summary)}
          </p>
          <p className="truncate text-[11px] text-muted-foreground">
            v{server.config_version} · {formatRelativeTime(server.last_seen_at)}
          </p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-primary transition-colors duration-150 group-hover:text-foreground">
          {t("nodes.index.manage")}
          <ArrowRightIcon className="size-3" />
        </span>
      </div>
    </Link>
  );
}

export default function NodesIndexPage() {
  useI18n();
  const [searchParams] = useSearchParams();
  const serverParam = searchParams.get("server");
  const servers = useServers();

  // 兼容 /nodes?server=<id> 的旧入口。
  if (serverParam) {
    return (
      <Navigate
        to={`/servers/${encodeURIComponent(serverParam)}/nodes`}
        replace
      />
    );
  }

  const items = servers.data ?? [];
  const showError = servers.isError && !servers.data;
  const errorMessage = errorText(
    servers.error,
    t("nodes.index.loadError"),
  );

  return (
    <div className="animate-in space-y-6 fade-in-0 slide-in-from-bottom-1 duration-150">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl leading-tight font-semibold tracking-tight">{t("nodes.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("nodes.index.subtitle")}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void servers.refetch()}
          disabled={servers.isFetching}
        >
          <RefreshCwIcon
            className={cn("size-3.5", servers.isFetching && "animate-spin")}
          />
          {t("common.refresh")}
        </Button>
      </div>

      {servers.isPending ? (
        <LoadingCards />
      ) : showError ? (
        <Card className="gap-0">
          <CardContent className="p-0">
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <div className="grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
                <TriangleAlertIcon className="size-5" />
              </div>
              <div>
                <p className="text-sm font-medium">{t("nodes.index.loadFailed")}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {errorMessage}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void servers.refetch()}
                disabled={servers.isFetching}
              >
                <RefreshCwIcon
                  className={cn(
                    "size-3.5",
                    servers.isFetching && "animate-spin",
                  )}
                />
                {t("common.retry")}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card className="gap-0">
          <CardContent className="p-0">
            <EmptyState
              icon={ServerOffIcon}
              title={t("nodes.index.emptyTitle")}
              description={t("nodes.index.emptyDesc")}
              action={
                <Button variant="outline" size="sm" asChild>
                  <Link to="/servers">{t("nodes.index.goAdd")}</Link>
                </Button>
              }
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {sortedServers(items).map((server) => (
            <ServerCard key={server.id} server={server} />
          ))}
        </div>
      )}
    </div>
  );
}
