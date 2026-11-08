import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Loader2Icon, TerminalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PasswordInput } from "@/components/ui/password-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLogin, usePanelName } from "@/lib/queries";
import { errorText } from "@/lib/errors";
import { safeNextPath } from "@/lib/auth";
import { useDocumentTitle, useI18n } from "@/i18n";

export default function LoginPage() {
  const { t } = useI18n();
  const panelName = usePanelName();

  useDocumentTitle(`${t("login.pageTitle")} · ${panelName}`);

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
          toast.error(errorText(error, t("login.failed")));
        },
      },
    );
  }

  const errorMessage = login.isError
    ? errorText(login.error, t("login.failed"))
    : null;

  return (
    <div className="relative grid min-h-full place-items-center overflow-hidden bg-background p-6">
      {/* 主题色低透明度光晕：纯装饰，深色下更强，亮色下收着用 */}
      <div
        aria-hidden="true"
        className="auth-glow pointer-events-none absolute inset-0"
      />

      <div className="animate-enter relative w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center gap-4 text-center">
          {/* 品牌标识：图标 + 产品字标 + 一句定位 */}
          <div className="flex items-center gap-2.5">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/25">
              <TerminalIcon className="size-5" aria-hidden="true" />
            </span>
            <span className="text-left leading-tight">
              <span className="block text-sm font-semibold tracking-tight">
                {panelName}
              </span>
              <span className="mt-0.5 block text-[11px] font-medium tracking-[0.16em] text-muted-foreground uppercase">
                {t("login.brandSubtitle")}
              </span>
            </span>
          </div>

          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              {t("login.title", { panelName })}
            </h1>
            <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground">
              {t("login.tagline")}
            </p>
          </div>
        </div>

        <Card>
          <CardContent>
            <form className="space-y-4" onSubmit={handleSubmit}>
              <div className="space-y-2">
                <Label htmlFor="login-username">
                  {t("login.username")}
                  <span aria-hidden="true" className="text-destructive">
                    *
                  </span>
                </Label>
                <Input
                  id="login-username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  autoFocus
                  required
                  aria-required="true"
                  aria-describedby={errorMessage ? "login-error" : undefined}
                  placeholder="admin"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="login-password">
                  {t("login.password")}
                  <span aria-hidden="true" className="text-destructive">
                    *
                  </span>
                </Label>
                <PasswordInput
                  id="login-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  required
                  aria-required="true"
                  aria-describedby={errorMessage ? "login-error" : undefined}
                  placeholder={t("login.passwordPlaceholder")}
                />
              </div>

              {errorMessage ? (
                <p
                  id="login-error"
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
                {login.isPending ? t("login.submitting") : t("login.submit")}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          {t("login.hint")}
        </p>
        <p className="mt-2 text-center text-xs">
          <Link
            to="/status"
            className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {t("login.statusLink")}
          </Link>
        </p>
      </div>
    </div>
  );
}
