import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Loader2Icon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import AppShell from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { isUnauthorized, useMe } from "@/lib/queries";
import { isPublicStatusPath } from "@/lib/publicStatus";
import { safeNextPath } from "@/lib/auth";
import { errorText } from "@/lib/errors";
import { useI18n } from "@/i18n";
const LoginPage = lazy(() => import("@/pages/Login"));
const StatusPage = lazy(() => import("@/pages/Status"));
const OverviewPage = lazy(() => import("@/pages/Overview"));
const ServersPage = lazy(() => import("@/pages/Servers"));
const UsersPage = lazy(() => import("@/pages/Users"));
const SubscriptionsPage = lazy(() => import("@/pages/Subscriptions"));
const PackagesPage = lazy(() => import("@/pages/Packages"));
const CertificatesPage = lazy(() => import("@/pages/Certificates"));
const EventsPage = lazy(() => import("@/pages/Events"));
const AuditPage = lazy(() => import("@/pages/Audit"));
const RulesPage = lazy(() => import("@/pages/Rules"));
const SettingsPage = lazy(() => import("@/pages/Settings"));
const NodesPage = lazy(() => import("@/pages/Nodes"));
const OutboundsPage = lazy(() => import("@/pages/Outbounds"));
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

/**
 * `/status` 公开路由在调用 `useMe` 之前分流：未登录访问时不会发
 * `/api/v1/auth/me`，也就不会触发下面的 401 → /login 重定向；页面本身
 * 仍保留「进入管理面板」链接。其余路径交给 `AuthenticatedApp` 做会话守卫。
 */
export default function App() {
  const { t } = useI18n();
  const { pathname } = useLocation();

  if (isPublicStatusPath(pathname)) {
    return (
      <Suspense fallback={<RouteFallback label={t("publicStatus.loading")} />}>
        <StatusPage />
      </Suspense>
    );
  }

  return <AuthenticatedApp />;
}

function AuthenticatedApp() {
  const { t } = useI18n();
  const me = useMe();

  if (me.isPending) {
    return (
      <Centered>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          {t("app.verifyingSession")}
        </div>
      </Centered>
    );
  }

  if (me.isError) {
    if (isUnauthorized(me.error)) {
      return (
        <Suspense fallback={<RouteFallback label={t("app.loadingLogin")} />}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        </Suspense>
      );
    }

    const message = errorText(me.error, t("app.cannotConnectFallback"));

    return (
      <Centered>
        <Card className="w-full max-w-md">
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <div className="grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
              <TriangleAlertIcon className="size-5" />
            </div>
            <div>
              <p className="text-sm font-medium">{t("app.cannotConnectTitle")}</p>
              <p className="mt-1 text-xs text-muted-foreground">{message}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void me.refetch()}
            >
              <RefreshCwIcon className="size-3.5" />
              {t("app.retry")}
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
    <Suspense fallback={<RouteFallback label={t("app.loadingPage")} />}>
      <Routes>
        <Route path="/login" element={<LoginRedirect landing={landing} />} />
        {isAdmin ? (
          <Route element={<AppShell user={user} />}>
            <Route index element={<OverviewPage />} />
            <Route path="servers" element={<ServersPage />} />
            <Route path="servers/:id/nodes" element={<NodesPage />} />
            <Route path="servers/:id/outbounds" element={<OutboundsPage />} />
            <Route path="nodes" element={<NodesIndexPage />} />
            <Route path="users" element={<UsersPage />} />
            <Route path="subscriptions" element={<SubscriptionsPage />} />
            <Route path="packages" element={<PackagesPage />} />
            <Route path="certificates" element={<CertificatesPage />} />
            <Route path="events" element={<EventsPage />} />
            <Route path="audit" element={<AuditPage />} />
            <Route path="rules" element={<RulesPage />} />
            <Route path="settings" element={<SettingsPage />} />
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
