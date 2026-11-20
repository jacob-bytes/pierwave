import { useEffect, useMemo, useState } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  EyeIcon,
  RefreshCwIcon,
  ScrollTextIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import {
  EmptyState,
  ListError,
  ListErrorRow,
  MobileDataCard,
  SkeletonCard,
  SkeletonTable,
} from "@/components/common";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollFade } from "@/components/common/ScrollFade";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AuditEntry } from "@/lib/api";
import {
  auditActionLabel,
  auditActionTone,
  resolveAuditTarget,
} from "@/lib/audit";
import {
  AUDIT_CATEGORY_GROUPS,
  auditCategoryAction,
  type AuditCategory,
} from "@/lib/auditCategories";
import type {
  AuditNameResolver,
  AuditTargetKind,
  AuditTone,
} from "@/lib/audit";
import {
  formatChangeText,
  formatChanges,
  formatFieldLabel,
  formatFieldValue,
} from "@/lib/auditChanges";
import type { ChangeEntityKind, ChangeResolver } from "@/lib/auditChanges";
import { copyText } from "@/lib/clipboard";
import { errorText } from "@/lib/errors";
import { formatJsonObject } from "@/lib/json";
import {
  useAllNodes,
  useApiTokens,
  useAuditLog,
  useCertificates,
  useChainTemplates,
  useChains,
  usePackages,
  useRuleTemplates,
  useServers,
  useUsers,
} from "@/lib/queries";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";
import { useIsDesktop } from "@/lib/useIsDesktop";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

const COLUMN_COUNT = 6;
const LIMIT_OPTIONS = [50, 200, 500] as const;
const SUMMARY_LIMIT = 2;
const HEAD_CLASS =
  "h-9 px-4 text-xs font-medium tracking-wide text-muted-foreground";

const toneClass: Record<AuditTone, string> = {
  primary: "bg-primary/10 text-primary",
  destructive: "bg-destructive/10 text-destructive",
  warning: "bg-warning/10 text-warning",
  muted: "bg-muted text-muted-foreground",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 创建类记录没有 changes，退回到最能说明对象身份的几个字段。 */
const FALLBACK_FIELDS = [
  "name",
  "username",
  "package_name",
  "tag",
  "domains",
  "keys",
  "address",
  "role",
  "version",
  "config_version",
  "warnings",
  "revoked_sessions",
] as const;

/**
 * 从 detail 里提炼一行极简摘要：
 * 1. user_package.bind / unbind 没有 diff，直接用「绑定套餐」这类人话；
 * 2. `changes` 与顶层 `{from, to}` 交给 `formatChanges`，字段名/值都翻成人话；
 * 3. 其余（create / upload / delete / settings）取第一个有意义的字段。
 */
function summarizeAudit(
  action: string,
  detail: unknown,
  resolve: ChangeResolver,
): string[] {
  const entries = isRecord(detail) ? Object.entries(detail) : [];
  const items: string[] = [];

  if (action === "user_package.bind" || action === "user_package.unbind") {
    const rawName = entries.find(([key]) => key === "package_name")?.[1];
    const packageName =
      typeof rawName === "string" && rawName.trim() ? rawName.trim() : null;
    const binding = action === "user_package.bind";
    if (packageName === null) {
      items.push(
        t(binding ? "audit.summary.bindPackage" : "audit.summary.unbindPackage"),
      );
    } else {
      items.push(
        t(
          binding
            ? "audit.summary.bindPackageNamed"
            : "audit.summary.unbindPackageNamed",
          { name: packageName },
        ),
      );
    }
  }

  if (action === "password.change") {
    items.push(t("audit.summary.passwordChanged"));
  }

  if (action === "user.reset_subscription") {
    items.push(t("audit.summary.subscriptionReset"));
  }

  if (action === "auth.login_failed") {
    const record = isRecord(detail) ? detail : {};
    const username =
      typeof record.username === "string" ? record.username : "—";
    const reason =
      typeof record.reason === "string" && record.reason
        ? t(`audit.reason.${record.reason}`)
        : "—";
    items.push(t("audit.summary.loginFailed", { username, reason }));
  } else if (action.startsWith("auth.")) {
    const ip = isRecord(detail) ? detail.ip : null;
    if (typeof ip === "string" && ip) {
      items.push(t("audit.summary.loginFromIp", { ip }));
    }
  }

  for (const item of formatChanges(detail, resolve)) {
    items.push(formatChangeText(item));
  }

  if (items.length === 0) {
    for (const field of FALLBACK_FIELDS) {
      const value = entries.find(([key]) => key === field)?.[1];
      if (value === undefined || value === null) continue;
      items.push(
        t("audit.changes.fieldValue", {
          label: formatFieldLabel(field),
          value: formatFieldValue(field, value, resolve),
        }),
      );
      break;
    }
  }

  return items;
}

/**
 * 审计页复用其它列表的缓存把 id 翻译成名称；只读，不额外造请求。
 * 转发没有跨服务器的全局列表，由 detail.name 兜底（后端写操作都带）。
 */
interface LookupMaps {
  users: Map<string, string>;
  packages: Map<string, string>;
  servers: Map<string, string>;
  ruleTemplates: Map<string, string>;
  chains: Map<string, string>;
  chainTemplates: Map<string, string>;
  certificates: Map<string, string>;
  apiTokens: Map<string, string>;
  nodes: Map<string, string>;
}

function detailJsonText(detail: unknown): string {
  // 正常是 JSON 对象；解析失败时后端会退化成字符串，原样展示便于排查。
  if (typeof detail === "string") return detail;
  if (detail === null || detail === undefined) return "{}";
  return formatJsonObject(detail);
}

function ActionBadge({ action }: { action: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "border-transparent font-normal",
        toneClass[auditActionTone(action)],
      )}
    >
      {auditActionLabel(action)}
    </Badge>
  );
}

function SummaryCell({
  action,
  detail,
  resolve,
}: {
  action: string;
  detail: unknown;
  resolve: ChangeResolver;
}) {
  const items = summarizeAudit(action, detail, resolve);

  if (items.length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  const visible = items.slice(0, SUMMARY_LIMIT);
  const hidden = items.slice(SUMMARY_LIMIT);

  return (
    <div className="flex max-w-[440px] flex-wrap items-center gap-x-1 gap-y-1 text-xs text-muted-foreground">
      {visible.map((item, index) => (
        <span key={`${index}-${item}`} className="whitespace-nowrap">
          {index > 0 ? (
            <span aria-hidden="true" className="px-1 text-muted-foreground">
              ·
            </span>
          ) : null}
          <span className="font-mono type-micro">{item}</span>
        </span>
      ))}
      {hidden.length > 0 ? (
        <span
          className="type-micro text-muted-foreground"
          title={hidden.join("\n")}
        >
          +{hidden.length}
        </span>
      ) : null}
    </div>
  );
}

function EmptyRow({
  filtered,
  onClear,
}: {
  filtered: boolean;
  onClear: () => void;
}) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={COLUMN_COUNT} className="px-4 py-8">
        <EmptyState
          size="sm"
          icon={ScrollTextIcon}
          title={filtered ? t("audit.empty.filtered") : t("audit.empty.all")}
          description={
            filtered ? t("audit.empty.filteredDesc") : t("audit.empty.allDesc")
          }
          action={
            filtered ? (
              <Button variant="outline" size="sm" onClick={onClear}>
                {t("audit.empty.clearFilters")}
              </Button>
            ) : undefined
          }
        />
      </TableCell>
    </TableRow>
  );
}


function DetailDialog({
  entry,
  onClose,
}: {
  entry: AuditEntry | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const text = entry ? detailJsonText(entry.detail) : "";

  // 关闭时顺手把「已复制」复位；弹窗是模态的，打开期间不会换记录。
  function close() {
    setCopied(false);
    onClose();
  }

  async function handleCopy() {
    if (!entry) return;
    const ok = await copyText(text);
    if (!ok) {
      toast.error(t("audit.detail.copyError"));
      return;
    }
    setCopied(true);
    toast.success(t("audit.detail.copied"));
  }

  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScrollTextIcon className="size-4 text-primary" />
            {t("audit.detail.title")}
          </DialogTitle>
          <DialogDescription>
            {entry
              ? t("audit.detail.desc", {
                  action: auditActionLabel(entry.action),
                  actor: entry.actor_name?.trim() || "—",
                  time: formatAbsoluteTime(entry.created_at),
                })
              : null}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              {t("audit.detail.json")}
            </span>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void handleCopy()}
              disabled={!entry}
            >
              {copied ? (
                <CheckIcon className="text-primary" />
              ) : (
                <CopyIcon />
              )}
              {copied ? t("common.copied") : t("common.copy")}
            </Button>
          </div>
          <pre className="max-h-[55vh] overflow-auto rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs leading-normal break-words whitespace-pre-wrap">
            {text}
          </pre>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 缓存只用来翻译 id；查不到（对象已删除）时按规范回落到 id 前缀。 */
function useLookupMaps(): LookupMaps {
  const users = useUsers("");
  const packages = usePackages();
  const servers = useServers();
  const ruleTemplates = useRuleTemplates();
  const chains = useChains();
  const chainTemplates = useChainTemplates();
  const certificates = useCertificates();
  const apiTokens = useApiTokens();
  const nodes = useAllNodes();

  return useMemo(
    () => ({
      users: new Map((users.data ?? []).map((user) => [user.id, user.username])),
      packages: new Map(
        (packages.data ?? []).map((item) => [item.id, item.name]),
      ),
      servers: new Map(
        (servers.data ?? []).map((item) => [item.id, item.name]),
      ),
      ruleTemplates: new Map(
        (ruleTemplates.data ?? []).map((item) => [item.id, item.name]),
      ),
      chains: new Map((chains.data ?? []).map((item) => [item.id, item.name])),
      chainTemplates: new Map(
        (chainTemplates.data ?? []).map((item) => [item.id, item.name]),
      ),
      certificates: new Map(
        (certificates.data ?? []).map((item) => [item.id, item.name]),
      ),
      apiTokens: new Map(
        (apiTokens.data ?? []).map((item) => [item.id, item.name]),
      ),
      nodes: new Map((nodes.data ?? []).map((item) => [item.id, item.name])),
    }),
    [
      users.data,
      packages.data,
      servers.data,
      ruleTemplates.data,
      chains.data,
      chainTemplates.data,
      certificates.data,
      apiTokens.data,
      nodes.data,
    ],
  );
}

/** 把缓存合成一个 `resolve(kind, id)`；未命中返回 undefined，由纯函数降级。 */
function useAuditNameResolver(maps: LookupMaps): AuditNameResolver {
  return useMemo(() => {
    const tables: Partial<Record<AuditTargetKind, Map<string, string>>> = {
      user: maps.users,
      package: maps.packages,
      server: maps.servers,
      rule_template: maps.ruleTemplates,
      chain: maps.chains,
      chain_template: maps.chainTemplates,
      certificate: maps.certificates,
      api_token: maps.apiTokens,
      node: maps.nodes,
    };
    return (kind, id) => tables[kind]?.get(id);
  }, [maps]);
}

/** 把四份缓存合成一个 `resolve(kind, id)`；未命中返回 undefined，由纯函数降级。 */
function useChangeResolver(maps: LookupMaps): ChangeResolver {
  return useMemo(() => {
    const tables: Record<ChangeEntityKind, Map<string, string>> = {
      rule_template: maps.ruleTemplates,
      user: maps.users,
      package: maps.packages,
      server: maps.servers,
    };
    return (kind, id) => tables[kind].get(id);
  }, [maps]);
}

function SearchField({
  value,
  onChange,
  onClear,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
  placeholder: string;
  ariaLabel: string;
}) {
  return (
    <div className="relative min-w-[7.5rem] flex-1 sm:w-48 sm:flex-none">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="pr-8 pl-8"
      />
      {value ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t("audit.clearSearch")}
          className="absolute top-1/2 right-1 -translate-y-1/2"
          onClick={onClear}
        >
          <XIcon className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

/**
 * 「操作审计」面板：由 `/logs` 的 tab 挂载。
 * 页面标题与 tab 外壳在 `Logs.tsx`；服务端筛选、游标分页与四态逻辑保持原样。
 */
export function AuditPanel() {
  useI18n();
  const isDesktop = useIsDesktop();
  const [actorInput, setActorInput] = useState("");
  const [actorQuery, setActorQuery] = useState("");
  const [targetInput, setTargetInput] = useState("");
  const [targetQuery, setTargetQuery] = useState("");
  const [category, setCategory] = useState<AuditCategory>("all");
  const [limit, setLimit] = useState<number>(LIMIT_OPTIONS[0]);
  const [detailEntry, setDetailEntry] = useState<AuditEntry | null>(null);

  // 输入后 300ms 才生效，避免每敲一个字都打一次接口。
  useEffect(() => {
    const timer = setTimeout(() => {
      setActorQuery(actorInput.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [actorInput]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setTargetQuery(targetInput.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [targetInput]);

  // 分类/搜索/每页条数都进 queryKey：任一变化都会重置列表并回到第一页。
  const action = auditCategoryAction(category);
  const audit = useAuditLog({
    limit,
    action,
    actor: actorQuery || undefined,
    target: targetQuery || undefined,
  });
  const maps = useLookupMaps();
  const resolveChange = useChangeResolver(maps);
  const resolveName = useAuditNameResolver(maps);

  const items = audit.data?.pages.flatMap((page) => page.items) ?? [];
  const filtersActive =
    category !== "all" || actorQuery !== "" || targetQuery !== "";
  const showError = audit.isError && !audit.data;
  const errorMessage = errorText(audit.error, t("audit.loadError"));

  function clearFilters() {
    setActorInput("");
    setActorQuery("");
    setTargetInput("");
    setTargetQuery("");
    setCategory("all");
  }

  /** 窄屏卡片：时间 / 操作者 / 动作 / 对象 / 摘要与桌面表格逐项对应。 */
  function renderCard(entry: AuditEntry) {
    const target = resolveAuditTarget(
      entry.action,
      entry.target,
      resolveName,
      entry.detail,
    );
    const actor = entry.actor_name?.trim() || "—";

    return (
      <MobileDataCard
        key={entry.id}
        title={<ActionBadge action={entry.action} />}
        subtitle={
          <span title={formatAbsoluteTime(entry.created_at)}>
            {formatRelativeTime(entry.created_at)}
          </span>
        }
        actions={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("common.details")}
            title={t("common.details")}
            onClick={() => setDetailEntry(entry)}
          >
            <EyeIcon className="size-3.5" />
          </Button>
        }
        fields={[
          {
            label: t("audit.columns.actor"),
            value: (
              <span title={entry.actor_id ?? undefined}>{actor}</span>
            ),
          },
          {
            label: t("audit.columns.target"),
            value: (
              <span
                className={cn(
                  "break-all",
                  !target.resolved && "text-muted-foreground",
                )}
                title={target.title}
              >
                {target.label}
              </span>
            ),
          },
          {
            label: t("audit.columns.summary"),
            value: (
              <SummaryCell
                action={entry.action}
                detail={entry.detail}
                resolve={resolveChange}
              />
            ),
          },
        ]}
      />
    );
  }

  return (
    <div className="space-y-6">
      <Card className="gap-0 overflow-hidden">
        <CardHeader className="border-b border-border">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              {t("audit.list")}
              {audit.data ? (
                <Badge
                  variant="secondary"
                  className="font-mono type-micro font-normal text-muted-foreground"
                >
                  {t("audit.loaded", { n: items.length })}
                </Badge>
              ) : null}
            </CardTitle>

            {/* 控件同行排列：标题在左、三个控件在右；窄屏整体占满一行并自动换行 */}
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <SearchField
                value={actorInput}
                onChange={setActorInput}
                onClear={() => {
                  setActorInput("");
                  setActorQuery("");
                }}
                placeholder={t("audit.searchActorPlaceholder")}
                ariaLabel={t("audit.searchActorAria")}
              />
              <SearchField
                value={targetInput}
                onChange={setTargetInput}
                onClear={() => {
                  setTargetInput("");
                  setTargetQuery("");
                }}
                placeholder={t("audit.searchTargetPlaceholder")}
                ariaLabel={t("audit.searchTargetAria")}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => void audit.refetch()}
                disabled={audit.isFetching}
              >
                <RefreshCwIcon
                  className={cn(
                    "size-3.5",
                    audit.isFetching && "animate-spin",
                  )}
                />
                {t("common.refresh")}
              </Button>
            </div>
          </div>
          <CardDescription className="text-xs">
            {t("audit.desc")}
          </CardDescription>
        </CardHeader>

        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <ScrollFade className="min-w-0 max-w-full">
            <Tabs
              value={category}
              onValueChange={(value) =>
                setCategory(value as AuditCategory)
              }
            >
              <TabsList className="w-max max-w-none">
                {AUDIT_CATEGORY_GROUPS.map((option) => (
                  <TabsTrigger key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </ScrollFade>

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {t("audit.limitLabel")}
            </span>
            <Select
              value={String(limit)}
              onValueChange={(value) => setLimit(Number(value))}
            >
              <SelectTrigger size="sm" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {LIMIT_OPTIONS.map((option) => (
                    <SelectItem key={option} value={String(option)}>
                      {t("audit.limitOption", { n: option })}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </div>

        <CardContent className="p-0" aria-busy={audit.isPending}>
          {isDesktop ? (
            <>
          {audit.isPending ? (
            <SkeletonTable rows={5} columns={COLUMN_COUNT} />
          ) : null}
          <Table
            className={cn("min-w-[980px]", audit.isPending && "hidden")}
          >
            <TableCaption className="sr-only">
              {t("audit.tableCaption")}
            </TableCaption>
            <TableHeader className="bg-muted/30">
              <TableRow>
                <TableHead sticky="left" className={HEAD_CLASS}>
                  {t("audit.columns.time")}
                </TableHead>
                <TableHead className={HEAD_CLASS}>
                  {t("audit.columns.actor")}
                </TableHead>
                <TableHead className={HEAD_CLASS}>
                  {t("audit.columns.action")}
                </TableHead>
                <TableHead className={HEAD_CLASS}>
                  {t("audit.columns.target")}
                </TableHead>
                <TableHead className={HEAD_CLASS}>
                  {t("audit.columns.summary")}
                </TableHead>
                <TableHead sticky="right" className={cn(HEAD_CLASS, "text-right")}>
                  {t("audit.columns.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {showError ? (
                <ListErrorRow
                  colSpan={COLUMN_COUNT}
                  title={t("audit.loadFailed")}
                  message={errorMessage}
                  onRetry={() => void audit.refetch()}
                  retrying={audit.isFetching}
                />
              ) : items.length === 0 ? (
                <EmptyRow filtered={filtersActive} onClear={clearFilters} />
              ) : (
                items.map((entry) => {
                  const target = resolveAuditTarget(
                    entry.action,
                    entry.target,
                    resolveName,
                    entry.detail,
                  );

                  return (
                    <TableRow key={entry.id}>
                      <TableCell sticky="left" className="px-4 py-2.5">
                        <span
                          className="text-xs whitespace-nowrap tabular-nums text-muted-foreground"
                          title={formatAbsoluteTime(entry.created_at)}
                        >
                          {formatRelativeTime(entry.created_at)}
                        </span>
                      </TableCell>
                      <TableCell
                        className="max-w-40 truncate px-4 py-2.5 text-sm"
                        title={entry.actor_id ?? undefined}
                      >
                        {entry.actor_name?.trim() || "—"}
                      </TableCell>
                      <TableCell className="px-4 py-2.5">
                        <ActionBadge action={entry.action} />
                      </TableCell>
                      <TableCell className="max-w-56 px-4 py-2.5">
                        <span
                          className={cn(
                            "block truncate text-sm",
                            !target.resolved && "text-muted-foreground",
                          )}
                          title={target.title}
                        >
                          {target.label}
                        </span>
                      </TableCell>
                      <TableCell className="px-4 py-2.5">
                        <SummaryCell
                          action={entry.action}
                          detail={entry.detail}
                          resolve={resolveChange}
                        />
                      </TableCell>
                      <TableCell sticky="right" className="px-4 py-2.5 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDetailEntry(entry)}
                        >
                          <EyeIcon className="size-3.5" />
                          {t("common.details")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
            </>
          ) : audit.isPending ? (
            <div className="space-y-3 p-3">
              {Array.from({ length: 3 }).map((_, index) => (
                <SkeletonCard key={index} lines={4} />
              ))}
            </div>
          ) : (
            <div className="space-y-3 p-3">
              {showError ? (
                <ListError
                  title={t("audit.loadFailed")}
                  message={errorMessage}
                  onRetry={() => void audit.refetch()}
                  retrying={audit.isFetching}
                />
              ) : items.length === 0 ? (
                <EmptyState
                  size="sm"
                  icon={ScrollTextIcon}
                  title={t(
                    filtersActive
                      ? "audit.empty.filtered"
                      : "audit.empty.all",
                  )}
                  description={t(
                    filtersActive
                      ? "audit.empty.filteredDesc"
                      : "audit.empty.allDesc",
                  )}
                  action={
                    filtersActive ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={clearFilters}
                      >
                        {t("audit.empty.clearFilters")}
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                items.map(renderCard)
              )}
            </div>
          )}

          {!audit.isPending && !showError && items.length > 0 ? (
            <div className="flex flex-col items-center gap-2 border-t border-border px-4 py-3">
              {audit.hasNextPage ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void audit.fetchNextPage()}
                  disabled={audit.isFetchingNextPage}
                >
                  {audit.isFetchingNextPage ? (
                    <RefreshCwIcon className="size-3.5 animate-spin" />
                  ) : (
                    <ChevronDownIcon className="size-3.5" />
                  )}
                  {audit.isFetchingNextPage
                    ? t("audit.loadingMore")
                    : t("audit.loadMore")}
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t("audit.allLoaded")}
                </p>
              )}
              {audit.isFetchNextPageError ? (
                <p className="text-xs text-destructive">
                  {t("audit.loadMoreError")}
                </p>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <DetailDialog
        entry={detailEntry}
        onClose={() => setDetailEntry(null)}
      />
    </div>
  );
}
