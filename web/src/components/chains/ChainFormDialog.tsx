import { useEffect, useMemo } from "react";
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
  InfoIcon,
  Loader2Icon,
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
import type { Chain, Server } from "@/lib/api";
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
  FORWARD_ENGINES,
  effectiveUdp,
  engineInput,
  formatServerNameList,
  isForwardEngine,
  missingRealmServerNames,
  normalizeEngine,
  serversMissingRealm,
} from "@/lib/engines";
import { errorText } from "@/lib/errors";
import { useCreateChain, useUpdateChain } from "@/lib/queries";
import { chainFormSchema, type ChainFormValues } from "@/lib/schemas";
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
  servers,
  loadingServers,
  onMoveGroup,
  onRemoveGroup,
}: {
  index: number;
  groupCount: number;
  form: UseFormReturn<ChainFormValues>;
  pending: boolean;
  servers: Server[];
  loadingServers: boolean;
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
  const isEntry = index === 0;
  const isLast = index === groupCount - 1;
  const seq = index + 1;

  const errorGroups = Array.isArray(formState.errors.groups)
    ? (formState.errors.groups as unknown as (GroupFieldErrors | undefined)[])
    : undefined;
  const groupErrors = errorGroups?.[index];
  const membersRootError = rootMessage(groupErrors?.members);
  const memberErrors = Array.isArray(groupErrors?.members)
    ? groupErrors.members
    : undefined;

  const strategyOptions = CHAIN_STRATEGIES.map((value) => ({
    value,
    label: t(`chains.strategy.${value}.label`),
    desc: t(`chains.strategy.${value}.desc`),
  }));

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
      className="space-y-3 rounded-lg border border-border bg-muted/20 p-3"
      aria-label={t("chains.form.group", { seq })}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-foreground">
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
            <span className="type-micro text-muted-foreground">
              {t("chains.form.groupExitHint")}
            </span>
          ) : null}
          {!single ? (
            <span className="font-mono type-micro tabular-nums text-muted-foreground">
              {t("chains.form.memberLimit", {
                count: fields.length,
                max: GROUP_MAX_MEMBERS,
              })}
            </span>
          ) : null}
        </div>
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
            disabled={pending}
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

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_7rem]">
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
  );
}

/**
 * 新建 / 编辑转发链的「组编辑器」。
 *
 * 一条链 = 1–4 组，每组 = 1–8 台成员；组内顺序决定 priority（主备 / 轮询）。
 * 前端只拦「组数 / 成员数 / 同组与跨组重复服务器 / 端口 1–65535 / 目标非空」；
 * 保留端口、与节点 / 独立转发 / 其它链成员的端口冲突、自连回环都依赖服务器
 * 数据，由后端返回带 code 的错误，这里通过 `errorText` 原样透出。
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

  const initialGroups = useMemo(() => {
    const groups = chain?.groups ?? [];
    if (groups.length === 0) return [emptyGroup()];

    return orderGroups(groups).map((group) => {
      const members = orderMembers(group.members);
      return {
        kind: groupKind(group),
        name: group.name ?? "",
        strategy: normalizeStrategy(group.strategy),
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
      // 旧数据 / 旧后端没有 udp：按契约缺省 false 回填。
      udp: Boolean(chain?.udp),
      groups: initialGroups,
    },
  });
  const selectedEngine = form.watch("engine");
  const realmEngine = selectedEngine === "realm";
  // 用 useWatch 订阅整组：成员是在子组件 GroupCard 里改的，
  // 顶层 `form.watch` 的引用可能不变，warning 会漏更新。
  const watchedGroups =
    useWatch({ control: form.control, name: "groups" }) ?? [];

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

  const { fields, append, remove, move } = useFieldArray({
    control: form.control,
    name: "groups",
  });

  // 切换语言后重新校验，让已经显示的错误跟着换语言。
  useEffect(() => {
    if (form.formState.isSubmitted) void form.trigger();
  }, [t, form]);

  const groupsRootError = rootMessage(form.formState.errors.groups);

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors("root");

    const input = {
      name: values.name.trim(),
      target_host: values.target_host.trim(),
      target_port: Number(values.target_port),
      enabled: values.enabled,
      // native 也显式发送：编辑时把 realm 改回 native，PATCH 必须带 engine。
      ...engineInput(values.engine),
      // 只对 native 有意义；realm 时展示层按开启处理，提交仍原样带值。
      udp: values.udp,
      groups: values.groups.map((group) => ({
        name:
          group.kind === "single"
            ? undefined
            : group.name.trim() || undefined,
        strategy:
          group.kind === "single"
            ? DEFAULT_CHAIN_STRATEGY
            : group.strategy,
        members: group.members.map((member, index) => ({
          server_id: member.server_id,
          listen_port: Number(member.listen_port),
          priority: index,
        })),
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

  function clearGroupErrors() {
    form.clearErrors("groups");
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-3xl">
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

        <form
          id="chain-form"
          className="min-w-0 space-y-4"
          onSubmit={onSubmit}
        >
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
                  if (!isForwardEngine(next)) return;
                  form.setValue("engine", next, {
                    shouldDirty: true,
                    shouldTouch: true,
                    shouldValidate: true,
                  });
                }}
                disabled={pending}
                className="grid gap-2 sm:grid-cols-2"
              >
                {FORWARD_ENGINES.map((engine) => {
                  const active = selectedEngine === engine;
                  return (
                    <Label
                      key={engine}
                      htmlFor={`chain-engine-${engine}`}
                      className={cn(
                        "flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-card p-2.5 transition-colors duration-150 hover:bg-muted/40",
                        active &&
                          "border-primary/60 bg-primary/5 hover:bg-primary/5",
                        pending && "cursor-not-allowed opacity-60",
                      )}
                    >
                      <RadioGroupItem
                        id={`chain-engine-${engine}`}
                        value={engine}
                        disabled={pending}
                        className="mt-0.5"
                      />
                      <span className="min-w-0 space-y-0.5">
                        <span className="block text-sm font-medium">
                          {t(`common.engine.${engine}.label`)}
                        </span>
                        <span className="block type-micro leading-normal text-muted-foreground">
                          {t(`common.engine.${engine}.short`)}
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
            </div>
          </FormField>

          <FormField label={t("chains.form.udp")} htmlFor="chain-udp">
            <Controller
              control={form.control}
              name="udp"
              render={({ field }) => (
                <span
                  className="inline-flex items-center"
                  title={realmEngine ? t("common.udpRealmTitle") : undefined}
                >
                  <Switch
                    id="chain-udp"
                    checked={effectiveUdp(selectedEngine, field.value)}
                    onCheckedChange={field.onChange}
                    disabled={pending || realmEngine}
                  />
                </span>
              )}
            />
          </FormField>

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
                  servers={servers}
                  loadingServers={loadingServers}
                  onMoveGroup={(from, offset) => {
                    move(from, from + offset);
                    clearGroupErrors();
                  }}
                  onRemoveGroup={(groupIndex) => {
                    remove(groupIndex);
                    clearGroupErrors();
                  }}
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
                onClick={() => {
                  append(emptyGroup());
                  clearGroupErrors();
                }}
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
