import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { ArrowRightIcon, Loader2Icon, TerminalIcon } from "lucide-react";
import { SkeletonLine } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PasswordInput } from "@/components/ui/password-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useLogin, usePanelName } from "@/lib/queries";
import { errorText } from "@/lib/errors";
import { safeNextPath } from "@/lib/auth";
import { useDocumentTitle, useI18n } from "@/i18n";

/**
 * 登录页专用骨架：`/login` 在等 `/api/v1/auth/me` 返回（判断是否已登录）时
 * 用它占位，而不是站内数据页的通用骨架。
 *
 * 形态与真实登录页逐块一致：同一层居中容器、`max-w-sm`、品牌区、两张输入、
 * 一个按钮、底部提示行；`.auth-glow` 在这里就渲染，校验完成后不会突然多出一层
 * 背景光晕。所有占位块 `aria-hidden`，状态由外层 `role="status"` 朗读。
 */
export function LoginSkeleton({ label }: { label: string }) {
  const { t } = useI18n();
  return (
    <div className="relative grid min-h-full place-items-center overflow-hidden bg-background p-6">
      <div
        aria-hidden="true"
        className="auth-glow pointer-events-none absolute inset-0"
      />
      <div className="relative w-full max-w-sm">
        <div role="status" aria-busy="true" aria-label={label}>
          <div
            aria-hidden="true"
            className="mb-7 flex flex-col items-center gap-4 text-center"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <Skeleton className="size-10 shrink-0 rounded-xl" />
              <div className="flex min-w-0 flex-col justify-center gap-1.5">
                <SkeletonLine className="h-4 w-28 max-w-full" />
                <SkeletonLine className="h-3 w-36 max-w-full" />
              </div>
            </div>
          </div>

          <Card aria-hidden="true">
            <CardContent>
              <div className="space-y-4">
                <div className="space-y-2">
                  {/* 高度对齐真实 Label 的行盒（text-sm + leading-tight=1.35em），
                      可见的骨架条仍保持 14px，避免加载完成时整张卡片变高。 */}
                  <div className="flex h-[1.35em] items-center">
                    <SkeletonLine className="h-3.5 w-14" />
                  </div>
                  <Skeleton className="h-8 w-full rounded-md" />
                </div>
                <div className="space-y-2">
                  <div className="flex h-[1.35em] items-center">
                    <SkeletonLine className="h-3.5 w-12" />
                  </div>
                  <Skeleton className="h-8 w-full rounded-md" />
                </div>
                <Skeleton className="h-8 w-full rounded-md max-sm:min-h-10" />
              </div>
            </CardContent>
          </Card>

          {/* 提示行用真实文案（不可见）占位：中英文换行的行数不同，
              只有按真实文本排版才能保证加载完成时卡片不上下移动。 */}
          <div aria-hidden="true" className="relative mt-4">
            <p className="invisible flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-xs">
              <span>{t("login.hint")}</span>
              <span className="text-border">|</span>
              <span>{t("login.statusLink")}</span>
            </p>
            <div className="absolute inset-x-0 top-0 flex justify-center">
              <SkeletonLine className="h-3.5 w-48 max-w-full" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

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
      {/* 整屏光晕：设计规范里唯一允许的整屏渐变，只属于登录页。
          纯装饰层（pointer-events-none + aria-hidden），不遮挡、不拦截交互。 */}
      <div
        aria-hidden="true"
        className="auth-glow pointer-events-none absolute inset-0"
      />

      <div className="animate-enter relative w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center gap-4 text-center">
          {/* 品牌标识：logo 与两行文字等高（40px），两行之间只留 2px。
              缩进由 flex 布局自然产生，不再用 pl-* 对齐文字。 */}
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground">
              <TerminalIcon className="icon-lg" aria-hidden="true" />
            </span>
            <span className="flex min-w-0 flex-col text-left">
              <span className="truncate text-base leading-tight font-semibold tracking-tight">
                {panelName}
              </span>
              <span className="mt-0.5 truncate text-xs leading-tight text-muted-foreground">
                {t("login.brandSubtitle")}
              </span>
            </span>
          </div>

          {/* 可见标题与品牌行重复，视觉上不再渲染；保留一个供读屏识别的 h1。 */}
          <h1 className="sr-only">{t("login.title", { panelName })}</h1>
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

        <p className="mt-4 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-xs text-muted-foreground">
          <span>{t("login.hint")}</span>
          <span aria-hidden="true" className="text-border">
            |
          </span>
          <Link
            to="/status"
            className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
          >
            {t("login.statusLink")}
            <ArrowRightIcon className="icon-sm" aria-hidden="true" />
          </Link>
        </p>
      </div>
    </div>
  );
}
