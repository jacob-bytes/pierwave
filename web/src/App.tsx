import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import {
  LayoutDashboardIcon,
  Loader2Icon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import AppShell from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { isUnauthorized, useMe } from "@/lib/queries";
import LoginPage from "@/pages/Login";
import ServersPage from "@/pages/Servers";

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-full place-items-center bg-background p-6">
      {children}
    </div>
  );
}

function OverviewPlaceholder() {
  return (
    <div className="animate-in space-y-6 fade-in-0 slide-in-from-bottom-1 duration-150">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">概览</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          主控与节点的运行概况，后续接入。
        </p>
      </div>
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-2 py-16 text-center">
          <div className="mb-1 grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
            <LayoutDashboardIcon className="size-5" />
          </div>
          <p className="text-sm font-medium">概览正在建设中</p>
          <p className="text-xs text-muted-foreground">
            当前可以先在「服务器」页添加并管理 Agent。
          </p>
        </CardContent>
      </Card>
    </div>
  );
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
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      );
    }

    const message =
      me.error instanceof Error ? me.error.message : "无法连接主控";

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

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route element={<AppShell user={user} />}>
        <Route index element={<OverviewPlaceholder />} />
        <Route path="servers" element={<ServersPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
