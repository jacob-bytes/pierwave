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
  FileKeyIcon,
  HistoryIcon,
  KeyRoundIcon,
  LanguagesIcon,
  LayoutDashboardIcon,
  Link2Icon,
  ListFilterIcon,
  Loader2Icon,
  LogOutIcon,
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
} from "lucide-react";
import { ChangePasswordDialog } from "@/components/settings/ChangePasswordDialog";
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
  { to: "/events", labelKey: "nav.events", icon: HistoryIcon },
  { to: "/audit", labelKey: "nav.audit", icon: ScrollTextIcon },
  { to: "/rules", labelKey: "nav.rules", icon: ListFilterIcon },
  { to: "/certificates", labelKey: "nav.certificates", icon: FileKeyIcon },
  { to: "/settings", labelKey: "nav.settings", icon: SettingsIcon },
];

/** 普通用户只有两个入口：概览式「我的」和订阅锚点。 */
const userNav: NavItem[] = [
  {
    to: "/me",
    labelKey: "nav.me",
    icon: UserRoundIcon,
    end: true,
    activeWhen: (pathname) => pathname === "/me",
  },
  {
    to: "/me/subscription",
    labelKey: "nav.subscriptions",
    icon: Link2Icon,
    activeWhen: (pathname) => pathname.startsWith("/me/subscription"),
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
      <Loader2Icon className="size-4 animate-spin" />
      {t("app.loadingPage")}
    </div>
  );
}

function NavEntry({
  item,
  pathname,
  collapsed,
}: {
  item: NavItem;
  pathname: string;
  collapsed: boolean;
}) {
  const { t } = useI18n();
  const Icon = item.icon;
  const active = isItemActive(item, pathname);

  return (
    <NavLink
      to={item.to}
      end={item.end}
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
      <Icon className={item.sub ? "size-3.5" : "size-4"} />
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
      <Icon className="size-3.5" />
      <span className="flex-1">{label}</span>
      {selected ? <CheckIcon className="size-3.5 text-primary" /> : null}
    </DropdownMenuItem>
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
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const logout = useLogout();
  const health = useHealth();
  const panelName = usePanelName();
  const queryClient = useQueryClient();
  const fetching = useIsFetching() > 0;
  const [passwordOpen, setPasswordOpen] = useState(false);

  const navGroups = user.role === "admin" ? adminNavGroups : userNavGroups;
  const homePath = user.role === "admin" ? "/" : "/me";
  const allNav = navGroups.flatMap((group) => group.items);
  const current =
    allNav.find((item) => isItemActive(item, pathname)) ?? allNav[0];
  const pageLabel = current ? t(current.labelKey) : t("app.defaultPage");
  const roleText = user.role === "admin" ? t("roles.admin") : t("roles.user");
  const rawVersion = health.data?.version?.trim();
  const versionLabel = rawVersion
    ? rawVersion.toLowerCase().startsWith("v")
      ? rawVersion
      : `v${rawVersion}`
    : "v—";

  useDocumentTitle(`${pageLabel} · ${panelName}`);

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
          "flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200",
          collapsed ? "w-14" : "w-60",
        )}
      >
        <Link
          to={homePath}
          className={cn(
            "flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-border",
            collapsed ? "justify-center px-0" : "px-4",
          )}
          title={panelName}
        >
          <div className="grid size-6 shrink-0 place-items-center rounded-md bg-primary/15 text-primary">
            <TerminalIcon className="size-3.5" />
          </div>
          {collapsed ? null : (
            <span className="truncate text-sm font-semibold tracking-wide">{panelName}</span>
          )}
        </Link>

        <nav className="flex-1 overflow-y-auto p-3">
          {navGroups.map((group, index) => (
            <div key={group.titleKey}>
              {collapsed ? (
                index > 0 ? <div className="mx-2 my-2 h-px bg-sidebar-border" /> : null
              ) : (
                <p
                  className={cn(
                    "px-2.5 pb-1.5 text-[11px] font-medium tracking-wider text-muted-foreground/50",
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
                  />
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* 侧边栏底部只保留版本号；账号入口已移到右上角 header。 */}
        <div
          className={cn(
            "border-t border-sidebar-border py-3",
            collapsed ? "text-center" : "px-4",
          )}
        >
          <p
            className="font-mono text-[11px] text-muted-foreground/60"
            title={`PierWave ${versionLabel}`}
          >
            {collapsed ? versionLabel : `PierWave ${versionLabel}`}
          </p>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background/80 px-6 backdrop-blur">
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
              <PanelLeftOpenIcon className="size-4" />
            ) : (
              <PanelLeftCloseIcon className="size-4" />
            )}
          </Button>
          <span
            aria-hidden
            className="hidden h-4 w-px shrink-0 bg-border md:block"
          />

          <nav
            aria-label={t("app.breadcrumb")}
            className="flex min-w-0 items-center gap-1.5 text-sm"
          >
            <Link
              to={homePath}
              className="shrink-0 text-muted-foreground transition-colors duration-150 hover:text-foreground"
            >
              {panelName}
            </Link>
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/40" />
            <span className="truncate font-medium" aria-current="page">
              {pageLabel}
            </span>
          </nav>

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
              className={cn("size-4", fetching && "animate-spin")}
            />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className="gap-2 px-1.5 font-normal"
                aria-label={t("app.accountMenu", { username: user.username })}
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
                  {initial}
                </span>
                <span className="hidden max-w-32 truncate text-[13px] font-medium sm:inline">
                  {user.username}
                </span>
                <ChevronsUpDownIcon className="hidden size-3.5 shrink-0 text-muted-foreground sm:inline" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="end" className="w-56">
              <DropdownMenuLabel className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-foreground">
                  {user.username}
                </span>
                <span className="text-[11px] font-normal text-muted-foreground">
                  {roleText}
                </span>
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setPasswordOpen(true)}>
                <KeyRoundIcon className="size-3.5" />
                {t("userMenu.changePassword")}
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <LanguagesIcon className="size-3.5" />
                  {t("userMenu.language")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem onSelect={() => setLocale("zh-CN")}>
                    <span className="flex-1">{t("userMenu.chinese")}</span>
                    {locale === "zh-CN" ? (
                      <CheckIcon className="size-3.5 text-primary" />
                    ) : null}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setLocale("en")}>
                    <span className="flex-1">{t("userMenu.english")}</span>
                    {locale === "en" ? (
                      <CheckIcon className="size-3.5 text-primary" />
                    ) : null}
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <SunMoonIcon className="size-3.5" />
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
                <LogOutIcon className="size-3.5" />
                {t("userMenu.logout")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto p-6">
          <Suspense fallback={<PageLoading />}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      <ChangePasswordDialog
        open={passwordOpen}
        onOpenChange={setPasswordOpen}
      />
    </div>
  );
}
