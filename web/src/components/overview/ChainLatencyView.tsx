import { WaypointsIcon } from "lucide-react";
import { EmptyState } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { t, useI18n } from "@/i18n";

/**
 * 「链路时延」本轮只做占位：没有接口、也不画假图表。
 * 等 `chain-health` 聚合接口就绪后，把这里换成真实视图即可。
 */
export default function ChainLatencyView() {
  useI18n();

  return (
    <Card className="gap-0">
      <CardHeader className="border-b border-border pb-4">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">
            {t("overview.chainLatency.title")}
          </CardTitle>
          <Badge variant="outline" className="shrink-0 font-normal">
            {t("overview.chainLatency.soon")}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <EmptyState
          icon={WaypointsIcon}
          title={t("overview.chainLatency.emptyTitle")}
          description={t("overview.chainLatency.emptyDesc")}
          className="py-16"
        />
      </CardContent>
    </Card>
  );
}
