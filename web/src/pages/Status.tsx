import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ActivityIcon,
  ArrowRightIcon,
  LayoutDashboardIcon,
  ListFilterIcon,
  MoonIcon,
  ServerOffIcon,
  ShieldIcon,
  SunIcon,
} from "lucide-react";
import { EmptyState, ListError } from "@/components/common";
import { ServerCard } from "@/components/status/ServerCard";
import { ServerTable } from "@/components/status/ServerTable";
import {
  PAGE_CONTAINER,
  StatusSkeleton,
} from "@/components/status/StatusSkeleton";
import { Hero } from "@/components/status/Hero";
import { Toolbar } from "@/components/status/Toolbar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useDocumentTitle, useI18n } from "@/i18n";
import type { PublicStatus } from "@/lib/api";
import { errorText, isNotFound } from "@/lib/errors";
import {
  DEFAULT_STATUS_VIEW,
  filterPublicServers,
  isStatusStale,
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
 * 版式对照本机 `miniprobe/monitor-theme-default`：页头、一句结论与三个大数字的
 * 总结区、工具栏、卡片网格 / 列表视图，以及卡片内的 24 格可用率条。数据严格按
 * `GET /api/v1/public/status` 的白名单渲染 —— 公开 API 没有的丢包、
 * 运营商、单机流量和历史事件，这里一律不画。
 */

/** 页头右侧的实时状态点：数据新鲜是主色，过期转 muted，断线仍用警告色。 */
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
  // 2 分钟没有新数据就不再算“实时”，点与文字一起转 muted；轮询失败则是另一回事，
  // 仍然用警告色把「连接断了」和「数据旧了」分开。
  const stale = data !== undefined && isStatusStale(now, data.generated_at);
  const warn = isError;
  const calm = data !== undefined && !warn && !stale;
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
      title={warn || stale ? label : t("publicStatus.autoRefreshHint")}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          warn ? "bg-warning" : stale ? "bg-muted-foreground" : "bg-primary",
          calm && "status-breathe",
        )}
      />
      {/* 手机上页头放不下整句，圆点才是承载状态的部分；文字留在无障碍树里。 */}
      <span className="max-sm:sr-only">{label}</span>
    </span>
  );
}

function StatusHeader({
  data,
  isError,
}: {
  data: PublicStatus | undefined;
  isError: boolean;
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
        {/* 品牌区：logo 与两行文字等高，文字块靠行高撑满，两行之间只留 2px。 */}
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground">
            <ActivityIcon className="icon-lg" aria-hidden="true" />
          </span>
          <div className="flex min-w-0 flex-col">
            <h1 className="truncate text-base leading-tight font-semibold tracking-tight">
              {panelName}
            </h1>
            <p className="mt-0.5 truncate text-xs leading-tight text-muted-foreground">
              {t("publicStatus.tagline")}
            </p>
          </div>
        </div>

        <div className="flex-1" />

        {/* 顺序按参考实现：更新时间在最左，然后「进入后台」，主题切换最右。
            页面每 30 秒自己刷新，页头不再放刷新按钮。 */}
        <LiveStatus data={data} isError={isError} />

        <Button variant="ghost" asChild>
          <Link to="/login">
            <LayoutDashboardIcon className="icon-md" aria-hidden="true" />
            {t("publicStatus.header.admin")}
          </Link>
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
      <Hero summary={data.summary} servers={data.servers} />

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
      <StatusHeader data={status.data} isError={status.isError} />

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
