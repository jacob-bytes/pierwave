import { ChevronDownIcon, TriangleAlertIcon } from "lucide-react";
import { badgeVariants } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useI18n, type TFunction } from "@/i18n";
import type { Server } from "@/lib/api";
import { applySummary, type ApplySummary } from "@/lib/applyStatus";
import { cn } from "@/lib/utils";

const TONE_CLASS: Record<ApplySummary["status"], string> = {
  partial: "border-warning/30 bg-warning/10 text-warning",
  failed: "border-destructive/30 bg-destructive/10 text-destructive",
};

/**
 * 应用结果徽标的文案。
 *
 * partial 的计数来自 `effective.length`，total 缺失时不编造分母；
 * failed 只用一句「应用失败」，完整错误放在展开区里原样展示。
 */
function applyLabel(summary: ApplySummary, t: TFunction): string {
  if (summary.status === "failed") return t("servers.apply.failed");
  return summary.total > 0
    ? t("servers.apply.partial", {
        count: summary.count,
        total: summary.total,
      })
    : t("servers.apply.partialNoCounts");
}

/**
 * 徽标本体（不可点击）：详情段、弹层标题共用。
 * 列表里的触发器单独用 button 包一层，保证键盘可聚焦。
 */
export function ApplyStatusLabel({
  summary,
  className,
}: {
  summary: ApplySummary;
  className?: string;
}) {
  const { t } = useI18n();
  const label = applyLabel(summary, t);

  return (
    <span
      data-slot="apply-status-label"
      data-status={summary.status}
      className={cn(
        badgeVariants({ variant: "outline" }),
        "h-5 gap-1 px-1.5 type-micro font-normal",
        TONE_CLASS[summary.status],
        className,
      )}
    >
      <TriangleAlertIcon className="size-3" aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * 展开后的详情：stage、已生效路径、错误原文。
 *
 * `apply_error` 在 partial 时也保留（文档要求带上失败原因），但用次要色；
 * failed 时用 destructive，且完全不改写原文。
 */
export function ApplyStatusDetails({ summary }: { summary: ApplySummary }) {
  const { t } = useI18n();

  return (
    <div data-slot="apply-status-details" className="flex flex-col gap-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{t("servers.apply.title")}</span>
        <ApplyStatusLabel summary={summary} />
      </div>

      {summary.status === "partial" ? (
        <>
          <div className="flex items-start justify-between gap-3">
            <span className="shrink-0 text-muted-foreground">
              {t("servers.apply.stage")}
            </span>
            <span className="break-words text-right text-foreground">
              {summary.stage ?? t("servers.apply.notReported")}
            </span>
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">
                {t("servers.apply.effective")}
              </span>
              <span className="tnum text-foreground">
                {t("servers.apply.effectiveCount", {
                  count: summary.count,
                  total: summary.total,
                })}
              </span>
            </div>
            {summary.effective.length > 0 ? (
              <ul className="max-h-32 space-y-1 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-[11px] leading-normal">
                {summary.effective.map((path) => (
                  <li key={path} className="break-all text-foreground/90">
                    {path}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">
                {t("servers.apply.noPaths")}
              </p>
            )}
          </div>
        </>
      ) : null}

      {summary.error ? (
        <div className="space-y-1">
          <span className="text-muted-foreground">
            {t("servers.apply.error")}
          </span>
          <pre
            className={cn(
              "max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md p-2 font-mono text-[11px] leading-normal",
              summary.status === "failed"
                ? "bg-destructive/5 text-destructive"
                : "bg-muted/40 text-muted-foreground",
            )}
          >
            {summary.error}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 列表 / 卡片里的可展开徽标。
 *
 * ok / null / 未知状态直接返回 null，不占位、不制造噪音。
 * 用原生 button + Badge 样式是为了让 Popover 触发器可键盘聚焦；直接塞 Badge
 * 会得到一个不可聚焦的 span。
 */
export function ApplyStatusBadge({
  server,
  className,
}: {
  server: Server;
  className?: string;
}) {
  const { t } = useI18n();
  const summary = applySummary(server);
  if (!summary) return null;

  const label = applyLabel(summary, t);
  const hint =
    summary.status === "partial" && summary.stage
      ? `${label} · ${summary.stage}`
      : label;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="apply-status"
          data-status={summary.status}
          title={hint}
          aria-label={t("servers.apply.aria", { label })}
          className={cn(
            badgeVariants({ variant: "outline" }),
            "h-5 cursor-pointer gap-1 px-1.5 type-micro font-normal",
            TONE_CLASS[summary.status],
            className,
          )}
        >
          <TriangleAlertIcon className="size-3" aria-hidden="true" />
          {label}
          <ChevronDownIcon className="size-3 opacity-70" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)]"
      >
        <ApplyStatusDetails summary={summary} />
      </PopoverContent>
    </Popover>
  );
}

/** 详情 popover 里的应用结果段；ok / null 时整段不渲染。 */
export function ApplyStatusSection({ server }: { server: Server }) {
  const { t } = useI18n();
  const summary = applySummary(server);
  if (!summary) return null;

  // 详情 popover 已经很高（390 下要放进一屏）：stage 与路径直接给，partial
  // 的原始错误收进 <details>，避免把弹层撑出视口。徽标自己的弹层仍给完整信息。
  return (
    <section
      data-slot="apply-status-section"
      className="rounded-md border border-border bg-muted/20 p-2.5 text-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{t("servers.apply.title")}</span>
        <ApplyStatusLabel summary={summary} />
      </div>

      {summary.status === "partial" ? (
        <>
          <div className="mt-1.5 flex items-start justify-between gap-3">
            <span className="shrink-0 text-muted-foreground">
              {t("servers.apply.stage")}
            </span>
            <span className="break-words text-right text-foreground">
              {summary.stage ?? t("servers.apply.notReported")}
            </span>
          </div>
          {summary.effective.length > 0 ? (
            <ul className="mt-1.5 max-h-32 space-y-1 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-[11px] leading-normal">
              {summary.effective.map((path) => (
                <li key={path} className="break-all text-foreground/90">
                  {path}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1.5 text-muted-foreground">
              {t("servers.apply.noPaths")}
            </p>
          )}
          {summary.error ? (
            <details className="mt-1.5">
              <summary className="cursor-pointer text-muted-foreground">
                {t("servers.apply.error")}
              </summary>
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-mono text-[11px] leading-normal text-muted-foreground">
                {summary.error}
              </pre>
            </details>
          ) : null}
        </>
      ) : summary.error ? (
        <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-destructive/5 p-2 font-mono text-[11px] leading-normal text-destructive">
          {summary.error}
        </pre>
      ) : null}
    </section>
  );
}
