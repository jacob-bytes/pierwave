import { useMemo, useState } from "react";
import { BracesIcon, ListChecksIcon, RefreshCwIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { errorText } from "@/lib/errors";
import { templatePath } from "@/lib/myChains";
import { useChainTemplates } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

/**
 * 链模板多选（套餐的「允许的自助链模板」）。
 *
 * 数据复用管理端 `useChainTemplates()`；空数组表示一个都不允许。
 * 视觉与 `ServerMultiSelectField` 保持一致，不再单独发明一套列表。
 */
export function ChainTemplateMultiSelectField({
  value,
  onChange,
  disabled = false,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const templates = useChainTemplates();
  const [query, setQuery] = useState("");
  const selected = useMemo(() => new Set(value), [value]);
  const items = useMemo(() => templates.data ?? [], [templates.data]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((template) =>
      template.name.toLowerCase().includes(needle),
    );
  }, [items, query]);

  function toggle(id: string, checked: boolean) {
    const next = new Set(value);
    if (checked) next.add(id);
    else next.delete(id);
    onChange([...next]);
  }

  if (templates.isPending) {
    return (
      <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
        <Skeleton className="h-7 w-48" />
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="flex items-center gap-2 px-1 py-1">
            <Skeleton className="size-4 rounded-[4px]" />
            <Skeleton className="h-3.5 w-40" />
          </div>
        ))}
      </div>
    );
  }

  if (templates.isError) {
    return (
      <Alert variant="destructive">
        <BracesIcon />
        <AlertTitle>{t("packages.form.chainTemplatesLoadFailed")}</AlertTitle>
        <AlertDescription>
          {errorText(
            templates.error,
            t("packages.form.chainTemplatesLoadFailed"),
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void templates.refetch()}
            disabled={templates.isFetching}
          >
            <RefreshCwIcon
              className={cn(
                "size-3.5",
                templates.isFetching && "animate-spin",
              )}
            />
            {t("common.retry")}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (items.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
        {t("packages.form.chainTemplatesEmpty")}
      </p>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange(items.map((template) => template.id))}
            disabled={disabled}
          >
            <ListChecksIcon className="size-3.5" />
            {t("packages.form.chainTemplatesSelectAll")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange([])}
            disabled={disabled || value.length === 0}
          >
            {t("packages.form.chainTemplatesClear")}
          </Button>
        </div>
        <span
          aria-live="polite"
          className="font-mono text-xs text-muted-foreground"
        >
          {t("packages.form.chainTemplatesSelected", {
            selected: value.length,
            total: items.length,
          })}
        </span>
      </div>

      {items.length > 6 ? (
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("packages.form.chainTemplatesSearch")}
          aria-label={t("packages.form.chainTemplatesSearch")}
          disabled={disabled}
          className="h-8 text-xs"
        />
      ) : null}

      {visible.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">
          {t("packages.form.chainTemplatesNoMatch")}
        </p>
      ) : (
        <ScrollArea className="h-48">
          <div className="space-y-0.5 pr-3">
            {visible.map((template) => {
              const checked = selected.has(template.id);
              return (
                <div
                  key={template.id}
                  className={cn(
                    "flex items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors duration-150 hover:bg-muted/40",
                    checked && "bg-primary/5",
                  )}
                >
                  <Checkbox
                    id={`package-chain-template-${template.id}`}
                    checked={checked}
                    disabled={disabled}
                    onCheckedChange={(next) =>
                      toggle(template.id, next === true)
                    }
                    className="mt-0.5"
                  />
                  <Label
                    htmlFor={`package-chain-template-${template.id}`}
                    className="min-w-0 flex-1 cursor-pointer font-normal"
                  >
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-sm">{template.name}</span>
                      {template.enabled ? null : (
                        <Badge
                          variant="outline"
                          className="border-transparent bg-muted type-micro font-normal text-muted-foreground"
                        >
                          {t("chainTemplates.disabled")}
                        </Badge>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate font-mono type-micro text-muted-foreground">
                      {templatePath(template)}
                    </span>
                  </Label>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
