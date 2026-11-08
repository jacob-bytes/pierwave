import { useEffect, useState } from "react";
import type { KeyboardEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import {
  CopyIcon,
  ExternalLinkIcon,
  Link2Icon,
  ListFilterIcon,
  QrCodeIcon,
  RefreshCwIcon,
  SearchIcon,
  TriangleAlertIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RuleTemplateSelect } from "@/components/subscriptions/RuleTemplateSelect";
import { SubscriptionQrDialog } from "@/components/subscriptions/SubscriptionQrDialog";
import { UsageBar } from "@/components/UsageBar";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  ApiError,
  type RuleTemplate,
  type Subscription,
} from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { errorText } from "@/lib/errors";
import { SUBSCRIPTION_FORMATS } from "@/lib/subscriptionFormats";
import { useRuleTemplates, useSubscriptions } from "@/lib/queries";
import { ruleTemplateErrorText } from "@/lib/ruleTemplates";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

const COLUMN_COUNT = 6;

type PackageFilter = "all" | "with" | "none";

/**
 * P6：订阅列表的生效规则模板名。
 * 为空表示最终落在全局默认 / 内置规则上，页面展示「默认规则」。
 */
function effectiveRuleTemplateName(row: Subscription): string {
  return (row.rule_template_name ?? "").trim();
}

/** 后端可能暂时没有订阅接口：404 给专门的「尚未就绪」，其余错误原样透出。 */
function subscriptionListErrorText(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return t("subscriptions.unavailable");
  }
  return errorText(error, t("subscriptions.loadError"));
}

/**
 * 订阅地址由前端拼装，复制、打开和二维码都用同一个完整 URL。
 *
 * 选中非默认模板时带 `?rule=<id>`；默认模板不加参数，保持链接简洁。
 */
function subscriptionUrl(
  shortCode: string,
  template: RuleTemplate | null,
  format: string,
): string {
  const base = `${window.location.origin}/api/v1/sub/${encodeURIComponent(shortCode)}`;
  const params = new URLSearchParams();
  if (template && !template.is_default) params.set("rule", template.id);
  if (format && format !== "clash") params.set("target", format);
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

function packageLabel(user: Subscription): string {
  const names = (user.packages ?? [])
    .map((item) => item.package_name)
    .filter(Boolean);
  if (names.length === 0) {
    return user.package_count > 0
      ? t(
          user.package_count === 1
            ? "subscriptions.packageCountOne"
            : "subscriptions.packageCount",
          { n: user.package_count },
        )
      : t("subscriptions.noPackage");
  }
  const joined = names.join(t("common.listSeparator"));
  return user.package_count > names.length
    ? t("subscriptions.packageMore", {
        names: joined,
        count: user.package_count,
      })
    : joined;
}

function LoadingRows() {
  return (
    <>
      {Array.from({ length: 6 }).map((_, index) => (
        <TableRow key={index} className="hover:bg-transparent">
          <TableCell className="px-4 py-3">
            <div className="flex items-center gap-2.5">
              <Skeleton className="size-6 rounded-full" />
              <div className="space-y-1.5">
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="h-2.5 w-16" />
              </div>
            </div>
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-5 w-28 rounded-full" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-4 w-48" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-5 w-24 rounded-full" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-28" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-7 w-24 rounded-md" />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

function EmptyRow({
  title,
  description,
  actionLabel,
  onAction,
  searching,
}: {
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
  searching: boolean;
}) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={COLUMN_COUNT} className="px-4 py-16">
        <div className="mx-auto flex max-w-sm flex-col items-center gap-3 text-center">
          <div className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
            <Link2Icon className="size-5" />
          </div>
          <div>
            <p className="text-sm font-medium">{title}</p>
            <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          </div>
          <Button variant="outline" size="sm" onClick={onAction}>
            {searching ? (
              <XIcon className="size-3.5" />
            ) : (
              <UsersIcon className="size-3.5" />
            )}
            {actionLabel}
          </Button>
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
            <p className="text-sm font-medium">{t("subscriptions.loadFailed")}</p>
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

export default function SubscriptionsPage() {
  useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const q = (searchParams.get("q") ?? "").trim();
  const [searchInput, setSearchInput] = useState(q);
  const [format, setFormat] = useState<string>("clash");
  const [trackedQ, setTrackedQ] = useState(q);
  const [filter, setFilter] = useState<PackageFilter>("all");
  const [qrState, setQrState] = useState<{
    user: Subscription;
    url: string;
  } | null>(null);
  /** 每行选择的规则模板；只影响本页链接拼接，不写回后端。 */
  const [ruleSelections, setRuleSelections] = useState<Record<string, string>>(
    {},
  );
  const subscriptions = useSubscriptions(q);
  const ruleTemplates = useRuleTemplates();
  const templates = ruleTemplates.data ?? [];
  const ruleTemplateError =
    ruleTemplates.isError && templates.length === 0
      ? ruleTemplateErrorText(ruleTemplates.error)
      : null;

  /**
   * 行内选择：空/未选 = 跟随用户自己的绑定（链接不带 ?rule=）。
   * 之前默认选中全局默认模板，会让「规则模板」列显示默认、徽标却显示用户绑定，
   * 复制出来的链接看起来和生效规则不一致。
   */
  function selectedTemplate(userId: string): RuleTemplate | null {
    const selectedId = ruleSelections[userId];
    if (!selectedId) return null;
    return templates.find((item) => item.id === selectedId) ?? null;
  }

  // 浏览器前进/后退改变 ?q 时同步输入框；用 render 期间的派生状态避免额外 effect。
  if (q !== trackedQ) {
    setTrackedQ(q);
    setSearchInput(q);
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchInput.trim() === q) return;
      const next = new URLSearchParams(searchParams);
      const trimmed = searchInput.trim();
      if (trimmed) next.set("q", trimmed);
      else next.delete("q");
      setSearchParams(next, { replace: true });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput, q, searchParams, setSearchParams]);

  function commitSearch() {
    const trimmed = searchInput.trim();
    if (trimmed === q) return;
    const next = new URLSearchParams(searchParams);
    if (trimmed) next.set("q", trimmed);
    else next.delete("q");
    setSearchParams(next, { replace: true });
  }

  function clearSearch() {
    setSearchInput("");
    const next = new URLSearchParams(searchParams);
    next.delete("q");
    setSearchParams(next, { replace: true });
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      commitSearch();
    }
  }

  async function copySubscription(user: Subscription, url: string) {
    const ok = await copyText(url);
    if (ok) {
      toast.success(t("subscriptions.copied", { username: user.username }));
    } else {
      toast.error(t("subscriptions.copyError"));
    }
  }

  const items = subscriptions.data ?? [];
  const filteredItems = items.filter((user) => {
    if (filter === "with") return user.package_count > 0;
    if (filter === "none") return user.package_count === 0;
    return true;
  });

  const hasUsers = items.length > 0;
  const emptyTitle = q
    ? t("subscriptions.empty.search")
    : !hasUsers
      ? t("subscriptions.empty.noUsers")
      : filter === "with"
        ? t("subscriptions.empty.with")
        : t("subscriptions.empty.none");
  const emptyDescription = q
    ? t("subscriptions.empty.searchDesc")
    : !hasUsers
      ? t("subscriptions.empty.noUsersDesc")
      : t("subscriptions.empty.filterDesc");
  const emptyActionLabel = q
    ? t("subscriptions.empty.clearSearch")
    : !hasUsers
      ? t("subscriptions.empty.goCreate")
      : t("subscriptions.empty.viewAll");

  function handleEmptyAction() {
    if (q) {
      clearSearch();
      return;
    }
    if (!hasUsers) {
      navigate("/users");
      return;
    }
    setFilter("all");
  }

  return (
    <div className="animate-in space-y-6 fade-in-0 slide-in-from-bottom-1 duration-150">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t("subscriptions.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("subscriptions.subtitle")}
        </p>
      </div>

      <Card className="gap-0 overflow-hidden">
        <CardHeader className="border-b border-border">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              {t("subscriptions.list")}
              {subscriptions.data && !subscriptions.isError ? (
                <Badge
                  variant="secondary"
                  className="font-mono text-[11px] font-normal text-muted-foreground"
                >
                  {filteredItems.length}
                </Badge>
              ) : null}
            </CardTitle>

            <div className="flex flex-wrap items-center gap-2">
              <Tabs
                value={filter}
                onValueChange={(value) =>
                  setFilter(value as PackageFilter)
                }
              >
                <TabsList>
                  <TabsTrigger value="all">{t("subscriptions.filter.all")}</TabsTrigger>
                  <TabsTrigger value="with">{t("subscriptions.filter.with")}</TabsTrigger>
                  <TabsTrigger value="none">{t("subscriptions.filter.none")}</TabsTrigger>
                </TabsList>
              </Tabs>

              <div className="flex w-full items-center gap-2 sm:w-auto">
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t("subscriptions.formatLabel")}
                </span>
                <Select value={format} onValueChange={setFormat}>
                  <SelectTrigger
                    size="sm"
                    className="h-8 w-[132px] text-xs"
                    aria-label={t("subscriptions.formatAria")}
                    title={t("subscriptions.formatHint")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end">
                    {SUBSCRIPTION_FORMATS.map((item) => (
                      <SelectItem key={item} value={item} className="text-xs">
                        {t(`subscriptions.formats.${item}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="relative w-full sm:w-64">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder={t("subscriptions.searchPlaceholder")}
                  aria-label={t("subscriptions.searchAria")}
                  className="pr-8 pl-8"
                />
                {searchInput ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("subscriptions.clearSearch")}
                    className="absolute top-1/2 right-1 -translate-y-1/2"
                    onClick={clearSearch}
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                ) : null}
              </div>

              <Button
                variant="outline"
                size="sm"
                onClick={() => void subscriptions.refetch()}
                disabled={subscriptions.isFetching}
              >
                <RefreshCwIcon
                  className={cn(
                    "size-3.5",
                    subscriptions.isFetching && "animate-spin",
                  )}
                />
                {t("common.refresh")}
              </Button>
            </div>
          </div>
          <CardDescription className="text-xs">
            {t("subscriptions.desc")}
          </CardDescription>
        </CardHeader>

        <CardContent className="p-0">
          <Table className="min-w-[1000px]" aria-busy={subscriptions.isPending}>
            <TableCaption className="sr-only">{t("subscriptions.tableCaption")}</TableCaption>
            <TableHeader className="bg-muted/30">
              <TableRow>
                {[
                  t("subscriptions.columns.user"),
                  t("subscriptions.columns.packages"),
                  t("subscriptions.columns.used"),
                  t("subscriptions.columns.ruleTemplate"),
                  t("subscriptions.columns.link"),
                  t("subscriptions.columns.actions"),
                ].map((label) => (
                    <TableHead
                      key={label}
                      className="h-9 px-4 text-xs font-medium tracking-wide text-muted-foreground"
                    >
                      {label}
                    </TableHead>
                  ),
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {subscriptions.isPending ? (
                <LoadingRows />
              ) : subscriptions.isError ? (
                <ErrorRow
                  message={subscriptionListErrorText(subscriptions.error)}
                  retrying={subscriptions.isFetching}
                  onRetry={() => void subscriptions.refetch()}
                />
              ) : filteredItems.length === 0 ? (
                <EmptyRow
                  title={emptyTitle}
                  description={emptyDescription}
                  actionLabel={emptyActionLabel}
                  onAction={handleEmptyAction}
                  searching={Boolean(q)}
                />
              ) : (
                filteredItems.map((user) => {
                  const template = selectedTemplate(user.id);
                  const url = subscriptionUrl(user.short_code, template, format);
                  const label = packageLabel(user);
                  const ruleTemplateName = effectiveRuleTemplateName(user);

                  return (
                    <TableRow key={user.id}>
                      <TableCell className="px-4 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <Avatar size="sm">
                            <AvatarFallback>
                              {user.username.slice(0, 1).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <div className="truncate font-medium">
                              {user.username}
                            </div>
                            <div className="font-mono text-[11px] text-muted-foreground">
                              {user.short_code}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="px-4 py-2.5">
                        <Badge
                          variant="outline"
                          className={cn(
                            "max-w-[240px] font-normal",
                            user.package_count === 0 &&
                              "text-muted-foreground",
                          )}
                          title={label}
                        >
                          <span className="truncate">{label}</span>
                        </Badge>
                      </TableCell>
                      <TableCell className="px-4 py-2.5">
                        <UsageBar
                          usedBytes={user.used_bytes}
                          quotaBytes={user.quota_bytes}
                          label={null}
                          className="w-48"
                        />
                      </TableCell>
                      {/*
                        P6：生效规则模板（只读）。为空表示最终落在全局默认 /
                        内置规则上，展示「默认规则」；点击跳到规则模板页。
                      */}
                      <TableCell className="px-4 py-2.5">
                        <Badge
                          asChild
                          variant="outline"
                          className={cn(
                            "max-w-[200px] font-normal",
                            !ruleTemplateName && "text-muted-foreground",
                          )}
                        >
                          <Link
                            to="/settings?tab=templates"
                            title={t(
                              "subscriptions.ruleTemplateEffectiveTitle",
                            )}
                          >
                            <ListFilterIcon className="size-3" />
                            <span className="truncate">
                              {ruleTemplateName ||
                                t("subscriptions.ruleTemplateDefault")}
                            </span>
                          </Link>
                        </Badge>
                      </TableCell>
                      <TableCell className="px-4 py-2.5">
                        <div className="flex flex-col gap-1.5">
                          <a
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            title={url}
                            className="block max-w-[220px] truncate font-mono text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
                          >
                            {`…/sub/${user.short_code}`}
                          </a>
                          <RuleTemplateSelect
                            templates={templates}
                            selected={template}
                            effectiveName={ruleTemplateName}
                            pending={ruleTemplates.isPending}
                            error={ruleTemplateError}
                            username={user.username}
                            onSelect={(id) =>
                              setRuleSelections((current) => ({
                                ...current,
                                [user.id]: id,
                              }))
                            }
                          />
                        </div>
                      </TableCell>
                      <TableCell className="px-4 py-2.5">
                        <div className="flex items-center gap-0.5">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title={t("subscriptions.copyTitle")}
                            aria-label={t("subscriptions.copyAria", {
                              username: user.username,
                            })}
                            onClick={() => void copySubscription(user, url)}
                          >
                            <CopyIcon className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title={t("subscriptions.qrTitle")}
                            aria-label={t("subscriptions.qrAria", {
                              username: user.username,
                            })}
                            onClick={() => setQrState({ user, url })}
                          >
                            <QrCodeIcon className="size-3.5" />
                          </Button>
                          <Button
                            asChild
                            variant="ghost"
                            size="icon-sm"
                            title={t("subscriptions.openTitle")}
                          >
                            <a
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={t("subscriptions.openAria", {
                                username: user.username,
                              })}
                            >
                              <ExternalLinkIcon className="size-3.5" />
                            </a>
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {qrState ? (
        <SubscriptionQrDialog
          key={qrState.url}
          open
          username={qrState.user.username}
          url={qrState.url}
          onOpenChange={(open) => {
            if (!open) setQrState(null);
          }}
        />
      ) : null}
    </div>
  );
}
