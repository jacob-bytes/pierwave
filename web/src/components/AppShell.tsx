import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Server, LayoutDashboard, LogOut } from "lucide-react";
import { api, type SessionUser } from "../lib/api";
import { cn } from "../lib/cn";

const nav = [
  { to: "/", label: "概览", icon: LayoutDashboard, end: true },
  { to: "/servers", label: "服务器", icon: Server, end: false },
];

export default function AppShell({ user }: { user: SessionUser }) {
  const navigate = useNavigate();
  const qc = useQueryClient();

  async function logout() {
    await api.logout();
    qc.clear();
    navigate("/login");
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r border-white/10 bg-[var(--color-surface)]">
        <div className="px-4 py-5 text-sm font-semibold tracking-wide">mmrust</div>
        <nav className="flex-1 space-y-1 px-2">
          {nav.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm text-white/70 transition",
                  isActive ? "bg-white/10 text-white" : "hover:bg-white/5 hover:text-white",
                )
              }
            >
              <Icon size={16} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-white/10 p-3 text-xs text-white/50">
          <div className="mb-2 truncate">
            {user.username} · {user.role}
          </div>
          <button
            onClick={logout}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-white/5 hover:text-white"
          >
            <LogOut size={14} /> 退出
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
