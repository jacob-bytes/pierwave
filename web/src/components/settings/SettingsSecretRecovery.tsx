import { useState } from "react";
import type { FormEvent } from "react";
import {
  ExternalLinkIcon,
  KeyRoundIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { toast } from "sonner";
import { FormField } from "@/components/FormField";
import {
  Alert,
  AlertDescription,
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
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import type { UpdateSettingsInput } from "@/lib/api";
import { errorText } from "@/lib/errors";
import {
  useResetSubscriptionSecret,
  useUpdateSettings,
} from "@/lib/queries";
import {
  BACKUP_ENCRYPTION_DOC_URL,
  buildSecretPatch,
  canResetSubscriptionSecret,
  EDITABLE_SECRET_FIELDS,
  secretKeyText,
  subscriptionSecretResetUnsupported,
  SUBSCRIPTION_SECRET_KEY,
  type SecretDecryptFailure,
} from "@/lib/settingsSecrets";
import { t, useI18n } from "@/i18n";

/**
 * 设置秘密解不开时的专用恢复卡。
 *
 * 不再只显示「设置加载失败」：列出具体哪些秘密、给可编辑的那些提供重填
 * 表单（PATCH 只提交填写的键），保存成功后重新拉取设置；`hmac_secret_v1`
 * 这类内部密钥明确说明不能在这里重填。
 */
export function SettingsSecretRecovery({
  failure,
  onRetried,
}: {
  failure: SecretDecryptFailure;
  onRetried: () => void;
}) {
  const { t: translate } = useI18n();
  const update = useUpdateSettings();
  const reset = useResetSubscriptionSecret();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  // 旧后端没有重置端点：第一次 404 后本卡片不再展示按钮，也不报错。
  const [resetUnsupported, setResetUnsupported] = useState(false);

  const canSave = failure.editableKeys.some(
    (key) => (values[key] ?? "").trim().length > 0,
  );
  const canReset =
    canResetSubscriptionSecret(failure) && !resetUnsupported;
  // 内部键单独成段：它们没有输入框，但必须给出「下一步」。
  const badgeKeys = failure.keys.filter(
    (key) => !failure.internalKeys.includes(key),
  );

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave || update.isPending) return;

    const patch = buildSecretPatch(values);
    if (Object.keys(patch).length === 0) return;

    setSaveError(null);
    update.mutate(patch as UpdateSettingsInput, {
      onSuccess: () => {
        toast.success(t("settings.secretError.saved"));
        setValues({});
        setOpen(false);
        onRetried();
      },
      onError: (error) => {
        const message = errorText(error, t("settings.secretError.saveError"));
        setSaveError(message);
        toast.error(message);
      },
    });
  }

  function handleReset() {
    setResetError(null);
    reset.mutate(undefined, {
      onSuccess: () => {
        toast.success(t("settings.secretError.resetSuccess"));
        setResetOpen(false);
        setValues({});
        setOpen(false);
        onRetried();
      },
      onError: (error) => {
        if (subscriptionSecretResetUnsupported(error)) {
          // 能力未上线：静默降级成备份恢复说明，不把 404 当故障。
          setResetOpen(false);
          setResetError(null);
          setResetUnsupported(true);
          return;
        }
        // 真实失败留在弹窗里，别让用户以为已经重置成功。
        setResetError(
          errorText(error, t("settings.secretError.resetError")),
        );
      },
    });
  }

  return (
    <Card
      data-slot="settings-secret-recovery"
      className="border-warning/25 bg-warning/5"
    >
      <CardContent className="space-y-3">
        <div className="flex items-start gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-full bg-warning/10 text-warning">
            <ShieldAlertIcon className="icon-md" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              {t("settings.secretError.title")}
            </p>
            <p className="mt-1 text-xs leading-normal text-muted-foreground">
              {t("settings.secretError.description")}
            </p>
            {badgeKeys.length > 0 ? (
              <ul
                aria-label={t("settings.secretError.keysTitle")}
                className="mt-2 flex flex-wrap gap-1.5"
              >
                {badgeKeys.map((key) => (
                  <li key={key}>
                    <Badge
                      variant="outline"
                      className="border-warning/30 bg-background/40 font-normal text-warning"
                    >
                      {secretKeyText(key)}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : null}

            {/* 内部键没有输入框，所以「下一步」必须写在这里。只有后端明确
                报告 hmac_secret_v1 损坏时才提供在线重置；重置会轮换所有已
                派生凭据，不能和常驻动作等距摆放。 */}
            {failure.internalKeys.length > 0 ? (
              <ul className="mt-2 space-y-2 rounded-lg border border-warning/20 bg-background/40 p-2.5">
                {failure.internalKeys.map((key) => {
                  const subscription = key === SUBSCRIPTION_SECRET_KEY;
                  const consequence = !subscription
                    ? t("settings.secretError.internalUnknown")
                    : resetUnsupported
                      ? t("settings.secretError.resetUnsupported")
                      : canReset
                        ? t("settings.secretError.hmacConsequence")
                        : t("settings.secretError.hmacConsequenceNoReset");
                  return (
                    <li key={key} className="space-y-2">
                      <Badge
                        variant="outline"
                        className="border-warning/30 bg-background/40 font-normal text-warning"
                      >
                        {secretKeyText(key)}
                      </Badge>
                      <p className="text-xs leading-normal text-muted-foreground">
                        {consequence}
                      </p>
                      {subscription ? (
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <Button
                            asChild
                            variant="link"
                            size="sm"
                            className="h-auto p-0 text-xs"
                          >
                            <a
                              href={BACKUP_ENCRYPTION_DOC_URL}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {t("settings.secretError.hmacDoc")}
                              <ExternalLinkIcon className="size-3" />
                            </a>
                          </Button>
                          {canReset ? (
                            <Button
                              type="button"
                              variant="destructive"
                              size="sm"
                              onClick={() => {
                                setResetError(null);
                                setResetOpen(true);
                              }}
                              disabled={reset.isPending}
                            >
                              <RotateCcwIcon className="size-3.5" />
                              {t("settings.secretError.reset")}
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        </div>

        {failure.editableKeys.length > 0 ? (
          open ? (
            <form
              className="space-y-3 rounded-lg border border-border bg-background/60 p-3"
              onSubmit={handleSubmit}
            >
              {failure.editableKeys.map((key) => {
                const meta = EDITABLE_SECRET_FIELDS[key];
                const id = `secret-${key}`;
                const label = secretKeyText(key);
                return (
                  <FormField
                    key={key}
                    label={label}
                    htmlFor={id}
                    required
                  >
                    {meta.input === "password" ? (
                      <PasswordInput
                        id={id}
                        value={values[key] ?? ""}
                        onChange={(event) =>
                          setValues((current) => ({
                            ...current,
                            [key]: event.target.value,
                          }))
                        }
                        autoComplete="new-password"
                        placeholder={t("settings.secretError.reenterPlaceholder")}
                        disabled={update.isPending}
                      />
                    ) : (
                      <Input
                        id={id}
                        type="url"
                        value={values[key] ?? ""}
                        onChange={(event) =>
                          setValues((current) => ({
                            ...current,
                            [key]: event.target.value,
                          }))
                        }
                        autoComplete="off"
                        placeholder={t("settings.secretError.reenterPlaceholder")}
                        disabled={update.isPending}
                      />
                    )}
                  </FormField>
                );
              })}

              {saveError ? (
                <p role="alert" className="text-xs text-destructive">
                  {saveError}
                </p>
              ) : null}

              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setOpen(false);
                    setSaveError(null);
                  }}
                  disabled={update.isPending}
                >
                  {t("common.cancel")}
                </Button>
                <Button type="submit" disabled={!canSave || update.isPending}>
                  <KeyRoundIcon className="icon-sm" />
                  {update.isPending
                    ? t("settings.secretError.saving")
                    : t("settings.secretError.save")}
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex justify-end">
              <Button type="button" onClick={() => setOpen(true)}>
                <KeyRoundIcon className="icon-sm" />
                {translate("settings.secretError.reenter")}
              </Button>
            </div>
          )
        ) : null}

        <AlertDialog
          open={resetOpen}
          onOpenChange={(next) => {
            if (!next && reset.isPending) return;
            setResetOpen(next);
            if (!next) setResetError(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogMedia className="bg-destructive/10 text-destructive">
                <RotateCcwIcon className="size-5" />
              </AlertDialogMedia>
              <AlertDialogTitle>
                {t("settings.secretError.resetTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("settings.secretError.resetDesc")}
              </AlertDialogDescription>
            </AlertDialogHeader>

            {resetError ? (
              <Alert variant="destructive">
                <TriangleAlertIcon />
                <AlertDescription>{resetError}</AlertDescription>
              </Alert>
            ) : null}

            <AlertDialogFooter>
              <AlertDialogCancel disabled={reset.isPending}>
                {t("common.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={reset.isPending}
                onClick={(event) => {
                  // 失败时保持弹窗打开：默认 Action 会关闭，错误就没地方显示。
                  event.preventDefault();
                  handleReset();
                }}
              >
                {t("settings.secretError.resetAction")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
