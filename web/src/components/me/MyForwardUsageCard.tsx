import { ArrowRightLeftIcon, ChartColumnIcon } from "lucide-react";
import { EmptyState, ListError } from "@/components/common";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { errorText } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import {
  forwardUsageName,
  isUsageEmpty,
  sortUsageRows,
  sumUsageDays,
} from "@/lib/forwardUsage";
import { useMyForwardUsage } from "@/lib/queries";
import { useI18n } from "@/i18n";

/** 「我的转发」下方的小块只读用量：固定近 7 天，不给窗口切换。 */
const ME_USAGE_DAYS = 7;

export function MyForwardUsageCard() {
  const { t } = useI18n();
  const usage = useMyForwardUsage(ME_USAGE_DAYS);
  const data = usage.data;
  const deletedLabel = t("forwardUsage.deleted");
  const rows = sortUsageRows(data?.by_forward);
  const totals = data ? sumUsageDays(data.days) : { bytes: 0, weighted: 0 };
  const empty = data ? isUsageEmpty(data.totals, data.by_forward) : false;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <ChartColumnIcon className="size-4 text-muted-foreground" />
          {t("forwardUsage.meTitle")}
        </CardTitle>
      </CardHeader>

      <CardContent aria-busy={usage.isPending}>
        {usage.isPending && !data ? (
          <div className="space-y-3">
            {[0, 1].map((index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : usage.isError && !data ? (
          <ListError
            title={t("forwardUsage.loadFailed")}
            message={errorText(usage.error, t("forwardUsage.loadError"))}
            retrying={usage.isFetching}
            onRetry={() => void usage.refetch()}
          />
        ) : empty ? (
          <EmptyState
            size="sm"
            icon={ArrowRightLeftIcon}
            title={t("forwardUsage.meEmptyTitle")}
            description={t("forwardUsage.meEmptyDesc")}
          />
        ) : (
          <div className="space-y-3">
            <dl className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-xs">
              <div className="flex items-baseline gap-1.5">
                <dt className="text-muted-foreground">
                  {t("forwardUsage.raw")}
                </dt>
                <dd className="font-mono tabular-nums">
                  {formatBytes(totals.bytes)}
                </dd>
              </div>
              <div className="flex items-baseline gap-1.5">
                <dt className="text-muted-foreground">
                  {t("forwardUsage.billed")}
                </dt>
                <dd className="font-mono tabular-nums">
                  {formatBytes(totals.weighted)}
                </dd>
              </div>
            </dl>

            <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem] items-baseline gap-2 text-[11px] text-muted-foreground">
              <span />
              <span className="text-right">{t("forwardUsage.raw")}</span>
              <span className="text-right">{t("forwardUsage.billed")}</span>
            </div>

            <ul className="divide-y divide-border">
              {rows.map((row) => (
                <li
                  key={row.forward_id}
                  className="grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem] items-baseline gap-2 py-2 text-xs first:pt-0 last:pb-0"
                >
                  <span
                    className="min-w-0 truncate text-foreground/90"
                    title={forwardUsageName(row, deletedLabel)}
                  >
                    {forwardUsageName(row, deletedLabel)}
                  </span>
                  <span className="text-right font-mono tabular-nums">
                    {formatBytes(row.bytes)}
                  </span>
                  <span className="text-right font-mono tabular-nums text-muted-foreground">
                    {formatBytes(row.weighted)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
