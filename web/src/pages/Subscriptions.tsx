import { useEffect, useState } from "react";
import type { KeyboardEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import {
  CopyIcon,
  ExternalLinkIcon,
  Link2Icon,
  QrCodeIcon,
  RefreshCwIcon,
  SearchIcon,
  TriangleAlertIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
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
import type { UserView } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { errorText } from "@/lib/errors";
import { useUsers } from "@/lib/queries";
import { cn } from "@/lib/utils";

const COLUMN_COUNT = 5;

type PackageFilter = "all" | "with" | "none";

/** 订阅地址由前端拼装，复制和二维码都用同一个完整 URL。 */
function subscriptionUrl(shortCode: string): string {
  return `${window.location.origin}/api/v1/sub/${encodeURIComponent(shortCode)}`;
}

function packageLabel(user: UserView): string {
  const names = (user.packages ?? [])
    .map((item) => item.package_name)
    .filter(Boolean);
  if (names.length === 0) {
    return user.package_count > 0 ? `${user.package_count} 个套餐` : "未绑定套餐";
  }
  const joined = names.join("、");
  return user.package_count > names.length
    ? `${joined} 等 ${user.package_count} 个`
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
            <p className="text-sm font-medium">订阅列表加载失败</p>
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
            重试
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

export default function SubscriptionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const q = (searchParams.get("q") ?? "").trim();
  const [searchInput, setSearchInput] = useState(q);
  const [trackedQ, setTrackedQ] = useState(q);
  const [filter, setFilter] = useState<PackageFilter>("all");
  const [qrUser, setQrUser] = useState<UserView | null>(null);
  const users = useUsers(q);

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

  async function copySubscription(user: UserView) {
    const ok = await copyText(subscriptionUrl(user.short_code));
    if (ok) {
      toast.success(`已复制「${user.username}」的订阅链接`);
    } else {
      toast.error("复制失败，请打开链接后手动复制");
    }
  }

  const items = users.data ?? [];
  const filteredItems = items.filter((user) => {
    if (filter === "with") return user.package_count > 0;
    if (filter === "none") return user.package_count === 0;
    return true;
  });

  const hasUsers = items.length > 0;
  const emptyTitle = q
    ? "没有找到匹配的用户"
    : !hasUsers
      ? "还没有用户"
      : filter === "with"
        ? "没有绑定套餐的用户"
        : "所有用户都已绑定套餐";
  const emptyDescription = q
    ? "换个用户名再试，或者清空搜索。"
    : !hasUsers
      ? "创建用户后，订阅链接会自动生成，这里就能复制或展示二维码。"
      : "当前筛选下没有用户，切回「全部」看看。";
  const emptyActionLabel = q
    ? "清空搜索"
    : !hasUsers
      ? "去用户页创建"
      : "查看全部";

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
        <h1 className="text-xl font-semibold tracking-tight">订阅</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          每个用户的订阅链接与二维码，按短码生成。
        </p>
      </div>

      <Card className="gap-0 overflow-hidden">
        <CardHeader className="border-b border-border">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              订阅列表
              {users.data && !users.isError ? (
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
                  <TabsTrigger value="all">全部</TabsTrigger>
                  <TabsTrigger value="with">有套餐</TabsTrigger>
                  <TabsTrigger value="none">无套餐</TabsTrigger>
                </TabsList>
              </Tabs>

              <div className="relative w-full sm:w-64">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="搜索用户名"
                  aria-label="搜索订阅用户"
                  className="pr-8 pl-8"
                />
                {searchInput ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="清空搜索"
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
                onClick={() => void users.refetch()}
                disabled={users.isFetching}
              >
                <RefreshCwIcon
                  className={cn(
                    "size-3.5",
                    users.isFetching && "animate-spin",
                  )}
                />
                刷新
              </Button>
            </div>
          </div>
          <CardDescription className="text-xs">
            搜索会写入地址栏的 q 参数；「有套餐 / 无套餐」只过滤当前结果。
          </CardDescription>
        </CardHeader>

        <CardContent className="p-0">
          <Table className="min-w-[880px]" aria-busy={users.isPending}>
            <TableCaption className="sr-only">订阅管理列表</TableCaption>
            <TableHeader className="bg-muted/30">
              <TableRow>
                {["用户", "套餐", "已用 / 额度", "订阅链接", "操作"].map(
                  (label) => (
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
              {users.isPending ? (
                <LoadingRows />
              ) : users.isError ? (
                <ErrorRow
                  message={errorText(
                    users.error,
                    "加载用户列表失败，请检查网络后重试",
                  )}
                  retrying={users.isFetching}
                  onRetry={() => void users.refetch()}
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
                  const url = subscriptionUrl(user.short_code);
                  const label = packageLabel(user);

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
                      <TableCell className="px-4 py-2.5">
                        <a
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          title={url}
                          className="block max-w-[220px] truncate font-mono text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
                        >
                          {`…/sub/${user.short_code}`}
                        </a>
                      </TableCell>
                      <TableCell className="px-4 py-2.5">
                        <div className="flex items-center gap-0.5">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title="复制订阅链接"
                            aria-label={`复制 ${user.username} 的订阅链接`}
                            onClick={() => void copySubscription(user)}
                          >
                            <CopyIcon className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title="查看二维码"
                            aria-label={`查看 ${user.username} 的订阅二维码`}
                            onClick={() => setQrUser(user)}
                          >
                            <QrCodeIcon className="size-3.5" />
                          </Button>
                          <Button
                            asChild
                            variant="ghost"
                            size="icon-sm"
                            title="在新标签页打开"
                          >
                            <a
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`打开 ${user.username} 的订阅链接`}
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

      {qrUser ? (
        <SubscriptionQrDialog
          key={qrUser.id}
          open
          username={qrUser.username}
          url={subscriptionUrl(qrUser.short_code)}
          onOpenChange={(open) => {
            if (!open) setQrUser(null);
          }}
        />
      ) : null}
    </div>
  );
}
