import { Badge } from "@/components/ui/badge";
import { statusToneClasses } from "@/components/packages/packageTone";
import { packageStatusLabel, packageStatusTone } from "@/lib/labels";
import { cn } from "@/lib/utils";

export function PackageStatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const tone = packageStatusTone(status);

  return (
    <Badge
      variant="outline"
      className={cn(
        "shrink-0 border-transparent font-normal",
        statusToneClasses[tone],
        className,
      )}
    >
      {packageStatusLabel(status)}
    </Badge>
  );
}
