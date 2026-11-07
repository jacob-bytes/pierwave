import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  InfoIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  RouteIcon,
  SendIcon,
  Trash2Icon,
  TriangleAlertIcon,
  WaypointsIcon,
} from "lucide-react";
import { DeleteOutboundDialog } from "@/components/outbounds/DeleteOutboundDialog";
import { DeleteRoutingRuleDialog } from "@/components/outbounds/DeleteRoutingRuleDialog";
import { OutboundFormDialog } from "@/components/outbounds/OutboundFormDialog";
import { RoutingRuleFormDialog } from "@/components/outbounds/RoutingRuleFormDialog";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Outbound, RoutingRule } from "@/lib/api";
import {
  outboundErrorText,
  outboundProtocolLabel,
} from "@/lib/outbounds";
import {
  useApplyServer,
  useOutbounds,
  useReorderRoutingRules,
  useRoutingRules,
  useServers,
  useUpdateOutbound,
  useUpdateRoutingRule,
} from "@/lib/queries";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

const OUTBOUND_COLUMN_COUNT = 5;
const RULE_COLUMN_COUNT = 5;
const HEAD_CLASS =
  "h-9 px-4 text-xs font-medium tracking-wide text-muted-foreground";

function OutboundEnabledSwitch({
  serverId,
  outbound,
}: {
  serverId: string;
  outbound: Outbound;
}) {
  const { t } = useI18n();
  const update = useUpdateOutbound(serverId);
  const enabled = Boolean(outbound.enabled);

  return (
    <div className="flex items-center gap-2">
      <Switch
        size="sm"
        checked={enabled}
        disabled={update.isPending}
        aria-label={t("outbounds.toggleAria", {
          action: enabled
            ? t("outbounds.disableAction")
            : t("outbounds.enableAction"),
          tag: outbound.tag,
        })}
        onCheckedChange={(checked) => {
          update.mutate(
            { id: outbound.id, input: { enabled: checked } },
            {
              onSuccess: () => {
                toast.success(
                  checked
                    ? t("outbounds.enabledToast", { tag: outbound.tag })
                    : t("outbounds.disabledToast", { tag: outbound.tag }),
                );
              },
              onError: (error) => {
                toast.error(
                  outboundErrorText(error, t("outbounds.toggleError")),
                );
              },
            },
          );
        }}
      />
      <span className="text-xs text-muted-foreground">
        {enabled ? t("common.enabled") : t("common.disabled")}
      </span>
    </div>
  );
}

function RuleEnabledSwitch({
  serverId,
  rule,
}: {
  serverId: string;
  rule: RoutingRule;
}) {
  const { t } = useI18n();
  const update = useUpdateRoutingRule(serverId);
  const enabled = Boolean(rule.enabled);

  return (
    <div className="flex items-center gap-2">
      <Switch
        size="sm"
        checked={enabled}
        disabled={update.isPending}
        aria-label={t("outbounds.rules.toggleAria", {
          action: enabled
            ? t("outbounds.rules.disableAction")
            : t("outbounds.rules.enableAction"),
        })}
        onCheckedChange={(checked) => {
          update.mutate(
            { id: rule.id, input: { enabled: checked } },
            {
              onSuccess: () => {
                toast.success(
                  checked
                    ? t("outbounds.rules.enabledToast")
                    : t("outbounds.rules.disabledToast"),
                );
              },
              onError: (error) => {
                toast.error(
                  outboundErrorText(error, t("outbounds.rules.toggleError")),
                );
              },
            },
          );
        }}
      />
      <span className="text-xs text-muted-foreground">
        {enabled ? t("common.enabled") : t("common.disabled")}
      </span>
    </div>
  );
}

/** 「入站 X」「域名 a,b」「IP c」的组合展示；全空时显示破折号。 */
function RuleMatch({ rule }: { rule: RoutingRule }) {
  const { t } = useI18n();
  const parts: string[] = [];

  if (rule.inbound_tag?.trim()) {
    parts.push(
      t("outbounds.rules.inboundMatch", { tag: rule.inbound_tag.trim() }),
    );
  }
  if (rule.domain?.trim()) {
    parts.push(
      t("outbounds.rules.domainMatch", { value: rule.domain.trim() }),
    );
  }
  if (rule.ip?.trim()) {
    parts.push(t("outbounds.rules.ipMatch", { value: rule.ip.trim() }));
  }

  if (parts.length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  return (
    <div className="flex max-w-md flex-wrap gap-1">
      {parts.map((part) => (
        <span
          key={part}
          className="max-w-full rounded-md border border-border bg-muted/30 px-1.5 py-0.5 font-mono text-[11px] break-all text-muted-foreground"
        >
          {part}
        </span>
      ))}
    </div>
  );
}

function LoadingRows({
  columns,
  rows = 4,
}: {
  columns: number;
  rows?: number;
}) {
  const widths = ["w-24", "w-20", "w-14", "w-20", "w-16", "w-12"];

  return (
    <>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <TableRow key={rowIndex} className="hover:bg-transparent">
          {Array.from({ length: columns }).map((__, columnIndex) => (
            <TableCell key={columnIndex} className="px-4 py-3">
              <Skeleton
                className={cn(
                  "h-3.5",
                  widths[columnIndex % widths.length],
                )}
              />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

function ErrorRow({
  colSpan,
  title,
  message,
  onRetry,
  retrying,
}: {
  colSpan: number;
  title: string;
  message: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  const { t } = useI18n();

  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={colSpan} className="px-4 py-16">
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 text-center">
          <div className="grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
            <TriangleAlertIcon className="size-5" />
          </div>
          <div>
            <p className="text-sm font-medium">{title}</p>
            <p className="mt-1 text-xs text-muted-foreground">{message}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            disabled={retrying}
          >
            <RefreshCwIcon
              className={cn("size-3.5", retrying && "animate-spin")}
            />
            {t("common.retry")}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function EmptyRow({
  colSpan,
  icon,
  title,
  description,
  actionLabel,
  onAction,
}: {
  colSpan: number;
  icon: ReactNode;
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={colSpan} className="px-4 py-16">
        <div className="mx-auto flex max-w-sm flex-col items-center gap-3 text-center">
          <div className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
            {icon}
          </div>
          <div>
            <p className="text-sm font-medium">{title}</p>
            <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          </div>
          <Button variant="outline" size="sm" onClick={onAction}>
            <PlusIcon className="size-3.5" />
            {actionLabel}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

export default function OutboundsPage() {
  useI18n();
  const { id: serverId = "" } = useParams();
  const servers = useServers();
  const outbounds = useOutbounds(serverId);
  const rules = useRoutingRules(serverId);
  const apply = useApplyServer(serverId);
  const reorder = useReorderRoutingRules(serverId);

  const [outboundForm, setOutboundForm] = useState<{
    mode: "create" | "edit";
    outbound?: Outbound;
  } | null>(null);
  const [outboundDeleteTarget, setOutboundDeleteTarget] =
    useState<Outbound | null>(null);
  const [ruleForm, setRuleForm] = useState<{
    mode: "create" | "edit";
    rule?: RoutingRule;
  } | null>(null);
  const [ruleDeleteTarget, setRuleDeleteTarget] =
    useState<RoutingRule | null>(null);

  const server = servers.data?.find((item) => item.id === serverId);
  const outboundItems = outbounds.data ?? [];
  const ruleItems = rules.data ?? [];

  const outboundShowError = outbounds.isError && !outbounds.data;
  const ruleShowError = rules.isError && !rules.data;
  const outboundError = outboundErrorText(
    outbounds.error,
    t("outbounds.loadError"),
  );
  const ruleError = outboundErrorText(rules.error, t("outbounds.rules.loadError"));

  function handleApply() {
    if (!serverId || apply.isPending) return;

    apply.mutate(undefined, {
      onSuccess: (result) => {
        toast.success(
          t("outbounds.applySuccess", { version: result.config_version }),
        );
      },
      onError: (error) => {
        toast.error(outboundErrorText(error, t("outbounds.applyError")));
      },
    });
  }

  function moveRule(index: number, delta: -1 | 1) {
    if (reorder.isPending) return;

    const target = index + delta;
    if (target < 0 || target >= ruleItems.length) return;

    const next = [...ruleItems];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);

    const previousOrder = new Map(
      ruleItems.map((item) => [item.id, item.sort_order]),
    );
    const ordered = next.map((item, nextIndex) => ({
      ...item,
      sort_order: nextIndex,
    }));
    const patches = ordered
      .filter((item) => previousOrder.get(item.id) !== item.sort_order)
      .map((item) => ({ id: item.id, sort_order: item.sort_order }));

    reorder.mutate(
      { ordered, patches },
      {
        onError: (error) => {
          toast.error(
            outboundErrorText(error, t("outbounds.rules.orderError")),
          );
        },
      },
    );
  }

  return (
    <div className="animate-in space-y-6 fade-in-0 slide-in-from-bottom-1 duration-150">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <Link
            to="/servers"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
          >
            <ArrowLeftIcon className="size-3" />
            {t("outbounds.backServers")}
          </Link>
          <h1 className="mt-1 flex min-w-0 items-center gap-2 text-xl font-semibold tracking-tight">
            <span className="shrink-0">{t("outbounds.title")}</span>
            <span className="text-muted-foreground">·</span>
            {servers.isPending ? (
              <Skeleton className="h-5 w-32" />
            ) : (
              <span className="truncate">
                {server?.name ?? t("outbounds.unknownServer")}
              </span>
            )}
            {server ? (
              <Badge
                variant="secondary"
                className="font-mono text-[11px] font-normal text-muted-foreground"
              >
                v{server.config_version}
              </Badge>
            ) : null}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("outbounds.subtitle")}
          </p>
        </div>
      </div>

      <Alert className="items-center">
        <InfoIcon />
        <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <AlertTitle>{t("outbounds.applyHint")}</AlertTitle>
            <AlertDescription>{t("outbounds.applyHintDesc")}</AlertDescription>
          </div>
          <Button
            size="sm"
            className="shrink-0"
            onClick={handleApply}
            disabled={!serverId || apply.isPending}
          >
            {apply.isPending ? (
              <RefreshCwIcon className="animate-spin" />
            ) : (
              <SendIcon />
            )}
            {apply.isPending ? t("outbounds.applying") : t("outbounds.apply")}
          </Button>
        </div>
      </Alert>

      <Card className="gap-0 overflow-hidden">
        <CardHeader className="border-b border-border">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              {t("outbounds.outbounds.title")}
              {outbounds.data ? (
                <Badge
                  variant="secondary"
                  className="font-mono text-[11px] font-normal text-muted-foreground"
                >
                  {outboundItems.length}
                </Badge>
              ) : null}
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void outbounds.refetch()}
                disabled={outbounds.isFetching}
              >
                <RefreshCwIcon
                  className={cn(
                    "size-3.5",
                    outbounds.isFetching && "animate-spin",
                  )}
                />
                {t("common.refresh")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setOutboundForm({ mode: "create" })}
                disabled={!serverId}
              >
                <PlusIcon className="size-3.5" />
                {t("outbounds.outbounds.add")}
              </Button>
            </div>
          </div>
          <CardDescription className="text-xs">
            {t("outbounds.outbounds.desc")}
          </CardDescription>
        </CardHeader>

        <CardContent className="p-0">
          <Table className="min-w-[720px]" aria-busy={outbounds.isPending}>
            <TableCaption className="sr-only">
              {t("outbounds.outbounds.tableCaption")}
            </TableCaption>
            <TableHeader className="bg-muted/30">
              <TableRow>
                {[
                  t("outbounds.outbounds.columns.tag"),
                  t("outbounds.outbounds.columns.protocol"),
                  t("outbounds.outbounds.columns.enabled"),
                  t("outbounds.outbounds.columns.createdAt"),
                  t("common.actions"),
                ].map((label) => (
                  <TableHead key={label} className={HEAD_CLASS}>
                    {label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {outbounds.isPending ? (
                <LoadingRows columns={OUTBOUND_COLUMN_COUNT} />
              ) : outboundShowError ? (
                <ErrorRow
                  colSpan={OUTBOUND_COLUMN_COUNT}
                  title={t("outbounds.outbounds.loadFailed")}
                  message={outboundError}
                  onRetry={() => void outbounds.refetch()}
                  retrying={outbounds.isFetching}
                />
              ) : outboundItems.length === 0 ? (
                <EmptyRow
                  colSpan={OUTBOUND_COLUMN_COUNT}
                  icon={<RouteIcon className="size-5" />}
                  title={t("outbounds.outbounds.emptyTitle")}
                  description={t("outbounds.outbounds.emptyDesc")}
                  actionLabel={t("outbounds.outbounds.emptyAction")}
                  onAction={() => setOutboundForm({ mode: "create" })}
                />
              ) : (
                outboundItems.map((outbound) => (
                  <TableRow key={outbound.id}>
                    <TableCell className="px-4 py-2.5 font-mono text-xs font-medium">
                      {outbound.tag}
                    </TableCell>
                    <TableCell className="px-4 py-2.5">
                      <Badge
                        variant="outline"
                        className="font-mono text-[11px] font-normal text-muted-foreground"
                      >
                        {outboundProtocolLabel(outbound.protocol)}
                      </Badge>
                    </TableCell>
                    <TableCell className="px-4 py-2.5">
                      <OutboundEnabledSwitch
                        serverId={serverId}
                        outbound={outbound}
                      />
                    </TableCell>
                    <TableCell className="px-4 py-2.5 text-xs text-muted-foreground">
                      <span title={formatAbsoluteTime(outbound.created_at)}>
                        {formatRelativeTime(outbound.created_at)}
                      </span>
                    </TableCell>
                    <TableCell className="px-4 py-2.5">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("outbounds.actionsAria", {
                              tag: outbound.tag,
                            })}
                          >
                            <MoreHorizontalIcon className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-36">
                          <DropdownMenuItem
                            onSelect={() =>
                              setOutboundForm({ mode: "edit", outbound })
                            }
                          >
                            <PencilIcon className="size-3.5" />
                            {t("common.edit")}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() =>
                              setOutboundDeleteTarget(outbound)
                            }
                          >
                            <Trash2Icon className="size-3.5" />
                            {t("common.delete")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="gap-0 overflow-hidden">
        <CardHeader className="border-b border-border">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              {t("outbounds.rules.title")}
              {rules.data ? (
                <Badge
                  variant="secondary"
                  className="font-mono text-[11px] font-normal text-muted-foreground"
                >
                  {ruleItems.length}
                </Badge>
              ) : null}
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void rules.refetch()}
                disabled={rules.isFetching}
              >
                <RefreshCwIcon
                  className={cn(
                    "size-3.5",
                    rules.isFetching && "animate-spin",
                  )}
                />
                {t("common.refresh")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRuleForm({ mode: "create" })}
                disabled={!serverId}
              >
                <PlusIcon className="size-3.5" />
                {t("outbounds.rules.add")}
              </Button>
            </div>
          </div>
          <CardDescription className="text-xs">
            {t("outbounds.rules.desc")}
          </CardDescription>
        </CardHeader>

        <CardContent className="p-0">
          <Table className="min-w-[760px]" aria-busy={rules.isPending}>
            <TableCaption className="sr-only">
              {t("outbounds.rules.tableCaption")}
            </TableCaption>
            <TableHeader className="bg-muted/30">
              <TableRow>
                {[
                  t("outbounds.rules.columns.order"),
                  t("outbounds.rules.columns.match"),
                  t("outbounds.rules.columns.target"),
                  t("outbounds.rules.columns.enabled"),
                  t("common.actions"),
                ].map((label) => (
                  <TableHead key={label} className={HEAD_CLASS}>
                    {label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.isPending ? (
                <LoadingRows columns={RULE_COLUMN_COUNT} />
              ) : ruleShowError ? (
                <ErrorRow
                  colSpan={RULE_COLUMN_COUNT}
                  title={t("outbounds.rules.loadFailed")}
                  message={ruleError}
                  onRetry={() => void rules.refetch()}
                  retrying={rules.isFetching}
                />
              ) : ruleItems.length === 0 ? (
                <EmptyRow
                  colSpan={RULE_COLUMN_COUNT}
                  icon={<WaypointsIcon className="size-5" />}
                  title={t("outbounds.rules.emptyTitle")}
                  description={t("outbounds.rules.emptyDesc")}
                  actionLabel={t("outbounds.rules.emptyAction")}
                  onAction={() => setRuleForm({ mode: "create" })}
                />
              ) : (
                ruleItems.map((rule, index) => (
                  <TableRow key={rule.id}>
                    <TableCell className="px-4 py-2">
                      <div className="flex items-center gap-1">
                        <span className="w-5 text-right font-mono text-xs tabular-nums text-muted-foreground">
                          {index + 1}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={t("outbounds.rules.moveUpAria", {
                            index: index + 1,
                          })}
                          disabled={index === 0 || reorder.isPending}
                          onClick={() => moveRule(index, -1)}
                        >
                          <ArrowUpIcon />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={t("outbounds.rules.moveDownAria", {
                            index: index + 1,
                          })}
                          disabled={
                            index === ruleItems.length - 1 ||
                            reorder.isPending
                          }
                          onClick={() => moveRule(index, 1)}
                        >
                          <ArrowDownIcon />
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell className="px-4 py-2.5">
                      <RuleMatch rule={rule} />
                    </TableCell>
                    <TableCell className="px-4 py-2.5">
                      <Badge
                        variant="outline"
                        className="font-mono text-[11px] font-normal"
                      >
                        {rule.outbound_tag}
                      </Badge>
                    </TableCell>
                    <TableCell className="px-4 py-2.5">
                      <RuleEnabledSwitch serverId={serverId} rule={rule} />
                    </TableCell>
                    <TableCell className="px-4 py-2.5">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("outbounds.rules.actionsAria", {
                              index: index + 1,
                            })}
                          >
                            <MoreHorizontalIcon className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-36">
                          <DropdownMenuItem
                            onSelect={() => setRuleForm({ mode: "edit", rule })}
                          >
                            <PencilIcon className="size-3.5" />
                            {t("common.edit")}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => setRuleDeleteTarget(rule)}
                          >
                            <Trash2Icon className="size-3.5" />
                            {t("common.delete")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {outboundForm ? (
        <OutboundFormDialog
          key={`${outboundForm.mode}-${outboundForm.outbound?.id ?? "new"}`}
          open
          serverId={serverId}
          mode={outboundForm.mode}
          outbound={outboundForm.outbound}
          onOpenChange={(open) => {
            if (!open) setOutboundForm(null);
          }}
        />
      ) : null}

      {outboundDeleteTarget ? (
        <DeleteOutboundDialog
          key={outboundDeleteTarget.id}
          open
          serverId={serverId}
          outbound={outboundDeleteTarget}
          onOpenChange={(open) => {
            if (!open) setOutboundDeleteTarget(null);
          }}
        />
      ) : null}

      {ruleForm ? (
        <RoutingRuleFormDialog
          key={`${ruleForm.mode}-${ruleForm.rule?.id ?? "new"}`}
          open
          serverId={serverId}
          mode={ruleForm.mode}
          rule={ruleForm.rule}
          onOpenChange={(open) => {
            if (!open) setRuleForm(null);
          }}
        />
      ) : null}

      {ruleDeleteTarget ? (
        <DeleteRoutingRuleDialog
          key={ruleDeleteTarget.id}
          open
          serverId={serverId}
          rule={ruleDeleteTarget}
          onOpenChange={(open) => {
            if (!open) setRuleDeleteTarget(null);
          }}
        />
      ) : null}
    </div>
  );
}
