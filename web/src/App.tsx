import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Loader2Icon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import AppShell from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { isUnauthorized, useMe } from "@/lib/queries";
import { safeNextPath } from "@/lib/auth";
import { errorText } from "@/lib/errors";
const LoginPage = lazy(() => import("@/pages/Login"));
const OverviewPage = lazy(() => import("@/pages/Overview"));
const ServersPage = lazy(() => import("@/pages/Servers"));
const UsersPage = lazy(() => import("@/pages/Users"));
const SubscriptionsPage = lazy(() => import("@/pages/Subscriptions"));
const PackagesPage = lazy(() => import("@/pages/Packages"));
const CertificatesPage = lazy(() => import("@/pages/Certificates"));
const EventsPage = lazy(() => import("@/pages/Events"));
const NodesPage = lazy(() => import("@/pages/Nodes"));
const NodesIndexPage = lazy(() => import("@/pages/NodesIndex"));
const MePage = lazy(() => import("@/pages/Me"));

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-full place-items-center bg-background p-6">
      {children}
    </div>
  );
}

function RouteFallback({ label }: { label: string }) {
  return (
    <Centered>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" />
        {label}
      </div>
    </Centered>
  );
}

function LoginRedirect({ landing }: { landing: string }) {
  const location = useLocation();
  const next = safeNextPath(
    new URLSearchParams(location.search).get("next"),
  );
  return <Navigate to={next === "/" ? landing : next} replace />;
}

export default function App() {
  const me = useMe();

  if (me.isPending) {
    return (
      <Centered>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          正在验证会话…
        </div>
      </Centered>
    );
  }

  if (me.isError) {
    if (isUnauthorized(me.error)) {
      return (
        <Suspense fallback={<RouteFallback label="正在加载登录页…" />}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        </Suspense>
      );
    }

    const message = errorText(
      me.error,
      "无法连接主控，请检查网络或主控是否已启动",
    );

    return (
      <Centered>
        <Card className="w-full max-w-md">
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <div className="grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
              <TriangleAlertIcon className="size-5" />
            </div>
            <div>
              <p className="text-sm font-medium">无法连接主控</p>
              <p className="mt-1 text-xs text-muted-foreground">{message}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void me.refetch()}
            >
              <RefreshCwIcon className="size-3.5" />
              重试
            </Button>
          </CardContent>
        </Card>
      </Centered>
    );
  }

  const user = me.data;
  if (!user) return null;

  const isAdmin = user.role === "admin";
  const landing = isAdmin ? "/" : "/me";

  return (
    <Suspense fallback={<RouteFallback label="正在加载页面…" />}>
      <Routes>
        <Route path="/login" element={<LoginRedirect landing={landing} />} />
        {isAdmin ? (
          <Route element={<AppShell user={user} />}>
            <Route index element={<OverviewPage />} />
            <Route path="servers" element={<ServersPage />} />
            <Route path="servers/:id/nodes" element={<NodesPage />} />
            <Route path="nodes" element={<NodesIndexPage />} />
            <Route path="users" element={<UsersPage />} />
            <Route path="subscriptions" element={<SubscriptionsPage />} />
            <Route path="packages" element={<PackagesPage />} />
            <Route path="certificates" element={<CertificatesPage />} />
            <Route path="events" element={<EventsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        ) : (
          // 普通用户只有自助视图：管理路由一律回 /me，避免看到 403 报错。
          <Route element={<AppShell user={user} />}>
            <Route path="me" element={<MePage />} />
            <Route path="me/subscription" element={<MePage />} />
            <Route index element={<Navigate to="/me" replace />} />
            <Route path="*" element={<Navigate to="/me" replace />} />
          </Route>
        )}
      </Routes>
    </Suspense>
  );
}
