import { useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link } from "react-router-dom";
import { Loader2Icon, RotateCcwIcon } from "lucide-react";
import { toast } from "sonner";
import { FormField, FormRootError } from "@/components/FormField";
import { Badge } from "@/components/ui/badge";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { Node } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { formatJsonObject, parseJsonConfig } from "@/lib/json";
import {
  allowedSecurities,
  allowedTransports,
  buildConfigSkeleton,
  defaultSecurity,
  defaultTransport,
  isCombinationAllowed,
  isNodeProtocol,
  isNodeSecurity,
  isNodeTransport,
  nodeSummary,
  NODE_PROTOCOLS,
  protocolLabel,
  securityLabel,
  transportLabel,
  type NodeProtocol,
  type NodeSecurity,
  type NodeTransport,
} from "@/lib/protocols";
import {
  useCertificates,
  useCreateNode,
  useUpdateNode,
} from "@/lib/queries";
import { nodeFormSchema, type NodeFormValues } from "@/lib/schemas";

interface NodeFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
  mode: "create" | "edit";
  node?: Node;
}

function initialCombo(node?: Node): {
  protocol: NodeProtocol;
  transport: NodeTransport;
  security: NodeSecurity;
} {
  if (
    node &&
    isNodeProtocol(node.protocol) &&
    isNodeTransport(node.transport) &&
    isNodeSecurity(node.security)
  ) {
    return {
      protocol: node.protocol,
      transport: node.transport,
      security: node.security,
    };
  }

  return { protocol: "vless", transport: "tcp", security: "none" };
}

export function NodeFormDialog({
  open,
  onOpenChange,
  serverId,
  mode,
  node,
}: NodeFormDialogProps) {
  const isEdit = mode === "edit";
  const createNode = useCreateNode(serverId);
  const updateNode = useUpdateNode(serverId);
  const pending = isEdit ? updateNode.isPending : createNode.isPending;
  const certificates = useCertificates();

  const initial = initialCombo(node);
  const form = useForm<NodeFormValues>({
    resolver: zodResolver(nodeFormSchema),
    defaultValues: {
      name: node?.name ?? "",
      protocol: initial.protocol,
      transport: initial.transport,
      security: initial.security,
      cert_id: node?.cert_id ?? "",
      port: node ? String(node.port) : "443",
      enabled: node ? Boolean(node.enabled) : true,
    },
  });

  const [configText, setConfigText] = useState(() =>
    isEdit && node
      ? formatJsonObject(node.config ?? {})
      : formatJsonObject(
          buildConfigSkeleton(
            initial.protocol,
            initial.transport,
            initial.security,
          ),
        ),
  );
  // 编辑态永远保留用户已有 config；新建态只有在用户手改后才停止自动跟随联动。
  const [configDirty, setConfigDirty] = useState(isEdit);

  const parsed = useMemo(() => parseJsonConfig(configText), [configText]);
  const configError = parsed.ok ? undefined : parsed.issue.message;

  const protocol = form.watch("protocol");
  const transport = form.watch("transport");
  const security = form.watch("security");

  const certItems = certificates.data ?? [];
  const noCertificates = certificates.isSuccess && certItems.length === 0;
  // 只有「曾经选过 TLS，又改成别的安全层」时才提示，避免一打开表单就吓人。
  const [securityChangeNotice, setSecurityChangeNotice] = useState(false);

  const transportOptions = allowedTransports(protocol);
  const securityOptions = allowedSecurities(protocol, transport);
  const comboValid = isCombinationAllowed(protocol, transport, security);

  /** 安全层离开 TLS 时清空证书绑定；TLS 与非 TLS 之间切换都要提示重新应用。 */
  function noteSecurityChange(previous: NodeSecurity, next: NodeSecurity) {
    if (next === "tls") {
      setSecurityChangeNotice(false);
      return;
    }
    form.setValue("cert_id", "", { shouldValidate: true });
    if (previous === "tls") setSecurityChangeNotice(true);
  }

  function regenerate(
    nextProtocol: NodeProtocol,
    nextTransport: NodeTransport,
    nextSecurity: NodeSecurity,
  ) {
    if (isEdit || configDirty) return;
    setConfigText(
      formatJsonObject(
        buildConfigSkeleton(nextProtocol, nextTransport, nextSecurity),
      ),
    );
  }

  function handleProtocolChange(next: NodeProtocol) {
    const nextTransport = defaultTransport(next);
    const nextSecurity = defaultSecurity(next, nextTransport);
    form.setValue("protocol", next, { shouldValidate: true });
    form.setValue("transport", nextTransport, { shouldValidate: true });
    form.setValue("security", nextSecurity, { shouldValidate: true });
    noteSecurityChange(security, nextSecurity);
    regenerate(next, nextTransport, nextSecurity);
  }

  function handleSecurityChange(next: NodeSecurity) {
    const transports = allowedTransports(protocol, next);
    const nextTransport = transports.includes(transport)
      ? transport
      : (transports[0] ?? "tcp");
    form.setValue("security", next, { shouldValidate: true });
    form.setValue("transport", nextTransport, { shouldValidate: true });
    noteSecurityChange(security, next);
    regenerate(protocol, nextTransport, next);
  }

  function handleTransportChange(next: NodeTransport) {
    const securities = allowedSecurities(protocol, next);
    const nextSecurity = securities.includes(security)
      ? security
      : (securities[0] ?? "none");
    form.setValue("transport", next, { shouldValidate: true });
    form.setValue("security", nextSecurity, { shouldValidate: true });
    noteSecurityChange(security, nextSecurity);
    regenerate(protocol, next, nextSecurity);
  }

  function resetSkeleton() {
    setConfigText(
      formatJsonObject(buildConfigSkeleton(protocol, transport, security)),
    );
    setConfigDirty(false);
  }

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors("root");
    const check = parseJsonConfig(configText);
    if (!check.ok) {
      toast.error(check.issue.message);
      return;
    }

    const port = Number(values.port);
    // 只有 TLS 节点才带 cert_id；其余安全层必须完全省略，否则后端会 400。
    const certId = values.security === "tls" ? values.cert_id.trim() : "";
    const certBinding = certId ? { cert_id: certId } : {};

    try {
      if (isEdit && node) {
        await updateNode.mutateAsync({
          id: node.id,
          input: {
            name: values.name,
            port,
            enabled: values.enabled,
            config: check.value,
            ...certBinding,
          },
        });
        toast.success("节点已更新");
      } else {
        const created = await createNode.mutateAsync({
          name: values.name,
          protocol: values.protocol,
          transport: values.transport,
          security: values.security,
          port,
          config: check.value,
          enabled: values.enabled,
          ...certBinding,
        });
        toast.success(`节点「${created.name}」已创建`);
      }

      onOpenChange(false);
    } catch (error) {
      const message = errorText(error, "保存节点失败，请稍后重试");
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "编辑节点" : "新建节点"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "协议、传输、安全层创建后不可修改；名称、端口、启用状态与 config 可以调整。"
              : "协议、传输、安全层决定订阅链接的形态，创建后不可修改。"}
          </DialogDescription>
        </DialogHeader>

        <form id="node-form" onSubmit={onSubmit}>
          <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
            <div className="space-y-4">
              <FormField
                label="名称"
                htmlFor="node-name"
                required
                error={form.formState.errors.name?.message}
              >
                <Input
                  id="node-name"
                  autoComplete="off"
                  placeholder="hk-reality"
                  disabled={pending}
                  aria-invalid={Boolean(form.formState.errors.name)}
                  {...form.register("name")}
                />
              </FormField>

              <div className="grid gap-3 sm:grid-cols-2">
                <FormField
                  label="协议"
                  htmlFor="node-protocol"
                  error={form.formState.errors.protocol?.message}
                  hint={isEdit ? "创建后只读" : undefined}
                >
                  <Controller
                    control={form.control}
                    name="protocol"
                    render={({ field }) => (
                      <Select
                        value={field.value}
                        onValueChange={(value) =>
                          handleProtocolChange(value as NodeProtocol)
                        }
                        disabled={isEdit || pending}
                      >
                        <SelectTrigger
                          id="node-protocol"
                          className="w-full"
                          aria-invalid={Boolean(
                            form.formState.errors.protocol,
                          )}
                        >
                          <SelectValue placeholder="选择协议" />
                        </SelectTrigger>
                        <SelectContent>
                          {NODE_PROTOCOLS.map((item) => (
                            <SelectItem key={item} value={item}>
                              {protocolLabel(item)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </FormField>

                <FormField
                  label="端口"
                  htmlFor="node-port"
                  required
                  error={form.formState.errors.port?.message}
                >
                  <Input
                    id="node-port"
                    inputMode="numeric"
                    placeholder="443"
                    disabled={pending}
                    aria-invalid={Boolean(form.formState.errors.port)}
                    {...form.register("port")}
                  />
                </FormField>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <FormField
                  label="传输方式"
                  htmlFor="node-transport"
                  error={form.formState.errors.transport?.message}
                  hint={isEdit ? "创建后只读" : undefined}
                >
                  <Controller
                    control={form.control}
                    name="transport"
                    render={({ field }) => (
                      <Select
                        value={field.value}
                        onValueChange={(value) =>
                          handleTransportChange(value as NodeTransport)
                        }
                        disabled={isEdit || pending}
                      >
                        <SelectTrigger
                          id="node-transport"
                          className="w-full"
                          aria-invalid={Boolean(
                            form.formState.errors.transport,
                          )}
                        >
                          <SelectValue placeholder="选择传输方式" />
                        </SelectTrigger>
                        <SelectContent>
                          {transportOptions.map((item) => (
                            <SelectItem key={item} value={item}>
                              {transportLabel(item)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </FormField>

                <FormField
                  label="安全层"
                  htmlFor="node-security"
                  error={form.formState.errors.security?.message}
                  hint={
                    isEdit
                      ? "创建后只读；改安全层需要重新应用配置"
                      : undefined
                  }
                >
                  <Controller
                    control={form.control}
                    name="security"
                    render={({ field }) => (
                      <Select
                        value={field.value}
                        onValueChange={(value) =>
                          handleSecurityChange(value as NodeSecurity)
                        }
                        disabled={isEdit || pending}
                      >
                        <SelectTrigger
                          id="node-security"
                          className="w-full"
                          aria-invalid={Boolean(
                            form.formState.errors.security,
                          )}
                        >
                          <SelectValue placeholder="选择安全层" />
                        </SelectTrigger>
                        <SelectContent>
                          {securityOptions.map((item) => (
                            <SelectItem key={item} value={item}>
                              {securityLabel(item)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </FormField>
              </div>

              {!comboValid ? (
                <p role="alert" className="text-xs text-destructive">
                  当前协议不支持这个组合，请调整传输方式或安全层。
                </p>
              ) : null}

              {security === "tls" ? (
                <FormField
                  label="证书"
                  htmlFor="node-cert"
                  required
                  error={form.formState.errors.cert_id?.message}
                  hint={
                    certificates.isError
                      ? "证书列表加载失败，请确认主控可用后重试"
                      : isEdit
                        ? "更换证书后需要重新应用配置才会下发"
                        : undefined
                  }
                >
                  <div className="space-y-2">
                    <Controller
                      control={form.control}
                      name="cert_id"
                      render={({ field }) => (
                        <Select
                          value={field.value}
                          onValueChange={field.onChange}
                          disabled={
                            pending ||
                            certificates.isPending ||
                            certItems.length === 0
                          }
                        >
                          <SelectTrigger
                            id="node-cert"
                            className="w-full"
                            aria-invalid={Boolean(
                              form.formState.errors.cert_id,
                            )}
                          >
                            <SelectValue
                              placeholder={
                                certificates.isPending
                                  ? "正在加载证书…"
                                  : noCertificates
                                    ? "还没有证书"
                                    : "选择证书"
                              }
                            />
                          </SelectTrigger>
                          <SelectContent>
                            {certItems.map((cert) => (
                              <SelectItem key={cert.id} value={cert.id}>
                                {cert.name}
                                {cert.days_left < 0
                                  ? "（已过期）"
                                  : cert.days_left <= 30
                                    ? `（${cert.days_left} 天后到期）`
                                    : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                    {noCertificates ? (
                      <p className="text-xs text-muted-foreground">
                        还没有证书，
                        <Link
                          to="/certificates"
                          className="font-medium text-primary underline-offset-4 hover:underline"
                        >
                          去证书页上传
                        </Link>
                        后再回来绑定。
                      </p>
                    ) : null}
                  </div>
                </FormField>
              ) : null}

              {securityChangeNotice ? (
                <p
                  role="status"
                  className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning"
                >
                  安全层已从 TLS 改成 {securityLabel(security)}，证书绑定已清除；
                  改安全层需要重新应用配置。
                </p>
              ) : null}

              <FormField
                label="启用"
                htmlFor="node-enabled"
                hint="停用后节点仍保留，但不会写入下发的配置。"
              >
                <div className="flex items-center gap-2.5">
                  <Controller
                    control={form.control}
                    name="enabled"
                    render={({ field }) => (
                      <Switch
                        id="node-enabled"
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        disabled={pending}
                      />
                    )}
                  />
                  <span className="text-xs text-muted-foreground">
                    {form.watch("enabled") ? "保存后立即启用" : "保存为停用"}
                  </span>
                </div>
              </FormField>

              <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                <p className="font-medium text-foreground">
                  {nodeSummary(protocol, transport, security)}
                </p>
                <p className="mt-1">
                  传输/安全层只能从当前协议允许的组合里选择，避免提交后 Xray
                  启动失败。
                </p>
              </div>
            </div>

            <FormField
              label={
                <span className="flex items-center gap-2">
                  config 预览（JSON）
                  {!isEdit && configDirty ? (
                    <Badge
                      variant="secondary"
                      className="font-normal text-muted-foreground"
                    >
                      已手改
                    </Badge>
                  ) : null}
                </span>
              }
              htmlFor="node-config"
              error={configError}
              hint={
                parsed.ok
                  ? `JSON 合法 · ${configText.split("\n").length} 行`
                  : undefined
              }
            >
              <div className="space-y-2">
                <Textarea
                  id="node-config"
                  value={configText}
                  onChange={(event) => {
                    setConfigText(event.target.value);
                    setConfigDirty(true);
                  }}
                  spellCheck={false}
                  disabled={pending}
                  aria-invalid={!parsed.ok}
                  className="min-h-72 resize-y font-mono text-xs leading-relaxed"
                />
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] text-muted-foreground">
                    {isEdit
                      ? "这是该节点已保存的 config；修改后需重新应用配置。"
                      : configDirty
                        ? "配置已手动修改，切换协议/安全层不会覆盖；可重新生成骨架。"
                        : "按协议与安全层实时生成最小骨架，可直接手改。"}
                  </p>
                  {isEdit ? null : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={resetSkeleton}
                      disabled={pending || !configDirty}
                    >
                      <RotateCcwIcon />
                      重新生成
                    </Button>
                  )}
                </div>
              </div>
            </FormField>
          </div>

          <FormRootError message={form.formState.errors.root?.message} />
        </form>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            取消
          </Button>
          <Button
            type="submit"
            form="node-form"
            disabled={pending || !parsed.ok || !comboValid}
          >
            {pending ? <Loader2Icon className="animate-spin" /> : null}
            {pending
              ? "保存中…"
              : isEdit
                ? "保存修改"
                : "创建节点"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
