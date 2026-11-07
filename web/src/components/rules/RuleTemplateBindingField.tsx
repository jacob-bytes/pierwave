import { TriangleAlertIcon } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { RuleTemplate } from "@/lib/api";
import {
  RULE_TEMPLATE_INHERIT,
  ruleTemplateFromSelectValue,
  ruleTemplateToSelectValue,
} from "@/lib/ruleBindings";

interface RuleTemplateBindingFieldProps {
  id: string;
  /** 表单值：模板 id；空串表示「跟随套餐 / 全局默认」。 */
  value: string;
  onChange: (value: string) => void;
  templates: RuleTemplate[];
  /** 列表加载中：暂时禁用，避免用户选到尚未加载的模板。 */
  pending: boolean;
  /** 已本地化的加载错误；为空表示列表可用。 */
  error: string | null;
  disabled?: boolean;
  inheritLabel: string;
  loadingLabel: string;
  /** 已绑定但不在当前列表里的模板（例如分页或加载失败）的兜底标签。 */
  currentLabel: string;
  ariaLabel: string;
}

/**
 * P6：用户 / 套餐对话框共用的「规则模板」下拉。
 *
 * 空串表示不绑定，提交时会被转成显式的 `null`（见 `ruleTemplateInputValue`），
 * 因此「清空绑定」和「不改绑定」不会混淆。
 * 已绑定但列表里找不到的模板会补一个兜底选项，避免保存时把绑定意外清空。
 */
export function RuleTemplateBindingField({
  id,
  value,
  onChange,
  templates,
  pending,
  error,
  disabled,
  inheritLabel,
  loadingLabel,
  currentLabel,
  ariaLabel,
}: RuleTemplateBindingFieldProps) {
  const currentMissing =
    value !== "" && !templates.some((item) => item.id === value);
  const unavailable = Boolean(error) && templates.length === 0;

  return (
    <div className="space-y-2">
      <Select
        value={ruleTemplateToSelectValue(value)}
        onValueChange={(next) => onChange(ruleTemplateFromSelectValue(next))}
        disabled={disabled || pending}
      >
        <SelectTrigger
          id={id}
          className="w-full"
          aria-label={ariaLabel}
          aria-invalid={unavailable}
        >
          <SelectValue placeholder={pending ? loadingLabel : inheritLabel} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={RULE_TEMPLATE_INHERIT}>
            {inheritLabel}
          </SelectItem>
          {currentMissing ? (
            <SelectItem value={value} title={value}>
              {currentLabel}
            </SelectItem>
          ) : null}
          {templates.map((item) => (
            <SelectItem
              key={item.id}
              value={item.id}
              title={item.description.trim() || item.name}
            >
              <span className="truncate">{item.name}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error ? (
        <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <TriangleAlertIcon className="mt-0.5 size-3 shrink-0 text-destructive" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
