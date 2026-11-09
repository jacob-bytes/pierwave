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
import {
  EmptyState,
  ListError,
  MobileDataCard,
  PageHeader,
  SkeletonCard,
  SkeletonTable,
} from "@/components/common";
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
import { t, useI18n } from "@/i18n";
import { useIsDesktop } from "@/lib/useIsDesktop";

const COLUMN_COUNT = 7;

function roleLabel(role: UserView["role"]) {
  return role === "admin" ? t("roles.admin") : t("roles.user");
}

/** 账号维度：只说账号本身能不能登录，套餐是否断流由旁边单独展示。 */
function UserStatusBadge({ status }: { status: UserView["status"] }) {
  const active = status === "active";
  return (
    <Badge
      variant="outline"
      title={
        active
          ? t("users.status.activeTitle")
          : t("users.status.disabledTitle")
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
      {active ? t("users.status.active") : t("users.status.disabled")}
    </Badge>
  );
}

/** 套餐维度：`active` 不占位，其余取名下最严重的一张，避免「断了流还显示正常」。 */
const PACKAGE_WORST_TITLES: Record<
  Exclude<UserView["package_worst_status"], "active">,
  string
> = {
  exhausted: "users.packageWorst.exhausted",
  expired: "users.packageWorst.expired",
  disabled: "users.packageWorst.disabled",
  none: "users.packageWorst.none",
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
      title={t(PACKAGE_WORST_TITLES[status])}
      className={cn(
        "border-transparent font-normal",
        statusToneClasses[none ? "muted" : packageStatusTone(status)],
      )}
    >
      {none ? t("users.packageWorst.noPackage") : packageStatusLabel(status)}
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
      title={t("users.quotaExceededTitle")}
    >
      <TriangleAlertIcon className="size-3" />
      {t("users.quotaExceeded")}
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
        title={t("users.noPackagesTitle")}
      >
        {t("users.packageCount", { n: 0 })}
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
          aria-label={t("users.packageBreakdown.aria", {
            username: user.username,
            count,
          })}
          title={t("users.packageBreakdown.triggerTitle", { count })}
        >
          {t("users.packageCount", { n: count })}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <PopoverHeader>
          <PopoverTitle className="text-sm">{t("users.packageBreakdown.title")}</PopoverTitle>
          <PopoverDescription className="text-xs">
            {t("users.packageBreakdown.desc", { count })}
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
                <p className="mt-0.5 font-mono text-micro text-muted-foreground">
                  {formatBytes(item.used_bytes)} /{" "}
                  {formatBytes(item.quota_bytes, { zeroAsUnlimited: true })}
                </p>
              </div>
              <PackageStatusBadge status={item.status} />
            </li>
          ))}
        </ul>
        {count > packages.length ? (
          <p className="text-micro leading-normal text-muted-foreground">
            {t("users.packageBreakdown.onlyFirst", {
              shown: packages.length,
            })}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
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
      <TableCell colSpan={COLUMN_COUNT} className="px-4 py-8">
        <EmptyState
          size="sm"
          icon={UsersIcon}
          title={searching ? t("users.emptySearch") : t("users.emptyNoUsers")}
          description={
            searching ? t("users.emptySearchDesc") : t("users.emptyDesc")
          }
          action={
            searching ? (
              <Button variant="outline" size="sm" onClick={onClearSearch}>
                <XIcon className="icon-sm" />
                {t("users.clearSearch")}
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={onCreate}>
                <PlusIcon className="icon-md" />
                {t("users.create")}
              </Button>
            )
          }
        />
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
            <TriangleAlertIcon className="icon-lg" />
          </div>
          <div>
            <p className="text-sm font-medium">{t("users.loadFailed")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{message}</p>
          </div>
          <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
            <RefreshCwIcon
              className={cn("icon-md", retrying && "animate-spin")}
            />
            {t("common.retry")}
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
            <Trash2Icon className="icon-lg" />
          </AlertDialogMedia>
          <AlertDialogTitle>{t("users.delete.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("users.delete.desc", {
              username: user.username,
              count: user.package_count,
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteUser.isPending}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleteUser.isPending}
            onClick={(event) => {
              event.preventDefault();
              deleteUser.mutate(user.id, {
                onSuccess: () => {
                  toast.success(t("users.delete.success"));
                  onOpenChange(false);
                },
                onError: (error) => {
                  toast.error(
                    errorText(error, t("users.delete.error")),
                  );
                },
              });
            }}
          >
            {t("common.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function UsersPage() {
  useI18n();
  const isDesktop = useIsDesktop();
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
              ? t("users.toggle.disabledToast", { username: user.username })
              : t("users.toggle.enabledToast", { username: user.username }),
          );
        },
        onError: (error) => {
          toast.error(
            errorText(error, t("users.toggle.error")),
          );
        },
      },
    );
  }

  const items = users.data ?? [];
  const showError = users.isError;
  const errorMessage = errorText(
    users.error,
    t("users.loadError"),
  );

  function renderUserIdentity(user: UserView) {
    return (
      <div className="flex items-center gap-2.5">
        <Avatar size="sm">
          <AvatarFallback>
            {user.username.slice(0, 1).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="truncate font-medium">{user.username}</div>
          <div className="font-mono text-micro text-muted-foreground">
            {user.short_code}
          </div>
        </div>
      </div>
    );
  }

  function renderUserRole(user: UserView) {
    return (
      <Badge
        variant={user.role === "admin" ? "secondary" : "outline"}
        className="font-normal"
      >
        {user.role === "admin" ? <ShieldIcon className="size-3" /> : null}
        {roleLabel(user.role)}
      </Badge>
    );
  }

  function renderUserStatus(user: UserView) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <UserStatusBadge status={user.status} />
        <PackageWorstStatusBadge status={user.package_worst_status} />
        {user.quota_exceeded ? <QuotaExceededBadge /> : null}
      </div>
    );
  }

  function renderUserTraffic(user: UserView) {
    return (
      <div className="space-y-1">
        {user.package_count === 0 ? (
          <p
            className="w-48 text-xs text-muted-foreground"
            title={t("users.noPackagesTitle")}
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
            className="text-micro leading-normal text-destructive"
            title={t("users.quotaUsedTitle", {
              used: formatBytes(user.used_bytes),
              quota: formatBytes(user.quota_bytes),
            })}
          >
            {t("users.quotaUsedFull")}
          </p>
        ) : null}
      </div>
    );
  }

  function renderUserCreated(user: UserView) {
    return (
      <span
        className="text-xs tabular-nums text-muted-foreground"
        title={formatAbsoluteTime(user.created_at)}
      >
        {formatRelativeTime(user.created_at)}
      </span>
    );
  }

  function renderUserActions(user: UserView) {
    const isSelf = user.id === me.data?.id;

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("users.actions.aria", {
              username: user.username,
            })}
          >
            <MoreHorizontalIcon className="icon-md" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem
            onSelect={() => setFormState({ mode: "edit", user })}
          >
            <PencilIcon className="icon-sm" />
            {t("users.actions.edit")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setResetUser(user)}>
            <KeyRoundIcon className="icon-sm" />
            {t("users.actions.resetPassword")}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={isSelf || updateUser.isPending}
            title={
              isSelf ? t("users.actions.cannotDisableSelf") : undefined
            }
            onSelect={() => toggleStatus(user)}
          >
            <PowerIcon className="icon-sm" />
            {user.status === "active"
              ? t("users.actions.disable")
              : t("users.actions.enable")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setPackagesUser(user)}>
            <PackageIcon className="icon-sm" />
            {t("users.actions.managePackages")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={isSelf}
            title={isSelf ? t("users.actions.cannotDeleteSelf") : undefined}
            onSelect={() => setDeleteTarget(user)}
          >
            <Trash2Icon className="icon-sm" />
            {t("common.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  function renderRow(user: UserView) {
    return (
      <TableRow key={user.id}>
        <TableCell sticky="left" className="px-4 py-2.5">
          {renderUserIdentity(user)}
        </TableCell>
        <TableCell className="px-4 py-2.5">
          {renderUserRole(user)}
        </TableCell>
        <TableCell className="px-4 py-2.5">
          {renderUserStatus(user)}
        </TableCell>
        <TableCell className="px-4 py-2.5">
          <PackageBreakdownPopover user={user} />
        </TableCell>
        <TableCell className="px-4 py-2.5">
          {renderUserTraffic(user)}
        </TableCell>
        <TableCell className="px-4 py-2.5">
          {renderUserCreated(user)}
        </TableCell>
        <TableCell sticky="right" className="px-4 py-2.5">
          {renderUserActions(user)}
        </TableCell>
      </TableRow>
    );
  }

  function renderCard(user: UserView) {
    return (
      <MobileDataCard
        key={user.id}
        title={user.username}
        subtitle={user.short_code}
        actions={renderUserActions(user)}
        fields={[
          { label: t("users.columns.role"), value: renderUserRole(user) },
          { label: t("users.columns.status"), value: renderUserStatus(user) },
          {
            label: t("users.columns.packages"),
            value: <PackageBreakdownPopover user={user} />,
          },
          {
            label: t("users.columns.packageTraffic"),
            value: renderUserTraffic(user),
          },
          {
            label: t("users.columns.createdAt"),
            value: renderUserCreated(user),
          },
        ]}
      />
    );
  }


  return (
    <div className="animate-enter space-y-6">
      <PageHeader
        title={t("users.title")}
        description={t("users.subtitle")}
        actions={
          <Button onClick={() => setFormState({ mode: "create" })}>
            <PlusIcon className="icon-md" />
            {t("users.create")}
          </Button>
        }
      />

      <Card className="gap-0 overflow-hidden">
        <CardHeader className="border-b border-border">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              {t("users.list")}
              {users.data && !users.isError ? (
                <Badge
                  variant="secondary"
                  className="font-mono text-micro font-normal text-muted-foreground"
                >
                  {items.length}
                </Badge>
              ) : null}
            </CardTitle>

            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-full sm:w-72">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 icon-md -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder={t("users.searchPlaceholder")}
                  aria-label={t("users.searchAria")}
                  className="pr-8 pl-8"
                />
                {searchInput ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("users.clearSearch")}
                    className="absolute top-1/2 right-1 -translate-y-1/2"
                    onClick={clearSearch}
                  >
                    <XIcon className="icon-sm" />
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
                    "icon-md",
                    users.isFetching && "animate-spin",
                  )}
                />
                {t("common.refresh")}
              </Button>
            </div>
          </div>
          <CardDescription className="text-xs">
            {t("users.desc")}
          </CardDescription>
        </CardHeader>

        <CardContent className="p-0" aria-busy={users.isPending}>
          {users.isPending && isDesktop ? (
            <SkeletonTable rows={6} columns={COLUMN_COUNT} />
          ) : null}
          {users.isPending && !isDesktop ? (
            <div className="space-y-3 p-3">
              {Array.from({ length: 3 }).map((_, index) => (
                <SkeletonCard key={index} lines={5} />
              ))}
            </div>
          ) : null}
          {isDesktop ? (
          <div className={cn(users.isPending && "hidden")}>
          <Table className="min-w-[980px]">
            <TableCaption className="sr-only">{t("users.tableCaption")}</TableCaption>
            <TableHeader className="bg-muted/30">
              <TableRow>
                {[
                  { label: t("users.columns.user") },
                  { label: t("users.columns.role") },
                  {
                    label: t("users.columns.status"),
                    title: t("users.columnTitles.status"),
                  },
                  {
                    label: t("users.columns.packages"),
                    title: t("users.columnTitles.packages"),
                  },
                  {
                    label: t("users.columns.packageTraffic"),
                    hint: t("users.columnTitles.trafficHint"),
                    title: t("users.columnTitles.traffic"),
                  },
                  { label: t("users.columns.createdAt") },
                  { label: t("users.columns.actions") },
                ].map(({ label, hint, title }, index, columns) => (
                  <TableHead
                    key={label}
                    sticky={
                      index === 0
                        ? "left"
                        : index === columns.length - 1
                          ? "right"
                          : undefined
                    }
                    title={title}
                    className={cn(
                      "px-4 text-xs font-medium tracking-wide text-muted-foreground",
                      hint ? "h-auto py-2" : "h-9",
                    )}
                  >
                    <span className="block">{label}</span>
                    {hint ? (
                      <span className="mt-0.5 block text-micro font-normal tracking-normal whitespace-nowrap text-muted-foreground">
                        {hint}
                      </span>
                    ) : null}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {showError ? (
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
                items.map(renderRow)
              )}
            </TableBody>
          </Table>
          </div>
          ) : null}

          {!users.isPending && !isDesktop ? (
            <div className="space-y-3 p-3" aria-busy={false}>
              {showError ? (
                <Card size="sm" className="py-0">
                  <ListError
                    title={t("users.loadFailed")}
                    message={errorMessage}
                    retrying={users.isFetching}
                    onRetry={() => void users.refetch()}
                  />
                </Card>
              ) : items.length === 0 ? (
                <EmptyState
                  size="sm"
                  icon={UsersIcon}
                  title={
                    q ? t("users.emptySearch") : t("users.emptyNoUsers")
                  }
                  description={
                    q ? t("users.emptySearchDesc") : t("users.emptyDesc")
                  }
                  action={
                    q ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={clearSearch}
                      >
                        <XIcon className="icon-sm" />
                        {t("users.clearSearch")}
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setFormState({ mode: "create" })}
                      >
                        <PlusIcon className="icon-md" />
                        {t("users.create")}
                      </Button>
                    )
                  }
                />
              ) : (
                items.map(renderCard)
              )}
            </div>
          ) : null}
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
