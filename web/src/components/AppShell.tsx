import { Suspense, useEffect, useState } from "react";
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
} from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import {
  ChevronRightIcon,
  ChevronsUpDownIcon,
  FileKeyIcon,
  HistoryIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  Link2Icon,
  Loader2Icon,
  LogOutIcon,
  NetworkIcon,
  PackageIcon,
  ServerIcon,
  SettingsIcon,
  TerminalIcon,
  UserRoundIcon,
  UsersIcon,
} from "lucide-react";
import { ChangePasswordDialog } from "@/components/settings/ChangePasswordDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { SessionUser } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useHealth, useLogout, usePanelName } from "@/lib/queries";

type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  sub?: boolean;
  /** 多入口页面（例如 /servers/:id/nodes）需要自定义点亮规则。 */
  activeWhen?: (pathname: string) => boolean;
};

type NavGroup = {
  title: string;
  items: NavItem[];
};

const consoleNav: NavItem[] = [
  { to: "/", label: "概览", icon: LayoutDashboardIcon, end: true },
  {
    to: "/servers",
    label: "服务器",
    icon: ServerIcon,
    activeWhen: (pathname) => pathname === "/servers",
  },
];

const managementNav: NavItem[] = [
  { to: "/users", label: "用户", icon: UsersIcon },
  { to: "/subscriptions", label: "订阅", icon: Link2Icon },
  { to: "/packages", label: "套餐", icon: PackageIcon },
];

const systemNav: NavItem[] = [
  {
    to: "/nodes",
    label: "节点",
    icon: NetworkIcon,
    activeWhen: (pathname) =>
      pathname === "/nodes" ||
      /^\/servers\/[^/]+\/nodes(?:\/|$)/.test(pathname),
  },
  { to: "/events", label: "事件", icon: HistoryIcon },
  { to: "/certificates", label: "证书", icon: FileKeyIcon },
  { to: "/settings", label: "设置", icon: SettingsIcon },
];

/** 普通用户只有两个入口：概览式「我的」和订阅锚点。 */
const userNav: NavItem[] = [
  {
    to: "/me",
    label: "我的",
    icon: UserRoundIcon,
    end: true,
    activeWhen: (pathname) => pathname === "/me",
  },
  {
    to: "/me/subscription",
    label: "订阅",
    icon: Link2Icon,
    activeWhen: (pathname) => pathname.startsWith("/me/subscription"),
  },
];

const adminNavGroups: NavGroup[] = [
  { title: "控制台", items: consoleNav },
  { title: "管理", items: managementNav },
  { title: "系统", items: systemNav },
];

const userNavGroups: NavGroup[] = [{ title: "自助", items: userNav }];

function roleLabel(role: SessionUser["role"]) {
  return role === "admin" ? "管理员" : "普通用户";
}

function isItemActive(item: NavItem, pathname: string): boolean {
  if (item.activeWhen) return item.activeWhen(pathname);
  return item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
}

function PageLoading() {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
      <Loader2Icon className="size-4 animate-spin" />
      正在加载页面…
    </div>
  );
}

function NavEntry({
  item,
  pathname,
}: {
  item: NavItem;
  pathname: string;
}) {
  const Icon = item.icon;
  const active = isItemActive(item, pathname);

  return (
    <NavLink
      to={item.to}
      end={item.end}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-8 items-center gap-2 rounded-md px-2.5 text-[13px] transition-colors duration-150",
        item.sub && "ml-3 h-7 pl-2 text-xs",
        active
          ? "bg-sidebar-accent font-medium text-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
      )}
    >
      <Icon className={item.sub ? "size-3.5" : "size-4"} />
      {item.label}
    </NavLink>
  );
}

export default function AppShell({ user }: { user: SessionUser }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const logout = useLogout();
  const health = useHealth();
  const version = health.data?.version ?? "dev";
  const [passwordOpen, setPasswordOpen] = useState(false);

  const navGroups = user.role === "admin" ? adminNavGroups : userNavGroups;
  const homePath = user.role === "admin" ? "/" : "/me";
  const allNav = navGroups.flatMap((group) => group.items);
  const current =
    allNav.find((item) => isItemActive(item, pathname)) ?? allNav[0];
  const pageLabel = current?.label ?? "概览";
  const panelName = usePanelName();

  useEffect(() => {
    document.title = `${pageLabel} · ${panelName}`;
  }, [pageLabel, panelName]);

  const initial = user.username.slice(0, 1).toUpperCase();

  async function handleLogout() {
    try {
      await logout.mutateAsync();
    } catch {
      // 网络失败时 useLogout 仍会清空本地缓存，照常回登录页。
    }
    navigate("/login", { replace: true });
  }

  return (
    <div className="flex h-full bg-background text-foreground">
      <aside className="flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
        <Link
          to={homePath}
          className="flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-border px-4"
        >
          <div className="grid size-6 place-items-center rounded-md bg-primary/15 text-primary">
            <TerminalIcon className="size-3.5" />
          </div>
          <span className="text-sm font-semibold tracking-wide">{panelName}</span>
        </Link>

        <nav className="flex-1 overflow-y-auto p-3">
          {navGroups.map((group, index) => (
            <div key={group.title}>
              <p
                className={cn(
                  "px-2.5 pb-1.5 text-[11px] font-medium tracking-wider text-muted-foreground/50",
                  index > 0 && "pt-5",
                )}
              >
                {group.title}
              </p>
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <NavEntry key={item.to} item={item} pathname={pathname} />
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t border-sidebar-border p-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className="h-auto w-full justify-start gap-2.5 px-2 py-1.5 font-normal"
                aria-label={`${user.username} 的账号菜单`}
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
                  {initial}
                </span>
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-[13px] font-medium">
                    {user.username}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {roleLabel(user.role)}
                  </span>
                </span>
                <ChevronsUpDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-56">
              <DropdownMenuLabel>{user.username}</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setPasswordOpen(true)}>
                <KeyRoundIcon className="size-3.5" />
                修改密码
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={logout.isPending}
                onSelect={() => void handleLogout()}
              >
                <LogOutIcon className="size-3.5" />
                退出登录
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-background/80 px-6 backdrop-blur">
          <nav
            aria-label="面包屑"
            className="flex min-w-0 items-center gap-1.5 text-sm"
          >
            <Link
              to={homePath}
              className="shrink-0 text-muted-foreground transition-colors duration-150 hover:text-foreground"
            >
              pierwave
            </Link>
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/40" />
            <span className="truncate font-medium" aria-current="page">
              {pageLabel}
            </span>
          </nav>
          <Badge
            variant="outline"
            className="hidden font-normal text-muted-foreground sm:inline-flex"
          >
            {roleLabel(user.role)}
          </Badge>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto p-6">
          <Suspense fallback={<PageLoading />}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      <div className="pointer-events-none fixed right-4 bottom-3 z-20 font-mono text-[11px] text-muted-foreground/50">
        {version === "dev" ? "dev" : `v${version}`}
      </div>

      <ChangePasswordDialog
        open={passwordOpen}
        onOpenChange={setPasswordOpen}
      />
    </div>
  );
}
