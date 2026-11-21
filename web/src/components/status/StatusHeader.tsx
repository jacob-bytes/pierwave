import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ActivityIcon,
  LayoutDashboardIcon,
  MoonIcon,
  SunIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PAGE_CONTAINER } from "@/components/status/StatusSkeleton";
import { useI18n } from "@/i18n";
import type { PublicStatus } from "@/lib/api";
import { isStatusStale } from "@/lib/publicStatus";
import { formatClockTime } from "@/lib/time";
import { useTheme } from "@/lib/useTheme";
import { cn } from "@/lib/utils";

/**
 * 探针公开页共用的页头：品牌、实时状态点、进入后台、主题切换。
 *
 * `/status` 与 `/status/:id` 必须完全同高、同宽、同结构：从列表进入详情时
 * 页头不能跳一下；详情页的「返回列表」放在内容区的服务器头部，不挤占这里。
 */

/** 页头右侧的实时状态点：数据新鲜是主色，过期转 muted，断线仍用警告色。 */
function LiveStatus({
  data,
  isError,
  disabled,
}: {
  data: PublicStatus | undefined;
  isError: boolean;
  /** 404：公开页被关闭。这是管理员的设置，不是故障，不能画成告警。 */
  disabled: boolean;
}) {
  const { t } = useI18n();
  // 每 15 秒刷新一次“现在”，让「数据是否已经过期」自己会变；
  // 不在 render 里直接读 Date.now()，组件保持纯函数。
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = window.setInterval(tick, 15_000);
    return () => window.clearInterval(id);
  }, []);

  const time = data ? formatClockTime(data.generated_at) : null;
  // 2 分钟没有新数据就不再算“实时”，点与文字一起转 muted；轮询失败则是另一回事，
  // 仍然用警告色把「连接断了」和「数据旧了」分开。关闭态保持中性。
  const stale = data !== undefined && isStatusStale(now, data.generated_at);
  const warn = isError && !disabled;
  const calm = data !== undefined && !warn && !disabled && !stale;
  const label = disabled
    ? t("publicStatus.header.disabled")
    : isError
      ? t("publicStatus.header.disconnected")
      : time
        ? t("publicStatus.updatedAt", { time })
        : t("publicStatus.header.connecting");

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap",
        warn ? "text-warning" : "text-muted-foreground",
      )}
      title={
        disabled || warn || stale
          ? label
          : t("publicStatus.autoRefreshHint")
      }
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          warn
            ? "bg-warning"
            : stale || disabled
              ? "bg-muted-foreground"
              : "bg-primary",
          calm && "status-breathe",
        )}
      />
      {/* 手机上页头放不下整句，圆点才是承载状态的部分；文字留在无障碍树里。 */}
      <span className="max-sm:sr-only">{label}</span>
    </span>
  );
}

export function StatusHeader({
  data,
  isError,
  disabled,
}: {
  data: PublicStatus | undefined;
  isError: boolean;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const { resolvedTheme, setTheme } = useTheme();
  const panelName =
    data?.panel_name?.trim() || t("publicStatus.headingFallback");
  const dark = resolvedTheme === "dark";
  const themeLabel = t("publicStatus.header.themeToggle");

  return (
    <header className="sticky top-0 z-10 border-b border-border bg-[color-mix(in_oklab,var(--card)_80%,var(--background))]">
      <div className={cn(PAGE_CONTAINER, "flex items-center gap-2 py-3 sm:gap-3")}>
        {/* 品牌区：logo 与两行文字等高，文字块靠行高撑满，两行之间只留 2px。 */}
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground">
            <ActivityIcon className="icon-lg" aria-hidden="true" />
          </span>
          <div className="flex min-w-0 flex-col">
            <h1 className="truncate text-base leading-tight font-semibold tracking-tight">
              {panelName}
            </h1>
            <p className="mt-0.5 truncate text-xs leading-tight text-muted-foreground">
              {t("publicStatus.tagline")}
            </p>
          </div>
        </div>

        <div className="flex-1" />

        {/* 顺序按参考实现：更新时间在最左，然后「进入后台」，主题切换最右。
            页面每 20 秒自己刷新（页签隐藏时暂停，切回立即补拉），页头不放刷新按钮。 */}
        <LiveStatus data={data} isError={isError} disabled={disabled} />

        <Button variant="ghost" asChild>
          <Link to="/login">
            <LayoutDashboardIcon className="icon-md" aria-hidden="true" />
            {t("publicStatus.header.admin")}
          </Link>
        </Button>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => setTheme(dark ? "light" : "dark")}
          title={themeLabel}
          aria-label={themeLabel}
        >
          {dark ? (
            <SunIcon className="icon-md" aria-hidden="true" />
          ) : (
            <MoonIcon className="icon-md" aria-hidden="true" />
          )}
        </Button>
      </div>
    </header>
  );
}
