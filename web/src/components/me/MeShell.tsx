import { Suspense, useEffect, useRef } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { RefreshCwIcon } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ListError, ScrollFade } from "@/components/common";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MeStatusBadge, StatusAlerts } from "@/components/me/MeStatus";
import { meErrorText } from "@/lib/meError";
import {
  activeSection,
  meSections,
  sectionTitleKey,
} from "@/lib/meSections";
import { isSecretDecryptError } from "@/lib/settingsSecrets";
import type { MeShellContext } from "@/lib/meShell";
import { queryKeys, useMeSummary } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";

function MeTabs() {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const active = activeSection(pathname);
  const navRef = useRef<HTMLElement>(null);
  const activeRef = useRef<HTMLAnchorElement>(null);

  /*
   * 窄屏 + 英文标签会横向溢出：只把当前项滚进可视区，不带动整页滚动。
   * 与 TabsList 的处理一致，避免「收藏 /me/packages 后看不到当前标签」。
   * 滚动容器是 `ScrollFade`（两侧渐隐，提示还有内容），nav 的父元素就是它。
   */
  useEffect(() => {
    const current = activeRef.current;
    const scroller = navRef.current?.parentElement;
    if (!current || !scroller) return;
    if (scroller.scrollWidth <= scroller.clientWidth + 1) return;
    const navRect = scroller.getBoundingClientRect();
    const currentRect = current.getBoundingClientRect();
    if (currentRect.left < navRect.left || currentRect.right > navRect.right) {
      current.scrollIntoView({ inline: "nearest", block: "nearest" });
    }
  }, [pathname]);

  return (
    <ScrollFade>
      <nav
        ref={navRef}
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
    </ScrollFade>
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
  title,
  message,
  retrying,
  onRetry,
}: {
  title: string;
  message: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <Card>
      <CardContent>
        <ListError
          title={title}
          message={message}
          retrying={retrying}
          onRetry={onRetry}
        />
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
    // 503 的秘密故障不是网络问题：给出「谁能修、代价是什么」的可读提示，
    // 而不是让用户对着通用错误文案反复重试。
    const secretBroken = isSecretDecryptError(summary.error);
    return (
      <MeError
        title={secretBroken ? t("me.secretError.title") : t("me.loadFailed")}
        message={
          secretBroken
            ? t("me.secretError.description")
            : meErrorText(summary.error, t("me.loadError"))
        }
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
          className="ml-auto shrink-0"
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
