import { t } from "@/i18n";
import type { PackageDirection } from "@/lib/api";

/** 方向与套餐状态在各页面共用，统一从词典取词。 */
export function directionLabel(value: string): string {
  switch (value as PackageDirection) {
    case "both":
      return t("direction.both");
    case "upload":
      return t("direction.upload");
    case "download":
      return t("direction.download");
    default:
      return value;
  }
}

export function packageStatusLabel(status: string): string {
  switch (status) {
    case "active":
      return t("status.active");
    case "expired":
      return t("status.expired");
    case "disabled":
      return t("status.disabled");
    case "exhausted":
      return t("status.exhausted");
    default:
      return status;
  }
}

export function packageStatusTone(
  status: string,
): "primary" | "warning" | "destructive" | "muted" {
  switch (status) {
    case "active":
      return "primary";
    case "expired":
      return "warning";
    case "exhausted":
      return "destructive";
    default:
      return "muted";
  }
}
