import { Suspense, useEffect, useRef } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MeStatusBadge, StatusAlerts } from "@/components/me/MeStatus";
import { meErrorText } from "@/lib/meError";
import {
  activeSection,
  meSections,
  sectionTitleKey,
} from "@/lib/meSections";
import type { MeShellContext } from "@/lib/meShell";
import { queryKeys, useMeSummary } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";

function MeTabs() {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const active = activeSection(pathname);
  const navRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLAnchorElement>(null);

  /*
   * 窄屏 + 英文标签会横向溢出：只把当前项滚进可视区，不带动整页滚动。
   * 与 TabsList 的处理一致，避免「收藏 /me/packages 后看不到当前标签」。
   */
  useEffect(() => {
    const nav = navRef.current;
    const current = activeRef.current;
    if (!nav || !current || nav.scrollWidth <= nav.clientWidth + 1) return;
    const navRect = nav.getBoundingClientRect();
    const currentRect = current.getBoundingClientRect();
    if (currentRect.left < navRect.left || currentRect.right > navRect.right) {
      current.scrollIntoView({ inline: "nearest", block: "nearest" });
    }
  }, [pathname]);

  return (
    <div
      ref={navRef}
      className="min-w-0 max-w-full overflow-x-auto overscroll-x-contain"
    >
      <nav
        aria-label={t("me.tabs.ariaLabel")}
        className="flex w-max min-w-full items-center gap-1 border-b border-border"
      >
        {meSections().map((section) => {
          const isActive = active?.id === section.id;
          return (
            <Link
              key={section.id}
              ref={isActive ? activeRef : undefined}
              to={section.path}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "relative -mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors duration-150",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                isActive
                  ? "border-primary font-medium text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t(section.labelKey)}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/** 分页 chunk 加载态：只替换内容区，顶部标签保持可点。 */
function MeSectionSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-40 w-full rounded-xl" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}

/** 首次进入 `/me` 且 summary 未返回时的骨架：与最终结构等高，避免 CLS。 */
function MeSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-full" />
        <div className="space-y-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-3 w-44" />
        </div>
      </div>
      <Skeleton className="h-9 w-full rounded-none" />
      <Skeleton className="h-52 w-full rounded-xl" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    </div>
  );
}

function MeError({
  message,
  retrying,
  onRetry,
}: {
  message: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
        <div className="grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
          <TriangleAlertIcon className="size-5" />
        </div>
        <div>
          <p className="text-sm font-medium">{t("me.loadFailed")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{message}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={retrying}
        >
          <RefreshCwIcon
            className={cn("size-3.5", retrying && "animate-spin")}
          />
          {t("common.retry")}
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * 四个分页共用的用户端外壳：身份、告警、顶部标签与独立路由容器。
 *
 * 作为 `/me` 的布局路由使用，内容通过 `<Outlet>` 渲染；summary 只在这里
 * 请求一次，分页用 `useMeShellSummary()` 取同一份数据，切标签不重复加载。
 */
export default function MeShell() {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const summary = useMeSummary();
  const queryClient = useQueryClient();
  const fetching = useIsFetching({ queryKey: queryKeys.me }) > 0;
  const section = activeSection(pathname);
  const titleKey = section ? sectionTitleKey(section.id) : "me.pages.overview.title";

  if (summary.isPending) return <MeSkeleton />;

  if (summary.isError) {
    return (
      <MeError
        message={meErrorText(summary.error, t("me.loadError"))}
        retrying={summary.isFetching}
        onRetry={() => void summary.refetch()}
      />
    );
  }

  if (!summary.data) return null;

  const data = summary.data;
  const initial = data.user.username.slice(0, 1).toUpperCase();

  function refreshAll() {
    // `["me"]` 前缀覆盖 summary / traffic / events / forwards，四个分页都刷新。
    void queryClient.refetchQueries({ queryKey: queryKeys.me });
  }

  return (
    <div className="animate-in space-y-6 fade-in-0 slide-in-from-bottom-1 duration-150">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar size="lg">
            <AvatarFallback className="bg-primary/15 font-medium text-primary">
              {initial}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl leading-tight font-semibold tracking-tight">
                {t(titleKey)}
              </h1>
              <MeStatusBadge status={data.usage.status} />
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {data.user.username}
              {data.user.email ? ` · ${data.user.email}` : ""} ·{" "}
              {t("me.onlyOwnData")}
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={refreshAll}
          disabled={fetching}
        >
          <RefreshCwIcon
            className={cn("size-3.5", fetching && "animate-spin")}
          />
          {t("common.refresh")}
        </Button>
      </div>

      <StatusAlerts summary={data} />

      <MeTabs />

      <Suspense fallback={<MeSectionSkeleton />}>
        <Outlet context={{ summary: data } satisfies MeShellContext} />
      </Suspense>
    </div>
  );
}
