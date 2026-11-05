import { Suspense, useEffect } from "react";
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
  LayoutDashboardIcon,
  Loader2Icon,
  LogOutIcon,
  NetworkIcon,
  PackageIcon,
  ServerIcon,
  SettingsIcon,
  TerminalIcon,
  UsersIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { SessionUser } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useHealth, useLogout } from "@/lib/queries";

type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  disabled?: boolean;
  sub?: boolean;
};

const consoleNav: NavItem[] = [
  { to: "/", label: "概览", icon: LayoutDashboardIcon, end: true },
  { to: "/servers", label: "服务器", icon: ServerIcon },
];

const managementNav: NavItem[] = [
  { to: "/users", label: "用户", icon: UsersIcon },
  { to: "/packages", label: "套餐", icon: PackageIcon, sub: true },
];

const systemNav: NavItem[] = [
  { to: "/nodes", label: "节点", icon: NetworkIcon, disabled: true },
  { to: "/settings", label: "设置", icon: SettingsIcon, disabled: true },
];

const allNav = [...consoleNav, ...managementNav, ...systemNav];

function roleLabel(role: SessionUser["role"]) {
  return role === "admin" ? "管理员" : "普通用户";
}

function PageLoading() {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
      <Loader2Icon className="size-4 animate-spin" />
      正在加载页面…
    </div>
  );
}

function NavEntry({ item }: { item: NavItem }) {
  const Icon = item.icon;

  if (item.disabled) {
    return (
      <span title="待实现" className="block">
        <Button
          variant="ghost"
          size="default"
          disabled
          className="w-full justify-start gap-2 px-2.5 font-normal text-muted-foreground/40"
        >
          <Icon className="size-4" />
          {item.label}
        </Button>
      </span>
    );
  }

  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) =>
        cn(
          "flex h-8 items-center gap-2 rounded-md px-2.5 text-[13px] transition-colors duration-150",
          item.sub && "ml-3 h-7 pl-2 text-xs",
          isActive
            ? "bg-sidebar-accent font-medium text-foreground"
            : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
        )
      }
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

  const current =
    allNav.find((item) =>
      item.to === "/" ? pathname === "/" : pathname.startsWith(item.to),
    ) ?? allNav[0];
  const pageLabel = current?.label ?? "概览";

  useEffect(() => {
    document.title = `${pageLabel} · mmrust`;
  }, [pageLabel]);

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
          to="/"
          className="flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-border px-4"
        >
          <div className="grid size-6 place-items-center rounded-md bg-primary/15 text-primary">
            <TerminalIcon className="size-3.5" />
          </div>
          <span className="text-sm font-semibold tracking-wide">mmrust</span>
        </Link>

        <nav className="flex-1 overflow-y-auto p-3">
          <p className="px-2.5 pb-1.5 text-[11px] font-medium tracking-wider text-muted-foreground/50">
            控制台
          </p>
          <div className="space-y-0.5">
            {consoleNav.map((item) => (
              <NavEntry key={item.to} item={item} />
            ))}
          </div>

          <p className="px-2.5 pt-5 pb-1.5 text-[11px] font-medium tracking-wider text-muted-foreground/50">
            管理
          </p>
          <div className="space-y-0.5">
            {managementNav.map((item) => (
              <NavEntry key={item.to} item={item} />
            ))}
          </div>

          <p className="px-2.5 pt-5 pb-1.5 text-[11px] font-medium tracking-wider text-muted-foreground/50">
            系统
          </p>
          <div className="space-y-0.5">
            {systemNav.map((item) => (
              <NavEntry key={item.to} item={item} />
            ))}
          </div>
        </nav>

        <div className="border-t border-sidebar-border p-3">
          <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
            <div className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
              {initial}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium">
                {user.username}
              </div>
              <div className="truncate text-[11px] text-muted-foreground">
                {roleLabel(user.role)}
              </div>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="退出登录"
                  onClick={handleLogout}
                  disabled={logout.isPending}
                >
                  {logout.isPending ? (
                    <Loader2Icon className="animate-spin" />
                  ) : (
                    <LogOutIcon />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>退出登录</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-background/80 px-6 backdrop-blur">
          <nav
            aria-label="面包屑"
            className="flex min-w-0 items-center gap-1.5 text-sm"
          >
            <Link
              to="/"
              className="shrink-0 text-muted-foreground transition-colors duration-150 hover:text-foreground"
            >
              mmrust
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
    </div>
  );
}
