import { useEffect, useMemo, useState } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  EyeIcon,
  RefreshCwIcon,
  ScrollTextIcon,
  SearchIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
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
  useAuditLog,
  usePackages,
  useRuleTemplates,
  useServers,
  useUsers,
} from "@/lib/queries";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

const COLUMN_COUNT = 6;
const LIMIT_OPTIONS = [50, 200, 500] as const;
const TARGET_PREVIEW_LENGTH = 8;
const SUMMARY_LIMIT = 2;
const HEAD_CLASS =
  "h-9 px-4 text-xs font-medium tracking-wide text-muted-foreground";

type Category =
  | "all"
  | "user"
  | "package"
  | "server"
  | "node"
  | "certificate"
  | "rule_template"
  | "chain"
  | "forward"
  | "backup"
  | "system";

type Tone = "primary" | "destructive" | "warning" | "muted";

/**
 * 分类 → 服务端动作前缀。
 *
 * 后端按前缀匹配（逗号分隔的多个前缀是 OR）：
 * - `user` 同时命中 `user.*` 与 `user_package.*`（没有点号，所以两者都覆盖）；
 * - `system` 覆盖设置、改密码、应用配置三类动作。
 */
const CATEGORY_ACTION_PREFIX: Record<Exclude<Category, "all">, string> = {
  user: "user",
  package: "package",
  server: "server",
  node: "node",
  certificate: "certificate",
  rule_template: "rule_template",
  chain: "chain",
  forward: "forward",
  backup: "backup",
  system: "settings,password,config.apply,agent.upgrade",
};

const CATEGORIES: { value: Category; labelKey: string }[] = [
  { value: "all", labelKey: "audit.category.all" },
  { value: "user", labelKey: "audit.category.user" },
  { value: "package", labelKey: "audit.category.package" },
  { value: "server", labelKey: "audit.category.server" },
  { value: "node", labelKey: "audit.category.node" },
  { value: "certificate", labelKey: "audit.category.certificate" },
  { value: "rule_template", labelKey: "audit.category.ruleTemplate" },
  { value: "chain", labelKey: "audit.category.chain" },
  { value: "forward", labelKey: "audit.category.forward" },
  { value: "backup", labelKey: "audit.category.backup" },
  { value: "system", labelKey: "audit.category.system" },
];

/**
 * 动作 → 文案键。未知动作（后端新增、旧前端）原样展示，绝不吞掉。
 * 新增 action 时只需要在这里补一行，并在两个词典里补对应文案。
 */
const actionLabelKeys: Record<string, string> = {
  "agent.upgrade.batch": "audit.action.agent_upgrade_batch",
  "agent.upgrade": "audit.action.agent_upgrade",
  "backup.export": "audit.action.backup_export",
  "backup.restore.schedule": "audit.action.backup_restore_schedule",
  "backup.restore.cancel": "audit.action.backup_restore_cancel",
  "backup.restore.apply": "audit.action.backup_restore_apply",
  "chain.create": "audit.action.chain_create",
  "chain.update": "audit.action.chain_update",
  "chain.delete": "audit.action.chain_delete",
  "forward.create": "audit.action.forward_create",
  "forward.update": "audit.action.forward_update",
  "forward.delete": "audit.action.forward_delete",
  "user.create": "audit.action.userCreate",
  "user.update": "audit.action.userUpdate",
  "user.delete": "audit.action.userDelete",
  "user_package.bind": "audit.action.userPackageBind",
  "user_package.update": "audit.action.userPackageUpdate",
  "user_package.unbind": "audit.action.userPackageUnbind",
  "package.create": "audit.action.packageCreate",
  "package.update": "audit.action.packageUpdate",
  "package.delete": "audit.action.packageDelete",
  "server.create": "audit.action.serverCreate",
  "server.update": "audit.action.serverUpdate",
  "server.delete": "audit.action.serverDelete",
  "node.create": "audit.action.nodeCreate",
  "node.update": "audit.action.nodeUpdate",
  "node.delete": "audit.action.nodeDelete",
  "certificate.upload": "audit.action.certificateUpload",
  "certificate.delete": "audit.action.certificateDelete",
  "rule_template.create": "audit.action.ruleTemplateCreate",
  "rule_template.update": "audit.action.ruleTemplateUpdate",
  "rule_template.delete": "audit.action.ruleTemplateDelete",
  "settings.update": "audit.action.settingsUpdate",
  "password.change": "audit.action.passwordChange",
  "user.reset_subscription": "audit.action.userResetSubscription",
  "config.apply": "audit.action.configApply",
};

const toneClass: Record<Tone, string> = {
  primary: "bg-primary/10 text-primary",
  destructive: "bg-destructive/10 text-destructive",
  warning: "bg-warning/10 text-warning",
  muted: "bg-muted text-muted-foreground",
};

/** 未知 action 原样显示；词典缺键时也由 `t()` 回落到原字符串。 */
function actionLabel(action: string): string {
  const key = actionLabelKeys[action];
  return key ? t(key) : action;
}

function actionTone(action: string): Tone {
  // 删除优先于分类：任何资源的 delete 都用 destructive，避免被 primary 抢走。
  if (action.endsWith(".delete")) return "destructive";
  if (
    action.startsWith("settings.") ||
    action.startsWith("password.") ||
    action === "config.apply"
  ) {
    return "warning";
  }
  if (action.startsWith("rule_template.")) return "warning";
  if (action.startsWith("user.") || action.startsWith("user_package.")) {
    return "primary";
  }
  return "muted";
}

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

interface LookupMaps {
  users: Map<string, string>;
  packages: Map<string, string>;
  servers: Map<string, string>;
  ruleTemplates: Map<string, string>;
}

interface ResolvedTarget {
  label: string;
  title?: string;
  resolved: boolean;
}

/**
 * 对象列：按 action 选对应的缓存翻译 id；缓存里没有（对象已删除、或超出
 * 列表返回条数）时显示 id 前 8 位 + …，完整 id 放 title。
 */
function resolveTarget(
  action: string,
  target: string | null,
  maps: LookupMaps,
): ResolvedTarget {
  if (!target) return { label: "—", resolved: true };
  if (target === "settings") {
    return { label: t("audit.target.settings"), resolved: true };
  }

  const names = action.startsWith("user.")
    ? maps.users
    : action.startsWith("package.")
      ? maps.packages
      : action.startsWith("rule_template.")
        ? maps.ruleTemplates
        : action.startsWith("server.") || action === "config.apply"
          ? maps.servers
          : null;
  const name = names?.get(target);
  if (name) return { label: name, title: target, resolved: true };

  return {
    label:
      target.length > TARGET_PREVIEW_LENGTH
        ? `${target.slice(0, TARGET_PREVIEW_LENGTH)}…`
        : target,
    title: target,
    resolved: false,
  };
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
        toneClass[actionTone(action)],
      )}
    >
      {actionLabel(action)}
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
            <span aria-hidden="true" className="px-1 text-muted-foreground/40">
              ·
            </span>
          ) : null}
          <span className="font-mono text-[11px]">{item}</span>
        </span>
      ))}
      {hidden.length > 0 ? (
        <span
          className="text-[11px] text-muted-foreground/60"
          title={hidden.join("\n")}
        >
          +{hidden.length}
        </span>
      ) : null}
    </div>
  );
}

function LoadingRows() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, index) => (
        <TableRow key={index} className="hover:bg-transparent">
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-16" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-20" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-5 w-20 rounded-full" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-28" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-48" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="ml-auto h-6 w-14" />
          </TableCell>
        </TableRow>
      ))}
    </>
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
      <TableCell colSpan={COLUMN_COUNT} className="px-4 py-16">
        <div className="mx-auto flex max-w-sm flex-col items-center gap-3 text-center">
          <div className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
            <ScrollTextIcon className="size-5" />
          </div>
          <div>
            <p className="text-sm font-medium">
              {filtered ? t("audit.empty.filtered") : t("audit.empty.all")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {filtered
                ? t("audit.empty.filteredDesc")
                : t("audit.empty.allDesc")}
            </p>
          </div>
          {filtered ? (
            <Button variant="outline" size="sm" onClick={onClear}>
              {t("audit.empty.clearFilters")}
            </Button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

function ErrorRow({
  message,
  onRetry,
  retrying,
}: {
  message: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={COLUMN_COUNT} className="px-4 py-16">
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 text-center">
          <div className="grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
            <TriangleAlertIcon className="size-5" />
          </div>
          <div>
            <p className="text-sm font-medium">{t("audit.loadFailed")}</p>
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
                  action: actionLabel(entry.action),
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
          <pre className="max-h-[55vh] overflow-auto rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
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
    }),
    [users.data, packages.data, servers.data, ruleTemplates.data],
  );
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
    <div className="relative w-48 shrink-0">
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
  const [actorInput, setActorInput] = useState("");
  const [actorQuery, setActorQuery] = useState("");
  const [targetInput, setTargetInput] = useState("");
  const [targetQuery, setTargetQuery] = useState("");
  const [category, setCategory] = useState<Category>("all");
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
  const action =
    category === "all" ? undefined : CATEGORY_ACTION_PREFIX[category];
  const audit = useAuditLog({
    limit,
    action,
    actor: actorQuery || undefined,
    target: targetQuery || undefined,
  });
  const maps = useLookupMaps();
  const resolveChange = useChangeResolver(maps);

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
                  className="font-mono text-[11px] font-normal text-muted-foreground"
                >
                  {t("audit.loaded", { n: items.length })}
                </Badge>
              ) : null}
            </CardTitle>

            {/* 控件同行排列：标题在左、三个控件在右，窄屏才换行 */}
            <div className="flex items-center gap-2">
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
          <div className="min-w-0 max-w-full overflow-x-auto">
            <Tabs
              value={category}
              onValueChange={(value) => setCategory(value as Category)}
            >
              <TabsList>
                {CATEGORIES.map((option) => (
                  <TabsTrigger key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>

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

        <CardContent className="p-0">
          <Table className="min-w-[980px]" aria-busy={audit.isPending}>
            <TableCaption className="sr-only">
              {t("audit.tableCaption")}
            </TableCaption>
            <TableHeader className="bg-muted/30">
              <TableRow>
                <TableHead className={HEAD_CLASS}>
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
                <TableHead className={cn(HEAD_CLASS, "text-right")}>
                  {t("audit.columns.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {audit.isPending ? (
                <LoadingRows />
              ) : showError ? (
                <ErrorRow
                  message={errorMessage}
                  retrying={audit.isFetching}
                  onRetry={() => void audit.refetch()}
                />
              ) : items.length === 0 ? (
                <EmptyRow filtered={filtersActive} onClear={clearFilters} />
              ) : (
                items.map((entry) => {
                  const target = resolveTarget(entry.action, entry.target, maps);

                  return (
                    <TableRow key={entry.id}>
                      <TableCell className="px-4 py-2.5">
                        <span
                          className="text-xs whitespace-nowrap text-muted-foreground"
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
                            !target.resolved &&
                              "font-mono text-xs text-muted-foreground",
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
                      <TableCell className="px-4 py-2.5 text-right">
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
