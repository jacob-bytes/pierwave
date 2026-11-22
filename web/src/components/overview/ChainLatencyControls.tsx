import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ChainLatencyRange } from "@/lib/chainHealth";
import { t, useI18n } from "@/i18n";

/** 24h / 7d 切换；列表页与详情页共用。 */
export function ChainLatencyRangeTabs({
  range,
  onRangeChange,
}: {
  range: ChainLatencyRange;
  onRangeChange: (range: ChainLatencyRange) => void;
}) {
  useI18n();
  return (
    <Tabs
      value={range}
      onValueChange={(value) => {
        if (value === "24h" || value === "7d") onRangeChange(value);
      }}
    >
      <TabsList
        aria-label={t("overview.chainLatency.rangeAria")}
        className="max-w-full overflow-x-auto"
      >
        <TabsTrigger value="24h">
          {t("overview.chainLatency.range24")}
        </TabsTrigger>
        <TabsTrigger value="7d">
          {t("overview.chainLatency.range7d")}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

function formatGeneratedAt(ts: number): string {
  const date = new Date((ts + 8 * 3600) * 1000);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

export function ChainLatencyUpdatedBadge({
  generatedAt,
}: {
  generatedAt: number | null;
}) {
  useI18n();
  if (generatedAt === null) return null;
  return (
    <Badge
      variant="outline"
      className="font-mono type-micro font-normal text-muted-foreground"
    >
      {t("overview.chainLatency.updatedAt", {
        time: formatGeneratedAt(generatedAt),
      })}
    </Badge>
  );
}
