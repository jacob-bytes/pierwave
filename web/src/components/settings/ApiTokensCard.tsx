import { useReducer, useState, type FormEvent } from "react";
import {
  KeyRoundIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { toast } from "sonner";
import { FormField } from "@/components/FormField";
import {
  CopyButton,
  EmptyState,
  SkeletonTable,
} from "@/components/common";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ApiTokenRow } from "@/lib/api";
import {
  DEFAULT_API_TOKEN_SCOPE,
  type ApiTokenScope,
  API_TOKEN_NAME_MAX,
  describeExpiry,
  revealedToken,
  scopeHintKey,
  scopeLabelKey,
  tokenRevealReducer,
  tokenStatus,
  validateTokenName,
} from "@/lib/apiTokens";
import { errorText } from "@/lib/errors";
import {
  useApiTokens,
  useCreateApiToken,
  useRevokeApiToken,
} from "@/lib/queries";
import {
  dateInputAfterDays,
  dateInputToUnixEndOfDay,
  formatAbsoluteTime,
  formatRelativeTime,
} from "@/lib/time";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

const COLUMN_COUNT = 6;

function StatusBadge({ token }: { token: ApiTokenRow }) {
  const status = tokenStatus(token);
  const expiry = describeExpiry(token.expires_at);
  const expiryText =
    expiry.kind === "never"
      ? t("settings.apiTokens.expiry.never")
      : t(
          expiry.kind === "expired"
            ? "settings.apiTokens.expiry.expired"
            : "settings.apiTokens.expiry.at",
          { date: expiry.date },
        );

  return (
    <div className="space-y-1">
      <Badge
        variant={
          status === "revoked"
            ? "destructive"
            : status === "expired"
              ? "outline"
              : "secondary"
        }
      >
        {t(`settings.apiTokens.status.${status}`)}
      </Badge>
      <p className="text-xs text-muted-foreground">{expiryText}</p>
    </div>
  );
}

function NameCell({ token }: { token: ApiTokenRow }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-sm font-medium">{token.name}</p>
      <p className="truncate font-mono text-xs text-muted-foreground">
        {token.id}
      </p>
    </div>
  );
}

function ScopeBadge({ scope }: { scope: ApiTokenScope }) {
  return (
    <Badge variant={scope === "admin" ? "default" : "outline"}>
      {t(scopeLabelKey(scope))}
    </Badge>
  );
}

/** 设置 → 安全 下的「API 访问」卡：列表 + 创建（明文只显示一次）+ 吊销。 */
export function ApiTokensCard() {
  useI18n();
  const tokens = useApiTokens();
  const createToken = useCreateApiToken();
  const revokeToken = useRevokeApiToken();

  const [createOpen, setCreateOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiTokenRow | null>(null);
  const [reveal, dispatchReveal] = useReducer(tokenRevealReducer, {
    phase: "idle",
  });

  const [name, setName] = useState("");
  const [scope, setScope] = useState<ApiTokenScope>(DEFAULT_API_TOKEN_SCOPE);
  const [expiresDate, setExpiresDate] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const plaintext = revealedToken(reveal);
  const items = tokens.data ?? [];
  const showError = tokens.isError && !tokens.data;
  const errorMessage = errorText(tokens.error, t("settings.apiTokens.loadError"));

  function resetCreateForm() {
    setName("");
    setScope(DEFAULT_API_TOKEN_SCOPE);
    setExpiresDate("");
    setFormError(null);
  }

  function openCreateDialog() {
    // 上一轮的一次性明文已经 dismissed；再打开创建框时回到干净的 idle。
    dispatchReveal({ type: "reset" });
    resetCreateForm();
    setCreateOpen(true);
  }

  function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const problem = validateTokenName(name);
    if (problem === "empty") {
      setFormError(t("settings.apiTokens.nameRequired"));
      return;
    }
    if (problem === "too_long") {
      setFormError(t("settings.apiTokens.nameTooLong", { max: API_TOKEN_NAME_MAX }));
      return;
    }
    if (problem === "control") {
      setFormError(t("settings.apiTokens.nameControl"));
      return;
    }

    const expiresAt = expiresDate
      ? dateInputToUnixEndOfDay(expiresDate)
      : null;
    if (expiresDate && expiresAt === null) {
      setFormError(t("settings.apiTokens.expiryInvalid"));
      return;
    }
    if (expiresAt !== null && expiresAt <= Math.floor(Date.now() / 1_000)) {
      setFormError(t("settings.apiTokens.expiryInvalid"));
      return;
    }

    createToken.mutate(
      { name: name.trim(), scope, expires_at: expiresAt },
      {
        onSuccess: (result) => {
          setCreateOpen(false);
          // 唯一一次持有明文：关闭结果对话框后状态机把明文丢掉。
          dispatchReveal({ type: "created", token: result.token });
          toast.success(t("settings.apiTokens.created"));
          resetCreateForm();
        },
        onError: (error) => {
          setFormError(errorText(error, t("settings.apiTokens.createFailed")));
        },
      },
    );
  }

  return (
    <div className="space-y-4">
      <Card className="gap-0 overflow-hidden">
        <CardHeader className="border-b border-border">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <KeyRoundIcon className="size-4 text-muted-foreground" />
              {t("settings.apiTokens.title")}
              {tokens.data && !tokens.isError ? (
                <Badge
                  variant="secondary"
                  className="font-mono type-micro font-normal text-muted-foreground"
                >
                  {items.length}
                </Badge>
              ) : null}
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={openCreateDialog}>
                <PlusIcon className="size-3.5" />
                {t("settings.apiTokens.create")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void tokens.refetch()}
                disabled={tokens.isFetching}
              >
                <RefreshCwIcon
                  className={cn("size-3.5", tokens.isFetching && "animate-spin")}
                />
                {t("common.refresh")}
              </Button>
            </div>
          </div>
          <CardDescription className="text-xs">
            {t("settings.apiTokens.desc")}
          </CardDescription>
        </CardHeader>

        <CardContent className="p-0" aria-busy={tokens.isPending}>
          {tokens.isPending ? (
            <SkeletonTable rows={3} columns={COLUMN_COUNT} />
          ) : null}
          <Table className={cn("min-w-[860px]", tokens.isPending && "hidden")}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("settings.apiTokens.columns.name")}</TableHead>
                <TableHead>{t("settings.apiTokens.columns.scope")}</TableHead>
                <TableHead>{t("settings.apiTokens.columns.created")}</TableHead>
                <TableHead>{t("settings.apiTokens.columns.lastUsed")}</TableHead>
                <TableHead>{t("settings.apiTokens.columns.status")}</TableHead>
                <TableHead className="text-right">
                  {t("settings.apiTokens.columns.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {showError ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={COLUMN_COUNT} className="px-4 py-16">
                    <div className="mx-auto flex max-w-md flex-col items-center gap-3 text-center">
                      <div className="grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
                        <TriangleAlertIcon className="size-5" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">
                          {t("settings.apiTokens.loadFailed")}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {errorMessage}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void tokens.refetch()}
                        disabled={tokens.isFetching}
                      >
                        <RefreshCwIcon
                          className={cn(
                            "size-3.5",
                            tokens.isFetching && "animate-spin",
                          )}
                        />
                        {t("common.retry")}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ) : items.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={COLUMN_COUNT} className="px-4 py-8">
                    <EmptyState
                      size="sm"
                      icon={ShieldCheckIcon}
                      title={t("settings.apiTokens.emptyTitle")}
                      description={t("settings.apiTokens.emptyDesc")}
                      action={
                        <Button variant="outline" size="sm" onClick={openCreateDialog}>
                          <PlusIcon className="size-3.5" />
                          {t("settings.apiTokens.emptyAction")}
                        </Button>
                      }
                    />
                  </TableCell>
                </TableRow>
              ) : (
                items.map((token) => {
                  const status = tokenStatus(token);
                  return (
                    <TableRow key={token.id}>
                      <TableCell>
                        <NameCell token={token} />
                      </TableCell>
                      <TableCell>
                        <ScopeBadge scope={token.scope} />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatAbsoluteTime(token.created_at)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {token.last_used_at === null
                          ? t("settings.apiTokens.lastUsedNever")
                          : formatRelativeTime(token.last_used_at)}
                      </TableCell>
                      <TableCell>
                        <StatusBadge token={token} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="xs"
                          className="text-destructive"
                          disabled={status === "revoked" || revokeToken.isPending}
                          onClick={() => {
                            setRevokeError(null);
                            setRevokeTarget(token);
                          }}
                        >
                          <Trash2Icon className="size-3.5" />
                          {t("settings.apiTokens.revoke")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open && createToken.isPending) return;
          setCreateOpen(open);
        }}
      >
        <DialogContent>
          <form className="space-y-4" onSubmit={submitCreate}>
            <DialogHeader>
              <DialogTitle>{t("settings.apiTokens.create")}</DialogTitle>
            </DialogHeader>

            <FormField
              label={t("settings.apiTokens.name")}
              htmlFor="api-token-name"
              required
              error={formError ?? undefined}
            >
              <Input
                id="api-token-name"
                autoComplete="off"
                placeholder={t("settings.apiTokens.namePlaceholder")}
                maxLength={API_TOKEN_NAME_MAX}
                value={name}
                disabled={createToken.isPending}
                onChange={(event) => setName(event.target.value)}
              />
            </FormField>

            <div className="space-y-2">
              <Label htmlFor="api-token-scope">
                {t("settings.apiTokens.scopeLabel")}
              </Label>
              <Select
                value={scope}
                onValueChange={(value) => setScope(value as ApiTokenScope)}
                disabled={createToken.isPending}
              >
                <SelectTrigger id="api-token-scope" className="w-full">
                  <SelectValue
                    placeholder={t("settings.apiTokens.scopePlaceholder")}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="read">
                    {t("settings.apiTokens.scope.read")}
                  </SelectItem>
                  <SelectItem value="admin">
                    {t("settings.apiTokens.scope.admin")}
                  </SelectItem>
                </SelectContent>
              </Select>
              {/* 只写必要的一句：scope 的语义容易误解。 */}
              <p className="text-xs text-muted-foreground">
                {t(scopeHintKey(scope))}
              </p>
            </div>

            <FormField
              label={t("settings.apiTokens.expires")}
              htmlFor="api-token-expires"
              hint={t("settings.apiTokens.expiresHint")}
            >
              <Input
                id="api-token-expires"
                type="date"
                min={dateInputAfterDays(1)}
                value={expiresDate}
                disabled={createToken.isPending}
                onChange={(event) => setExpiresDate(event.target.value)}
              />
            </FormField>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={createToken.isPending}
                onClick={() => setCreateOpen(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={createToken.isPending}>
                {createToken.isPending ? (
                  <Loader2Icon className="animate-spin" />
                ) : (
                  <PlusIcon />
                )}
                {createToken.isPending
                  ? t("settings.apiTokens.creating")
                  : t("settings.apiTokens.submit")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* 一次性明文：只有 `created` 阶段存在；关闭即从状态机里删除。 */}
      <Dialog
        open={reveal.phase === "created"}
        onOpenChange={(open) => {
          if (!open) dispatchReveal({ type: "dismissed" });
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheckIcon className="size-4 text-primary" />
              {t("settings.apiTokens.revealTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("settings.apiTokens.revealDesc")}
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 rounded-md bg-muted p-3 font-mono text-xs break-all">
              {plaintext}
            </code>
            {plaintext ? (
              <CopyButton
                value={plaintext}
                label={t("settings.apiTokens.revealCopyLabel")}
                className="shrink-0"
              />
            ) : null}
          </div>

          <Alert>
            <TriangleAlertIcon />
            <AlertTitle>{t("settings.apiTokens.revealWarning")}</AlertTitle>
          </Alert>

          <DialogFooter>
            <Button
              type="button"
              onClick={() => dispatchReveal({ type: "dismissed" })}
            >
              {t("settings.apiTokens.revealAck")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open && revokeToken.isPending) return;
          if (!open) setRevokeTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <Trash2Icon className="size-5" />
            </AlertDialogMedia>
            <AlertDialogTitle>
              {t("settings.apiTokens.revokeTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.apiTokens.revokeDesc", {
                name: revokeTarget?.name ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {revokeError ? (
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>{t("settings.apiTokens.revokeError")}</AlertTitle>
              <AlertDescription>{revokeError}</AlertDescription>
            </Alert>
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={revokeToken.isPending}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={revokeToken.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (!revokeTarget) return;
                setRevokeError(null);
                revokeToken.mutate(revokeTarget.id, {
                  onSuccess: () => {
                    toast.success(
                      t("settings.apiTokens.revokeSuccess", {
                        name: revokeTarget.name,
                      }),
                    );
                    setRevokeTarget(null);
                  },
                  onError: (error) => {
                    setRevokeError(
                      errorText(error, t("settings.apiTokens.revokeError")),
                    );
                  },
                });
              }}
            >
              {t("settings.apiTokens.revoke")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
