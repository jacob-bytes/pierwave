import {
  CalendarClockIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  statusToneClasses,
  type PackageStatusTone,
} from "@/components/packages/packageTone";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import type { MeSummary, UserPackageStatus } from "@/lib/api";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

export type MeStatus = UserPackageStatus | "none";

const statusMeta: Record<
  MeStatus,
  { labelKey: string; tone: PackageStatusTone }
> = {
  active: { labelKey: "me.status.active", tone: "primary" },
  exhausted: { labelKey: "me.status.exhausted", tone: "destructive" },
  expired: { labelKey: "me.status.expired", tone: "warning" },
  disabled: { labelKey: "me.status.disabled", tone: "muted" },
  none: { labelKey: "me.status.none", tone: "muted" },
};

export function MeStatusBadge({ status }: { status: MeStatus }) {
  const meta = statusMeta[status];
  return (
    <Badge
      variant="outline"
      className={cn(
        "border-transparent font-normal",
        statusToneClasses[meta.tone],
      )}
    >
      {t(meta.labelKey)}
    </Badge>
  );
}

/**
 * 账户级 / 套餐级告警。四个分页共用：断流原因不能只在概览出现。
 *
 * 账户总额度是总闸：命中时全站停用，只留这一条，不再叠单卡提示。
 */
export function StatusAlerts({ summary }: { summary: MeSummary }) {
  const { usage, user } = summary;

  if (user.quota_exceeded) {
    return (
      <Alert
        variant="destructive"
        className="border-destructive/25 bg-destructive/10"
      >
        <TriangleAlertIcon />
        <AlertTitle>{t("me.alerts.quotaExceededTitle")}</AlertTitle>
        <AlertDescription className="text-destructive/90">
          {t("me.alerts.quotaExceededDesc")}
        </AlertDescription>
      </Alert>
    );
  }

  if (usage.status === "active" || usage.status === "none") return null;

  if (usage.status === "exhausted") {
    return (
      <Alert
        variant="destructive"
        className="border-destructive/25 bg-destructive/10"
      >
        <TriangleAlertIcon />
        <AlertTitle>{t("me.alerts.exhaustedTitle")}</AlertTitle>
        <AlertDescription className="text-destructive/90">
          {t("me.alerts.exhaustedDesc")}
        </AlertDescription>
      </Alert>
    );
  }

  if (usage.status === "expired") {
    return (
      <Alert className="border-warning/25 bg-warning/10 text-warning">
        <CalendarClockIcon />
        <AlertTitle>{t("me.alerts.expiredTitle")}</AlertTitle>
        <AlertDescription className="text-warning/90">
          {t("me.alerts.expiredDesc")}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert className="border-border bg-muted/40">
      <ShieldCheckIcon />
      <AlertTitle>{t("me.alerts.disabledTitle")}</AlertTitle>
      <AlertDescription>{t("me.alerts.disabledDesc")}</AlertDescription>
    </Alert>
  );
}
