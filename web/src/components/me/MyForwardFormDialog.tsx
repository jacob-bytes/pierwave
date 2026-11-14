import { useEffect, useMemo, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CheckIcon, CopyIcon, InfoIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { FormField, FormRootError } from "@/components/FormField";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { MeForward, MeForwardServer } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { errorText } from "@/lib/errors";
import { entryLabel } from "@/lib/myForwards";
import { useCreateMyForward } from "@/lib/queries";
import {
  MY_FORWARD_PROTOCOLS,
  myForwardFormSchema,
  type MyForwardFormValues,
} from "@/lib/schemas";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";

interface MyForwardFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前套餐允许的服务器；空数组时表单不可提交。 */
  servers: MeForwardServer[];
}

/**
 * 用户自助新建转发：只填服务器、目标与协议。
 *
 * 入口端口由系统分配，表单里没有端口字段；创建成功后在本对话框内
 * 直接展示后端返回的入口地址（可复制），避免用户再回列表里找。
 */
export function MyForwardFormDialog({
  open,
  onOpenChange,
  servers,
}: MyForwardFormDialogProps) {
  const { t } = useI18n();
  const createForward = useCreateMyForward();
  const [created, setCreated] = useState<MeForward | null>(null);
  const schema = useMemo(() => myForwardFormSchema(t), [t]);
  const form = useForm<MyForwardFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      server_id: servers.length === 1 ? servers[0].id : "",
      target_host: "",
      target_port: "",
      protocol: "tcp",
    },
  });

  // 服务器列表可能比对话框晚到：只有一个选项时自动选中，少点一次。
  useEffect(() => {
    if (form.getValues("server_id")) return;
    if (servers.length === 1) {
      form.setValue("server_id", servers[0].id, { shouldValidate: false });
    }
  }, [servers, form]);

  // 切换语言后重新校验，让已经显示的错误跟着换语言。
  useEffect(() => {
    if (form.formState.isSubmitted) void form.trigger();
  }, [t, form]);

  const pending = createForward.isPending;
  const selectedProtocol = useWatch({ control: form.control, name: "protocol" });
  const targetHost = useWatch({ control: form.control, name: "target_host" });
  const targetPort = useWatch({ control: form.control, name: "target_port" });

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors("root");
    try {
      const result = await createForward.mutateAsync({
        server_id: values.server_id,
        target_host: values.target_host.trim(),
        target_port: Number(values.target_port),
        protocol: values.protocol,
      });
      if (result) {
        setCreated(result);
      } else {
        // 后端只回 `{ ok: true }` 时不编造地址：关掉对话框，列表会刷新出来。
        toast.success(t("me.forwards.createdFallback"));
        onOpenChange(false);
      }
    } catch (error) {
      const message = errorText(error, t("me.forwards.formError"));
      form.setError("root", { message });
      toast.error(message);
    }
  });

  async function copyEntry(address: string) {
    if (await copyText(address)) {
      toast.success(t("me.forwards.copied"));
    } else {
      toast.error(t("me.forwards.copyError"));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {created
              ? t("me.forwards.createdTitle")
              : t("me.forwards.createTitle")}
          </DialogTitle>
          <DialogDescription>
            {created
              ? t("me.forwards.createdDesc")
              : t("me.forwards.createDesc")}
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 p-2.5">
              <code
                className="min-w-0 flex-1 truncate font-mono text-sm"
                title={entryLabel(created)}
              >
                {entryLabel(created)}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void copyEntry(entryLabel(created))}
                disabled={entryLabel(created) === "—"}
              >
                <CopyIcon className="size-3.5" />
                {t("common.copy")}
              </Button>
            </div>
            <div className="flex items-start gap-2 rounded-lg border border-primary/25 bg-primary/5 p-3">
              <CheckIcon className="mt-0.5 size-4 shrink-0 text-primary" />
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("me.forwards.portAuto")}
              </p>
            </div>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>
                {t("me.forwards.done")}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <form id="my-forward-form" className="space-y-4" onSubmit={onSubmit}>
              {servers.length === 0 ? (
                <Alert>
                  <InfoIcon />
                  <AlertTitle>{t("me.forwards.serverEmptyTitle")}</AlertTitle>
                  <AlertDescription>
                    {t("me.forwards.serverEmptyDesc")}
                  </AlertDescription>
                </Alert>
              ) : (
                <FormField
                  label={t("me.forwards.server")}
                  htmlFor="my-forward-server"
                  required
                  hint={t("me.forwards.serverHint")}
                  error={form.formState.errors.server_id?.message}
                >
                  <Controller
                    control={form.control}
                    name="server_id"
                    render={({ field }) => (
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                        disabled={pending}
                      >
                        <SelectTrigger id="my-forward-server" className="w-full">
                          <SelectValue
                            placeholder={t("me.forwards.serverPlaceholder")}
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {servers.map((server) => (
                            <SelectItem key={server.id} value={server.id}>
                              {server.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </FormField>
              )}

              <FormField
                label={t("me.forwards.targetHost")}
                htmlFor="my-forward-target-host"
                required
                error={form.formState.errors.target_host?.message}
              >
                <Input
                  id="my-forward-target-host"
                  value={targetHost}
                  onChange={(event) =>
                    form.setValue("target_host", event.target.value)
                  }
                  onBlur={() => void form.trigger("target_host")}
                  placeholder={t("me.forwards.targetHostPlaceholder")}
                  autoComplete="off"
                  disabled={pending}
                  aria-invalid={Boolean(form.formState.errors.target_host)}
                  className="font-mono"
                />
              </FormField>

              <FormField
                label={t("me.forwards.targetPort")}
                htmlFor="my-forward-target-port"
                required
                error={form.formState.errors.target_port?.message}
              >
                <Input
                  id="my-forward-target-port"
                  value={targetPort}
                  onChange={(event) =>
                    form.setValue("target_port", event.target.value)
                  }
                  onBlur={() => void form.trigger("target_port")}
                  inputMode="numeric"
                  autoComplete="off"
                  disabled={pending}
                  aria-invalid={Boolean(form.formState.errors.target_port)}
                  className="font-mono tabular-nums"
                />
              </FormField>

              <FormField
                label={t("me.forwards.protocol")}
                error={form.formState.errors.protocol?.message}
              >
                <RadioGroup
                  aria-label={t("me.forwards.protocol")}
                  value={selectedProtocol}
                  onValueChange={(next) => {
                    form.setValue(
                      "protocol",
                      next as MyForwardFormValues["protocol"],
                      {
                        shouldDirty: true,
                        shouldTouch: true,
                        shouldValidate: form.formState.isSubmitted,
                      },
                    );
                  }}
                  disabled={pending}
                  className="grid grid-cols-2 gap-2"
                >
                  {MY_FORWARD_PROTOCOLS.map((protocol) => {
                    const active = selectedProtocol === protocol;
                    return (
                      <Label
                        key={protocol}
                        htmlFor={`my-forward-protocol-${protocol}`}
                        className={cn(
                          "flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-2 transition-colors duration-150 hover:bg-muted/40",
                          active &&
                            "border-primary/60 bg-primary/5 hover:bg-primary/5",
                          pending && "cursor-not-allowed opacity-60",
                        )}
                      >
                        <RadioGroupItem
                          id={`my-forward-protocol-${protocol}`}
                          value={protocol}
                          disabled={pending}
                        />
                        <span className="text-sm font-medium">
                          {t(`me.forwards.protocolOptions.${protocol}`)}
                        </span>
                      </Label>
                    );
                  })}
                </RadioGroup>
              </FormField>

              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <InfoIcon className="size-3.5 shrink-0" />
                {t("me.forwards.portAuto")}
              </p>

              <FormRootError message={form.formState.errors.root?.message} />
            </form>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={pending}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                form="my-forward-form"
                disabled={pending || servers.length === 0}
              >
                {pending ? <Loader2Icon className="animate-spin" /> : null}
                {pending
                  ? t("me.forwards.submitting")
                  : t("me.forwards.submit")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
