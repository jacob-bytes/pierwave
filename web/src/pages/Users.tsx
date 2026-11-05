import { useEffect, useState } from "react";
import type { KeyboardEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import {
  KeyRoundIcon,
  MoreHorizontalIcon,
  PackageIcon,
  PencilIcon,
  PlusIcon,
  PowerIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { UserFormDialog } from "@/components/users/UserFormDialog";
import { ResetPasswordDialog } from "@/components/users/ResetPasswordDialog";
import { UserPackagesSheet } from "@/components/users/UserPackagesSheet";
import { statusToneClasses } from "@/components/packages/packageTone";
import { PackageStatusBadge } from "@/components/packages/PackageStatusBadge";
import { UsageBar } from "@/components/UsageBar";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import type { UserView } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { packageStatusLabel, packageStatusTone } from "@/lib/labels";
import { useDeleteUser, useMe, useUpdateUser, useUsers } from "@/lib/queries";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { UserFormMode } from "@/lib/schemas";

const COLUMN_COUNT = 7;

function roleLabel(role: UserView["role"]) {
  return role === "admin" ? "管理员" : "普通用户";
}

/** 账号维度：只说账号本身能不能登录，套餐是否断流由旁边单独展示。 */
function UserStatusBadge({ status }: { status: UserView["status"] }) {
  const active = status === "active";
  return (
    <Badge
      variant="outline"
      title={
        active
          ? "账号状态：正常，可以登录并获取订阅"
          : "账号状态：已禁用，无法登录和获取订阅"
      }
      className={cn(
        "gap-1.5 border-transparent font-normal",
        active
          ? "bg-primary/10 text-primary"
          : "bg-muted text-muted-foreground",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          active
            ? "bg-primary motion-safe:animate-pulse"
            : "bg-muted-foreground/40",
        )}
      />
      {active ? "正常" : "已禁用"}
    </Badge>
  );
}

/** 套餐维度：`active` 不占位，其余取名下最严重的一张，避免「断了流还显示正常」。 */
const PACKAGE_WORST_TITLES: Record<
  Exclude<UserView["package_worst_status"], "active">,
  string
> = {
  exhausted: "套餐状态：至少一张套餐已用尽，该用户已被断流",
  expired: "套餐状态：至少一张套餐已过期，需要续期",
  disabled: "套餐状态：名下套餐均已停用",
  none: "套餐状态：名下还没有绑定任何套餐",
};

function PackageWorstStatusBadge({
  status,
}: {
  status: UserView["package_worst_status"];
}) {
  if (status === "active") return null;

  const none = status === "none";
  return (
    <Badge
      variant="outline"
      title={PACKAGE_WORST_TITLES[status]}
      className={cn(
        "border-transparent font-normal",
        statusToneClasses[none ? "muted" : packageStatusTone(status)],
      )}
    >
      {none ? "无套餐" : packageStatusLabel(status)}
    </Badge>
  );
}

/**
 * 账户级「超出总额度」：与套餐实例的「已用尽」区分。
 * 后者只看单张卡，前者是 users.quota_bytes 这道跨套餐总闸，命中后全站节点都停用。
 */
function QuotaExceededBadge() {
  return (
    <Badge
      variant="destructive"
      className="gap-1 font-normal"
      title="账户总额度已用尽，该用户在所有节点上失去资格"
    >
      <TriangleAlertIcon className="size-3" />
      超出总额度
    </Badge>
  );
}

/** 套餐列的「N 张」入口：点开就能看到每张卡的 套餐名 · 已用/额度 · 状态。 */
function PackageBreakdownPopover({ user }: { user: UserView }) {
  const packages = user.packages ?? [];
  const count = user.package_count;

  if (count === 0) {
    return (
      <Badge
        variant="outline"
        className="font-normal text-muted-foreground"
        title="还没有绑定任何套餐"
      >
        0 张
      </Badge>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-6 rounded-full px-2 text-xs font-normal text-muted-foreground"
          aria-label={`查看 ${user.username} 的 ${count} 张套餐明细`}
          title={`${count} 张套餐，点击查看明细`}
        >
          {count} 张
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <PopoverHeader>
          <PopoverTitle className="text-sm">套餐明细</PopoverTitle>
          <PopoverDescription className="text-xs">
            名下 {count} 张套餐实例，额度与状态按当前时刻计算。
          </PopoverDescription>
        </PopoverHeader>
        <ul className="flex flex-col divide-y divide-border">
          {packages.map((item) => (
            <li
              key={item.id}
              className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0"
            >
              <div className="min-w-0">
                <p className="truncate text-xs font-medium">
                  {item.package_name}
                </p>
                <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                  {formatBytes(item.used_bytes)} /{" "}
                  {formatBytes(item.quota_bytes, { zeroAsUnlimited: true })}
                </p>
              </div>
              <PackageStatusBadge status={item.status} />
            </li>
          ))}
        </ul>
        {count > packages.length ? (
          <p className="text-[11px] text-muted-foreground">
            仅显示前 {packages.length} 张，完整明细请到「管理套餐」查看。
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
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
            <Skeleton className="h-5 w-14 rounded-full" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-5 w-14 rounded-full" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-5 w-10 rounded-full" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-36" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-20" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="size-7 rounded-md" />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

function EmptyRow({
  searching,
  onCreate,
  onClearSearch,
}: {
  searching: boolean;
  onCreate: () => void;
  onClearSearch: () => void;
}) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={COLUMN_COUNT} className="px-4 py-16">
        <div className="mx-auto flex max-w-sm flex-col items-center gap-3 text-center">
          <div className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
            <UsersIcon className="size-5" />
          </div>
          <div>
            <p className="text-sm font-medium">
              {searching ? "没有找到匹配的用户" : "还没有用户"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {searching
                ? "换个用户名或短码再试，或者清空搜索。"
                : "创建用户后，可以在「管理套餐」里给他绑定流量卡。"}
            </p>
          </div>
          {searching ? (
            <Button variant="outline" size="sm" onClick={onClearSearch}>
              <XIcon className="size-3.5" />
              清空搜索
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={onCreate}>
              <PlusIcon className="size-3.5" />
              新建用户
            </Button>
          )}
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
            <p className="text-sm font-medium">用户列表加载失败</p>
            <p className="mt-1 text-xs text-muted-foreground">{message}</p>
          </div>
          <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
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

function DeleteUserDialog({
  user,
  open,
  onOpenChange,
}: {
  user: UserView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const deleteUser = useDeleteUser();

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && deleteUser.isPending) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <Trash2Icon className="size-5" />
          </AlertDialogMedia>
          <AlertDialogTitle>删除用户</AlertDialogTitle>
          <AlertDialogDescription>
            确定删除「{user.username}」？删除后将同时解绑{" "}
            {user.package_count} 个套餐，且不可恢复。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteUser.isPending}>
            取消
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleteUser.isPending}
            onClick={(event) => {
              event.preventDefault();
              deleteUser.mutate(user.id, {
                onSuccess: () => {
                  toast.success("用户已删除");
                  onOpenChange(false);
                },
                onError: (error) => {
                  toast.error(
                    errorText(error, "删除用户失败，请稍后重试"),
                  );
                },
              });
            }}
          >
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function UsersPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const q = (searchParams.get("q") ?? "").trim();
  const [searchInput, setSearchInput] = useState(q);
  const [trackedQ, setTrackedQ] = useState(q);
  const users = useUsers(q);
  const me = useMe();
  const updateUser = useUpdateUser();

  const [formState, setFormState] = useState<{
    mode: UserFormMode;
    user?: UserView;
  } | null>(null);
  const [resetUser, setResetUser] = useState<UserView | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserView | null>(null);
  const [packagesUser, setPackagesUser] = useState<UserView | null>(null);

  // 浏览器前进/后退改变 ?q 时同步输入框；用 render 期间的派生状态避免额外 effect 渲染。
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

  function toggleStatus(user: UserView) {
    const nextStatus = user.status === "active" ? "disabled" : "active";
    updateUser.mutate(
      { id: user.id, input: { status: nextStatus } },
      {
        onSuccess: () => {
          toast.success(
            nextStatus === "disabled"
              ? `已禁用「${user.username}」`
              : `已启用「${user.username}」`,
          );
        },
        onError: (error) => {
          toast.error(
            errorText(error, "更新用户状态失败，请稍后重试"),
          );
        },
      },
    );
  }

  const items = users.data ?? [];
  const showError = users.isError;
  const errorMessage = errorText(
    users.error,
    "加载用户列表失败，请检查网络后重试",
  );

  return (
    <div className="animate-in space-y-6 fade-in-0 slide-in-from-bottom-1 duration-150">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">用户</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            管理账号、角色与流量套餐。
          </p>
        </div>
        <Button onClick={() => setFormState({ mode: "create" })}>
          <PlusIcon className="size-4" />
          新建用户
        </Button>
      </div>

      <Card className="gap-0 overflow-hidden">
        <CardHeader className="border-b border-border">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              用户列表
              {users.data && !users.isError ? (
                <Badge
                  variant="secondary"
                  className="font-mono text-[11px] font-normal text-muted-foreground"
                >
                  {items.length}
                </Badge>
              ) : null}
            </CardTitle>

            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-full sm:w-72">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="搜索用户名或短码"
                  aria-label="搜索用户"
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
            输入后 300ms 自动搜索，回车立即触发；搜索参数会写入地址栏。
          </CardDescription>
        </CardHeader>

        <CardContent className="p-0">
          <Table className="min-w-[980px]" aria-busy={users.isPending}>
            <TableCaption className="sr-only">用户列表</TableCaption>
            <TableHeader className="bg-muted/30">
              <TableRow>
                {[
                  { label: "用户" },
                  { label: "角色" },
                  {
                    label: "状态",
                    title: "账号状态在前、套餐状态在后，两个维度独立",
                  },
                  {
                    label: "套餐",
                    title: "点开「N 张」可查看每张套餐的已用 / 额度 / 状态",
                  },
                  {
                    label: "套餐流量",
                    hint: "名下所有套餐实例合计",
                    title:
                      "名下所有套餐实例的已用 / 额度合计；任一卡不限量时显示「不限」",
                  },
                  { label: "创建时间" },
                  { label: "操作" },
                ].map(({ label, hint, title }) => (
                  <TableHead
                    key={label}
                    title={title}
                    className={cn(
                      "px-4 text-xs font-medium tracking-wide text-muted-foreground",
                      hint ? "h-auto py-2" : "h-9",
                    )}
                  >
                    <span className="block">{label}</span>
                    {hint ? (
                      <span className="mt-0.5 block text-[10px] font-normal tracking-normal whitespace-nowrap text-muted-foreground/70">
                        {hint}
                      </span>
                    ) : null}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.isPending ? (
                <LoadingRows />
              ) : showError ? (
                <ErrorRow
                  message={errorMessage}
                  retrying={users.isFetching}
                  onRetry={() => void users.refetch()}
                />
              ) : items.length === 0 ? (
                <EmptyRow
                  searching={Boolean(q)}
                  onCreate={() => setFormState({ mode: "create" })}
                  onClearSearch={clearSearch}
                />
              ) : (
                items.map((user) => {
                  const isSelf = user.id === me.data?.id;

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
                          variant={
                            user.role === "admin" ? "secondary" : "outline"
                          }
                          className="font-normal"
                        >
                          {user.role === "admin" ? (
                            <ShieldIcon className="size-3" />
                          ) : null}
                          {roleLabel(user.role)}
                        </Badge>
                      </TableCell>
                      <TableCell className="px-4 py-2.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <UserStatusBadge status={user.status} />
                          <PackageWorstStatusBadge
                            status={user.package_worst_status}
                          />
                          {user.quota_exceeded ? <QuotaExceededBadge /> : null}
                        </div>
                      </TableCell>
                      <TableCell className="px-4 py-2.5">
                        <PackageBreakdownPopover user={user} />
                      </TableCell>
                      <TableCell className="px-4 py-2.5">
                        <div className="space-y-1">
                          {user.package_count === 0 ? (
                            <p
                              className="w-48 text-xs text-muted-foreground"
                              title="名下还没有绑定套餐"
                            >
                              —
                            </p>
                          ) : (
                            <UsageBar
                              usedBytes={user.package_used_bytes}
                              quotaBytes={user.package_quota_bytes}
                              label={null}
                              className="w-48"
                            />
                          )}
                          {user.quota_exceeded ? (
                            <p
                              className="text-[11px] text-destructive"
                              title={`账户已用 ${formatBytes(user.used_bytes)} / 总额度 ${formatBytes(user.quota_bytes)}`}
                            >
                              账户总额度已用满
                            </p>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="px-4 py-2.5 text-xs text-muted-foreground">
                        <span title={formatAbsoluteTime(user.created_at)}>
                          {formatRelativeTime(user.created_at)}
                        </span>
                      </TableCell>
                      <TableCell className="px-4 py-2.5">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`操作 ${user.username}`}
                            >
                              <MoreHorizontalIcon className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            <DropdownMenuItem
                              onSelect={() =>
                                setFormState({ mode: "edit", user })
                              }
                            >
                              <PencilIcon className="size-3.5" />
                              编辑
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => setResetUser(user)}
                            >
                              <KeyRoundIcon className="size-3.5" />
                              重置密码
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={isSelf || updateUser.isPending}
                              title={
                                isSelf
                                  ? "不能禁用当前登录账号"
                                  : undefined
                              }
                              onSelect={() => toggleStatus(user)}
                            >
                              <PowerIcon className="size-3.5" />
                              {user.status === "active" ? "禁用" : "启用"}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => setPackagesUser(user)}
                            >
                              <PackageIcon className="size-3.5" />
                              管理套餐
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={isSelf}
                              title={
                                isSelf
                                  ? "不能删除当前登录账号"
                                  : undefined
                              }
                              onSelect={() => setDeleteTarget(user)}
                            >
                              <Trash2Icon className="size-3.5" />
                              删除
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {formState ? (
        <UserFormDialog
          key={`${formState.mode}-${formState.user?.id ?? "new"}`}
          open
          mode={formState.mode}
          user={formState.user}
          onOpenChange={(open) => {
            if (!open) setFormState(null);
          }}
        />
      ) : null}

      {resetUser ? (
        <ResetPasswordDialog
          key={resetUser.id}
          open
          user={resetUser}
          onOpenChange={(open) => {
            if (!open) setResetUser(null);
          }}
        />
      ) : null}

      {deleteTarget ? (
        <DeleteUserDialog
          key={deleteTarget.id}
          open
          user={deleteTarget}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
        />
      ) : null}

      {packagesUser ? (
        <UserPackagesSheet
          key={packagesUser.id}
          open
          user={packagesUser}
          onOpenChange={(open) => {
            if (!open) setPackagesUser(null);
          }}
        />
      ) : null}
    </div>
  );
}
