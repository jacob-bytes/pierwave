import { ArrowLeftIcon, CompassIcon, LayoutDashboardIcon } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * 404：不再把走错路的访客静默重定向回首页。
 *
 * 公开区（`/status/*`）与登录后的控制台各挂一个 `*` 路由，都用这一页；
 * `homePath` 由路由决定（管理员 `/`、普通用户 `/me`、公开区 `/`）。
 * 返回上一页依赖浏览器历史；没有历史时回落到 `homePath`，不会把人留在原地。
 */
export default function NotFoundPage({
  homePath = "/",
  standalone = false,
}: {
  homePath?: string;
  /** 公开区没有 AppShell，自己铺满视口。 */
  standalone?: boolean;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();

  function goBack() {
    if (window.history.length > 1) {
      navigate(-1);
      return;
    }
    navigate(homePath);
  }

  return (
    <div
      data-slot="not-found"
      className={cn(
        "grid place-items-center",
        standalone ? "min-h-dvh bg-background p-6" : "min-h-full p-6",
      )}
    >
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center px-6 py-12 text-center">
          <CompassIcon
            className="size-8 text-muted-foreground"
            aria-hidden="true"
          />
          <p className="mt-4 text-5xl leading-none font-semibold tracking-tight">
            404
          </p>
          <p className="mt-3 max-w-xs text-sm leading-relaxed text-muted-foreground">
            {t("notFound.description")}
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            <Button asChild>
              <Link to={homePath}>
                <LayoutDashboardIcon aria-hidden="true" />
                {t("notFound.console")}
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to="/status">{t("notFound.status")}</Link>
            </Button>
            <Button type="button" variant="ghost" onClick={goBack}>
              <ArrowLeftIcon aria-hidden="true" />
              {t("notFound.back")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
