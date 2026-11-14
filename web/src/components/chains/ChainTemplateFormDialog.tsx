import { useState } from "react";
import { Loader2Icon, PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { FormField } from "@/components/FormField";
import { ServerMultiSelectField } from "@/components/servers/ServerMultiSelectField";
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
import type {
  ChainTemplate,
  ChainTemplateGroupInput,
  CreateChainTemplateInput,
  ForwardEngine,
} from "@/lib/api";
import { CHAIN_STRATEGIES, type ChainStrategy } from "@/lib/chains";
import { errorText } from "@/lib/errors";
import {
  useCreateChainTemplate,
  useUpdateChainTemplate,
} from "@/lib/queries";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

interface GroupDraft {
  strategy: ChainStrategy;
  server_ids: string[];
}

const ENGINES: ForwardEngine[] = ["native", "realm", "nftables", "tunnel"];
const PROTOCOLS = ["tcp", "udp", "both"] as const;
const SECURITIES = ["tls", "noise"] as const;

function initialGroups(template?: ChainTemplate): GroupDraft[] {
  if (!template || template.groups.length === 0) {
    return [{ strategy: "round_robin", server_ids: [] }];
  }
  return [...template.groups]
    .sort((a, b) => a.seq - b.seq)
    .map((group) => ({
      strategy: group.strategy,
      server_ids: [...group.server_ids],
    }));
}

/**
 * 链模板表单：模板只定义形态，不携带证书，因此不提供 `transport` 选项
 * （后端固定 `none`；`tls` 会被拒绝）。
 */
export function ChainTemplateFormDialog({
  open,
  onOpenChange,
  template,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template?: ChainTemplate;
}) {
  useI18n();
  const editing = Boolean(template);
  const create = useCreateChainTemplate();
  const update = useUpdateChainTemplate();
  const pending = editing ? update.isPending : create.isPending;

  const [name, setName] = useState(template?.name ?? "");
  const [engine, setEngine] = useState<ForwardEngine>(
    template?.engine ?? "native",
  );
  const [security, setSecurity] = useState<"tls" | "noise">(
    template?.security ?? "tls",
  );
  const [protocol, setProtocol] = useState<(typeof PROTOCOLS)[number]>(
    template?.protocol ?? "tcp",
  );
  const [enabled, setEnabled] = useState(template?.enabled ?? true);
  const [groups, setGroups] = useState<GroupDraft[]>(() =>
    initialGroups(template),
  );
  const [error, setError] = useState<string | null>(null);

  function patchGroup(index: number, patch: Partial<GroupDraft>) {
    setGroups((current) =>
      current.map((group, position) =>
        position === index ? { ...group, ...patch } : group,
      ),
    );
  }

  /** 前端只挡明显的形态错误；引擎/协议组合以服务端校验为准（带 code 可翻译）。 */
  function validateDraft(): string | null {
    if (!name.trim()) return t("chainTemplates.form.nameRequired");
    if (groups.length === 0) return t("chainTemplates.form.noGroups");
    if (groups.length > 6) return t("chainTemplates.form.tooManyGroups");
    for (const [index, group] of groups.entries()) {
      if (group.server_ids.length === 0) {
        return t("chainTemplates.form.groupEmpty", { seq: index + 1 });
      }
    }
    if (engine === "tunnel") {
      if (groups.length < 2) return t("chainTemplates.form.tunnelHops");
      if (groups.some((group) => group.server_ids.length !== 1)) {
        return t("chainTemplates.form.tunnelMember");
      }
    }
    if (security === "noise" && engine !== "tunnel") {
      return t("chainTemplates.form.noiseRequiresTunnel");
    }
    return null;
  }

  async function submit() {
    const validation = validateDraft();
    if (validation) {
      setError(validation);
      return;
    }
    setError(null);
    const input: CreateChainTemplateInput = {
      name: name.trim(),
      engine,
      // 非 tunnel 引擎的安全模式没有意义；统一发默认值，避免把 noise 留给读路径忽略。
      security: engine === "tunnel" ? security : "tls",
      transport: "none",
      protocol,
      enabled,
      groups: groups.map<ChainTemplateGroupInput>((group, index) => ({
        seq: index,
        strategy: group.strategy,
        server_ids: group.server_ids,
      })),
    };
    try {
      if (template) {
        await update.mutateAsync({ id: template.id, input });
        toast.success(t("chainTemplates.form.updated", { name: input.name }));
      } else {
        await create.mutateAsync(input);
        toast.success(t("chainTemplates.form.created", { name: input.name }));
      }
      onOpenChange(false);
    } catch (submitError) {
      const message = errorText(submitError, t("chainTemplates.form.error"));
      setError(message);
      toast.error(message);
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? t("chainTemplates.form.editTitle")
              : t("chainTemplates.form.createTitle")}
          </DialogTitle>
          <DialogDescription>{t("chainTemplates.form.desc")}</DialogDescription>
        </DialogHeader>

        <form
          id="chain-template-form"
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FormField
            label={t("chainTemplates.form.name")}
            htmlFor="chain-template-name"
            required
          >
            <Input
              id="chain-template-name"
              value={name}
              autoComplete="off"
              disabled={pending}
              placeholder={t("chainTemplates.form.namePlaceholder")}
              onChange={(event) => setName(event.target.value)}
            />
          </FormField>

          <div className="grid gap-4 sm:grid-cols-3">
            <FormField
              label={t("chainTemplates.form.engine")}
              htmlFor="chain-template-engine"
            >
              <Select
                value={engine}
                onValueChange={(value) => setEngine(value as ForwardEngine)}
                disabled={pending}
              >
                <SelectTrigger id="chain-template-engine" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ENGINES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`common.engine.${value}.label`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField
              label={t("chainTemplates.form.protocol")}
              htmlFor="chain-template-protocol"
            >
              <Select
                value={protocol}
                onValueChange={(value) =>
                  setProtocol(value as (typeof PROTOCOLS)[number])
                }
                disabled={pending}
              >
                <SelectTrigger id="chain-template-protocol" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROTOCOLS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`common.protocolMode.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField
              label={t("chainTemplates.form.security")}
              htmlFor="chain-template-security"
            >
              <Select
                value={security}
                onValueChange={(value) =>
                  setSecurity(value as (typeof SECURITIES)[number])
                }
                disabled={pending || engine !== "tunnel"}
              >
                <SelectTrigger id="chain-template-security" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SECURITIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`chains.tunnelSecurity.${value}.label`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <Label htmlFor="chain-template-enabled" className="text-sm">
              {t("chainTemplates.form.enabled")}
            </Label>
            <Switch
              id="chain-template-enabled"
              checked={enabled}
              disabled={pending}
              onCheckedChange={setEnabled}
            />
          </div>

          <div className="space-y-3 border-t border-border pt-4">
            {groups.map((group, index) => (
              <div
                key={index}
                className="space-y-3 rounded-lg border border-border bg-muted/20 p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("chainTemplates.form.group", { seq: index + 1 })}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("chainTemplates.form.removeGroup", {
                      seq: index + 1,
                    })}
                    disabled={pending || groups.length <= 1}
                    onClick={() =>
                      setGroups((current) =>
                        current.filter((_, position) => position !== index),
                      )
                    }
                  >
                    <Trash2Icon className="size-3.5 text-muted-foreground" />
                  </Button>
                </div>

                <FormField
                  label={t("chains.form.strategy")}
                  htmlFor={`chain-template-strategy-${index}`}
                >
                  <Select
                    value={group.strategy}
                    onValueChange={(value) =>
                      patchGroup(index, {
                        strategy: value as ChainStrategy,
                      })
                    }
                    disabled={pending}
                  >
                    <SelectTrigger
                      id={`chain-template-strategy-${index}`}
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CHAIN_STRATEGIES.map((value) => (
                        <SelectItem key={value} value={value}>
                          {t(`chains.strategy.${value}.label`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>

                <ServerMultiSelectField
                  value={group.server_ids}
                  disabled={pending}
                  onChange={(ids) => patchGroup(index, { server_ids: ids })}
                />
              </div>
            ))}

            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending || groups.length >= 6}
              onClick={() =>
                setGroups((current) => [
                  ...current,
                  { strategy: "round_robin", server_ids: [] },
                ])
              }
            >
              <PlusIcon className="size-3.5" />
              {t("chainTemplates.form.addGroup")}
            </Button>
          </div>

          {error ? (
            <p
              role="alert"
              className={cn(
                "rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive",
              )}
            >
              {error}
            </p>
          ) : null}
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
          <Button type="submit" form="chain-template-form" disabled={pending}>
            {pending ? <Loader2Icon className="animate-spin" /> : null}
            {pending
              ? t("common.saving")
              : editing
                ? t("chainTemplates.form.submitSave")
                : t("chainTemplates.form.submitCreate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
