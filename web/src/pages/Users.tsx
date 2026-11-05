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
import { useDeleteUser, useMe, useUpdateUser, useUsers } from "@/lib/queries";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { UserFormMode } from "@/lib/schemas";

const COLUMN_COUNT = 7;

function roleLabel(role: UserView["role"]) {
  return role === "admin" ? "管理员" : "普通用户";
}

function UserStatusBadge({ status }: { status: UserView["status"] }) {
  const active = status === "active";
  return (
    <Badge
      variant="outline"
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
            {user.packages?.length ?? 0} 个套餐，且不可恢复。
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
                  "用户",
                  "角色",
                  "状态",
                  "套餐",
                  "流量",
                  "创建时间",
                  "操作",
                ].map((label) => (
                  <TableHead
                    key={label}
                    className="h-9 px-4 text-xs font-medium tracking-wide text-muted-foreground"
                  >
                    {label}
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
                  const packageNames = (user.packages ?? [])
                    .map((item) => item.package_name)
                    .join("、");

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
                        <UserStatusBadge status={user.status} />
                      </TableCell>
                      <TableCell className="px-4 py-2.5">
                        <Badge
                          variant="outline"
                          className="font-normal text-muted-foreground"
                          title={packageNames || "未绑定套餐"}
                        >
                          {user.packages?.length ?? 0} 张
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
