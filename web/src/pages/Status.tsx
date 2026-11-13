import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ActivityIcon,
  ArrowRightIcon,
  LayoutDashboardIcon,
  ListFilterIcon,
  MoonIcon,
  RefreshCwIcon,
  ServerOffIcon,
  ShieldIcon,
  SunIcon,
} from "lucide-react";
import { EmptyState, ListError, SkeletonLine } from "@/components/common";
import { ServerCard } from "@/components/status/ServerCard";
import { ServerTable } from "@/components/status/ServerTable";
import { Summary } from "@/components/status/Summary";
import { Toolbar } from "@/components/status/Toolbar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDocumentTitle, useI18n } from "@/i18n";
import type { PublicStatus } from "@/lib/api";
import { errorText, isNotFound } from "@/lib/errors";
import {
  DEFAULT_STATUS_VIEW,
  filterPublicServers,
  loadStatusView,
  matchesGroupFilter,
  matchesServerQuery,
  persistStatusView,
  publicServerCounts,
  statusGroupTabs,
  type StatusFilter,
  type StatusGroupFilter,
  type StatusView,
} from "@/lib/publicStatus";
import { usePublicStatus } from "@/lib/queries";
import { formatClockTime } from "@/lib/time";
import { useTheme } from "@/lib/useTheme";
import { cn } from "@/lib/utils";

/**
 * 探针公开页 `/status`。
 *
 * 版式对照本机 `miniprobe/monitor-theme-default`：页头、四个汇总块、
 * 工具栏、卡片网格 / 列表视图，以及卡片内的 24 格可用率条。数据严格按
 * `GET /api/v1/public/status` 的白名单渲染 —— 公开 API 没有的丢包、
 * 运营商、单机流量和历史事件，这里一律不画。
 */

/**
 * 页头与内容共用一条容器：同样的最大宽度和左右内边距，
 * 保证页头左边缘和下方卡片左边缘始终对齐。
 */
const PAGE_CONTAINER = "mx-auto w-full max-w-[1400px] px-4 sm:px-6";

/** 页头右侧的实时状态点：有数据是主色，断线或数据过期转警告色。 */
function LiveStatus({
  data,
  isError,
}: {
  data: PublicStatus | undefined;
  isError: boolean;
}) {
  const { t } = useI18n();
  // 每 15 秒刷新一次“现在”，让「数据是否已经过期」自己会变；
  // 不在 render 里直接读 Date.now()，组件保持纯函数。
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = window.setInterval(tick, 15_000);
    return () => window.clearInterval(id);
  }, []);

  const time = data ? formatClockTime(data.generated_at) : null;
  // 30 秒轮询 × 3：90 秒还没有新数据，说明页面上的数字已经不能当“实时”看。
  const stale =
    now > 0 &&
    data !== undefined &&
    now / 1_000 - data.generated_at > 90;
  const warn = isError || stale;
  const label = isError
    ? t("publicStatus.header.disconnected")
    : time
      ? t("publicStatus.updatedAt", { time })
      : t("publicStatus.header.connecting");

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap",
        warn ? "text-warning" : "text-muted-foreground",
      )}
      title={warn ? label : t("publicStatus.autoRefreshHint")}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          warn ? "bg-warning" : "bg-primary",
          !warn && "status-breathe",
        )}
      />
      <span className="max-sm:sr-only">{label}</span>
    </span>
  );
}

function StatusHeader({
  data,
  isError,
  isFetching,
  onRefresh,
}: {
  data: PublicStatus | undefined;
  isError: boolean;
  isFetching: boolean;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const { resolvedTheme, setTheme } = useTheme();
  const panelName =
    data?.panel_name?.trim() || t("publicStatus.headingFallback");
  const dark = resolvedTheme === "dark";
  const themeLabel = t("publicStatus.header.themeToggle");

  return (
    <header className="sticky top-0 z-10 border-b border-border bg-[color-mix(in_oklab,var(--card)_80%,var(--background))]">
      <div className={cn(PAGE_CONTAINER, "flex items-center gap-2 py-3 sm:gap-3")}>
        <div className="min-w-0">
          <h1 className="flex min-w-0 items-center gap-2 text-base leading-tight font-semibold tracking-tight">
            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
              <ActivityIcon className="icon-lg" aria-hidden="true" />
            </span>
            <span className="truncate">{panelName}</span>
          </h1>
          <p className="mt-0.5 truncate pl-9 text-xs text-muted-foreground">
            {t("publicStatus.tagline")}
          </p>
        </div>

        <div className="flex-1" />

        <LiveStatus data={data} isError={isError} />

        <Button
          type="button"
          variant="ghost"
          onClick={onRefresh}
          disabled={isFetching}
          title={t("publicStatus.refresh")}
        >
          <RefreshCwIcon
            className={cn("icon-md", isFetching && "animate-spin")}
            aria-hidden="true"
          />
          <span className="max-sm:sr-only">
            {isFetching
              ? t("publicStatus.refreshing")
              : t("publicStatus.refresh")}
          </span>
        </Button>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => setTheme(dark ? "light" : "dark")}
          title={themeLabel}
          aria-label={themeLabel}
        >
          {dark ? (
            <SunIcon className="icon-md" aria-hidden="true" />
          ) : (
            <MoonIcon className="icon-md" aria-hidden="true" />
          )}
        </Button>

        <Button variant="ghost" asChild>
          <Link to="/login">
            <LayoutDashboardIcon className="icon-md" aria-hidden="true" />
            <span className="max-sm:sr-only">
              {t("publicStatus.header.admin")}
            </span>
          </Link>
        </Button>
      </div>
    </header>
  );
}

/**
 * 空态统一进站内的 `EmptyState`，外面套一张与卡片同材质的底，
 * 让「无数据 / 无结果 / 已关闭」三种情况在页面上是同一层视觉。
 */
function StatePanel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("rounded-xl py-0", className)}>{children}</Card>
  );
}

/** 一个指标的骨架：标签 / 数值一行、4px 进度条、底部原始值。 */
function MeterSkeleton() {
  return (
    <div className="min-w-0" aria-hidden="true">
      <div className="flex items-baseline justify-between gap-2">
        <SkeletonLine className="h-3 w-12" />
        <SkeletonLine className="h-3 w-8" />
      </div>
      <Skeleton className="mt-2 h-1 w-full rounded-full" />
      <SkeletonLine className="mt-1.5 h-3 w-20" />
    </div>
  );
}

/**
 * 与 `ServerCard` 同构的骨架：标题行 + 副行 + 2×2 指标 + 底部可用率点阵。
 * 结构一致，加载结束换成真数据时不会整块跳动。
 */
function ServerCardSkeleton() {
  return (
    <Card
      aria-hidden="true"
      className="h-full min-w-0 gap-0 rounded-xl p-4 [--card-spacing:--spacing(4)]"
    >
      <div className="flex min-w-0 items-center gap-2">
        <SkeletonLine className="h-4 w-1/2" />
        <Skeleton className="ml-auto h-5 w-20 shrink-0 rounded-full" />
      </div>
      <SkeletonLine className="mt-1.5 h-3 w-3/5" />

      <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4">
        {Array.from({ length: 4 }, (_, index) => (
          <MeterSkeleton key={index} />
        ))}
      </div>

      <div className="mt-auto pt-4">
        <div className="mt-3 grid grid-cols-[repeat(24,minmax(0,1fr))] gap-0.5">
          {Array.from({ length: 24 }, (_, index) => (
            <Skeleton key={index} className="h-1.5 rounded-[2px]" />
          ))}
        </div>
        <div className="mt-2 flex items-baseline justify-between gap-2">
          <SkeletonLine className="h-3 w-16" />
          <SkeletonLine className="h-3 w-10" />
        </div>
      </div>
    </Card>
  );
}

/**
 * 首屏骨架：四个汇总块 + 工具栏 + 四张服务器卡片。
 *
 * 摘要块只占位高度；服务器卡片按真实卡片的结构铺骨架，
 * 手机上是一列、桌面最多四列，与真实网格一致。
 */
function StatusSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" aria-label={label}>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Card
            key={index}
            aria-hidden="true"
            className="h-[86px] gap-0 rounded-xl p-3 [--card-spacing:--spacing(3)]"
          >
            <SkeletonLine className="h-3 w-16" />
            <SkeletonLine className="mt-2 h-5 w-20" />
            <SkeletonLine className="mt-auto h-3 w-24" />
          </Card>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-2 px-1">
        <Skeleton className="h-8 w-64 rounded-md" />
        <div className="flex-1" />
        <Skeleton className="h-8 w-40 rounded-md sm:w-52" />
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <ServerCardSkeleton key={index} />
        ))}
      </div>
    </div>
  );
}

function StatusContent({ data }: { data: PublicStatus }) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [group, setGroup] = useState<StatusGroupFilter>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<StatusView>(() =>
    typeof window === "undefined"
      ? DEFAULT_STATUS_VIEW
      : loadStatusView(window.localStorage),
  );

  const changeView = (next: StatusView) => {
    setView(next);
    if (typeof window !== "undefined") {
      persistStatusView(window.localStorage, next);
    }
  };

  const clear = () => {
    setFilter("all");
    setGroup(null);
    setQuery("");
  };

  // 状态标签的计数跟着搜索与分组走，点下去才不会出现「写着 3、点开只剩 0」。
  const searched = data.servers.filter((server) =>
    matchesServerQuery(server, query),
  );
  const counts = publicServerCounts(
    searched.filter((server) => matchesGroupFilter(server, group)),
  );
  // 分组标签从全量服务器派生：计数是「该组服务器数」，不随搜索或状态标签缩水，
  // 激活中的分组也不会因为搜索命中 0 而消失。
  const groupTabs = statusGroupTabs(data.servers);
  const filtered = filterPublicServers(data.servers, filter, query, group);
  const narrowing =
    filter !== "all" || query.trim() !== "" || group !== null;

  return (
    <>
      <Summary
        summary={data.summary}
        servers={data.servers}
        filter={filter}
        onFilter={setFilter}
      />

      <h2 className="sr-only">{t("publicStatus.servers.title")}</h2>
      <div className="mt-4 space-y-4">
        {data.servers.length === 0 ? (
          <StatePanel>
            <EmptyState
              icon={ServerOffIcon}
              title={t("publicStatus.servers.emptyTitle")}
              description={t("publicStatus.servers.emptyDescription")}
            />
          </StatePanel>
        ) : (
          <>
            <Toolbar
              counts={counts}
              total={data.servers.length}
              filter={filter}
              onFilter={setFilter}
              groups={groupTabs}
              group={group}
              onGroup={setGroup}
              query={query}
              onQuery={setQuery}
              view={view}
              onView={changeView}
              narrowing={narrowing}
              shown={filtered.length}
              onClear={clear}
            />

            {filtered.length === 0 ? (
              <StatePanel>
                <EmptyState
                  icon={ListFilterIcon}
                  title={
                    group !== null
                      ? t("publicStatus.groups.emptyFilteredTitle")
                      : t("publicStatus.servers.emptyFilteredTitle")
                  }
                  description={
                    group === null
                      ? t("publicStatus.servers.emptyFilteredDescription")
                      : undefined
                  }
                  action={
                    <Button variant="outline" size="sm" onClick={clear}>
                      {t("publicStatus.toolbar.clearFilters")}
                    </Button>
                  }
                />
              </StatePanel>
            ) : view === "list" ? (
              <ServerTable servers={filtered} />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {filtered.map((server) => (
                  <ServerCard key={server.id} server={server} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

export default function StatusPage() {
  const { t } = useI18n();
  const status = usePublicStatus();
  const panelName =
    status.data?.panel_name?.trim() || t("publicStatus.headingFallback");
  useDocumentTitle(`${t("publicStatus.pageTitle")} · ${panelName}`);

  const disabled = status.isError && isNotFound(status.error);

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <StatusHeader
        data={status.data}
        isError={status.isError}
        isFetching={status.isFetching}
        onRefresh={() => void status.refetch()}
      />

      <main className={cn(PAGE_CONTAINER, "flex-1 py-4")}>
        {status.data ? (
          <>
            {status.isError ? (
              <p role="alert" className="mb-4 text-sm text-destructive">
                {errorText(
                  status.error,
                  t("publicStatus.error.description"),
                )}
              </p>
            ) : null}
            <StatusContent data={status.data} />
          </>
        ) : status.isPending ? (
          <StatusSkeleton label={t("publicStatus.loading")} />
        ) : disabled ? (
          <StatePanel>
            <EmptyState
              icon={ShieldIcon}
              title={t("publicStatus.disabled.title")}
              description={t("publicStatus.disabled.description")}
              action={
                <Button asChild variant="outline" size="sm">
                  <Link to="/login">
                    {t("publicStatus.header.admin")}
                    <ArrowRightIcon className="icon-sm" aria-hidden="true" />
                  </Link>
                </Button>
              }
            />
          </StatePanel>
        ) : (
          <StatePanel>
            <ListError
              title={t("publicStatus.error.title")}
              message={errorText(
                status.error,
                t("publicStatus.error.description"),
              )}
              retrying={status.isFetching}
              onRetry={() => void status.refetch()}
            />
          </StatePanel>
        )}
      </main>
    </div>
  );
}
