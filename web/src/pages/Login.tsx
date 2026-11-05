import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Loader2Icon, TerminalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLogin } from "@/lib/queries";
import { errorText } from "@/lib/errors";
import { safeNextPath } from "@/lib/auth";

export default function LoginPage() {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const nextPath = safeNextPath(searchParams.get("next"));
  const login = useLogin();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    login.mutate(
      { username: username.trim(), password },
      {
        onSuccess: (user) => {
          // 管理员进控制台，普通用户进自助页；`next` 只在非根路径时优先。
          const landing = user.role === "admin" ? "/" : "/me";
          navigate(nextPath === "/" ? landing : nextPath, { replace: true });
        },
        onError: (error) => {
          toast.error(errorText(error, "登录失败，请检查网络后重试"));
        },
      },
    );
  }

  const errorMessage = login.isError
    ? errorText(login.error, "登录失败，请检查网络后重试")
    : null;

  return (
    <div className="grid min-h-full place-items-center bg-background p-6">
      <div className="w-full max-w-sm animate-in fade-in-0 slide-in-from-bottom-1 duration-150">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="grid size-10 place-items-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/20">
            <TerminalIcon className="size-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">
              登录 mmrust
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              使用账号登录，管理员与普通用户共用入口
            </p>
          </div>
        </div>

        <Card>
          <CardContent>
            <form className="space-y-4" onSubmit={handleSubmit}>
              <div className="space-y-2">
                <Label htmlFor="login-username">用户名</Label>
                <Input
                  id="login-username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  autoFocus
                  placeholder="admin"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="login-password">密码</Label>
                <Input
                  id="login-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  placeholder="请输入密码"
                />
              </div>

              {errorMessage ? (
                <p
                  role="alert"
                  aria-live="polite"
                  className="text-xs text-destructive"
                >
                  {errorMessage}
                </p>
              ) : null}

              <Button
                type="submit"
                className="w-full"
                disabled={login.isPending || !username.trim() || !password}
              >
                {login.isPending ? (
                  <Loader2Icon className="animate-spin" />
                ) : null}
                {login.isPending ? "登录中…" : "登录"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          首次启动的管理员密码见服务端日志
        </p>
      </div>
    </div>
  );
}
