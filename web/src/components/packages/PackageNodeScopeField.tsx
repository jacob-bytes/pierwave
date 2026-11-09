import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  BanIcon,
  FilterIcon,
  GlobeIcon,
  ListChecksIcon,
  NetworkIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, type NodeSummary } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { nodeSummary } from "@/lib/protocols";
import { useAllNodes } from "@/lib/queries";
import type { PackageNodeScope } from "@/lib/schemas";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

interface PackageNodeScopeFieldProps {
  value: PackageNodeScope;
  onChange: (value: PackageNodeScope) => void;
  selectedIds: string[];
  onSelectedChange: (ids: string[]) => void;
  disabled?: boolean;
}

const SCOPE_OPTIONS = [
  {
    value: "all",
    titleKey: "packages.nodeScope.all",
    hintKey: "packages.nodeScope.allHint",
    Icon: GlobeIcon,
  },
  {
    value: "selected",
    titleKey: "packages.nodeScope.selected",
    hintKey: "packages.nodeScope.selectedHint",
    Icon: ListChecksIcon,
  },
  {
    value: "none",
    titleKey: "packages.nodeScope.none",
    hintKey: "packages.nodeScope.noneHint",
    Icon: BanIcon,
  },
] as const;

/** 全局节点接口可能还没上线：404 单独给一句可操作的中文兜底。 */
function nodesErrorText(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return t("packages.nodeScope.error404");
  }
  return errorText(error, t("packages.nodeScope.loadError"));
}

export function PackageNodeScopeField({
  value,
  onChange,
  selectedIds,
  onSelectedChange,
  disabled = false,
}: PackageNodeScopeFieldProps) {
  const nodesQuery = useAllNodes();
  const nodes = useMemo(() => nodesQuery.data ?? [], [nodesQuery.data]);
  const [enabledOnly, setEnabledOnly] = useState(false);

  const visibleNodes = useMemo(
    () => (enabledOnly ? nodes.filter((node) => Boolean(node.enabled)) : nodes),
    [nodes, enabledOnly],
  );

  const groups = useMemo(() => {
    // 按 server_id 分组、用 server_name 作标题：同名服务器不会被合并。
    const byServer = new Map<
      string,
      { serverName: string; items: NodeSummary[] }
    >();
    for (const node of visibleNodes) {
      const bucket = byServer.get(node.server_id);
      if (bucket) bucket.items.push(node);
      else
        byServer.set(node.server_id, {
          serverName: node.server_name,
          items: [node],
        });
    }
    return Array.from(byServer, ([serverId, group]) => ({
      serverId,
      ...group,
    }));
  }, [visibleNodes]);

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const loaded = nodesQuery.isSuccess;
  const noNodes = loaded && nodes.length === 0;

  function toggleNode(id: string, checked: boolean) {
    const next = new Set(selectedIds);
    if (checked) next.add(id);
    else next.delete(id);
    onSelectedChange([...next]);
  }

  function selectVisible() {
    const next = new Set(selectedIds);
    for (const node of visibleNodes) next.add(node.id);
    onSelectedChange([...next]);
  }

  return (
    <div className="space-y-3">
      <RadioGroup
        aria-label={t("packages.nodeScope.aria")}
        value={value}
        onValueChange={(next) => onChange(next as PackageNodeScope)}
        disabled={disabled}
        className="grid gap-2 sm:grid-cols-3"
      >
        {SCOPE_OPTIONS.map((option) => {
          const Icon = option.Icon;
          const optionDisabled =
            disabled || (option.value === "selected" && noNodes);
          const active = value === option.value;

          return (
            <Label
              key={option.value}
              htmlFor={`package-node-scope-${option.value}`}
              className={cn(
                "flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-card p-3 transition-colors duration-150 hover:bg-muted/40",
                active && "border-primary/60 bg-primary/5 hover:bg-primary/5",
                optionDisabled && "cursor-not-allowed opacity-60",
              )}
            >
              <RadioGroupItem
                id={`package-node-scope-${option.value}`}
                value={option.value}
                disabled={optionDisabled}
                className="mt-0.5"
              />
              <span className="min-w-0 space-y-1">
                <span className="flex items-center gap-1.5">
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="text-sm font-medium">{t(option.titleKey)}</span>
                </span>
                <span className="block text-micro leading-normal text-muted-foreground">
                  {option.value === "selected" && noNodes
                    ? t("packages.nodeScope.noNodesHint")
                    : t(option.hintKey)}
                </span>
              </span>
            </Label>
          );
        })}
      </RadioGroup>

      {noNodes ? (
        <Alert>
          <NetworkIcon />
          <AlertTitle>{t("packages.nodeScope.noNodesTitle")}</AlertTitle>
          <AlertDescription>
            {t("packages.nodeScope.noNodesDescPrefix")}{" "}
            <Link
              to="/nodes"
              className="font-medium text-foreground underline underline-offset-3"
            >
              {t("packages.nodeScope.noNodesLink")}
            </Link>{" "}
            {t("packages.nodeScope.noNodesDescSuffix")}
          </AlertDescription>
        </Alert>
      ) : null}

      {value === "selected" ? (
        <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
          {nodesQuery.isPending ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Skeleton className="h-7 w-48" />
                <Skeleton className="h-3.5 w-20" />
              </div>
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="flex items-center gap-2 px-1 py-1">
                  <Skeleton className="size-4 rounded-[4px]" />
                  <Skeleton className="h-3.5 w-40" />
                </div>
              ))}
            </div>
          ) : nodesQuery.isError ? (
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>{t("packages.nodeScope.loadFailedTitle")}</AlertTitle>
              <AlertDescription>
                {nodesErrorText(nodesQuery.error)}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => void nodesQuery.refetch()}
                  disabled={nodesQuery.isFetching}
                >
                  <RefreshCwIcon
                    className={cn(
                      "size-3.5",
                      nodesQuery.isFetching && "animate-spin",
                    )}
                  />
                  {t("common.retry")}
                </Button>
              </AlertDescription>
            </Alert>
          ) : nodes.length === 0 ? (
            <p className="py-2 text-center text-xs text-muted-foreground">
              {t("packages.nodeScope.empty")}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={selectVisible}
                    disabled={disabled}
                    title={t("packages.nodeScope.selectAllTitle")}
                  >
                    {t("packages.nodeScope.selectAll")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onSelectedChange([])}
                    disabled={disabled || selectedIds.length === 0}
                  >
                    {t("packages.nodeScope.clear")}
                  </Button>
                  <Button
                    type="button"
                    variant={enabledOnly ? "secondary" : "outline"}
                    size="sm"
                    aria-pressed={enabledOnly}
                    onClick={() => setEnabledOnly((prev) => !prev)}
                    disabled={disabled}
                  >
                    <FilterIcon className="size-3.5" />
                    {t("packages.nodeScope.enabledOnly")}
                  </Button>
                </div>
                <span
                  aria-live="polite"
                  className="font-mono text-xs text-muted-foreground"
                >
                  {t("packages.nodeScope.selectedCount", {
                    selected: selectedIds.length,
                    total: nodes.length,
                  })}
                </span>
              </div>

              {visibleNodes.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  {t("packages.nodeScope.filterEmpty")}
                </p>
              ) : (
                <ScrollArea className="h-64">
                  <div className="space-y-1 pr-3">
                    {groups.map((group, groupIndex) => (
                      <div key={group.serverId}>
                        <div
                          className={cn(
                            "flex items-center gap-1.5 px-1 pb-1 text-micro font-medium tracking-wide text-muted-foreground",
                            groupIndex === 0 ? "pt-0" : "pt-2",
                          )}
                        >
                          <NetworkIcon className="size-3 shrink-0" />
                          <span className="truncate">{group.serverName}</span>
                          <span className="font-mono text-muted-foreground">
                            {group.items.length}
                          </span>
                        </div>
                        <div className="space-y-0.5">
                          {group.items.map((node) => {
                            const enabled = Boolean(node.enabled);
                            const checked = selected.has(node.id);

                            return (
                              <div
                                key={node.id}
                                className={cn(
                                  "flex items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors duration-150 hover:bg-muted/40",
                                  checked && "bg-primary/5",
                                  !enabled && "text-muted-foreground",
                                )}
                              >
                                <Checkbox
                                  id={`package-node-${node.id}`}
                                  checked={checked}
                                  disabled={disabled}
                                  onCheckedChange={(next) =>
                                    toggleNode(node.id, next === true)
                                  }
                                  className="mt-0.5"
                                />
                                <Label
                                  htmlFor={`package-node-${node.id}`}
                                  className={cn(
                                    "min-w-0 flex-1 cursor-pointer font-normal",
                                    !enabled && "text-muted-foreground",
                                  )}
                                >
                                  <span className="flex flex-wrap items-center gap-1.5">
                                    <span className="truncate text-sm">
                                      {node.name}
                                    </span>
                                    {!enabled ? (
                                      <Badge
                                        variant="outline"
                                        className="border-transparent bg-muted text-micro font-normal text-muted-foreground"
                                      >
                                        {t("packages.nodeScope.disabled")}
                                      </Badge>
                                    ) : null}
                                  </span>
                                  <span className="mt-0.5 block truncate font-mono text-micro text-muted-foreground">
                                    {nodeSummary(
                                      node.protocol,
                                      node.transport,
                                      node.security,
                                    )}
                                  </span>
                                </Label>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </>
          )}
        </div>
      ) : null}

      {value === "none" ? (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>{t("packages.nodeScope.noneTitle")}</AlertTitle>
          <AlertDescription>
            {t("packages.nodeScope.noneDesc")}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
