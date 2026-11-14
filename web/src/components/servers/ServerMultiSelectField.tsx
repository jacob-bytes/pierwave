import { useMemo, useState } from "react";
import { ListChecksIcon, NetworkIcon, RefreshCwIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import type { Server } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { useServers } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

interface ServerMultiSelectFieldProps {
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}

/**
 * 服务器多选（套餐的「允许自助转发的服务器」）。
 *
 * 列表数据复用管理端已有的 `useServers()`；勾选状态由表单持有，
 * 空数组表示一个都不允许。行样式与节点范围选择器保持一致，
 * 不再单独发明一套列表。
 */
export function ServerMultiSelectField({
  value,
  onChange,
  disabled = false,
}: ServerMultiSelectFieldProps) {
  const servers = useServers();
  const [query, setQuery] = useState("");
  const selected = useMemo(() => new Set(value), [value]);
  const items = useMemo(() => servers.data ?? [], [servers.data]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (server) =>
        server.name.toLowerCase().includes(needle) ||
        server.address.toLowerCase().includes(needle) ||
        (server.group_name ?? "").toLowerCase().includes(needle),
    );
  }, [items, query]);

  function toggle(id: string, checked: boolean) {
    const next = new Set(value);
    if (checked) next.add(id);
    else next.delete(id);
    onChange([...next]);
  }

  function selectVisible() {
    const next = new Set(value);
    for (const server of visible) next.add(server.id);
    onChange([...next]);
  }

  if (servers.isPending) {
    return (
      <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
        <div className="flex items-center justify-between gap-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-3.5 w-20" />
        </div>
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="flex items-center gap-2 px-1 py-1">
            <Skeleton className="size-4 rounded-[4px]" />
            <Skeleton className="h-3.5 w-40" />
          </div>
        ))}
      </div>
    );
  }

  if (servers.isError) {
    return (
      <Alert variant="destructive">
        <NetworkIcon />
        <AlertTitle>{t("packages.form.forwardServersLoadFailed")}</AlertTitle>
        <AlertDescription>
          {errorText(
            servers.error,
            t("packages.form.forwardServersLoadFailed"),
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void servers.refetch()}
            disabled={servers.isFetching}
          >
            <RefreshCwIcon
              className={cn("size-3.5", servers.isFetching && "animate-spin")}
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
        {t("packages.form.forwardServersEmpty")}
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
            onClick={selectVisible}
            disabled={disabled || visible.length === 0}
          >
            <ListChecksIcon className="size-3.5" />
            {t("packages.form.forwardServersSelectAll")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange([])}
            disabled={disabled || value.length === 0}
          >
            {t("packages.form.forwardServersClear")}
          </Button>
        </div>
        <span
          aria-live="polite"
          className="font-mono text-xs text-muted-foreground"
        >
          {t("packages.form.forwardServersSelected", {
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
          placeholder={t("packages.form.forwardServersSearch")}
          aria-label={t("packages.form.forwardServersSearch")}
          disabled={disabled}
          className="h-8 text-xs"
        />
      ) : null}

      {visible.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">
          {t("packages.form.forwardServersNoMatch")}
        </p>
      ) : (
        <ScrollArea className="h-48">
          <div className="space-y-0.5 pr-3">
            {visible.map((server: Server) => {
              const checked = selected.has(server.id);
              return (
                <div
                  key={server.id}
                  className={cn(
                    "flex items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors duration-150 hover:bg-muted/40",
                    checked && "bg-primary/5",
                  )}
                >
                  <Checkbox
                    id={`package-forward-server-${server.id}`}
                    checked={checked}
                    disabled={disabled}
                    onCheckedChange={(next) =>
                      toggle(server.id, next === true)
                    }
                    className="mt-0.5"
                  />
                  <Label
                    htmlFor={`package-forward-server-${server.id}`}
                    className="min-w-0 flex-1 cursor-pointer font-normal"
                  >
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-sm">{server.name}</span>
                      {server.group_name ? (
                        <Badge
                          variant="outline"
                          className="border-transparent bg-muted type-micro font-normal text-muted-foreground"
                        >
                          {server.group_name}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block truncate font-mono type-micro text-muted-foreground">
                      {server.address}
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
