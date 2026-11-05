import { Link, Navigate, useSearchParams } from "react-router-dom";
import {
  ArrowRightIcon,
  NetworkIcon,
  RefreshCwIcon,
  ServerOffIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { Server } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { useServers } from "@/lib/queries";
import { formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

function LoadingCards() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }).map((_, index) => (
        <div
          key={index}
          className="rounded-xl border border-border bg-card p-4"
        >
          <Skeleton className="h-4 w-28" />
          <Skeleton className="mt-2 h-3 w-36" />
          <Skeleton className="mt-4 h-3 w-20" />
        </div>
      ))}
    </div>
  );
}

function ServerCard({ server }: { server: Server }) {
  const online = server.status === "online";

  return (
    <Link
      to={`/servers/${server.id}/nodes`}
      className="group rounded-xl border border-border bg-card p-4 transition-colors duration-150 hover:bg-muted/40"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <NetworkIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">{server.name}</span>
          </div>
          <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
            {server.address}
          </p>
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
      <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
        <span>
          v{server.config_version} · {formatRelativeTime(server.last_seen_at)}
        </span>
        <span className="inline-flex items-center gap-1 text-primary opacity-80 transition-opacity duration-150 group-hover:opacity-100">
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
          <h1 className="text-xl font-semibold tracking-tight">{t("nodes.title")}</h1>
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

      <Card className="gap-0">
        <CardHeader className="border-b border-border">
          <CardTitle className="text-sm font-medium">
            {t("nodes.index.selectServer")}
          </CardTitle>
          <CardDescription className="text-xs">
            {t("nodes.index.selectServerDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4">
          {servers.isPending ? (
            <LoadingCards />
          ) : showError ? (
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
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <div className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
                <ServerOffIcon className="size-5" />
              </div>
              <div>
                <p className="text-sm font-medium">{t("nodes.index.emptyTitle")}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("nodes.index.emptyDesc")}
                </p>
              </div>
              <Button variant="outline" size="sm" asChild>
                <Link to="/servers">{t("nodes.index.goAdd")}</Link>
              </Button>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {items.map((server) => (
                <ServerCard key={server.id} server={server} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
