import { Suspense, useState } from "react";
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import {
  CheckIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  KeyRoundIcon,
  LanguagesIcon,
  LayoutDashboardIcon,
  Link2Icon,
  Loader2Icon,
  LogOutIcon,
  MenuIcon,
  MonitorIcon,
  MoonIcon,
  NetworkIcon,
  PackageIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  RefreshCwIcon,
  ScrollTextIcon,
  ServerIcon,
  SettingsIcon,
  SunIcon,
  SunMoonIcon,
  TerminalIcon,
  UserRoundIcon,
  UsersIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ChangePasswordDialog } from "@/components/settings/ChangePasswordDialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDocumentTitle, useI18n } from "@/i18n";
import type { SessionUser } from "@/lib/api";
import { resolveLogsTab } from "@/lib/logsTabs";
import {
  DEFAULT_SETTINGS_TAB,
  resolveSettingsTab,
} from "@/lib/settingsTabs";
import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/useTheme";
import type { ThemeMode } from "@/lib/theme";
import { useHealth, useLogout, usePanelName } from "@/lib/queries";

type NavItem = {
  to: string;
  /** 词典键；具体文案在渲染时由 `t()` 取，切换语言即生效。 */
  labelKey: string;
  icon: LucideIcon;
  end?: boolean;
  sub?: boolean;
  /** 多入口页面（例如 /servers/:id/nodes）需要自定义点亮规则。 */
  activeWhen?: (pathname: string) => boolean;
};

type NavGroup = {
  titleKey: string;
  items: NavItem[];
};

const consoleNav: NavItem[] = [
  { to: "/", labelKey: "nav.overview", icon: LayoutDashboardIcon, end: true },
  {
    to: "/servers",
    labelKey: "nav.servers",
    icon: ServerIcon,
    // 出站与路由 / 端口转发挂在服务器下，面包屑仍归到「服务器」。
    activeWhen: (pathname) =>
      pathname === "/servers" ||
      /^\/servers\/[^/]+\/(?:outbounds|forwards)(?:\/|$)/.test(pathname),
  },
];

const managementNav: NavItem[] = [
  { to: "/users", labelKey: "nav.users", icon: UsersIcon },
  { to: "/subscriptions", labelKey: "nav.subscriptions", icon: Link2Icon },
  { to: "/packages", labelKey: "nav.packages", icon: PackageIcon },
  { to: "/chains", labelKey: "nav.chains", icon: WorkflowIcon },
];

const systemNav: NavItem[] = [
  {
    to: "/nodes",
    labelKey: "nav.nodes",
    icon: NetworkIcon,
    activeWhen: (pathname) =>
      pathname === "/nodes" ||
      /^\/servers\/[^/]+\/nodes(?:\/|$)/.test(pathname),
  },
  { to: "/logs", labelKey: "nav.logs", icon: ScrollTextIcon },
  { to: "/settings", labelKey: "nav.settings", icon: SettingsIcon },
];

/**
 * 普通用户侧栏只有「我的」一个入口：订阅、节点、流量、事件都在这一页里，
 * 不再拆二级导航（导流到同一页面的锚点没有信息量）。
 */
const userNav: NavItem[] = [
  {
    to: "/me",
    labelKey: "nav.me",
    icon: UserRoundIcon,
    end: true,
    activeWhen: (pathname) => pathname === "/me" || pathname.startsWith("/me/"),
  },
];

const adminNavGroups: NavGroup[] = [
  { titleKey: "nav.groups.console", items: consoleNav },
  { titleKey: "nav.groups.management", items: managementNav },
  { titleKey: "nav.groups.system", items: systemNav },
];

const userNavGroups: NavGroup[] = [
  { titleKey: "nav.groups.selfService", items: userNav },
];

function isItemActive(item: NavItem, pathname: string): boolean {
  if (item.activeWhen) return item.activeWhen(pathname);
  return item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
}

function PageLoading() {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
      <Loader2Icon className="icon-md animate-spin" />
      {t("app.loadingPage")}
    </div>
  );
}

function NavEntry({
  item,
  pathname,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  pathname: string;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const { t } = useI18n();
  const Icon = item.icon;
  const active = isItemActive(item, pathname);

  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      title={collapsed ? t(item.labelKey) : undefined}
      className={cn(
        "flex h-8 items-center gap-2 rounded-md px-2.5 text-[13px] transition-colors duration-150",
        item.sub && "ml-3 h-7 pl-2 text-xs",
        collapsed && "justify-center px-0",
        collapsed && item.sub && "ml-0",
        active
          ? "bg-sidebar-accent font-medium text-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
      )}
    >
      <Icon className={item.sub ? "icon-sm" : "icon-md"} />
      {collapsed ? <span className="sr-only">{t(item.labelKey)}</span> : t(item.labelKey)}
    </NavLink>
  );
}

function ThemeItem({
  mode,
  current,
  icon: Icon,
  label,
  onSelect,
}: {
  mode: ThemeMode;
  current: ThemeMode;
  icon: LucideIcon;
  label: string;
  onSelect: (mode: ThemeMode) => void;
}) {
  const selected = current === mode;
  return (
    <DropdownMenuItem onSelect={() => onSelect(mode)}>
      <Icon className="icon-sm" />
      <span className="flex-1">{label}</span>
      {selected ? <CheckIcon className="icon-sm text-primary" /> : null}
    </DropdownMenuItem>
  );
}

/**
 * 侧栏内容。桌面端固定展示；移动端放进 Sheet 抽屉，两者共用同一份
 * 导航结构，避免「手机上少一个入口」这种两套菜单漂移。
 */
function SidebarBody({
  collapsed,
  homePath,
  panelName,
  navGroups,
  pathname,
  versionLabel,
  onNavigate,
}: {
  collapsed: boolean;
  homePath: string;
  panelName: string;
  navGroups: NavGroup[];
  pathname: string;
  versionLabel: string;
  onNavigate?: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Link
        to={homePath}
        onClick={onNavigate}
        className={cn(
          "flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-border",
          collapsed ? "justify-center px-0" : "px-4",
        )}
        title={panelName}
      >
        <div className="grid size-6 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
          <TerminalIcon className="icon-sm" />
        </div>
        {collapsed ? null : (
          <span className="truncate text-sm font-semibold tracking-wide">
            {panelName}
          </span>
        )}
      </Link>

      <nav className="flex-1 overflow-y-auto p-3">
        {navGroups.map((group, index) => (
          <div key={group.titleKey}>
            {collapsed ? (
              index > 0 ? (
                <div className="mx-2 my-2 h-px bg-sidebar-border" />
              ) : null
            ) : (
              <p
                className={cn(
                  "px-2.5 pb-1.5 text-[11.5px] leading-[1.35] font-medium tracking-wider text-muted-foreground",
                  index > 0 && "pt-5",
                )}
              >
                {t(group.titleKey)}
              </p>
            )}
            <div className="space-y-0.5">
              {group.items.map((item) => (
                <NavEntry
                  key={item.to}
                  item={item}
                  pathname={pathname}
                  collapsed={collapsed}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div
        className={cn(
          "border-t border-sidebar-border py-3",
          collapsed ? "text-center" : "px-4",
        )}
      >
        <p
          className="font-mono text-micro text-muted-foreground"
          title={`PierWave ${versionLabel}`}
        >
          {collapsed ? versionLabel : `PierWave ${versionLabel}`}
        </p>
      </div>
    </div>
  );
}

const SIDEBAR_KEY = "pierwave.sidebar";

export default function AppShell({ user }: { user: SessionUser }) {
  const { t, locale, setLocale } = useI18n();
  // 侧栏折叠状态跟着浏览器走：侧栏是导航结构，不是每次访问都要重新决定的偏好。
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(SIDEBAR_KEY) === "collapsed",
  );
  function toggleSidebar() {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(SIDEBAR_KEY, next ? "collapsed" : "expanded");
      return next;
    });
  }
  const { theme, setTheme } = useTheme();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const logout = useLogout();
  const health = useHealth();
  const panelName = usePanelName();
  const queryClient = useQueryClient();
  const fetching = useIsFetching() > 0;
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const navGroups = user.role === "admin" ? adminNavGroups : userNavGroups;
  const homePath = user.role === "admin" ? "/" : "/me";
  const allNav = navGroups.flatMap((group) => group.items);
  // 管理员侧栏不加入口，但 `/me` 仍然可访问；面包屑不能因此回落到「概览」。
  const current =
    pathname === "/me"
      ? { to: "/me", labelKey: "nav.me", icon: UserRoundIcon }
      : (allNav.find((item) => isItemActive(item, pathname)) ?? allNav[0]);
  const pageLabel = current ? t(current.labelKey) : t("app.defaultPage");
  // `/logs` 的 tab 决定面包屑第二级：日志 › 系统事件 / 操作审计。
  const logsTab =
    pathname === "/logs"
      ? resolveLogsTab(new URLSearchParams(search).get("tab"))
      : null;
  // `/settings` 同理：规则模板 / 证书等非默认 tab 也进面包屑。
  const settingsTab =
    pathname === "/settings"
      ? resolveSettingsTab(new URLSearchParams(search).get("tab"))
      : null;
  const pageSubLabel = logsTab
    ? t(`logs.tabs.${logsTab}`)
    : settingsTab && settingsTab !== DEFAULT_SETTINGS_TAB
      ? t(`settings.tabs.${settingsTab}`)
      : null;
  const roleText = user.role === "admin" ? t("roles.admin") : t("roles.user");
  const rawVersion = health.data?.version?.trim();
  const versionLabel = rawVersion
    ? rawVersion.toLowerCase().startsWith("v")
      ? rawVersion
      : `v${rawVersion}`
    : "v—";

  const titleLabel = pageSubLabel
    ? `${pageLabel} · ${pageSubLabel}`
    : pageLabel;
  useDocumentTitle(`${titleLabel} · ${panelName}`);

  const initial = user.username.slice(0, 1).toUpperCase();

  async function handleLogout() {
    try {
      await logout.mutateAsync();
    } catch {
      // 网络失败时 useLogout 仍会清空本地缓存，照常回登录页。
    }
    navigate("/login", { replace: true });
  }

  function refreshActiveQueries() {
    void queryClient.refetchQueries({ type: "active" });
  }

  return (
    <div className="flex h-full bg-background text-foreground">
      <aside
        className={cn(
          // 侧栏跟页面底同色，内容区再抬一档（bg-card/40），形成「深 → 浅」两层。
          "hidden shrink-0 flex-col border-r border-sidebar-border bg-background transition-[width] duration-200 md:flex",
          collapsed ? "w-14" : "w-60",
        )}
      >
        <SidebarBody
          collapsed={collapsed}
          homePath={homePath}
          panelName={panelName}
          navGroups={navGroups}
          pathname={pathname}
          versionLabel={versionLabel}
        />
      </aside>

      {/* 移动端导航：与桌面侧栏共用 SidebarBody，点条目后自动收起抽屉。 */}
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent
          side="left"
          className="w-64 gap-0 bg-background p-0"
          showCloseButton={false}
        >
          <SheetTitle className="sr-only">{panelName}</SheetTitle>
          <SidebarBody
            collapsed={false}
            homePath={homePath}
            panelName={panelName}
            navGroups={navGroups}
            pathname={pathname}
            versionLabel={versionLabel}
            onNavigate={() => setMobileNavOpen(false)}
          />
          {/* 触屏没有 Escape，也不一定知道点遮罩能关：给一个显式关闭按钮。 */}
          <div className="shrink-0 border-t border-sidebar-border p-3">
            <Button
              variant="ghost"
              className="w-full justify-start"
              onClick={() => setMobileNavOpen(false)}
            >
              <XIcon className="icon-md" />
              {t("common.close")}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-card/40">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 sm:px-6">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setMobileNavOpen(true)}
            aria-label={t("app.openNavigation")}
            title={t("app.openNavigation")}
            className="md:hidden"
          >
            <MenuIcon className="icon-md" />
          </Button>
          {/* 折叠按钮 + 竖线分隔：按钮贴着侧栏，面包屑与导航结构分属两块 */}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleSidebar}
            aria-label={
              collapsed ? t("app.expandSidebar") : t("app.collapseSidebar")
            }
            aria-expanded={!collapsed}
            title={collapsed ? t("app.expandSidebar") : t("app.collapseSidebar")}
            className="hidden md:inline-flex"
          >
            {collapsed ? (
              <PanelLeftOpenIcon className="icon-md" />
            ) : (
              <PanelLeftCloseIcon className="icon-md" />
            )}
          </Button>
          <span
            aria-hidden
            className="hidden h-4 w-px shrink-0 bg-border md:block"
          />

          <nav
            aria-label={t("app.breadcrumb")}
            className="hidden min-w-0 items-center gap-1.5 text-sm sm:flex"
          >
            <Link
              to={homePath}
              className="shrink-0 text-muted-foreground transition-colors duration-150 hover:text-foreground"
            >
              {panelName}
            </Link>
            <ChevronRightIcon className="icon-sm shrink-0 text-muted-foreground" />
            <span
              className="truncate font-medium"
              aria-current={pageSubLabel ? undefined : "page"}
            >
              {pageLabel}
            </span>
            {pageSubLabel ? (
              <>
                <ChevronRightIcon className="icon-sm shrink-0 text-muted-foreground" />
                <span
                  className="truncate text-muted-foreground"
                  aria-current="page"
                >
                  {pageSubLabel}
                </span>
              </>
            ) : null}
          </nav>

          {/* 手机上面包屑折叠成当前页标题，避免与刷新/账号按钮抢宽度。 */}
          <span className="min-w-0 truncate text-sm font-medium sm:hidden">
            {pageLabel}
          </span>

          {/* 中间留空，把页面动作与账号菜单推到最右侧。 */}
          <div className="flex-1" />

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={refreshActiveQueries}
            disabled={fetching}
            title={t("common.refresh")}
            aria-label={t("common.refresh")}
          >
            <RefreshCwIcon
              className={cn("icon-md", fetching && "animate-spin")}
            />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className="gap-2 px-1.5 font-normal"
                aria-label={t("app.accountMenu", { username: user.username })}
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/15 text-micro font-medium text-primary">
                  {initial}
                </span>
                <span className="hidden max-w-32 truncate text-[13px] font-medium sm:inline">
                  {user.username}
                </span>
                <ChevronsUpDownIcon className="hidden icon-sm shrink-0 text-muted-foreground sm:inline" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="end" className="w-56">
              <DropdownMenuLabel className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-foreground">
                  {user.username}
                </span>
                <span className="text-micro font-normal text-muted-foreground">
                  {roleText}
                </span>
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setPasswordOpen(true)}>
                <KeyRoundIcon className="icon-sm" />
                {t("userMenu.changePassword")}
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <LanguagesIcon className="icon-sm" />
                  {t("userMenu.language")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem onSelect={() => setLocale("zh-CN")}>
                    <span className="flex-1">{t("userMenu.chinese")}</span>
                    {locale === "zh-CN" ? (
                      <CheckIcon className="icon-sm text-primary" />
                    ) : null}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setLocale("en")}>
                    <span className="flex-1">{t("userMenu.english")}</span>
                    {locale === "en" ? (
                      <CheckIcon className="icon-sm text-primary" />
                    ) : null}
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <SunMoonIcon className="icon-sm" />
                  {t("userMenu.theme")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <ThemeItem
                    mode="light"
                    current={theme}
                    icon={SunIcon}
                    label={t("userMenu.themeLight")}
                    onSelect={setTheme}
                  />
                  <ThemeItem
                    mode="dark"
                    current={theme}
                    icon={MoonIcon}
                    label={t("userMenu.themeDark")}
                    onSelect={setTheme}
                  />
                  <ThemeItem
                    mode="system"
                    current={theme}
                    icon={MonitorIcon}
                    label={t("userMenu.themeSystem")}
                    onSelect={setTheme}
                  />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={logout.isPending}
                onSelect={() => void handleLogout()}
              >
                <LogOutIcon className="icon-sm" />
                {t("userMenu.logout")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto p-6">
          {/*
            每个路由一个独立边界：渲染异常只影响当前页，切换路径时
            通过 key 重新挂载，上一页的错误状态不会残留。
          */}
          <ErrorBoundary key={pathname} homePath={homePath}>
            <Suspense fallback={<PageLoading />}>
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>

      <ChangePasswordDialog
        open={passwordOpen}
        onOpenChange={setPasswordOpen}
      />
    </div>
  );
}
