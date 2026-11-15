import { useState } from "react";
import {
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
  SubscriptionTemplate,
} from "@/lib/api";
import { errorText } from "@/lib/errors";
import {
  useCreateSubscriptionTemplate,
  useUpdateSubscriptionTemplate,
} from "@/lib/queries";
import {
  TEMPLATE_PROTOCOLS,
  draftFromTemplate,
  emptyFilterDraft,
  emptyGroupDraft,
  emptyTemplateDraft,
  groupsFromDraft,
  validateTemplateDraft,
  type DraftError,
  type FilterDraft,
  type GroupDraft,
  type TemplateDraft,
  type TemplateProtocol,
} from "@/lib/subscriptionTemplates";
import { t, useI18n } from "@/i18n";

interface SubscriptionTemplateFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template?: SubscriptionTemplate;
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
  const protocolId = (protocol: TemplateProtocol) =>
    `group-${groupIndex}-filter-${filterIndex}-${protocol}`;

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
          htmlFor={`group-${groupIndex}-filter-${filterIndex}-tags`}
        >
          <Input
            id={`group-${groupIndex}-filter-${filterIndex}-tags`}
            placeholder={t("subscriptionTemplates.form.tagsPlaceholder")}
            autoComplete="off"
            disabled={disabled}
            value={filter.tags}
            onChange={(event) => onChange({ ...filter, tags: event.target.value })}
          />
        </FormField>
        <FormField
          label={t("subscriptionTemplates.form.regions")}
          htmlFor={`group-${groupIndex}-filter-${filterIndex}-regions`}
        >
          <Input
            id={`group-${groupIndex}-filter-${filterIndex}-regions`}
            placeholder={t("subscriptionTemplates.form.regionsPlaceholder")}
            autoComplete="off"
            disabled={disabled}
            value={filter.regions}
            onChange={(event) =>
              onChange({ ...filter, regions: event.target.value })
            }
          />
        </FormField>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-4">
        {TEMPLATE_PROTOCOLS.map((protocol) => (
          <label
            key={protocol}
            htmlFor={protocolId(protocol)}
            className="flex cursor-pointer items-center gap-1.5 font-mono text-xs text-muted-foreground"
          >
            <Checkbox
              id={protocolId(protocol)}
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
    </div>
  );
}

function GroupEditor({
  group,
  index,
  disabled,
  onChange,
  onRemove,
  canRemove,
}: {
  group: GroupDraft;
  index: number;
  disabled: boolean;
  onChange: (next: GroupDraft) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  function updateFilter(filterIndex: number, next: FilterDraft) {
    onChange({
      ...group,
      filters: group.filters.map((filter, itemIndex) =>
        itemIndex === filterIndex ? next : filter,
      ),
    });
  }

  return (
    <div className="space-y-3 rounded-xl border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <GripVerticalIcon className="size-4 shrink-0 text-muted-foreground/60" />
          <span className="truncate text-sm font-medium">
            {group.name.trim() || t("subscriptionTemplates.form.groupName")}
          </span>
        </div>
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
          label={t("subscriptionTemplates.form.type")}
          htmlFor={`group-${index}-type`}
        >
          <Select
            value={group.type}
            disabled={disabled}
            onValueChange={(value) =>
              onChange({
                ...group,
                type: value === "url-test" ? "url-test" : "select",
              })
            }
          >
            <SelectTrigger id={`group-${index}-type`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="select">
                {t("subscriptionTemplates.form.typeSelect")}
              </SelectItem>
              <SelectItem value="url-test">
                {t("subscriptionTemplates.form.typeUrlTest")}
              </SelectItem>
            </SelectContent>
          </Select>
        </FormField>
      </div>

      {group.type === "url-test" ? (
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
}: SubscriptionTemplateFormDialogProps) {
  useI18n();
  const createTemplate = useCreateSubscriptionTemplate();
  const updateTemplate = useUpdateSubscriptionTemplate();
  const editing = Boolean(template);
  const pending = editing ? updateTemplate.isPending : createTemplate.isPending;
  const [draft, setDraft] = useState<TemplateDraft>(() =>
    template ? draftFromTemplate(template) : emptyTemplateDraft(),
  );
  const [error, setError] = useState<string | null>(null);

  function close(next: boolean) {
    if (!next && pending) return;
    if (!next) {
      setError(null);
      setDraft(template ? draftFromTemplate(template) : emptyTemplateDraft());
    }
    onOpenChange(next);
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
                disabled={pending}
                canRemove={draft.groups.length > 1}
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
