import { useEffect, useMemo } from "react";
import { Controller, useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  Loader2Icon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";
import { FormField, FormRootError } from "@/components/FormField";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { Chain, Server } from "@/lib/api";
import {
  CHAIN_MAX_HOPS,
  CHAIN_MIN_HOPS,
  orderHops,
} from "@/lib/chains";
import { errorText } from "@/lib/errors";
import { useCreateChain, useUpdateChain } from "@/lib/queries";
import { chainFormSchema, type ChainFormValues } from "@/lib/schemas";
import { useI18n } from "@/i18n";

interface ChainFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  chain?: Chain;
  servers: Server[];
  loadingServers: boolean;
}

interface HopFieldErrors {
  server_id?: { message?: string };
  listen_port?: { message?: string };
}

/**
 * 新建 / 编辑多跳转发链。
 *
 * 前端只拦「1–4 跳、同一服务器不重复、端口 1–65535、目标地址非空」；
 * 保留端口、与节点 / 独立转发 / 其它链跳的冲突、自连回环都依赖服务器数据，
 * 由后端返回带 code 的错误，这里通过 `errorText` 原样透出。
 */
export function ChainFormDialog({
  open,
  onOpenChange,
  mode,
  chain,
  servers,
  loadingServers,
}: ChainFormDialogProps) {
  const { t } = useI18n();
  const isEdit = mode === "edit";
  const createChain = useCreateChain();
  const updateChain = useUpdateChain();
  const pending = isEdit ? updateChain.isPending : createChain.isPending;

  const schema = useMemo(() => chainFormSchema(t), [t]);
  const form = useForm<ChainFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: chain?.name ?? "",
      target_host: chain?.target_host ?? "",
      target_port: chain ? String(chain.target_port) : "",
      enabled: chain ? Boolean(chain.enabled) : true,
      hops:
        chain && chain.hops.length > 0
          ? orderHops(chain.hops).map((hop) => ({
              server_id: hop.server_id,
              listen_port: String(hop.listen_port),
            }))
          : [{ server_id: "", listen_port: "" }],
    },
  });

  const { fields, append, remove, move } = useFieldArray({
    control: form.control,
    name: "hops",
  });
  const hopValues = form.watch("hops");

  // 切换语言后重新校验，让已经显示的错误跟着换语言。
  useEffect(() => {
    if (form.formState.isSubmitted) void form.trigger();
  }, [t, form]);

  // zod 把「1–4 跳」挂在 hops 根上、把重复服务器挂在对应行上，这里分别取。
  const hopErrors = form.formState.errors.hops as unknown as
    | (HopFieldErrors | undefined)[]
    | { message?: string }
    | undefined;
  const hopsRootError = Array.isArray(hopErrors)
    ? undefined
    : hopErrors?.message;

  function hopFieldError(
    index: number,
    field: keyof HopFieldErrors,
  ): string | undefined {
    if (!Array.isArray(hopErrors)) return undefined;
    return hopErrors[index]?.[field]?.message;
  }

  function setHopField(
    index: number,
    field: "server_id" | "listen_port",
    value: string,
  ) {
    form.setValue(`hops.${index}.${field}`, value, {
      shouldDirty: true,
      shouldTouch: true,
    });
  }

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors("root");

    const input = {
      name: values.name.trim(),
      target_host: values.target_host.trim(),
      target_port: Number(values.target_port),
      enabled: values.enabled,
      hops: values.hops.map((hop) => ({
        server_id: hop.server_id,
        listen_port: Number(hop.listen_port),
      })),
    };

    try {
      if (isEdit && chain) {
        await updateChain.mutateAsync({ id: chain.id, input });
        toast.success(t("chains.form.updated", { name: input.name }));
      } else {
        await createChain.mutateAsync(input);
        toast.success(t("chains.form.created", { name: input.name }));
      }

      onOpenChange(false);
    } catch (error) {
      const message = errorText(error, t("chains.form.error"));
      form.setError("root", { message });
      toast.error(message);
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t("chains.form.editTitle")
              : t("chains.form.createTitle")}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? t("chains.form.editDesc")
              : t("chains.form.createDesc")}
          </DialogDescription>
        </DialogHeader>

        <form id="chain-form" className="space-y-4" onSubmit={onSubmit}>
          <FormField
            label={t("chains.form.name")}
            htmlFor="chain-name"
            required
            error={form.formState.errors.name?.message}
          >
            <Input
              id="chain-name"
              value={form.watch("name")}
              onChange={(event) =>
                form.setValue("name", event.target.value, {
                  shouldDirty: true,
                })
              }
              onBlur={() => void form.trigger("name")}
              placeholder={t("chains.form.namePlaceholder")}
              autoComplete="off"
              disabled={pending}
              aria-invalid={Boolean(form.formState.errors.name)}
            />
          </FormField>

          <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
            <FormField
              label={t("chains.form.targetHost")}
              htmlFor="chain-target-host"
              required
              error={form.formState.errors.target_host?.message}
              hint={t("chains.form.targetHostHint")}
            >
              <Input
                id="chain-target-host"
                value={form.watch("target_host")}
                onChange={(event) =>
                  form.setValue("target_host", event.target.value, {
                    shouldDirty: true,
                  })
                }
                onBlur={() => void form.trigger("target_host")}
                placeholder={t("chains.form.targetHostPlaceholder")}
                autoComplete="off"
                disabled={pending}
                aria-invalid={Boolean(form.formState.errors.target_host)}
                className="font-mono"
              />
            </FormField>

            <FormField
              label={t("chains.form.targetPort")}
              htmlFor="chain-target-port"
              required
              error={form.formState.errors.target_port?.message}
            >
              <Input
                id="chain-target-port"
                value={form.watch("target_port")}
                onChange={(event) =>
                  form.setValue("target_port", event.target.value, {
                    shouldDirty: true,
                  })
                }
                onBlur={() => void form.trigger("target_port")}
                inputMode="numeric"
                autoComplete="off"
                placeholder="5432"
                disabled={pending}
                aria-invalid={Boolean(form.formState.errors.target_port)}
                className="font-mono tabular-nums"
              />
            </FormField>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label>
                {t("chains.form.hops")}
                <span className="text-destructive">*</span>
              </Label>
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                {t("chains.form.hopLimit", {
                  count: fields.length,
                  max: CHAIN_MAX_HOPS,
                })}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("chains.form.hopsHint")}
            </p>

            <div className="space-y-2">
              {fields.map((field, index) => {
                const serverError = hopFieldError(index, "server_id");
                const portError = hopFieldError(index, "listen_port");
                const isFirst = index === 0;
                const isLast = index === fields.length - 1;
                const seq = index + 1;

                return (
                  <div
                    key={field.id}
                    className="space-y-1.5 rounded-lg border border-border bg-muted/20 p-2.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span className="font-medium text-foreground">
                          {t("chains.form.hop", { seq })}
                        </span>
                        {isFirst ? (
                          <span className="text-primary">
                            {t("chains.form.hopEntryHint")}
                          </span>
                        ) : null}
                        {isLast && !isFirst ? (
                          <span className="text-muted-foreground">
                            {t("chains.form.hopExitHint")}
                          </span>
                        ) : null}
                      </span>
                      <div className="flex shrink-0 items-center gap-0.5">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="size-6"
                          aria-label={t("chains.form.moveUp", { seq })}
                          disabled={pending || isFirst}
                          onClick={() => {
                            // 顺序变了，旧错误会指向错误的行，先清掉等提交时重算。
                            move(index, index - 1);
                            form.clearErrors("hops");
                          }}
                        >
                          <ArrowUpIcon className="size-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="size-6"
                          aria-label={t("chains.form.moveDown", { seq })}
                          disabled={pending || isLast}
                          onClick={() => {
                            move(index, index + 1);
                            form.clearErrors("hops");
                          }}
                        >
                          <ArrowDownIcon className="size-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="size-6 text-muted-foreground hover:text-destructive"
                          aria-label={t("chains.form.removeHop", { seq })}
                          disabled={pending || fields.length <= CHAIN_MIN_HOPS}
                          onClick={() => {
                            remove(index);
                            form.clearErrors("hops");
                          }}
                        >
                          <Trash2Icon className="size-3.5" />
                        </Button>
                      </div>
                    </div>

                    <div className="grid gap-2 sm:grid-cols-[1fr_7rem]">
                      <div className="space-y-1">
                        <Select
                          value={hopValues[index]?.server_id ?? ""}
                          onValueChange={(value) => {
                            setHopField(index, "server_id", value);
                            // 首次填写不打扰：只有提交过之后才随改随校验，
                            // 避免选中服务器时把「端口未填」等没轮到的错误一起弹出来。
                            if (form.formState.isSubmitted) void form.trigger();
                          }}
                          disabled={pending || loadingServers}
                        >
                          <SelectTrigger
                            className="w-full"
                            aria-label={t("chains.form.hopServerAria", {
                              seq,
                            })}
                            aria-invalid={Boolean(serverError)}
                          >
                            <SelectValue
                              placeholder={t(
                                "chains.form.hopServerPlaceholder",
                              )}
                            />
                          </SelectTrigger>
                          <SelectContent>
                            {servers.map((server) => (
                              <SelectItem
                                key={server.id}
                                value={server.id}
                                title={server.address}
                              >
                                <span className="truncate">{server.name}</span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {serverError ? (
                          <p
                            role="alert"
                            className="text-xs text-destructive"
                          >
                            {serverError}
                          </p>
                        ) : null}
                      </div>

                      <div className="space-y-1">
                        <Input
                          value={hopValues[index]?.listen_port ?? ""}
                          onChange={(event) =>
                            setHopField(
                              index,
                              "listen_port",
                              event.target.value,
                            )
                          }
                          onBlur={() => {
                            if (form.formState.isSubmitted) void form.trigger();
                          }}
                          inputMode="numeric"
                          autoComplete="off"
                          placeholder={t("chains.form.hopPortPlaceholder")}
                          aria-label={t("chains.form.hopPortAria", { seq })}
                          aria-invalid={Boolean(portError)}
                          className="font-mono tabular-nums"
                          disabled={pending}
                        />
                        {portError ? (
                          <p
                            role="alert"
                            className="text-xs text-destructive"
                          >
                            {portError}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {hopsRootError ? (
              <p role="alert" className="text-xs text-destructive">
                {hopsRootError}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  append({ server_id: "", listen_port: "" })
                }
                disabled={pending || fields.length >= CHAIN_MAX_HOPS}
              >
                <PlusIcon className="size-3.5" />
                {t("chains.form.addHop")}
              </Button>
              {servers.length === 0 && !loadingServers ? (
                <span className="text-[11px] text-muted-foreground">
                  {t("chains.form.noServers")}
                </span>
              ) : null}
            </div>
          </div>

          <FormField
            label={t("chains.form.enabled")}
            htmlFor="chain-enabled"
            hint={t("chains.form.enabledHint")}
          >
            <div className="flex items-center gap-2.5">
              <Controller
                control={form.control}
                name="enabled"
                render={({ field }) => (
                  <Switch
                    id="chain-enabled"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    disabled={pending}
                  />
                )}
              />
              <span className="text-xs text-muted-foreground">
                {form.watch("enabled")
                  ? t("chains.form.enabledOn")
                  : t("chains.form.enabledOff")}
              </span>
            </div>
          </FormField>

          <FormRootError message={form.formState.errors.root?.message} />
        </form>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form="chain-form"
            disabled={pending || (servers.length === 0 && !loadingServers)}
          >
            {pending ? <Loader2Icon className="animate-spin" /> : null}
            {pending
              ? t("chains.form.saving")
              : isEdit
                ? t("chains.form.submitSave")
                : t("chains.form.submitCreate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
