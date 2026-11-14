import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ServerInterface } from "@/lib/api";
import { nicLabel, nicOptions } from "@/lib/nic";
import type { NicState } from "@/lib/nic";
import { useI18n } from "@/i18n";

/** Radix Select 不允许空字符串值，「不限制」用哨兵值映射回 null。 */
const NONE_VALUE = "__none__";

interface NicFieldProps {
  id: string;
  /** 已选网卡；null = 不限制。 */
  value: string | null;
  /** 服务器上报的网卡列表；缺失表示从未上报。 */
  interfaces: readonly ServerInterface[] | null | undefined;
  /** 由 `nicState(server)` 派生；create 表单传 `unverified`。 */
  state: NicState;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}

/**
 * 服务器创建 / 编辑共用的「网卡（可选）」下拉。
 *
 * 选项只来自服务器上报的列表；未上报或列表为空时整体禁用，
 * 并在下方用一行灰色说明告诉用户为什么现在不能选。
 */
export function NicField({
  id,
  value,
  interfaces,
  state,
  onChange,
  disabled = false,
}: NicFieldProps) {
  const { t } = useI18n();

  const options = nicOptions(interfaces);
  const selected = nicLabel(value);
  // 已选网卡可能因服务器重装等原因不在最新列表里：仍要把它渲染成一项，
  // 否则 Radix Select 会显示空白，用户也看不到自己保存的值。
  const items =
    selected !== null && !options.some((option) => option.name === selected)
      ? [...options, { name: selected, label: selected, addresses: [] }]
      : options;

  const locked = state === "unverified" || state === "empty";
  const hint =
    state === "unverified"
      ? t("servers.nic.unverifiedHint")
      : state === "empty"
        ? t("servers.nic.emptyHint")
        : null;
  const hintId = `${id}-hint`;
  const title =
    state === "unverified" && selected !== null
      ? t("servers.nic.unverifiedTitle")
      : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-sm">
        {t("servers.nic.label")}
      </Label>
      <Select
        value={selected ?? NONE_VALUE}
        onValueChange={(next) => onChange(next === NONE_VALUE ? null : next)}
        disabled={disabled || locked}
      >
        <SelectTrigger
          id={id}
          className="w-full"
          title={title}
          aria-describedby={hint ? hintId : undefined}
        >
          <SelectValue placeholder={t("servers.nic.unlimited")} />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value={NONE_VALUE}>
            {t("servers.nic.unlimited")}
          </SelectItem>
          {items.map((option) => (
            <SelectItem key={option.name} value={option.name}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hint ? (
        <p
          id={hintId}
          className="text-xs leading-relaxed text-muted-foreground"
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}
