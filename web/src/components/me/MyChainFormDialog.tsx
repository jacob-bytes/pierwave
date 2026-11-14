import { useState } from "react";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { FormField } from "@/components/FormField";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ChainTemplate } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { templatePath } from "@/lib/myChains";
import { useCreateMyChain } from "@/lib/queries";
import { t, useI18n } from "@/i18n";

/**
 * 用户自助建链：只选模板 + 填目标，端口由后端按服务器端口策略分配。
 * 模板已经决定跳数 / 引擎 / 加密方式，这里不暴露任何链级配置。
 */
export function MyChainFormDialog({
  open,
  onOpenChange,
  templates,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: ChainTemplate[];
}) {
  useI18n();
  const create = useCreateMyChain();
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [targetHost, setTargetHost] = useState("");
  const [targetPort, setTargetPort] = useState("");
  const [error, setError] = useState<string | null>(null);

  const template = templates.find((item) => item.id === templateId);
  const entryServer =
    template?.groups
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .at(0)
      ?.servers.at(0)?.name ?? "—";

  function submit() {
    if (!template) {
      setError(t("me.chains.form.templateRequired"));
      return;
    }
    const host = targetHost.trim();
    if (!host) {
      setError(t("me.chains.form.targetRequired"));
      return;
    }
    const port = Number(targetPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError(t("me.chains.form.portRange"));
      return;
    }
    setError(null);
    create.mutate(
      { template_id: template.id, target_host: host, target_port: port },
      {
        onSuccess: (chain) => {
          toast.success(
            t("me.chains.created", {
              address: chain.entry_address ?? "—",
            }),
          );
          onOpenChange(false);
        },
        onError: (submitError) => {
          const message = errorText(
            submitError,
            t("me.chains.form.error"),
          );
          setError(message);
          toast.error(message);
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && create.isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("me.chains.form.title")}</DialogTitle>
          <DialogDescription>{t("me.chains.form.desc")}</DialogDescription>
        </DialogHeader>

        <form
          id="my-chain-form"
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <FormField
            label={t("me.chains.form.template")}
            htmlFor="my-chain-template"
          >
            <Select
              value={templateId}
              onValueChange={setTemplateId}
              disabled={create.isPending}
            >
              <SelectTrigger id="my-chain-template" className="w-full">
                <SelectValue
                  placeholder={t("me.chains.form.templatePlaceholder")}
                />
              </SelectTrigger>
              <SelectContent>
                {templates.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {template ? (
              <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                <p className="truncate font-mono" title={templatePath(template)}>
                  {templatePath(template)}
                </p>
                <p>{t("me.chains.form.entryServer", { server: entryServer })}</p>
              </div>
            ) : null}
          </FormField>

          <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
            <FormField
              label={t("me.chains.form.targetHost")}
              htmlFor="my-chain-target-host"
              required
            >
              <Input
                id="my-chain-target-host"
                value={targetHost}
                autoComplete="off"
                disabled={create.isPending}
                placeholder={t("me.chains.form.targetHostPlaceholder")}
                onChange={(event) => setTargetHost(event.target.value)}
              />
            </FormField>
            <FormField
              label={t("me.chains.form.targetPort")}
              htmlFor="my-chain-target-port"
              required
            >
              <Input
                id="my-chain-target-port"
                value={targetPort}
                inputMode="numeric"
                autoComplete="off"
                disabled={create.isPending}
                placeholder="443"
                onChange={(event) => setTargetPort(event.target.value)}
              />
            </FormField>
          </div>

          {error ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
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
            disabled={create.isPending}
          >
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="my-chain-form" disabled={create.isPending}>
            {create.isPending ? <Loader2Icon className="animate-spin" /> : null}
            {create.isPending
              ? t("common.saving")
              : t("me.chains.form.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
