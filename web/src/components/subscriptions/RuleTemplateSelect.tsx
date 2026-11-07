import { ListFilterIcon, TriangleAlertIcon } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { RuleTemplate } from "@/lib/api";
import { t } from "@/i18n";

/** 「跟随绑定」的哨兵值：Radix Select 不接受空字符串作为 item value。 */
export const FOLLOW_BINDING = "__follow__";

interface RuleTemplateSelectProps {
  templates: RuleTemplate[];
  selected: RuleTemplate | null;
  /** 该用户实际生效的模板名（来自后端解析），用于「跟随」选项的文案。 */
  effectiveName: string | null;
  pending: boolean;
  /** 已本地化的加载错误；为空表示列表可用。 */
  error: string | null;
  username: string;
  onSelect: (id: string) => void;
}

/**
 * 订阅行内的规则模板下拉。只影响当前页面的链接拼接，不写回后端。
 *
 * 宽度固定，选项放在 Portal 里，不会把表格撑破；列表未就绪时保持禁用，
 * 链接回落到默认模板（不带 `?rule=`）。
 */
export function RuleTemplateSelect({
  templates,
  selected,
  effectiveName,
  pending,
  error,
  username,
  onSelect,
}: RuleTemplateSelectProps) {
  const disabled = pending || templates.length === 0;
  const placeholder = pending
    ? t("subscriptions.ruleTemplateLoading")
    : error
      ? t("subscriptions.ruleTemplateUnavailable")
      : templates.length === 0
        ? t("rules.emptyTitle")
        : t("subscriptions.ruleTemplate");

  const title = pending
    ? t("subscriptions.ruleTemplateLoading")
    : error
      ? error
      : selected?.description.trim()
        ? selected.description
        : selected?.name || t("subscriptions.ruleTemplateTitle");

  return (
    <div className="flex min-w-0 items-center gap-1">
      <Select
        value={selected?.id ?? FOLLOW_BINDING}
        onValueChange={(value) =>
          onSelect(value === FOLLOW_BINDING ? "" : value)
        }
        disabled={disabled}
      >
        <SelectTrigger
          size="sm"
          className="h-7 w-[164px] text-xs"
          aria-label={t("subscriptions.ruleTemplateAria", { username })}
          title={title}
        >
          <ListFilterIcon className="size-3.5 text-muted-foreground" />
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent align="start" className="max-w-[320px]">
          <SelectGroup>
            {/* 默认就是「跟随」：用它自己的绑定，链接不带 ?rule=，避免静默覆盖 */}
            <SelectItem value={FOLLOW_BINDING} title={t("subscriptions.ruleTemplateFollowHint")}>
              <span className="truncate">
                {t("subscriptions.ruleTemplateFollowShort", {
                  name: effectiveName || t("subscriptions.ruleTemplateDefault"),
                })}
              </span>
            </SelectItem>
            {templates.map((item) => (
              <SelectItem
                key={item.id}
                value={item.id}
                title={item.description.trim() || item.name}
              >
                <span className="truncate">{item.name}</span>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {error && templates.length === 0 ? (
        <TriangleAlertIcon
          className="size-3.5 shrink-0 text-destructive"
          aria-label={error}
        />
      ) : null}
    </div>
  );
}
