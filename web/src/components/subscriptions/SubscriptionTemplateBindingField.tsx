import { TriangleAlertIcon } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SubscriptionTemplate } from "@/lib/api";
import {
  SUBSCRIPTION_TEMPLATE_INHERIT,
  subscriptionTemplateFromSelectValue,
  subscriptionTemplateToSelectValue,
} from "@/lib/subscriptionTemplates";

interface SubscriptionTemplateBindingFieldProps {
  id: string;
  /** 表单值：空串 = 不绑定。 */
  value: string;
  onChange: (value: string) => void;
  templates: SubscriptionTemplate[];
  pending: boolean;
  /** 已本地化的加载错误；为空表示列表可用。 */
  error: string | null;
  disabled?: boolean;
  inheritLabel: string;
  loadingLabel: string;
  currentLabel: string;
  ariaLabel: string;
}

/**
 * 用户 / 套餐表单里的订阅模板下拉。
 *
 * 与规则模板的绑定字段同构：空值 = 不绑定（用户跟随套餐、套餐跟随内置分组），
 * 提交时由调用方把空串转成显式 `null`，避免「不选」与「不改」混淆。
 */
export function SubscriptionTemplateBindingField({
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
}: SubscriptionTemplateBindingFieldProps) {
  const currentMissing =
    value !== "" && !templates.some((item) => item.id === value);
  const unavailable = Boolean(error) && templates.length === 0;

  return (
    <div className="space-y-2">
      <Select
        value={subscriptionTemplateToSelectValue(value)}
        onValueChange={(next) =>
          onChange(subscriptionTemplateFromSelectValue(next))
        }
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
        <SelectContent position="popper" align="start">
          <SelectItem value={SUBSCRIPTION_TEMPLATE_INHERIT}>
            {inheritLabel}
          </SelectItem>
          {currentMissing ? (
            <SelectItem value={value} title={value}>
              {currentLabel}
            </SelectItem>
          ) : null}
          {templates.map((item) => (
            <SelectItem key={item.id} value={item.id} title={item.name}>
              <span className="truncate">{item.name}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error ? (
        <p className="flex items-start gap-1.5 type-micro text-muted-foreground">
          <TriangleAlertIcon className="mt-0.5 size-3 shrink-0 text-destructive" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
