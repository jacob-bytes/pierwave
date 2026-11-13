import { useEffect, useMemo, useState } from "react";
import {
  Controller,
  useFieldArray,
  useForm,
  useWatch,
  type UseFormReturn,
} from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  InfoIcon,
  Loader2Icon,
  LockIcon,
  PlusIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { toast } from "sonner";
import { FormField, FormRootError } from "@/components/FormField";
import { StrategyBadge } from "@/components/chains/StrategyBadge";
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
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { portFieldVisible, stripAutoPorts } from "@/lib/chainPorts";
import {
  needsCert,
  normalizeTransport,
  tlsAvailable,
} from "@/lib/chainTls";
import type { Certificate, Chain, Server } from "@/lib/api";
import {
  CHAIN_MAX_GROUPS,
  CHAIN_MIN_GROUPS,
  CHAIN_STRATEGIES,
  DEFAULT_CHAIN_STRATEGY,
  GROUP_MAX_MEMBERS,
  GROUP_MIN_GROUP_MEMBERS,
  groupKind,
  normalizeStrategy,
  orderGroups,
  orderMembers,
  type ChainStrategy,
} from "@/lib/chains";
import {
  chainEngineOptions,
  engineInput,
  formatServerNameList,
  isChainEngine,
  missingNftablesServerNames,
  missingRealmServerNames,
  missingTunnelServerNames,
  normalizeEngine,
  serversMissingNftables,
  serversMissingRealm,
} from "@/lib/engines";
import { errorText } from "@/lib/errors";
import {
  DEFAULT_PROTOCOL,
  PROTOCOL_MODES,
  normalizeProtocol,
  protocolAvailable,
} from "@/lib/protocolMode";
import {
  useCertificates,
  useCreateChain,
  useUpdateChain,
} from "@/lib/queries";
import { chainFormSchema, type ChainFormValues } from "@/lib/schemas";
import {
  TUNNEL_SECURITY_MODES,
  normalizeTunnelSecurity,
  securityLabelKey,
} from "@/lib/tunnelSecurity";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";

interface ChainFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  chain?: Chain;
  servers: Server[];
  loadingServers: boolean;
}

interface MemberFieldErrors {
  server_id?: { message?: string };
  listen_port?: { message?: string };
}

interface GroupFieldErrors {
  name?: { message?: string };
  strategy?: { message?: string };
  cert_id?: { message?: string };
  members?: { message?: string } | (MemberFieldErrors | undefined)[];
}

function emptyMember() {
  return { server_id: "", listen_port: "" };
}

function emptyGroup() {
  return {
    kind: "single" as const,
    name: "",
    strategy: DEFAULT_CHAIN_STRATEGY,
    cert_id: "",
    members: [emptyMember()],
  };
}

/** 根错误（组数 / 成员数）与数组错误（逐字段）在 RHF 里形状不同。 */
function rootMessage(error: unknown): string | undefined {
  if (Array.isArray(error) || typeof error !== "object" || error === null) {
    return undefined;
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

function GroupCard({
  index,
  groupCount,
  form,
  pending,
  editing,
  servers,
  loadingServers,
  tlsEnabled,
  nftablesEngine,
  tunnelEngine,
  certificates,
  certsLoading,
  certsError,
  expanded,
  onToggle,
  onMoveGroup,
  onRemoveGroup,
}: {
  index: number;
  groupCount: number;
  form: UseFormReturn<ChainFormValues>;
  pending: boolean;
  /** 编辑已保存的链：中间跳展示后端已分配的只读端口。 */
  editing: boolean;
  servers: Server[];
  loadingServers: boolean;
  tlsEnabled: boolean;
  nftablesEngine: boolean;
  /** 选中 tunnel 时，该组的成员必须都明确上报 `tunnel_available = true`。 */
  tunnelEngine: boolean;
  certificates: Certificate[];
  certsLoading: boolean;
  certsError: boolean;
  expanded: boolean;
  onToggle: () => void;
  onMoveGroup: (index: number, offset: -1 | 1) => void;
  onRemoveGroup: (index: number) => void;
}) {
  const { t } = useI18n();
  const { control, formState, setValue, trigger, watch } = form;

  // 组内成员是第二层动态数组：每张组卡片各自维护 append / remove / move。
  const { fields, append, remove, move, replace } = useFieldArray({
    control,
    name: `groups.${index}.members`,
  });
  const members = watch(`groups.${index}.members`) ?? [];
  const kind = watch(`groups.${index}.kind`) ?? "group";
  const single = kind === "single";
  const strategy = watch(`groups.${index}.strategy`);
  const selectedStrategy: ChainStrategy = normalizeStrategy(strategy);
  const groupName = (watch(`groups.${index}.name`) ?? "").trim();
  const isEntry = index === 0;
  const isLast = index === groupCount - 1;
  const seq = index + 1;
  // 入口组仍由用户填端口；中间跳的端口由后端自动分配，不渲染输入框。
  const showPortField = portFieldVisible(index);

  // tunnel 能力是静态环境事实：未知（null / 缺失）与 false 都不能参与 tunnel 链，
  // 提示挂在这一组下方，不阻止用户继续编辑其它字段。
  const tunnelMissingNames = tunnelEngine
    ? missingTunnelServerNames(
        members
          .map((member) =>
            servers.find((server) => server.id === member.server_id),
          )
          .filter((server): server is Server => server !== undefined),
      )
    : [];

  const errorGroups = Array.isArray(formState.errors.groups)
    ? (formState.errors.groups as unknown as (GroupFieldErrors | undefined)[])
    : undefined;
  const groupErrors = errorGroups?.[index];
  const membersRootError = rootMessage(groupErrors?.members);
  const memberErrors = Array.isArray(groupErrors?.members)
    ? groupErrors.members
    : undefined;
  const hasError = Boolean(groupErrors);

  const strategyOptions = CHAIN_STRATEGIES.map((value) => ({
    value,
    label: t(`chains.strategy.${value}.label`),
    desc: t(`chains.strategy.${value}.desc`),
  }));

  const certPlaceholder = certsLoading
    ? t("chains.tls.certLoading")
    : certsError
      ? t("chains.tls.certLoadError")
      : certificates.length === 0
        ? t("chains.tls.certEmpty")
        : t("chains.tls.certPlaceholder");

  function setGroupField(field: "name" | "strategy", value: string) {
    setValue(`groups.${index}.${field}`, value, {
      shouldDirty: true,
      shouldTouch: true,
    });
  }

  function setMemberField(
    memberIndex: number,
    field: "server_id" | "listen_port",
    value: string,
  ) {
    setValue(`groups.${index}.members.${memberIndex}.${field}`, value, {
      shouldDirty: true,
      shouldTouch: true,
    });
  }

  function setKind(next: "single" | "group") {
    setValue(`groups.${index}.kind`, next, {
      shouldDirty: true,
      shouldTouch: true,
    });
    if (next === "single") {
      const first = members[0] ?? emptyMember();
      replace([
        {
          server_id: first.server_id,
          listen_port: first.listen_port,
        },
      ]);
    } else if (members.length < GROUP_MIN_GROUP_MEMBERS) {
      append(emptyMember());
    }
    form.clearErrors(`groups.${index}`);
  }

  return (
    <div
      role="group"
      data-group-index={index}
      aria-label={t("chains.form.group", { seq })}
      className={cn(
        "overflow-hidden rounded-lg border bg-muted/20 transition-colors duration-150",
        expanded ? "border-border" : "border-border/70 hover:border-border",
        hasError && "border-destructive/45",
      )}
    >
      <div
        className={cn(
          "flex items-center justify-between gap-2 px-2.5 py-1.5",
          expanded && "border-b border-border/60 bg-muted/20",
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={`chain-group-${index}-body`}
          aria-label={t(
            expanded
              ? "chains.form.collapseGroup"
              : "chains.form.expandGroup",
            { seq },
          )}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
              expanded && "rotate-90",
            )}
            aria-hidden="true"
          />
          <span className="shrink-0 text-xs font-medium text-foreground">
            {t("chains.form.group", { seq })}
          </span>
          {isEntry ? (
            <Badge
              variant="secondary"
              className="h-4 px-1.5 type-micro font-normal"
            >
              {t("chains.form.groupEntryHint")}
            </Badge>
          ) : null}
          {isLast && !isEntry ? (
            <span className="shrink-0 type-micro text-muted-foreground">
              {t("chains.form.groupExitHint")}
            </span>
          ) : null}
          {!expanded ? (
            <>
              <Badge
                variant="secondary"
                className="h-4 px-1.5 type-micro font-normal"
              >
                {t(single ? "chains.form.typeSingle" : "chains.form.typeGroup")}
              </Badge>
              {!single && groupName ? (
                <span
                  className="max-w-40 truncate text-xs text-foreground"
                  title={groupName}
                >
                  {groupName}
                </span>
              ) : null}
              {!single ? <StrategyBadge strategy={selectedStrategy} /> : null}
              {!single ? (
                <span className="shrink-0 font-mono type-micro tabular-nums text-muted-foreground">
                  {t("chains.form.memberLimit", {
                    count: fields.length,
                    max: GROUP_MAX_MEMBERS,
                  })}
                </span>
              ) : null}
            </>
          ) : null}
          {hasError ? (
            <span
              className="inline-flex shrink-0 text-destructive"
              title={t("chains.form.groupErrorTitle")}
            >
              <TriangleAlertIcon className="size-3.5" aria-hidden="true" />
            </span>
          ) : null}
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-6"
            aria-label={t("chains.form.moveGroupUp", { seq })}
            disabled={pending || isEntry}
            onClick={() => onMoveGroup(index, -1)}
          >
            <ArrowUpIcon className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-6"
            aria-label={t("chains.form.moveGroupDown", { seq })}
            disabled={pending || isLast}
            onClick={() => onMoveGroup(index, 1)}
          >
            <ArrowDownIcon className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-6 text-muted-foreground hover:text-destructive"
            aria-label={t("chains.form.removeGroup", { seq })}
            disabled={pending || groupCount <= CHAIN_MIN_GROUPS}
            onClick={() => onRemoveGroup(index)}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      </div>

      {expanded ? (
      <div
        id={`chain-group-${index}-body`}
        className="space-y-3 p-3"
      >

      <div className="flex flex-wrap items-center gap-2">
        <span className="type-micro text-muted-foreground">
          {t("chains.form.hopType")}
        </span>
        <div
          role="group"
          aria-label={t("chains.form.hopTypeAria", { seq })}
          className="inline-flex items-center gap-0.5 rounded-md border border-border bg-background/60 p-0.5"
        >
          <Button
            type="button"
            size="xs"
            variant={single ? "secondary" : "ghost"}
            aria-pressed={single}
            disabled={pending}
            onClick={() => setKind("single")}
            className="h-6 rounded-sm px-2 type-micro"
          >
            {t("chains.form.typeSingle")}
          </Button>
          <Button
            type="button"
            size="xs"
            variant={!single ? "secondary" : "ghost"}
            aria-pressed={!single}
            title={
              nftablesEngine && !isEntry
                ? t("chains.form.nftablesSingleOnly")
                : undefined
            }
            disabled={pending || (nftablesEngine && !isEntry)}
            onClick={() => setKind("group")}
            className="h-6 rounded-sm px-2 type-micro"
          >
            {t("chains.form.typeGroup")}
          </Button>
        </div>
      </div>

      {!single ? (
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`chain-group-${index}-name`} className="text-xs">
            {t("chains.form.groupName")}
          </Label>
          <Input
            id={`chain-group-${index}-name`}
            value={watch(`groups.${index}.name`)}
            onChange={(event) => setGroupField("name", event.target.value)}
            onBlur={() => {
              if (formState.isSubmitted) void trigger();
            }}
            placeholder={t("chains.form.groupNamePlaceholder")}
            aria-label={t("chains.form.groupNameAria", { seq })}
            autoComplete="off"
            disabled={pending}
            aria-invalid={Boolean(groupErrors?.name)}
            className="h-8"
          />
          {groupErrors?.name?.message ? (
            <p role="alert" className="text-xs text-destructive">
              {groupErrors.name.message}
            </p>
          ) : null}
        </div>

        <div className="space-y-1">
          <Label className="text-xs">{t("chains.form.strategy")}</Label>
          <Select
            value={selectedStrategy}
            onValueChange={(value) => {
              setGroupField("strategy", value);
              if (formState.isSubmitted) void trigger();
            }}
            disabled={pending}
          >
            <SelectTrigger
              className="h-8 w-full"
              aria-label={t("chains.form.strategyAria", { seq })}
              aria-invalid={Boolean(groupErrors?.strategy)}
            >
              {/* 显式给 Value 文案：默认会把 SelectItem 里的说明文字也塞进触发器。 */}
              <SelectValue>
                {t(`chains.strategy.${selectedStrategy}.label`)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="w-72">
              {strategyOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  <span className="flex min-w-0 flex-col gap-0.5 whitespace-normal">
                    <span className="font-medium">{option.label}</span>
                    <span className="type-micro leading-normal text-muted-foreground">
                      {option.desc}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {groupErrors?.strategy?.message ? (
            <p role="alert" className="text-xs text-destructive">
              {groupErrors.strategy.message}
            </p>
          ) : null}
        </div>
      </div>
      ) : null}

      {!single ? (
      <div className="flex items-start gap-1.5 rounded-md border border-border/70 bg-background/40 px-2 py-1.5">
        <InfoIcon
          className="mt-px size-3 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <StrategyBadge strategy={selectedStrategy} />
            <span className="type-micro text-muted-foreground">
              {t("chains.form.strategyHint")}
            </span>
          </div>
          <p className="mt-0.5 type-micro leading-normal text-muted-foreground">
            {t(`chains.strategy.${selectedStrategy}.desc`)}
          </p>
        </div>
      </div>
      ) : null}

      {tlsEnabled && needsCert(index) ? (
        <div className="space-y-1">
          <Label htmlFor={`chain-group-${index}-cert`} className="text-xs">
            {t("chains.tls.cert")}
          </Label>
          <Controller
            control={control}
            name={`groups.${index}.cert_id`}
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={(value) => {
                  field.onChange(value);
                  if (formState.isSubmitted) void trigger();
                }}
                disabled={
                  pending ||
                  certsLoading ||
                  certsError ||
                  certificates.length === 0
                }
              >
                <SelectTrigger
                  id={`chain-group-${index}-cert`}
                  className="h-8 w-full"
                  aria-required
                  aria-invalid={Boolean(groupErrors?.cert_id)}
                  aria-label={t("chains.tls.certAria", { seq })}
                >
                  <SelectValue placeholder={certPlaceholder} />
                </SelectTrigger>
                <SelectContent>
                  {certificates.map((cert) => (
                    <SelectItem key={cert.id} value={cert.id}>
                      {cert.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          {groupErrors?.cert_id?.message ? (
            <p role="alert" className="text-xs text-destructive">
              {groupErrors.cert_id.message}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-1">
          <Label className="text-xs">
            {single ? t("chains.form.singleNode") : t("chains.form.members")}
          </Label>
          <span className="type-micro text-muted-foreground">
            {single ? t("chains.form.singleHint") : t("chains.form.membersHint")}
          </span>
        </div>

        <div className="space-y-2">
          {fields.map((field, memberIndex) => {
            const memberError = memberErrors?.[memberIndex];
            const serverError = memberError?.server_id?.message;
            const portError = memberError?.listen_port?.message;
            const memberSeq = memberIndex + 1;
            const isFirstMember = memberIndex === 0;
            const isLastMember = memberIndex === fields.length - 1;
            const savedPort = (
              members[memberIndex]?.listen_port ?? ""
            ).trim();
            // 中间跳只在编辑已保存的链时展示后端已分配的端口；新建时没有可展示的值。
            const showSavedPort =
              editing && !showPortField && /^\d+$/.test(savedPort);

            return (
              <div
                key={field.id}
                className="rounded-md border border-border/70 bg-card/60 p-2"
              >
                {!single ? (
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="type-micro font-medium text-muted-foreground">
                    {t("chains.form.member", { seq: memberSeq })}
                  </span>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="size-6"
                      aria-label={t("chains.form.moveMemberUp", {
                        group: seq,
                        member: memberSeq,
                      })}
                      disabled={pending || isFirstMember}
                      onClick={() => {
                        move(memberIndex, memberIndex - 1);
                        form.clearErrors("groups");
                      }}
                    >
                      <ArrowUpIcon className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="size-6"
                      aria-label={t("chains.form.moveMemberDown", {
                        group: seq,
                        member: memberSeq,
                      })}
                      disabled={pending || isLastMember}
                      onClick={() => {
                        move(memberIndex, memberIndex + 1);
                        form.clearErrors("groups");
                      }}
                    >
                      <ArrowDownIcon className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="size-6 text-muted-foreground hover:text-destructive"
                      aria-label={t("chains.form.removeMember", {
                        group: seq,
                        member: memberSeq,
                      })}
                      disabled={pending || fields.length <= GROUP_MIN_GROUP_MEMBERS}
                      onClick={() => {
                        remove(memberIndex);
                        form.clearErrors("groups");
                      }}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                </div>
                ) : null}

                <div
                  className={cn(
                    "grid grid-cols-1 gap-2",
                    showPortField && "sm:grid-cols-[minmax(0,1fr)_7rem]",
                    showSavedPort && "sm:grid-cols-[minmax(0,1fr)_auto]",
                  )}
                >
                  <div className="space-y-1">
                    <Select
                      value={members[memberIndex]?.server_id ?? ""}
                      onValueChange={(value) => {
                        setMemberField(memberIndex, "server_id", value);
                        if (formState.isSubmitted) void trigger();
                      }}
                      disabled={pending || loadingServers}
                    >
                      <SelectTrigger
                        className="w-full"
                        aria-required
                        aria-label={t("chains.form.memberServerAria", {
                          group: seq,
                          member: memberSeq,
                        })}
                        aria-invalid={Boolean(serverError)}
                      >
                        <SelectValue
                          placeholder={t(
                            "chains.form.memberServerPlaceholder",
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
                      <p role="alert" className="text-xs text-destructive">
                        {serverError}
                      </p>
                    ) : null}
                  </div>

                  {showPortField ? (
                    <div className="space-y-1">
                      <Input
                        value={members[memberIndex]?.listen_port ?? ""}
                        onChange={(event) =>
                          setMemberField(
                            memberIndex,
                            "listen_port",
                            event.target.value,
                          )
                        }
                        onBlur={() => {
                          if (formState.isSubmitted) void trigger();
                        }}
                        inputMode="numeric"
                        autoComplete="off"
                        placeholder={t("chains.form.memberPortPlaceholder")}
                        aria-required
                        aria-label={t("chains.form.memberPortAria", {
                          group: seq,
                          member: memberSeq,
                        })}
                        aria-invalid={Boolean(portError)}
                        className="font-mono tabular-nums"
                        disabled={pending}
                      />
                      {portError ? (
                        <p role="alert" className="text-xs text-destructive">
                          {portError}
                        </p>
                      ) : null}
                    </div>
                  ) : showSavedPort ? (
                    <div className="flex min-w-0 items-center sm:justify-end">
                      <div
                        data-auto-port="true"
                        title={t("chains.autoPort")}
                        aria-label={t("chains.autoPortReadonly", {
                          port: savedPort,
                        })}
                        className="flex h-9 w-full items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2.5 sm:w-auto"
                      >
                        <LockIcon
                          className="size-3 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span className="whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">
                          {t("chains.autoPortReadonly", { port: savedPort })}
                        </span>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>

        {membersRootError ? (
          <p role="alert" className="text-xs text-destructive">
            {membersRootError}
          </p>
        ) : null}

        {tunnelMissingNames.length > 0 ? (
          <div
            role="status"
            data-tunnel-unavailable="true"
            className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs leading-normal text-warning"
          >
            <TriangleAlertIcon
              className="mt-0.5 size-3.5 shrink-0"
              aria-hidden="true"
            />
            <span>
              {t("chains.form.tunnelNotAvailable", {
                servers: formatServerNameList(
                  tunnelMissingNames,
                  t("common.listSeparator"),
                ),
              })}
            </span>
          </div>
        ) : null}

        {!single ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              append(emptyMember());
              form.clearErrors("groups");
            }}
            disabled={pending || fields.length >= GROUP_MAX_MEMBERS}
          >
            <PlusIcon className="size-3.5" />
            {t("chains.form.addMember")}
          </Button>
        ) : null}
      </div>
      </div>
      ) : null}
    </div>
  );
}

/**
 * 新建 / 编辑转发链的「组编辑器」。
 *
 * 一条链 = 1–6 组，每组 = 1–8 台成员；组内顺序决定 priority（主备 / 轮询）。
 * 前端只拦「组数 / 成员数 / 同组与跨组重复服务器 / 入口组端口 1–65535 /
 * 目标非空 / tls 链每组的证书」；中间跳（seq ≥ 1）的端口由后端自动分配，
 * 表单不渲染输入，提交时整段省略。保留端口、与节点 / 独立转发 / 其它链成员的
 * 端口冲突、自连回环都依赖服务器数据，由后端返回带 code 的错误，这里通过 `errorText`
 * 原样透出。
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
  const certificates = useCertificates();
  const pending = isEdit ? updateChain.isPending : createChain.isPending;
  // 组卡片一次只展开一个：6 组时也能把弹窗压在一屏内，同时保留完整编辑器。
  const [activeGroup, setActiveGroup] = useState<number | null>(0);

  const schema = useMemo(() => chainFormSchema(t), [t]);

  const initialGroups = useMemo(() => {
    const groups = chain?.groups ?? [];
    if (groups.length === 0) return [emptyGroup()];

    return orderGroups(groups).map((group, index) => {
      const members = orderMembers(group.members);
      return {
        kind: groupKind(group),
        name: group.name ?? "",
        strategy: normalizeStrategy(group.strategy),
        // 入口组（index 0）即使有历史脏数据也不回填证书：后端口径同样禁止。
        cert_id: index === 0 ? "" : (group.cert_id ?? ""),
        members:
          members.length > 0
            ? members.map((member) => ({
                server_id: member.server_id,
                listen_port: String(member.listen_port),
              }))
            : [emptyMember()],
      };
    });
  }, [chain]);

  const form = useForm<ChainFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: chain?.name ?? "",
      target_host: chain?.target_host ?? "",
      target_port: chain ? String(chain.target_port) : "",
      enabled: chain ? Boolean(chain.enabled) : true,
      // 编辑旧链：engine 缺失时按契约缺省 native 回填，不让选项显示成空白。
      engine: normalizeEngine(chain?.engine),
      // 旧数据 / 旧后端没有 protocol：旧 udp:true 按 both 回填，否则 tcp。
      protocol: normalizeProtocol(chain?.protocol, chain?.udp),
      // 旧数据 / 旧后端没有 transport：按契约缺省 none 回填。
      transport: normalizeTransport(chain?.transport),
      // 旧数据 / 旧后端没有 tunnel_security：按契约缺省 tls 回填。
      tunnel_security: normalizeTunnelSecurity(chain?.tunnel_security),
      groups: initialGroups,
    },
  });
  const selectedEngine = form.watch("engine");
  // 用 useWatch 订阅整组：成员是在子组件 GroupCard 里改的，
  // 顶层 `form.watch` 的引用可能不变，warning 会漏更新。
  const watchedGroups =
    useWatch({ control: form.control, name: "groups" }) ?? [];
  const selectedTransport = form.watch("transport");
  const tlsEnabled = selectedTransport === "tls";
  const selectedTunnelSecurity = form.watch("tunnel_security");
  const engineOptions = chainEngineOptions(
    watchedGroups.length,
    watchedGroups.map((group) => group.members.length),
  );
  const tunnelSelected = normalizeEngine(selectedEngine) === "tunnel";
  const tlsDisabledTitle = tunnelSelected
    ? t("chains.tls.tunnelDisabledTitle")
    : t("chains.tls.disabledTitle");
  const canTls = tlsAvailable(selectedEngine, watchedGroups.length);
  const selectedProtocol = form.watch("protocol");
  const availability = protocolAvailable(selectedEngine, selectedTransport);

  // 引擎 / 加密方式改动可能让当前协议失效：
  // realm 不接受仅 UDP；TLS 只走 TCP（UDP 与 both 都不行）。
  // 立即回落 tcp，避免留下「禁用但仍选中」的无效状态。
  useEffect(() => {
    if (availability[selectedProtocol]) return;
    form.setValue("protocol", DEFAULT_PROTOCOL, {
      shouldDirty: true,
      shouldTouch: true,
      shouldValidate: form.formState.isSubmitted,
    });
  }, [
    availability.tcp,
    availability.udp,
    availability.both,
    selectedProtocol,
    form,
  ]);

  // 已选成员指向的服务器（按当前服务器列表解析；已被删掉的跳过）。
  const selectedServers = useMemo(() => {
    const byId = new Map(servers.map((server) => [server.id, server]));
    return watchedGroups.flatMap((group) =>
      group.members
        .map((member) => byId.get(member.server_id))
        .filter((server): server is Server => server !== undefined),
    );
  }, [servers, watchedGroups]);

  // 静态事实：选了 realm，且已选服务器里至少有一台明确没装 realm。
  // null / 缺失（旧 Agent）不算缺失；只提示，不阻止保存。
  const realmMissing =
    selectedEngine === "realm" && serversMissingRealm(selectedServers);
  const realmMissingNames = realmMissing
    ? missingRealmServerNames(selectedServers)
    : [];
  const nftablesMissing =
    selectedEngine === "nftables" &&
    serversMissingNftables(selectedServers);
  const nftablesMissingNames = nftablesMissing
    ? missingNftablesServerNames(selectedServers)
    : [];

  const { fields, append, remove, move } = useFieldArray({
    control: form.control,
    name: "groups",
  });

  // 引擎改回 native 或删到只剩 1 组时，加密开关会变成禁用；
  // 先把 transport 收回 none，避免留下一个「禁用但仍勾选」的无效状态。
  useEffect(() => {
    if (tlsEnabled && !canTls) {
      form.setValue("transport", "none", { shouldDirty: true });
    }
  }, [tlsEnabled, canTls, form]);

  // 入口组不允许证书：组被上移 / 删除后，新入口组的历史证书要清掉，
  // 否则校验会把错误挂在一个不渲染的字段上。
  useEffect(() => {
    if (watchedGroups[0]?.cert_id) {
      form.setValue("groups.0.cert_id", "", { shouldDirty: true });
    }
  }, [watchedGroups, form]);

  // 切换语言后重新校验，让已经显示的错误跟着换语言。
  useEffect(() => {
    if (form.formState.isSubmitted) void form.trigger();
  }, [t, form]);

  const groupsRootError = rootMessage(form.formState.errors.groups);

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors("root");

    const tls = values.transport === "tls";
    const input = {
      name: values.name.trim(),
      target_host: values.target_host.trim(),
      target_port: Number(values.target_port),
      enabled: values.enabled,
      // native 也显式发送：编辑时把 realm 改回 native，PATCH 必须带 engine。
      ...engineInput(values.engine),
      // 编辑时把 tls 改回 none 同样必须显式发送。
      transport: values.transport,
      // 只在 tunnel 引擎下提交：其它引擎没有这条语义，不发无意义字段。
      ...(values.engine === "tunnel"
        ? { tunnel_security: normalizeTunnelSecurity(values.tunnel_security) }
        : {}),
      // 协议是权威字段；引擎 / TLS 切换瞬间的无效组合回落 tcp。
      protocol: protocolAvailable(values.engine, values.transport)[
        values.protocol
      ]
        ? values.protocol
        : DEFAULT_PROTOCOL,
      // 入口组照常发送 listen_port；中间跳整个去掉，交给后端从端口池分配。
      groups: stripAutoPorts(
        values.groups.map((group, index) => ({
          seq: index,
          name:
            group.kind === "single"
              ? undefined
              : group.name.trim() || undefined,
          strategy:
            group.kind === "single"
              ? DEFAULT_CHAIN_STRATEGY
              : group.strategy,
          // 入口组始终不带证书；非 tls 链也不保留证书绑定。
          cert_id:
            tls && needsCert(index) ? group.cert_id.trim() : undefined,
          members: group.members.map((member, memberIndex) => ({
            server_id: member.server_id,
            // 中间跳在新建时为空；统一归一成 undefined，避免提交空串数字 0。
            listen_port:
              member.listen_port.trim() === ""
                ? undefined
                : Number(member.listen_port),
            priority: memberIndex,
          })),
        })),
      ).map((group) => ({
        // seq 只用于判断端口归属，不发给后端（顺序由数组下标表达）。
        name: group.name,
        strategy: group.strategy,
        ...(group.cert_id !== undefined ? { cert_id: group.cert_id } : {}),
        members: group.members,
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
  }, (errors) => {
    // 被折叠的组也可能有错：保存失败时展开第一个出错组，避免「点了保存没反应」。
    const groupErrors = Array.isArray(errors.groups)
      ? errors.groups
      : undefined;
    const firstInvalid = groupErrors?.findIndex((group) => Boolean(group));
    if (firstInvalid === undefined || firstInvalid < 0) return;
    setActiveGroup(firstInvalid);
    window.setTimeout(() => {
      document
        .getElementById(`chain-group-${firstInvalid}`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 0);
  });

  function clearGroupErrors() {
    form.clearErrors("groups");
  }

  function handleMoveGroup(from: number, offset: -1 | 1) {
    move(from, from + offset);
    setActiveGroup(from + offset);
    clearGroupErrors();
  }

  function handleRemoveGroup(groupIndex: number) {
    remove(groupIndex);
    setActiveGroup((current) => {
      if (current === null) return null;
      if (current === groupIndex) {
        return Math.min(groupIndex, fields.length - 2);
      }
      return current > groupIndex ? current - 1 : current;
    });
    clearGroupErrors();
  }

  function handleAddGroup() {
    const nextIndex = fields.length;
    append(emptyGroup());
    setActiveGroup(nextIndex);
    clearGroupErrors();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <DialogHeader className="border-b border-border px-4 py-4 pr-12 sm:px-6">
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

        <form
          id="chain-form"
          className="min-h-0 flex-1 overflow-y-auto"
          onSubmit={onSubmit}
        >
          <div className="grid gap-6 p-4 sm:p-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
            <div className="min-w-0 space-y-4">
              <span className="block text-sm font-medium">
                {t("chains.form.basics")}
              </span>
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

          <FormField
            label={t("chains.form.engine")}
            hint={t("chains.form.engineHint")}
          >
            <div className="space-y-2">
              <RadioGroup
                aria-label={t("chains.form.engineAria")}
                value={selectedEngine}
                onValueChange={(next) => {
                  if (!isChainEngine(next)) return;
                  form.setValue("engine", next, {
                    shouldDirty: true,
                    shouldTouch: true,
                    shouldValidate: true,
                  });
                  // realm 固定双开：先把仅 UDP 收回 tcp，再等 effect 兜底。
                  if (
                    next === "realm" &&
                    form.getValues("protocol") === "udp"
                  ) {
                    form.setValue("protocol", DEFAULT_PROTOCOL, {
                      shouldDirty: true,
                      shouldTouch: true,
                      shouldValidate: true,
                    });
                  }
                }}
                disabled={pending}
                className="grid gap-2 sm:grid-cols-2"
              >
                {engineOptions.map((option) => {
                  const active = selectedEngine === option.engine;
                  return (
                    <Label
                      key={option.engine}
                      htmlFor={`chain-engine-${option.engine}`}
                      data-engine-option={option.engine}
                      data-tunnel-ready={option.available}
                      className={cn(
                        "flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-card p-2.5 transition-colors duration-150 hover:bg-muted/40",
                        active &&
                          "border-primary/60 bg-primary/5 hover:bg-primary/5",
                        pending && "cursor-not-allowed opacity-60",
                      )}
                    >
                      <RadioGroupItem
                        id={`chain-engine-${option.engine}`}
                        value={option.engine}
                        disabled={pending}
                        className="mt-0.5"
                      />
                      <span className="min-w-0 space-y-0.5">
                        <span className="flex flex-wrap items-center gap-1 text-sm font-medium">
                          {t(option.labelKey)}
                          {option.experimental ? (
                            <Badge
                              variant="outline"
                              data-experimental="true"
                              className="h-4 px-1 type-micro font-normal border-border/80 bg-muted/40 text-muted-foreground"
                            >
                              {t("common.engine.tunnel.experimental")}
                            </Badge>
                          ) : null}
                        </span>
                        <span className="block type-micro leading-normal text-muted-foreground">
                          {t(option.shortKey)}
                        </span>
                      </span>
                    </Label>
                  );
                })}
              </RadioGroup>
              {/* 整条链一个引擎：说明里点明「逐跳透传」与 UDP 差异。 */}
              <p className="rounded-md border border-border bg-muted/20 px-2.5 py-2 type-micro leading-normal text-muted-foreground">
                {t(`common.engine.${selectedEngine}.desc`)}
              </p>
              {realmMissingNames.length > 0 ? (
                <div
                  role="status"
                  className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs leading-normal text-warning"
                >
                  <TriangleAlertIcon
                    className="mt-0.5 size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span>
                    {t("chains.form.realmNotInstalled", {
                      servers: formatServerNameList(
                        realmMissingNames,
                        t("common.listSeparator"),
                      ),
                    })}
                  </span>
                </div>
              ) : null}
              {nftablesMissingNames.length > 0 ? (
                <div
                  role="status"
                  className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs leading-normal text-warning"
                >
                  <TriangleAlertIcon
                    className="mt-0.5 size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span>
                    {t("chains.form.nftablesNotAvailable", {
                      servers: formatServerNameList(
                        nftablesMissingNames,
                        t("common.listSeparator"),
                      ),
                    })}
                  </span>
                </div>
              ) : null}
            </div>
          </FormField>

          {/* tunnel 引擎才有隧道加密模式；其它引擎整项不渲染，也不占位。 */}
          {tunnelSelected ? (
            <FormField label={t("chains.tunnelSecurity.label")}>
              <RadioGroup
                aria-label={t("chains.tunnelSecurity.label")}
                value={selectedTunnelSecurity}
                onValueChange={(next) => {
                  if (next !== "tls" && next !== "noise") return;
                  form.setValue("tunnel_security", next, {
                    shouldDirty: true,
                    shouldTouch: true,
                    shouldValidate: form.formState.isSubmitted,
                  });
                }}
                disabled={pending}
                className="grid gap-2"
              >
                {TUNNEL_SECURITY_MODES.map((mode) => {
                  const active = selectedTunnelSecurity === mode;
                  return (
                    <Label
                      key={mode}
                      htmlFor={`chain-tunnel-security-${mode}`}
                      data-tunnel-security-option={mode}
                      data-active={active}
                      className={cn(
                        "flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-card p-2.5 transition-colors duration-150 hover:bg-muted/40",
                        active &&
                          "border-primary/60 bg-primary/5 hover:bg-primary/5",
                        pending && "cursor-not-allowed opacity-60",
                      )}
                    >
                      <RadioGroupItem
                        id={`chain-tunnel-security-${mode}`}
                        value={mode}
                        disabled={pending}
                        className="mt-0.5"
                      />
                      <span className="min-w-0 space-y-0.5">
                        <span className="block text-sm font-medium">
                          {t(securityLabelKey(mode))}
                        </span>
                        <span className="block type-micro leading-normal text-muted-foreground">
                          {t(`chains.tunnelSecurity.${mode}.desc`)}
                        </span>
                      </span>
                    </Label>
                  );
                })}
              </RadioGroup>
            </FormField>
          ) : null}

          <FormField label={t("chains.tls.label")} htmlFor="chain-tls">
            <Controller
              control={form.control}
              name="transport"
              render={({ field }) => (
                <span
                  className="inline-flex items-center"
                  title={canTls ? undefined : tlsDisabledTitle}
                >
                  <Switch
                    id="chain-tls"
                    checked={field.value === "tls"}
                    onCheckedChange={(checked) => {
                      form.setValue("transport", checked ? "tls" : "none", {
                        shouldDirty: true,
                        shouldTouch: true,
                        shouldValidate: form.formState.isSubmitted,
                      });
                      // 加密链只走 TCP：开启加密时把仅 UDP / both 收回 tcp。
                      if (checked && form.getValues("protocol") !== "tcp") {
                        form.setValue("protocol", DEFAULT_PROTOCOL, {
                          shouldDirty: true,
                          shouldTouch: true,
                          shouldValidate: form.formState.isSubmitted,
                        });
                      }
                    }}
                    disabled={pending || !canTls}
                  />
                </span>
              )}
            />
          </FormField>

          <FormField
            label={t("common.protocolMode.label")}
            error={form.formState.errors.protocol?.message}
          >
            <RadioGroup
              aria-label={t("common.protocolMode.label")}
              value={selectedProtocol}
              onValueChange={(next) => {
                if (!availability[next as keyof typeof availability]) return;
                form.setValue("protocol", next as typeof selectedProtocol, {
                  shouldDirty: true,
                  shouldTouch: true,
                  shouldValidate: form.formState.isSubmitted,
                });
              }}
              disabled={pending}
              className="grid gap-2 sm:grid-cols-3"
            >
              {PROTOCOL_MODES.map((mode) => {
                const active = selectedProtocol === mode;
                const disabled = pending || !availability[mode];
                return (
                  <Label
                    key={mode}
                    htmlFor={`chain-protocol-${mode}`}
                    title={
                      availability[mode]
                        ? undefined
                        : tunnelSelected
                          ? t("chains.tunnel.protocolTitle")
                          : tlsEnabled
                            ? t("chains.tls.udpDisabledTitle")
                            : t("common.udpRealmTitle")
                    }
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-2 transition-colors duration-150 hover:bg-muted/40",
                      active &&
                        "border-primary/60 bg-primary/5 hover:bg-primary/5",
                      disabled && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <RadioGroupItem
                      id={`chain-protocol-${mode}`}
                      value={mode}
                      disabled={disabled}
                    />
                    <span className="text-sm font-medium">
                      {t(`common.protocolMode.${mode}`)}
                    </span>
                  </Label>
                );
              })}
            </RadioGroup>
          </FormField>

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
            </div>

            <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              {/*
                分组是复合字段（组 + 成员），不是单个控件：
                组标题用普通文本 + 星号，必填语义落在每个成员的
                服务器 / 端口控件上（见下方 aria-required）。
              */}
              <span className="text-sm font-medium">
                {t("chains.form.groups")}
                <span aria-hidden="true" className="text-destructive">
                  *
                </span>
              </span>
              <span className="font-mono type-micro tabular-nums text-muted-foreground">
                {t("chains.form.groupLimit", {
                  count: fields.length,
                  max: CHAIN_MAX_GROUPS,
                })}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("chains.form.groupsHint")}
            </p>

            <div className="min-w-0 space-y-2">
              {fields.map((field, index) => (
                <GroupCard
                  key={field.id}
                  index={index}
                  groupCount={fields.length}
                  form={form}
                  pending={pending}
                  editing={isEdit}
                  servers={servers}
                  loadingServers={loadingServers}
                  tlsEnabled={tlsEnabled}
                  nftablesEngine={selectedEngine === "nftables"}
                  tunnelEngine={tunnelSelected}
                  certificates={certificates.data ?? []}
                  certsLoading={certificates.isPending}
                  certsError={certificates.isError}
                  expanded={activeGroup === index}
                  onToggle={() =>
                    setActiveGroup((current) =>
                      current === index ? null : index,
                    )
                  }
                  onMoveGroup={handleMoveGroup}
                  onRemoveGroup={handleRemoveGroup}
                />
              ))}
            </div>

            {groupsRootError ? (
              <p role="alert" className="text-xs text-destructive">
                {groupsRootError}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleAddGroup}
                disabled={pending || fields.length >= CHAIN_MAX_GROUPS}
              >
                <PlusIcon className="size-3.5" />
                {t("chains.form.addGroup")}
              </Button>
              {servers.length === 0 && !loadingServers ? (
                <span className="type-micro text-muted-foreground">
                  {t("chains.form.noServers")}
                </span>
              ) : null}
            </div>
            </div>
          </div>

          {form.formState.errors.root?.message ? (
            <div className="px-4 pb-4 sm:px-6 sm:pb-6">
              <FormRootError message={form.formState.errors.root?.message} />
            </div>
          ) : null}
        </form>

        <DialogFooter className="mx-0 mb-0 rounded-none border-border px-4 py-3 sm:px-6">
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
