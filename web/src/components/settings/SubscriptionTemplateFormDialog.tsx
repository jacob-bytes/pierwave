import { useEffect, useRef, useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  GripVerticalIcon,
  Loader2Icon,
  PlusIcon,
  Trash2Icon,
  WorkflowIcon,
} from "lucide-react";
import { toast } from "sonner";
import { FormField, FormRootError } from "@/components/FormField";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  CreateSubscriptionTemplateInput,
  SubscriptionLoadBalanceStrategy,
  SubscriptionTemplate,
} from "@/lib/api";
import { errorText } from "@/lib/errors";
import {
  useCreateSubscriptionTemplate,
  useUpdateSubscriptionTemplate,
} from "@/lib/queries";
import {
  DEFAULT_LOAD_BALANCE_STRATEGY,
  LOAD_BALANCE_STRATEGIES,
  TEMPLATE_GROUP_KINDS,
  TEMPLATE_PROTOCOLS,
  draftFromTemplate,
  emptyFilterDraft,
  emptyGroupDraft,
  emptyTemplateDraft,
  groupsFromDraft,
  isAutoGroupKind,
  moveGroup,
  validateTemplateDraft,
  type DraftError,
  type FilterDraft,
  type GroupDraft,
  type TemplateDraft,
  type TemplateProtocol,
} from "@/lib/subscriptionTemplates";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

interface SubscriptionTemplateFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template?: SubscriptionTemplate;
  /** 复制模板时传入预填草稿；`template` 为空 → 走新建流程。 */
  initialDraft?: TemplateDraft;
}

/** 第一条校验错误 → 双语文案；参数直接透传给 i18n。 */
function draftErrorText(error: DraftError): string {
  return t(
    `subscriptionTemplates.form.errors.${error.code}`,
    error.params ?? {},
  );
}

function FilterEditor({
  filter,
  groupIndex,
  filterIndex,
  disabled,
  onChange,
  onRemove,
  canRemove,
}: {
  filter: FilterDraft;
  groupIndex: number;
  filterIndex: number;
  disabled: boolean;
  onChange: (next: FilterDraft) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const fieldId = (name: string) =>
    `group-${groupIndex}-filter-${filterIndex}-${name}`;
  const protocolId = (protocol: TemplateProtocol, exclude: boolean) =>
    `${fieldId(exclude ? "exclude" : "include")}-${protocol}`;

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <div className="flex items-start justify-between gap-2">
        <span className="type-micro text-muted-foreground">
          {t("subscriptionTemplates.form.filters")} {filterIndex + 1}
        </span>
        {canRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground"
            onClick={onRemove}
            disabled={disabled}
          >
            <Trash2Icon className="size-3" />
            {t("subscriptionTemplates.form.removeFilter")}
          </Button>
        ) : null}
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <FormField
          label={t("subscriptionTemplates.form.tags")}
          htmlFor={fieldId("tags")}
        >
          <Input
            id={fieldId("tags")}
            placeholder={t("subscriptionTemplates.form.tagsPlaceholder")}
            autoComplete="off"
            disabled={disabled}
            value={filter.tags}
            onChange={(event) => onChange({ ...filter, tags: event.target.value })}
          />
        </FormField>
        <FormField
          label={t("subscriptionTemplates.form.regions")}
          htmlFor={fieldId("regions")}
        >
          <Input
            id={fieldId("regions")}
            placeholder={t("subscriptionTemplates.form.regionsPlaceholder")}
            autoComplete="off"
            disabled={disabled}
            value={filter.regions}
            onChange={(event) =>
              onChange({ ...filter, regions: event.target.value })
            }
          />
        </FormField>
        <FormField
          label={t("subscriptionTemplates.form.nameContains")}
          htmlFor={fieldId("name-contains")}
        >
          <Input
            id={fieldId("name-contains")}
            placeholder={t("subscriptionTemplates.form.nameContainsPlaceholder")}
            autoComplete="off"
            disabled={disabled}
            value={filter.nameContains}
            onChange={(event) =>
              onChange({ ...filter, nameContains: event.target.value })
            }
          />
        </FormField>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-4">
        {TEMPLATE_PROTOCOLS.map((protocol) => (
          <label
            key={protocol}
            htmlFor={protocolId(protocol, false)}
            className="flex cursor-pointer items-center gap-1.5 font-mono text-xs text-muted-foreground"
          >
            <Checkbox
              id={protocolId(protocol, false)}
              checked={filter.protocols.includes(protocol)}
              disabled={disabled}
              onCheckedChange={(checked) =>
                onChange({
                  ...filter,
                  protocols: checked
                    ? [...filter.protocols, protocol]
                    : filter.protocols.filter((item) => item !== protocol),
                })
              }
            />
            {protocol}
          </label>
        ))}
      </div>

      <div className="mt-2 space-y-2 border-t border-border/60 pt-2">
        <p className="type-micro text-muted-foreground">
          {t("subscriptionTemplates.form.excludeConditions")}
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <FormField
            label={t("subscriptionTemplates.form.excludeTags")}
            htmlFor={fieldId("exclude-tags")}
          >
            <Input
              id={fieldId("exclude-tags")}
              placeholder={t("subscriptionTemplates.form.excludeTagsPlaceholder")}
              autoComplete="off"
              disabled={disabled}
              value={filter.excludeTags}
              onChange={(event) =>
                onChange({ ...filter, excludeTags: event.target.value })
              }
            />
          </FormField>
          <FormField
            label={t("subscriptionTemplates.form.excludeRegions")}
            htmlFor={fieldId("exclude-regions")}
          >
            <Input
              id={fieldId("exclude-regions")}
              placeholder={t(
                "subscriptionTemplates.form.excludeRegionsPlaceholder",
              )}
              autoComplete="off"
              disabled={disabled}
              value={filter.excludeRegions}
              onChange={(event) =>
                onChange({ ...filter, excludeRegions: event.target.value })
              }
            />
          </FormField>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          {TEMPLATE_PROTOCOLS.map((protocol) => (
            <label
              key={protocol}
              htmlFor={protocolId(protocol, true)}
              className="flex cursor-pointer items-center gap-1.5 font-mono text-xs text-muted-foreground"
            >
              <Checkbox
                id={protocolId(protocol, true)}
                checked={filter.excludeProtocols.includes(protocol)}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  onChange({
                    ...filter,
                    excludeProtocols: checked
                      ? [...filter.excludeProtocols, protocol]
                      : filter.excludeProtocols.filter(
                          (item) => item !== protocol,
                        ),
                  })
                }
              />
              {protocol}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

function GroupEditor({
  group,
  index,
  total,
  disabled,
  dragging,
  dragOver,
  onChange,
  onRemove,
  onMove,
  onDragStart,
  canRemove,
}: {
  group: GroupDraft;
  index: number;
  total: number;
  disabled: boolean;
  dragging: boolean;
  dragOver: boolean;
  onChange: (next: GroupDraft) => void;
  onRemove: () => void;
  onMove: (from: number, to: number) => void;
  onDragStart: (index: number) => void;
  canRemove: boolean;
}) {
  const groupLabel = group.name.trim() || t("subscriptionTemplates.form.groupName");

  function updateFilter(filterIndex: number, next: FilterDraft) {
    onChange({
      ...group,
      filters: group.filters.map((filter, itemIndex) =>
        itemIndex === filterIndex ? next : filter,
      ),
    });
  }

  return (
    <div
      data-testid="subscription-template-group"
      data-index={index}
      className={cn(
        "space-y-3 rounded-xl border border-border p-3 transition-shadow",
        dragOver && "ring-2 ring-primary/40",
        dragging && "opacity-60",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            data-testid="subscription-template-group-drag-handle"
            onPointerDown={(event) => {
              if (disabled) return;
              event.preventDefault();
              onDragStart(index);
            }}
            className={cn(
              "touch-none cursor-grab rounded p-0.5 text-muted-foreground/60 hover:text-foreground active:cursor-grabbing",
              disabled && "cursor-not-allowed opacity-50",
            )}
            aria-label={t("subscriptionTemplates.form.dragAria", { name: groupLabel })}
            title={t("subscriptionTemplates.form.dragAria", { name: groupLabel })}
          >
            <GripVerticalIcon className="size-4" />
          </span>
          <span className="truncate text-sm font-medium">{groupLabel}</span>
          <span className="type-micro text-muted-foreground">
            {index + 1}/{total}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t("subscriptionTemplates.form.moveUpAria", {
              name: groupLabel,
            })}
            title={t("subscriptionTemplates.form.moveUpAria", {
              name: groupLabel,
            })}
            disabled={disabled || index === 0}
            onClick={() => onMove(index, index - 1)}
          >
            <ArrowUpIcon className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t("subscriptionTemplates.form.moveDownAria", {
              name: groupLabel,
            })}
            title={t("subscriptionTemplates.form.moveDownAria", {
              name: groupLabel,
            })}
            disabled={disabled || index === total - 1}
            onClick={() => onMove(index, index + 1)}
          >
            <ArrowDownIcon className="size-3.5" />
          </Button>
          {canRemove ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={onRemove}
              disabled={disabled}
            >
              <Trash2Icon className="size-3.5" />
              {t("subscriptionTemplates.form.removeGroup")}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          label={t("subscriptionTemplates.form.groupName")}
          htmlFor={`group-${index}-name`}
          required
        >
          <Input
            id={`group-${index}-name`}
            placeholder={t("subscriptionTemplates.form.groupNamePlaceholder")}
            autoComplete="off"
            disabled={disabled}
            value={group.name}
            onChange={(event) => onChange({ ...group, name: event.target.value })}
          />
        </FormField>
        <FormField
          label={t("subscriptionTemplates.form.typeLabel")}
          htmlFor={`group-${index}-type`}
        >
          <Select
            value={group.type}
            disabled={disabled}
            onValueChange={(value) => {
              const next = (
                TEMPLATE_GROUP_KINDS as readonly string[]
              ).includes(value)
                ? (value as GroupDraft["type"])
                : "select";
              onChange({
                ...group,
                type: next,
                includeAuto: next === "select" ? group.includeAuto : false,
              });
            }}
          >
            <SelectTrigger id={`group-${index}-type`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TEMPLATE_GROUP_KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {t(`subscriptionTemplates.form.type.${kind}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      </div>

      {isAutoGroupKind(group.type) ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField
            label={t("subscriptionTemplates.form.interval")}
            htmlFor={`group-${index}-interval`}
            required
          >
            <Input
              id={`group-${index}-interval`}
              inputMode="numeric"
              placeholder={t("subscriptionTemplates.form.intervalPlaceholder")}
              disabled={disabled}
              value={group.interval}
              onChange={(event) =>
                onChange({ ...group, interval: event.target.value })
              }
            />
          </FormField>
          {group.type === "load-balance" ? (
            <FormField
              label={t("subscriptionTemplates.form.strategyLabel")}
              htmlFor={`group-${index}-strategy`}
            >
              <Select
                value={group.strategy}
                disabled={disabled}
                onValueChange={(value) =>
                  onChange({
                    ...group,
                    strategy: (
                      LOAD_BALANCE_STRATEGIES as readonly string[]
                    ).includes(value)
                      ? (value as SubscriptionLoadBalanceStrategy)
                      : DEFAULT_LOAD_BALANCE_STRATEGY,
                  })
                }
              >
                <SelectTrigger id={`group-${index}-strategy`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOAD_BALANCE_STRATEGIES.map((strategy) => (
                    <SelectItem key={strategy} value={strategy}>
                      {t(`subscriptionTemplates.form.strategy.${strategy}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          ) : null}
        </div>
      ) : (
        <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-muted/20 px-3 py-2.5">
          <div className="space-y-1">
            <Label htmlFor={`group-${index}-include-auto`}>
              {t("subscriptionTemplates.form.includeAuto")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("subscriptionTemplates.form.includeAutoHint")}
            </p>
          </div>
          <Switch
            id={`group-${index}-include-auto`}
            checked={group.includeAuto}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onChange({ ...group, includeAuto: checked })
            }
            className="mt-0.5"
          />
        </div>
      )}

      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          {t("subscriptionTemplates.form.filterHint")}
        </p>
        {group.filters.map((filter, filterIndex) => (
          <FilterEditor
            key={filterIndex}
            filter={filter}
            groupIndex={index}
            filterIndex={filterIndex}
            disabled={disabled}
            canRemove
            onChange={(next) => updateFilter(filterIndex, next)}
            onRemove={() =>
              onChange({
                ...group,
                filters: group.filters.filter(
                  (_, itemIndex) => itemIndex !== filterIndex,
                ),
              })
            }
          />
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() =>
            onChange({ ...group, filters: [...group.filters, emptyFilterDraft()] })
          }
        >
          <PlusIcon className="size-3.5" />
          {t("subscriptionTemplates.form.addFilter")}
        </Button>
      </div>
    </div>
  );
}

/** 设置页的订阅模板编辑器：表单，没有代码编辑器。 */
export function SubscriptionTemplateFormDialog({
  open,
  onOpenChange,
  template,
  initialDraft,
}: SubscriptionTemplateFormDialogProps) {
  useI18n();
  const createTemplate = useCreateSubscriptionTemplate();
  const updateTemplate = useUpdateSubscriptionTemplate();
  const editing = Boolean(template);
  const pending = editing ? updateTemplate.isPending : createTemplate.isPending;
  const freshDraft = () =>
    template
      ? draftFromTemplate(template)
      : initialDraft
        ? structuredCloneDraft(initialDraft)
        : emptyTemplateDraft();
  const [draft, setDraft] = useState<TemplateDraft>(freshDraft);
  const [error, setError] = useState<string | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragRef = useRef<{ from: number | null; over: number | null }>({
    from: null,
    over: null,
  });

  useEffect(() => {
    if (draggingIndex === null) return;
    function handlePointerMove(event: PointerEvent) {
      const element = document.elementFromPoint(event.clientX, event.clientY);
      const card = element?.closest<HTMLElement>(
        '[data-testid="subscription-template-group"]',
      );
      if (!card) return;
      const target = Number(card.dataset.index);
      if (!Number.isInteger(target)) return;
      dragRef.current.over = target;
      setDragOverIndex(target);
    }
    function finish() {
      const { from, over } = dragRef.current;
      if (from !== null && over !== null && from !== over) {
        move(from, over);
      }
      dragRef.current = { from: null, over: null };
      setDraggingIndex(null);
      setDragOverIndex(null);
    }
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [draggingIndex]);

  function close(next: boolean) {
    if (!next && pending) return;
    if (!next) {
      setError(null);
      setDraft(freshDraft());
      setDraggingIndex(null);
      setDragOverIndex(null);
      dragRef.current = { from: null, over: null };
    }
    onOpenChange(next);
  }

  function move(from: number, to: number) {
    setDraft((current) => ({
      ...current,
      groups: moveGroup(current.groups, from, to),
    }));
  }

  async function submit() {
    setError(null);
    const errors = validateTemplateDraft(draft);
    if (errors.length > 0) {
      const message = draftErrorText(errors[0]);
      setError(message);
      toast.error(message);
      return;
    }
    const input: CreateSubscriptionTemplateInput = {
      name: draft.name.trim(),
      groups: groupsFromDraft(draft.groups),
    };
    try {
      if (template) {
        await updateTemplate.mutateAsync({ id: template.id, input });
        toast.success(t("subscriptionTemplates.form.updated"));
      } else {
        await createTemplate.mutateAsync(input);
        toast.success(
          t("subscriptionTemplates.form.created", { name: input.name }),
        );
      }
      onOpenChange(false);
    } catch (caught) {
      const message = errorText(
        caught,
        t("subscriptionTemplates.form.error"),
      );
      setError(message);
      toast.error(message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <WorkflowIcon className="size-4 text-primary" />
            {editing
              ? t("subscriptionTemplates.form.editTitle")
              : t("subscriptionTemplates.form.createTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("subscriptionTemplates.form.desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <FormField
            label={t("subscriptionTemplates.form.name")}
            htmlFor="subscription-template-name"
            required
          >
            <Input
              id="subscription-template-name"
              placeholder={t("subscriptionTemplates.form.namePlaceholder")}
              autoComplete="off"
              disabled={pending}
              value={draft.name}
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
            />
          </FormField>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>{t("subscriptionTemplates.form.groups")}</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() =>
                  setDraft({
                    ...draft,
                    groups: [...draft.groups, emptyGroupDraft()],
                  })
                }
              >
                <PlusIcon className="size-3.5" />
                {t("subscriptionTemplates.form.addGroup")}
              </Button>
            </div>
            {draft.groups.map((group, index) => (
              <GroupEditor
                key={index}
                group={group}
                index={index}
                total={draft.groups.length}
                disabled={pending}
                dragging={draggingIndex === index}
                dragOver={dragOverIndex === index && draggingIndex !== index}
                canRemove={draft.groups.length > 1}
                onMove={move}
                onDragStart={(from) => {
                  dragRef.current = { from, over: from };
                  setDraggingIndex(from);
                  setDragOverIndex(from);
                }}
                onChange={(next) =>
                  setDraft({
                    ...draft,
                    groups: draft.groups.map((item, itemIndex) =>
                      itemIndex === index ? next : item,
                    ),
                  })
                }
                onRemove={() =>
                  setDraft({
                    ...draft,
                    groups: draft.groups.filter(
                      (_, itemIndex) => itemIndex !== index,
                    ),
                  })
                }
              />
            ))}
          </div>

          <FormRootError message={error ?? undefined} />
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => close(false)}
            disabled={pending}
          >
            {t("common.cancel")}
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={pending}>
            {pending ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <PlusIcon className="size-4" />
            )}
            {editing
              ? t("subscriptionTemplates.form.submitSave")
              : t("subscriptionTemplates.form.submitCreate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 初始草稿深拷贝：复制模板后编辑表单不能改动列表里的原对象。 */
function structuredCloneDraft(draft: TemplateDraft): TemplateDraft {
  return {
    name: draft.name,
    groups: draft.groups.map((group) => ({
      ...group,
      filters: group.filters.map((filter) => ({
        ...filter,
        protocols: [...filter.protocols],
        excludeProtocols: [...filter.excludeProtocols],
      })),
    })),
  };
}
