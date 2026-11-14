import { useEffect, useMemo, useState } from "react";
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
import type { Node, Server } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { formatJsonObject, parseJsonConfig } from "@/lib/json";
import {
  isPortPolicyConstrained,
  portPolicySummary,
} from "@/lib/portPolicy";
import { parsePublicPortInput } from "@/lib/publicPort";
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
import {
  expectedKeyBytes,
  generateSsKey,
  SS_DEFAULT_METHOD,
  SS_DEFAULT_NETWORK,
  SS_METHODS,
  SS_NETWORKS,
  ssSettings,
  stripSsSettings,
  withSsSettings,
  type SsSettings,
} from "@/lib/shadowsocks";
import { kbpsToMbpsInput, mbpsInputToKbps } from "@/lib/speed";
import { t, useI18n } from "@/i18n";

interface NodeFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
  /** 当前服务器：用于在端口输入旁展示该服务器允许的端口范围。 */
  server?: Server;
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
  server,
  mode,
  node,
}: NodeFormDialogProps) {
  const { t: translate } = useI18n();
  const isEdit = mode === "edit";
  const createNode = useCreateNode(serverId);
  const updateNode = useUpdateNode(serverId);
  const pending = isEdit ? updateNode.isPending : createNode.isPending;
  const certificates = useCertificates();

  const initial = initialCombo(node);
  const initialSs = ssSettings(node);
  const schema = useMemo(() => nodeFormSchema(translate), [translate]);
  const form = useForm<NodeFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: node?.name ?? "",
      protocol: initial.protocol,
      transport: initial.transport,
      security: initial.security,
      cert_id: node?.cert_id ?? "",
      port: node ? String(node.port) : "443",
      public_port:
        node?.public_port == null ? "" : String(node.public_port),
      bandwidth_mbps: kbpsToMbpsInput(node?.bandwidth_kbps),
      enabled: node ? Boolean(node.enabled) : true,
      ss_method: initialSs.method,
      ss_password: initialSs.password,
      ss_network: initialSs.network,
    },
  });

  // 切换语言后重新校验，让已显示的错误跟着换语言。
  useEffect(() => {
    if (form.formState.isSubmitted) void form.trigger();
  }, [translate, form]);

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

  const parsed = useMemo(
    () => parseJsonConfig(configText, translate),
    [configText, translate],
  );
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

  // 服务器端口约束：只在有约束时提示；最终仍由后端校验。
  const portPolicy = server
    ? {
        port_start: server.port_start,
        port_end: server.port_end,
        port_allow: server.port_allow,
      }
    : null;
  const portPolicyHint =
    portPolicy && isPortPolicyConstrained(portPolicy)
      ? portPolicySummary(portPolicy)
      : undefined;

  const isSs = protocol === "shadowsocks";
  const ssMethod = form.watch("ss_method");
  const ssIs2022 = expectedKeyBytes(ssMethod) !== null;

  function ssValues(): SsSettings {
    const values = form.getValues();
    return {
      method: values.ss_method,
      password: values.ss_password,
      network: values.ss_network,
    };
  }

  /** 把三件套同步进右侧 JSON，避免字段与预览各说各话。 */
  function syncSsToConfig(settings: SsSettings) {
    const config = parseJsonConfig(configText, translate);
    if (!config.ok) return;
    setConfigText(formatJsonObject(withSsSettings(config.value, settings)));
  }

  function updateSsField(
    field: "ss_method" | "ss_password" | "ss_network",
    value: string,
  ) {
    form.setValue(field, value, { shouldValidate: true });
    const key =
      field === "ss_method"
        ? "method"
        : field === "ss_password"
          ? "password"
          : "network";
    syncSsToConfig({ ...ssValues(), [key]: value });
  }

  /** 切走 SS 时把专有字段清掉，避免 vless 等协议残留 settings.password。 */
  function clearSsFields() {
    form.setValue("ss_method", SS_DEFAULT_METHOD);
    form.setValue("ss_password", "");
    form.setValue("ss_network", SS_DEFAULT_NETWORK);
    form.clearErrors(["ss_method", "ss_password", "ss_network"]);
  }

  function stripSsFromConfigText() {
    const config = parseJsonConfig(configText, translate);
    if (!config.ok) return;
    const stripped = stripSsSettings(config.value);
    if (stripped !== config.value) setConfigText(formatJsonObject(stripped));
  }

  /** 骨架里的 SS settings 跟随三个字段，避免重置后 JSON 与字段不一致。 */
  function skeletonFor(
    nextProtocol: NodeProtocol,
    nextTransport: NodeTransport,
    nextSecurity: NodeSecurity,
  ) {
    const skeleton = buildConfigSkeleton(
      nextProtocol,
      nextTransport,
      nextSecurity,
    );
    return nextProtocol === "shadowsocks"
      ? withSsSettings(skeleton, ssValues())
      : skeleton;
  }

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
        skeletonFor(nextProtocol, nextTransport, nextSecurity),
      ),
    );
  }

  function handleProtocolChange(next: NodeProtocol) {
    const nextTransport = defaultTransport(next);
    const nextSecurity = defaultSecurity(next, nextTransport);
    form.setValue("protocol", next, { shouldValidate: true });
    form.setValue("transport", nextTransport, { shouldValidate: true });
    form.setValue("security", nextSecurity, { shouldValidate: true });
    // 凭据永远不跨协议沿用：切到 SS 时从空密码开始，切走时清空三个字段。
    clearSsFields();
    if (next !== "shadowsocks") stripSsFromConfigText();
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
    setConfigText(formatJsonObject(skeletonFor(protocol, transport, security)));
    setConfigDirty(false);
  }

  /** 手改 JSON 时反向同步三个字段，提交时不会用旧字段覆盖刚写的 settings。 */
  function handleConfigTextChange(text: string) {
    setConfigText(text);
    setConfigDirty(true);
    if (!isSs) return;
    const config = parseJsonConfig(text, translate);
    if (!config.ok) return;
    const settings = ssSettings({ config: config.value });
    form.setValue("ss_method", settings.method);
    form.setValue("ss_password", settings.password);
    form.setValue("ss_network", settings.network);
  }

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors("root");
    const check = parseJsonConfig(configText, translate);
    if (!check.ok) {
      toast.error(check.issue.message);
      return;
    }

    const port = Number(values.port);
    const publicPort = parsePublicPortInput(values.public_port);
    if (publicPort === undefined) {
      form.setError("public_port", {
        message: t("validation.publicPortRange"),
      });
      return;
    }
    // 单位换算只在 lib/speed.ts 里发生，这里已经拿到的就是 kbps。
    const bandwidthKbps = mbpsInputToKbps(values.bandwidth_mbps);
    // 只有 TLS 节点才带 cert_id；其余安全层必须完全省略，否则后端会 400。
    const certId = values.security === "tls" ? values.cert_id.trim() : "";
    const certBinding = certId ? { cert_id: certId } : {};
    // SS 三件套只写 config.settings；切到其它协议时反过来剥掉，避免残留。
    const config =
      values.protocol === "shadowsocks"
        ? withSsSettings(check.value, {
            method: values.ss_method,
            password: values.ss_password,
            network: values.ss_network,
          })
        : stripSsSettings(check.value);

    try {
      if (isEdit && node) {
        await updateNode.mutateAsync({
          id: node.id,
          input: {
            name: values.name,
            port,
            public_port: publicPort,
            enabled: values.enabled,
            config,
            bandwidth_kbps: bandwidthKbps,
            ...certBinding,
          },
        });
        toast.success(t("nodes.form.updated"));
      } else {
        const created = await createNode.mutateAsync({
          name: values.name,
          protocol: values.protocol,
          transport: values.transport,
          security: values.security,
          port,
          public_port: publicPort,
          config,
          enabled: values.enabled,
          bandwidth_kbps: bandwidthKbps,
          ...certBinding,
        });
        toast.success(t("nodes.form.created", { name: created.name }));
      }

      onOpenChange(false);
    } catch (error) {
      const message = errorText(error, t("nodes.form.error"));
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
          <DialogTitle>
            {isEdit ? t("nodes.form.editTitle") : t("nodes.form.createTitle")}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? t("nodes.form.editDesc")
              : t("nodes.form.createDesc")}
          </DialogDescription>
        </DialogHeader>

        <form id="node-form" onSubmit={onSubmit}>
          <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
            <div className="space-y-4">
              <FormField
                label={t("nodes.form.name")}
                htmlFor="node-name"
                required
                error={form.formState.errors.name?.message}
              >
                <Input
                  id="node-name"
                  autoComplete="off"
                  placeholder={t("nodes.form.namePlaceholder")}
                  disabled={pending}
                  aria-invalid={Boolean(form.formState.errors.name)}
                  {...form.register("name")}
                />
              </FormField>

              <div className="grid gap-3 sm:grid-cols-2">
                <FormField
                  label={t("nodes.form.protocol")}
                  htmlFor="node-protocol"
                  error={form.formState.errors.protocol?.message}
                  hint={isEdit ? t("nodes.form.readOnly") : undefined}
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
                          <SelectValue placeholder={t("nodes.form.protocolPlaceholder")} />
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
                  label={t("nodes.form.port")}
                  htmlFor="node-port"
                  required
                  hint={portPolicyHint}
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

              <FormField
                label={t("nodes.form.publicPort")}
                htmlFor="node-public-port"
                hint={t("nodes.form.publicPortHint")}
                error={form.formState.errors.public_port?.message}
              >
                <Input
                  id="node-public-port"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder={t("nodes.form.publicPortPlaceholder")}
                  disabled={pending}
                  aria-invalid={Boolean(form.formState.errors.public_port)}
                  {...form.register("public_port")}
                />
              </FormField>

              <div className="grid gap-3 sm:grid-cols-2">
                <FormField
                  label={t("nodes.form.transport")}
                  htmlFor="node-transport"
                  error={form.formState.errors.transport?.message}
                  hint={isEdit ? t("nodes.form.readOnly") : undefined}
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
                          <SelectValue placeholder={t("nodes.form.transportPlaceholder")} />
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
                  label={t("nodes.form.security")}
                  htmlFor="node-security"
                  error={form.formState.errors.security?.message}
                  hint={
                    isEdit
                      ? t("nodes.form.securityReadOnlyHint")
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
                          <SelectValue placeholder={t("nodes.form.securityPlaceholder")} />
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

              {isSs ? (
                <>
                  <FormField
                    label={t("nodes.form.ssMethod")}
                    htmlFor="node-ss-method"
                    required
                    error={form.formState.errors.ss_method?.message}
                  >
                    <Controller
                      control={form.control}
                      name="ss_method"
                      render={({ field }) => (
                        <Select
                          value={field.value}
                          onValueChange={(value) =>
                            updateSsField("ss_method", value)
                          }
                          disabled={pending}
                        >
                          <SelectTrigger
                            id="node-ss-method"
                            className="w-full font-mono"
                            aria-invalid={Boolean(
                              form.formState.errors.ss_method,
                            )}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {SS_METHODS.map((item) => (
                              <SelectItem
                                key={item}
                                value={item}
                                className="font-mono"
                              >
                                {item}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </FormField>

                  <FormField
                    label={t("nodes.form.ssPassword")}
                    htmlFor="node-ss-password"
                    required={ssIs2022}
                    error={form.formState.errors.ss_password?.message}
                  >
                    <Controller
                      control={form.control}
                      name="ss_password"
                      render={({ field }) => (
                        <div className="flex items-center gap-2">
                          <Input
                            id="node-ss-password"
                            autoComplete="off"
                            spellCheck={false}
                            className="font-mono"
                            disabled={pending}
                            aria-invalid={Boolean(
                              form.formState.errors.ss_password,
                            )}
                            value={field.value}
                            onChange={(event) =>
                              updateSsField(
                                "ss_password",
                                event.target.value,
                              )
                            }
                          />
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() =>
                              updateSsField(
                                "ss_password",
                                generateSsKey(form.getValues("ss_method")),
                              )
                            }
                            disabled={pending}
                          >
                            {t("nodes.form.ssGenerate")}
                          </Button>
                        </div>
                      )}
                    />
                  </FormField>

                  <FormField
                    label={t("nodes.form.ssNetwork")}
                    htmlFor="node-ss-network"
                    error={form.formState.errors.ss_network?.message}
                  >
                    <Controller
                      control={form.control}
                      name="ss_network"
                      render={({ field }) => (
                        <Select
                          value={field.value}
                          onValueChange={(value) =>
                            updateSsField("ss_network", value)
                          }
                          disabled={pending}
                        >
                          <SelectTrigger
                            id="node-ss-network"
                            className="w-full font-mono"
                            aria-invalid={Boolean(
                              form.formState.errors.ss_network,
                            )}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {SS_NETWORKS.map((item) => (
                              <SelectItem
                                key={item}
                                value={item}
                                className="font-mono"
                              >
                                {item}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </FormField>
                </>
              ) : null}

              <FormField
                label={t("nodes.form.bandwidth")}
                htmlFor="node-bandwidth"
                hint={t("nodes.form.bandwidthHint")}
                error={form.formState.errors.bandwidth_mbps?.message}
              >
                <div className="relative">
                  <Input
                    id="node-bandwidth"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder={t("nodes.form.bandwidthPlaceholder")}
                    disabled={pending}
                    aria-invalid={Boolean(
                      form.formState.errors.bandwidth_mbps,
                    )}
                    className="pr-14"
                    {...form.register("bandwidth_mbps")}
                  />
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground"
                  >
                    Mbps
                  </span>
                </div>
              </FormField>

              {!comboValid ? (
                <p role="alert" className="text-xs text-destructive">
                  {t("nodes.form.comboInvalid")}
                </p>
              ) : null}

              {security === "tls" ? (
                <FormField
                  label={t("nodes.form.cert")}
                  htmlFor="node-cert"
                  required
                  error={form.formState.errors.cert_id?.message}
                  hint={
                    certificates.isError
                      ? t("nodes.form.certLoadError")
                      : isEdit
                        ? t("nodes.form.certChangeHint")
                        : undefined
                  }
                >
                  <div className="space-y-2">
                    {/*
                      FormField 下探不到 Controller 的 render-prop：
                      必填/错误语义显式传给真正获得焦点的 trigger。
                    */}
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
                            aria-required
                            aria-invalid={Boolean(
                              form.formState.errors.cert_id,
                            )}
                            aria-describedby={
                              form.formState.errors.cert_id
                                ? "node-cert-error"
                                : certificates.isError || isEdit
                                  ? "node-cert-hint"
                                  : undefined
                            }
                          >
                            <SelectValue
                              placeholder={
                                certificates.isPending
                                  ? t("nodes.form.certLoading")
                                  : noCertificates
                                    ? t("nodes.form.certEmpty")
                                    : t("nodes.form.certPlaceholder")
                              }
                            />
                          </SelectTrigger>
                          <SelectContent>
                            {certItems.map((cert) => (
                              <SelectItem key={cert.id} value={cert.id}>
                                {cert.name}
                                {cert.days_left < 0
                                  ? t("nodes.form.certExpired")
                                  : cert.days_left <= 30
                                    ? t("nodes.form.certExpiring", { n: cert.days_left })
                                    : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                    {noCertificates ? (
                      <p className="text-xs text-muted-foreground">
                        {t("nodes.form.certEmptyPrefix")}
                        <Link
                          to="/settings?tab=certificates"
                          className="font-medium text-primary underline-offset-4 hover:underline"
                        >
                          {t("nodes.form.certEmptyLink")}
                        </Link>
                        {t("nodes.form.certEmptySuffix")}
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
                  {t("nodes.form.securityChanged", {
                    security: securityLabel(security),
                  })}
                </p>
              ) : null}

              <FormField
                label={t("nodes.form.enabled")}
                htmlFor="node-enabled"
                hint={t("nodes.form.enabledHint")}
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
                    {form.watch("enabled")
                      ? t("nodes.form.enabledOn")
                      : t("nodes.form.enabledOff")}
                  </span>
                </div>
              </FormField>

              <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                <p className="font-medium text-foreground">
                  {nodeSummary(protocol, transport, security)}
                </p>
                <p className="mt-1">
                  {t("nodes.form.comboNote")}
                </p>
              </div>
            </div>

            <FormField
              label={
                <span className="flex items-center gap-2">
                  {t("nodes.form.configLabel")}
                  {!isEdit && configDirty ? (
                    <Badge
                      variant="secondary"
                      className="font-normal text-muted-foreground"
                    >
                      {t("nodes.form.configDirty")}
                    </Badge>
                  ) : null}
                </span>
              }
              htmlFor="node-config"
              error={configError}
              hint={
                parsed.ok
                  ? t("nodes.form.configValid", {
                      n: configText.split("\n").length,
                    })
                  : undefined
              }
            >
              <div className="space-y-2">
                <Textarea
                  id="node-config"
                  value={configText}
                  onChange={(event) =>
                    handleConfigTextChange(event.target.value)
                  }
                  spellCheck={false}
                  disabled={pending}
                  aria-invalid={!parsed.ok}
                  className="min-h-72 resize-y font-mono text-xs leading-normal"
                />
                <div className="flex items-center justify-between gap-2">
                  <p className="type-micro leading-normal text-muted-foreground">
                    {isEdit
                      ? t("nodes.form.configEditHint")
                      : configDirty
                        ? t("nodes.form.configDirtyHint")
                        : t("nodes.form.configAutoHint")}
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
                      {t("nodes.form.regenerate")}
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
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form="node-form"
            disabled={pending || !parsed.ok || !comboValid}
          >
            {pending ? <Loader2Icon className="animate-spin" /> : null}
            {pending
              ? t("nodes.form.saving")
              : isEdit
                ? t("nodes.form.submitSave")
                : t("nodes.form.submitCreate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
