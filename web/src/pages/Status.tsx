import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import {
  ActivityIcon,
  ArrowRightIcon,
  LayoutDashboardIcon,
  MoonIcon,
  RefreshCwIcon,
  ServerOffIcon,
  ShieldIcon,
  SunIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { AvailabilityLegend } from "@/components/status/Availability";
import { GroupOverview } from "@/components/status/GroupOverview";
import { ServerCard } from "@/components/status/ServerCard";
import { ServerTable } from "@/components/status/ServerTable";
import { Summary } from "@/components/status/Summary";
import { Toolbar } from "@/components/status/Toolbar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDocumentTitle, useI18n } from "@/i18n";
import type { PublicStatus } from "@/lib/api";
import { errorText, isNotFound } from "@/lib/errors";
import {
  DEFAULT_STATUS_VIEW,
  filterPublicServers,
  loadStatusView,
  matchesServerQuery,
  persistStatusView,
  publicServerCounts,
  type StatusFilter,
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
      <div className="mx-auto flex max-w-[1400px] items-center gap-2 px-4 py-3 sm:gap-3 sm:px-6">
        <div className="min-w-0">
          <h1 className="flex min-w-0 items-center gap-2 text-base leading-tight font-semibold tracking-tight">
            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/15">
              <ActivityIcon className="icon-lg" aria-hidden="true" />
            </span>
            <span className="truncate">{panelName}</span>
          </h1>
          <p className="mt-0.5 hidden truncate text-xs text-muted-foreground sm:block">
            {t("publicStatus.subtitle")}
          </p>
        </div>

        <div className="flex-1" />

        <LiveStatus data={data} isError={isError} />

        <Button
          type="button"
          variant="ghost"
          size="sm"
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
          size="icon-sm"
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

        <Button variant="ghost" size="sm" asChild>
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

function NoticeCard({
  icon: Icon,
  iconClassName,
  title,
  description,
  children,
  className,
}: {
  icon: LucideIcon;
  iconClassName: string;
  title: string;
  description: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("rounded-xl", className)}>
      <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
        <div
          className={cn(
            "grid size-10 place-items-center rounded-full",
            iconClassName,
          )}
        >
          <Icon className="icon-lg" aria-hidden="true" />
        </div>
        <div>
          <p className="text-sm font-medium">{title}</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            {description}
          </p>
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

/** 骨架屏照参考项目的尺寸：四个 86px 汇总块 + 六张等高卡片。 */
function StatusSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" aria-label={label}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-[86px] rounded-xl" />
        ))}
      </div>
      <div className="mt-2.5 flex items-center gap-2 px-1">
        <Skeleton className="h-8 w-64 rounded-md" />
        <div className="flex-1" />
        <Skeleton className="h-8 w-40 rounded-md sm:w-52" />
      </div>
      <div className="mt-2.5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-[258px] rounded-xl" />
        ))}
      </div>
    </div>
  );
}

/** 当前筛选没有结果：与「一台服务器都没有」分开，这里给一条出路。 */
function FilterEmpty({ onClear }: { onClear: () => void }) {
  const { t } = useI18n();

  return (
    <div className="grid place-items-center rounded-xl border border-dashed border-border py-16 text-center">
      <p className="text-sm font-medium">
        {t("publicStatus.servers.emptyFilteredTitle")}
      </p>
      <p className="mt-1 max-w-sm text-xs text-muted-foreground">
        {t("publicStatus.servers.emptyFilteredDescription")}
      </p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onClear}>
        {t("publicStatus.toolbar.clearFilters")}
      </Button>
    </div>
  );
}

function StatusContent({ data }: { data: PublicStatus }) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<StatusFilter>("all");
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
    setQuery("");
  };

  // 标签上的计数跟着搜索走，点下去才不会出现「写着 3、点开只剩 0」。
  const searched = data.servers.filter((server) =>
    matchesServerQuery(server, query),
  );
  const counts = publicServerCounts(searched);
  const filtered = filterPublicServers(data.servers, filter, query);
  const narrowing = filter !== "all" || query.trim() !== "";

  return (
    <>
      <Summary
        summary={data.summary}
        servers={data.servers}
        filter={filter}
        onFilter={setFilter}
      />

      <GroupOverview groups={data.groups} />

      <h2 className="sr-only">{t("publicStatus.servers.title")}</h2>
      <div className="mt-2.5 space-y-2.5">
        {data.servers.length === 0 ? (
          <NoticeCard
            icon={ServerOffIcon}
            iconClassName="bg-muted text-muted-foreground"
            title={t("publicStatus.servers.emptyTitle")}
            description={t("publicStatus.servers.emptyDescription")}
            className="mt-6"
          />
        ) : (
          <>
            <Toolbar
              counts={counts}
              total={data.servers.length}
              filter={filter}
              onFilter={setFilter}
              query={query}
              onQuery={setQuery}
              view={view}
              onView={changeView}
              narrowing={narrowing}
              onClear={clear}
            />

            <AvailabilityLegend className="px-1" />

            {filtered.length === 0 ? (
              <FilterEmpty onClear={clear} />
            ) : view === "list" ? (
              <ServerTable servers={filtered} />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
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

      <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-4 sm:px-6">
        {status.data ? (
          <>
            {status.isError ? (
              <p role="alert" className="mb-3 text-sm text-destructive">
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
          <NoticeCard
            icon={ShieldIcon}
            iconClassName="bg-muted text-muted-foreground"
            title={t("publicStatus.disabled.title")}
            description={t("publicStatus.disabled.description")}
          >
            <Button asChild variant="outline" size="sm">
              <Link to="/login">
                {t("publicStatus.header.admin")}
                <ArrowRightIcon className="icon-md" aria-hidden="true" />
              </Link>
            </Button>
          </NoticeCard>
        ) : (
          <NoticeCard
            icon={TriangleAlertIcon}
            iconClassName="bg-destructive/10 text-destructive"
            title={t("publicStatus.error.title")}
            description={errorText(
              status.error,
              t("publicStatus.error.description"),
            )}
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void status.refetch()}
              disabled={status.isFetching}
            >
              <RefreshCwIcon
                className={cn(
                  "icon-md",
                  status.isFetching && "animate-spin",
                )}
                aria-hidden="true"
              />
              {t("publicStatus.error.retry")}
            </Button>
          </NoticeCard>
        )}
      </main>
    </div>
  );
}
