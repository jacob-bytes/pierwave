import { lazy, Suspense, type ReactNode } from "react";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useParams,
} from "react-router-dom";
import { Loader2Icon } from "lucide-react";
import AppShell from "@/components/AppShell";
import { ListError, PageSkeleton } from "@/components/common";
import { StatusRouteSkeleton } from "@/components/status/StatusSkeleton";
import { StatusDetailRouteSkeleton } from "@/components/status/StatusDetailSkeleton";
import { Card, CardContent } from "@/components/ui/card";
import { CHAIN_USAGE_URL } from "@/lib/chainSections";
import { isUnauthorized, useMe } from "@/lib/queries";
import {
  isPublicStatusPath,
  publicStatusServerId,
} from "@/lib/publicStatus";
import { safeNextPath } from "@/lib/auth";
import { errorText } from "@/lib/errors";
import { useI18n } from "@/i18n";
import NotFoundPage from "@/pages/NotFound";
// 登录页是静态导入：它的依赖（queries / i18n / 表单组件）本来就随入口加载，
// 单独切 chunk 只会让 /login 先闪一帧路由骨架。静态引入后表单随首帧渲染，
// 不再有「骨架 → 表单」的形态跳变。
import LoginPage, { LoginSkeleton } from "@/pages/Login";
const StatusPage = lazy(() => import("@/pages/Status"));
const StatusDetailPage = lazy(() => import("@/pages/StatusDetail"));
const OverviewPage = lazy(() => import("@/pages/Overview"));
const ServersPage = lazy(() => import("@/pages/Servers"));
const UsersPage = lazy(() => import("@/pages/Users"));
const SubscriptionsPage = lazy(() => import("@/pages/Subscriptions"));
const PackagesPage = lazy(() => import("@/pages/Packages"));
const LogsPage = lazy(() => import("@/pages/Logs"));
const SettingsPage = lazy(() => import("@/pages/Settings"));
const NodesPage = lazy(() => import("@/pages/Nodes"));
const OutboundsPage = lazy(() => import("@/pages/Outbounds"));
const ForwardsPage = lazy(() => import("@/pages/Forwards"));
const ChainsPage = lazy(() => import("@/pages/Chains"));
const ChainTemplatesPage = lazy(() => import("@/pages/ChainTemplates"));
const NodesIndexPage = lazy(() => import("@/pages/NodesIndex"));
const MeShell = lazy(() => import("@/components/me/MeShell"));
const MeOverviewPage = lazy(() => import("@/pages/me/Overview"));
const MeSubscriptionPage = lazy(() => import("@/pages/me/Subscription"));
const MeForwardsPage = lazy(() => import("@/pages/me/Forwards"));
const MePackagesPage = lazy(() => import("@/pages/me/Packages"));

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-full place-items-center bg-background p-6">
      {children}
    </div>
  );
}

/**
 * 路由 chunk 加载时的页面级骨架：不再用全屏 spinner。
 * 头部条 + 两行内容块与后台页面的大致结构一致；具体路由共用这一个骨架。
 */
function RouteFallback({ label }: { label: string }) {
  return (
    <div className="flex min-h-full justify-center bg-background p-6">
      <div className="w-full max-w-5xl">
        <PageSkeleton label={label} />
      </div>
    </div>
  );
}

function LoginRedirect({ landing }: { landing: string }) {
  const location = useLocation();
  const next = safeNextPath(
    new URLSearchParams(location.search).get("next"),
  );
  return <Navigate to={next === "/" ? landing : next} replace />;
}

/** 公开详情路由：id 从 URL 取，页面本身仍只接收字符串。 */
function StatusDetailRoute() {
  const { id } = useParams<{ id: string }>();
  return <StatusDetailPage id={id ?? ""} />;
}

/**
 * `/status` 公开区在调用 `useMe` 之前分流：未登录访问时不会发
 * `/api/v1/auth/me`，也就不会触发下面的 401 → /login 重定向；页面本身
 * 仍保留「进入管理面板」链接。其余路径交给 `AuthenticatedApp` 做会话守卫。
 *
 * 公开区也有自己的 `*`：`/status/xxx` 之外的子路径（例如多段地址）显示
 * 404，而不是把人送进登录页。登录后的控制台另有 `*`，两处不再静默重定向。
 */
export default function App() {
  const { t } = useI18n();
  const { pathname } = useLocation();
  // 已知公开路由 + 它们的未知子路径；`/statuses` 这类别的路径仍走登录守卫。
  const publicArea =
    isPublicStatusPath(pathname) || pathname.startsWith("/status/");

  if (publicArea) {
    const serverId = publicStatusServerId(pathname);
    return (
      <Suspense
        fallback={
          serverId ? (
            <StatusDetailRouteSkeleton label={t("publicStatus.loading")} />
          ) : (
            <StatusRouteSkeleton label={t("publicStatus.loading")} />
          )
        }
      >
        <Routes>
          <Route path="/status" element={<StatusPage />} />
          <Route path="/status/:id" element={<StatusDetailRoute />} />
          <Route
            path="*"
            element={<NotFoundPage homePath="/" standalone />}
          />
        </Routes>
      </Suspense>
    );
  }

  return <AuthenticatedApp />;
}

function AuthenticatedApp() {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const me = useMe();

  if (me.isPending) {
    // `/login` 的会话校验态用登录页自己的骨架（同形、同背景光晕），
    // 其它路由才用居中的会话校验提示。
    if (pathname === "/login") {
      return <LoginSkeleton label={t("app.verifyingSession")} />;
    }

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
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      );
    }

    const message = errorText(me.error, t("app.cannotConnectFallback"));

    return (
      <Centered>
        <Card className="w-full max-w-md py-0">
          <CardContent>
            <ListError
              title={t("app.cannotConnectTitle")}
              message={message}
              retrying={me.isFetching}
              onRetry={() => void me.refetch()}
            />
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
            <Route path="servers/:id/forwards" element={<ForwardsPage />} />
            <Route path="chains" element={<ChainsPage />} />
            <Route path="chain-templates" element={<ChainTemplatesPage />} />
            {/* 转发用量已并入概览 → 链路时延的第三个子页：旧书签跳到对应 URL。 */}
            <Route
              path="forward-usage"
              element={<Navigate to={CHAIN_USAGE_URL} replace />}
            />
            <Route path="nodes" element={<NodesIndexPage />} />
            <Route path="users" element={<UsersPage />} />
            <Route path="subscriptions" element={<SubscriptionsPage />} />
            <Route path="packages" element={<PackagesPage />} />
            <Route path="logs" element={<LogsPage />} />
            {/* 旧书签保留：/events 与 /audit 重定向到合并后的日志页。 */}
            <Route
              path="events"
              element={<Navigate to="/logs?tab=events" replace />}
            />
            <Route
              path="audit"
              element={<Navigate to="/logs?tab=audit" replace />}
            />
            {/* 规则模板与证书已并入设置页：旧书签跳到对应 tab。 */}
            <Route
              path="rules"
              element={<Navigate to="/settings?tab=templates" replace />}
            />
            <Route
              path="certificates"
              element={<Navigate to="/settings?tab=certificates" replace />}
            />
            <Route path="settings" element={<SettingsPage />} />
            {/* `/me` 对管理员同样保留：返回的是管理员自己的数据，侧栏不加入口。 */}
            <Route path="me" element={<MeShell />}>
              <Route index element={<MeOverviewPage />} />
              <Route path="subscription" element={<MeSubscriptionPage />} />
              <Route path="forwards" element={<MeForwardsPage />} />
              <Route path="packages" element={<MePackagesPage />} />
            </Route>
            {/* 未知路径不再静默回首页：告诉用户走错了，并给出三个出口。 */}
            <Route path="*" element={<NotFoundPage homePath="/" />} />
          </Route>
        ) : (
          // 普通用户只有自助视图：管理路由一律回 /me，避免看到 403 报错。
          <Route element={<AppShell user={user} />}>
            <Route path="me" element={<MeShell />}>
              <Route index element={<MeOverviewPage />} />
              <Route path="subscription" element={<MeSubscriptionPage />} />
              <Route path="forwards" element={<MeForwardsPage />} />
              <Route path="packages" element={<MePackagesPage />} />
            </Route>
            <Route index element={<Navigate to="/me" replace />} />
            <Route path="*" element={<NotFoundPage homePath="/me" />} />
          </Route>
        )}
      </Routes>
    </Suspense>
  );
}
