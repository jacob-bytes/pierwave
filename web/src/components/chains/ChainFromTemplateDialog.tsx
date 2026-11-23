import { useEffect, useRef, useState } from "react";
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
import type { ChainTemplate, CreateChainFromTemplateInput } from "@/lib/api";
import { isTemplateUnsupported } from "@/lib/chainTemplateCreate";
import { errorText } from "@/lib/errors";
import {
  chainActualEntryPort,
  entryPortInputError,
  entryPortNotAdopted,
  entryPortNotAdoptedText,
  entryPortPayload,
  entryPortRangeLabel,
  hopCountLabel,
  templateChainName,
  templateEntryPortRange,
  templateHopCount,
  templatePath,
} from "@/lib/myChains";
import { useCreateChain } from "@/lib/queries";
import { t, useI18n } from "@/i18n";

/**
 * 管理员「从模板创建」：模板固定入口与中间跳，这里只填入口端口与目标。
 *
 * 旧主控不认识 `template_id`。提交失败后如果错误形状说明是能力缺失，
 * 就保留表单内容、把入口标记为不可用并提示「需要新版本主控」；端口冲突
 * 409 仍走普通错误提示，不误判。
 */
export function ChainFromTemplateDialog({
  open,
  onOpenChange,
  templates,
  loadingTemplates,
  templatesError,
  onUnsupported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: ChainTemplate[];
  loadingTemplates: boolean;
  templatesError: string | null;
  onUnsupported: () => void;
}) {
  useI18n();
  const create = useCreateChain();
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [entryPort, setEntryPort] = useState("");
  const [targetHost, setTargetHost] = useState("");
  const [targetPort, setTargetPort] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const notified = useRef(false);

  // 模板列表是异步加载的：打开对话框时可能还没到，到了以后默认选第一张。
  useEffect(() => {
    if (templates.length === 0) return;
    if (templates.some((item) => item.id === templateId)) return;
    setTemplateId(templates[0].id);
  }, [templateId, templates]);

  const template = templates.find((item) => item.id === templateId);
  const hops = templateHopCount(template);
  const portHint = entryPortRangeLabel(templateEntryPortRange(template));
  const pending = create.isPending;
  const blocked =
    unsupported || loadingTemplates || Boolean(templatesError) || !template;

  function markUnsupported() {
    setUnsupported(true);
    onUnsupported();
    const message = t("chains.templateCreate.needsNewMaster");
    setError(message);
    // 只 toast 一次：重复提交不会再刷屏。
    if (!notified.current) {
      notified.current = true;
      toast.error(message);
    }
  }

  function submit() {
    if (!template) {
      setError(t("chains.templateCreate.templateRequired"));
      return;
    }
    const portError = entryPortInputError(entryPort);
    if (portError) {
      setError(t("chains.templateCreate.entryPortRange"));
      return;
    }
    const host = targetHost.trim();
    if (!host) {
      setError(t("chains.templateCreate.targetRequired"));
      return;
    }
    const port = Number(targetPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError(t("chains.templateCreate.portRange"));
      return;
    }

    setError(null);
    const requestedPort = entryPortPayload(entryPort);
    const input: CreateChainFromTemplateInput = {
      name: templateChainName(template.name, host, port),
      template_id: template.id,
      ...(requestedPort !== undefined ? { entry_port: requestedPort } : {}),
      target_host: host,
      target_port: port,
    };

    create.mutate(input, {
      onSuccess: (chain) => {
        // 旧主控会忽略 `entry_port` 并自行分配；响应里的实际端口才是事实。
        const notAdopted = entryPortNotAdopted(
          requestedPort,
          chainActualEntryPort(chain),
        );
        if (notAdopted !== null) {
          toast.warning(entryPortNotAdoptedText(notAdopted));
        } else {
          toast.success(
            t("chains.templateCreate.created", { name: chain.name }),
          );
        }
        onOpenChange(false);
      },
      onError: (submitError) => {
        if (isTemplateUnsupported(submitError)) {
          markUnsupported();
          return;
        }
        const message = errorText(
          submitError,
          t("chains.templateCreate.error"),
        );
        setError(message);
        toast.error(message);
      },
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("chains.templateCreate.title")}</DialogTitle>
          <DialogDescription>
            {t("chains.templateCreate.desc")}
          </DialogDescription>
        </DialogHeader>

        <form
          id="chain-from-template-form"
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <FormField
            label={t("chains.templateCreate.template")}
            htmlFor="chain-from-template"
            error={
              templatesError
                ? t("chains.templateCreate.templateLoadError")
                : undefined
            }
            required
          >
            <Select
              value={templateId}
              onValueChange={setTemplateId}
              disabled={pending || loadingTemplates || Boolean(templatesError)}
            >
              <SelectTrigger id="chain-from-template" className="w-full">
                <SelectValue
                  placeholder={t("chains.templateCreate.templatePlaceholder")}
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
              <div className="mt-2 space-y-1 rounded-md border border-border bg-muted/20 px-2.5 py-2">
                <p className="type-micro font-medium text-muted-foreground">
                  {t("chains.templateCreate.sequence")}
                </p>
                <p
                  className="truncate font-mono text-xs text-foreground"
                  title={templatePath(template)}
                >
                  {templatePath(template)}
                </p>
                <p className="type-micro text-muted-foreground">
                  {hopCountLabel(hops)}
                </p>
              </div>
            ) : templatesError ? null : loadingTemplates ? (
              <p className="mt-2 type-micro text-muted-foreground">
                {t("chains.templateCreate.templateLoading")}
              </p>
            ) : (
              <p className="mt-2 type-micro text-muted-foreground">
                {t("chains.templateCreate.templateEmpty")}
              </p>
            )}
          </FormField>

          <FormField
            label={t("chains.templateCreate.entryPort")}
            htmlFor="chain-from-template-entry-port"
            hint={portHint ?? undefined}
          >
            <Input
              id="chain-from-template-entry-port"
              className="sm:max-w-40"
              value={entryPort}
              inputMode="numeric"
              autoComplete="off"
              disabled={pending}
              placeholder={t("chains.templateCreate.entryPortPlaceholder")}
              onChange={(event) => setEntryPort(event.target.value)}
            />
          </FormField>

          <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
            <FormField
              label={t("chains.templateCreate.targetHost")}
              htmlFor="chain-from-template-target-host"
              required
            >
              <Input
                id="chain-from-template-target-host"
                value={targetHost}
                autoComplete="off"
                disabled={pending}
                placeholder={t("chains.templateCreate.targetHostPlaceholder")}
                onChange={(event) => setTargetHost(event.target.value)}
              />
            </FormField>
            <FormField
              label={t("chains.templateCreate.targetPort")}
              htmlFor="chain-from-template-target-port"
              required
            >
              <Input
                id="chain-from-template-target-port"
                value={targetPort}
                inputMode="numeric"
                autoComplete="off"
                disabled={pending}
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
            disabled={pending}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form="chain-from-template-form"
            disabled={pending || blocked}
          >
            {pending ? <Loader2Icon className="animate-spin" /> : null}
            {pending
              ? t("common.saving")
              : t("chains.templateCreate.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
