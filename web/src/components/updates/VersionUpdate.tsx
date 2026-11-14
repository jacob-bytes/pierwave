import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRightIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { errorText } from "@/lib/errors";
import { useCheckUpdates, useUpdates } from "@/lib/queries";
import {
  checkedAtText,
  formatVersion,
  pickBilingual,
  releaseDateText,
  showsUpdateDot,
  updateBadgeState,
  updateErrorText,
} from "@/lib/updates";
import { cn } from "@/lib/utils";

/**
 * 侧栏底部的版本号 + 更新圆点 + 浮层（仅管理员）。
 *
 * 为什么不用 shadcn `Popover`（Radix Portal）：移动端侧栏本身是一个 modal
 * Sheet，Portal 到 body 的浮层会被 Dialog 的 `aria-hidden` / pointer-events
 * 挡住；这里把浮层做成侧栏内的绝对定位层，既跟随侧栏宽度（390px 屏幕也
 * 不会溢出），又能被 Sheet 的焦点管理正常识别。
 *
 * 交互：悬停或点击展开；移出 140ms 后收起；Esc / 点外部关闭。
 */
export function VersionUpdate({
  versionLabel,
  collapsed,
}: {
  versionLabel: string;
  collapsed: boolean;
}) {
  const { t, locale } = useI18n();
  const updates = useUpdates(true);
  const check = useCheckUpdates();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);

  const state = updateBadgeState({
    enabled: true,
    pending: updates.isPending,
    failed: updates.isError,
    data: updates.data,
  });

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 140);
  }, [cancelClose]);

  useEffect(() => () => cancelClose(), [cancelClose]);

  // 点浮层外部或按 Esc 关闭；指针事件覆盖鼠标、触屏与手写笔。
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (event.target instanceof Node && containerRef.current?.contains(event.target)) {
        return;
      }
      setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const master = updates.data?.master;
  const latest = master?.latest ?? null;
  const updateAvailable = state === "update";
  // 检测失败有两种：最近一次检测失败（master.error），或 /updates 本身失败。
  const failure =
    updateErrorText(master?.error) ??
    (state === "error"
      ? errorText(updates.error, t("settings.updates.loadError"))
      : null);
  const failureText = failure ? pickBilingual(failure, locale) : null;
  const releaseUrl = master?.release_url?.trim() || null;
  const releasedOn = releaseDateText(master?.released_at);
  const checkedAt = master?.checked_at ?? null;

  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseEnter={() => {
        cancelClose();
        setOpen(true);
      }}
      onMouseLeave={scheduleClose}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn(
          "h-auto w-full justify-start gap-1.5 px-0 py-0 font-mono type-micro font-normal text-muted-foreground hover:bg-transparent hover:text-foreground",
          collapsed && "justify-center",
        )}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`PierWave ${versionLabel}`}
        // 只负责展开：触屏上 pointerenter 会先触发一次，用 toggle 会「开了又关」。
        // 收起走移出、点外部或 Esc。
        onClick={() => setOpen(true)}
      >
        <span className="truncate">
          {collapsed ? versionLabel : `PierWave ${versionLabel}`}
        </span>
        {showsUpdateDot(state) ? (
          <span
            data-testid="update-dot"
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full bg-primary"
          />
        ) : null}
        <span className="sr-only">{t("updates.title")}</span>
      </Button>

      {open ? (
        <div
          role="dialog"
          aria-label={t("updates.popoverAria")}
          className={cn(
            "absolute z-50 w-full rounded-lg bg-popover p-3 text-popover-foreground shadow-md ring-1 ring-foreground/10 animate-in duration-150 fade-in-0 zoom-in-95",
            // 移动端跟随侧栏宽度（不溢出屏幕）；桌面展开时比侧栏略宽，避免
            // 「当前 → 最新」被挤成两行。折叠态从侧栏右侧弹出。
            collapsed
              ? "bottom-0 left-full ml-2 w-64"
              : "bottom-full left-0 mb-2 w-full md:w-64",
          )}
        >
          {state === "loading" ? (
            <p className="text-xs text-muted-foreground">
              {t("updates.checking")}
            </p>
          ) : null}

          {state === "unknown" ? (
            <p className="text-xs text-muted-foreground">
              {t("updates.neverChecked")}
            </p>
          ) : null}

          {master && state !== "loading" ? (
            <div className="flex flex-wrap items-center gap-1.5 font-mono type-micro">
              <span className="text-muted-foreground">
                {t("updates.current", {
                  version: formatVersion(master.current),
                })}
              </span>
              {latest ? (
                <>
                  <ArrowRightIcon
                    className="size-3 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span
                    className={cn(
                      updateAvailable && "font-medium text-primary",
                    )}
                  >
                    {t("updates.latest", { version: formatVersion(latest) })}
                  </span>
                </>
              ) : null}
            </div>
          ) : null}

          {state === "latest" ? (
            <p className="mt-1.5 text-xs font-medium">
              {t("updates.upToDate")}
            </p>
          ) : null}

          {state === "error" && failureText ? (
            <p className="mt-1.5 text-xs break-words text-destructive">
              {t("updates.checkedFailed", { error: failureText })}
            </p>
          ) : null}

          {updateAvailable && (releasedOn || releaseUrl) ? (
            <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
              {releasedOn ? (
                <span>{t("updates.releasedOn", { date: releasedOn })}</span>
              ) : null}
              {releasedOn && releaseUrl ? <span aria-hidden="true">·</span> : null}
              {releaseUrl ? (
                <a
                  href={releaseUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline-offset-2 hover:underline"
                >
                  {t("updates.viewRelease")}
                </a>
              ) : null}
            </p>
          ) : null}

          {check.isError ? (
            <p className="mt-1.5 text-xs break-words text-destructive">
              {t("settings.updates.checkFailed")}{" "}
              {errorText(check.error, "")}
            </p>
          ) : null}

          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {checkedAt !== null
                ? t("updates.lastChecked", { time: checkedAtText(checkedAt) })
                : t("updates.neverChecked")}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 gap-1 px-1.5 text-xs"
              disabled={check.isPending}
              onClick={() => check.mutate()}
            >
              {check.isPending ? (
                <Loader2Icon className="size-3 animate-spin" />
              ) : (
                <RefreshCwIcon className="size-3" />
              )}
              {check.isPending ? t("updates.checking") : t("updates.check")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
