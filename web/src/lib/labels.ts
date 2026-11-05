import type { PackageDirection } from "@/lib/api";

const directionLabels: Record<PackageDirection, string> = {
  both: "双向",
  upload: "上行",
  download: "下行",
};

export function directionLabel(value: string): string {
  return directionLabels[value as PackageDirection] ?? value;
}

export function packageStatusLabel(status: string): string {
  switch (status) {
    case "active":
      return "生效中";
    case "expired":
      return "已过期";
    case "disabled":
      return "已停用";
    case "exhausted":
      return "已用尽";
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
