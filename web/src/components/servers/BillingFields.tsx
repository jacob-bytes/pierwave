import { useState } from "react";
import { GlobeIcon } from "lucide-react";
import { FormField } from "@/components/FormField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n } from "@/i18n";
import {
  BILLING_CURRENCIES,
  BILLING_NONE,
  CURRENCY_CUSTOM,
  CURRENCY_NONE,
  currencySelectValue,
  cycleCountForUnit,
  EMPTY_BILLING_FORM,
  hasAnyBillingField,
  isBillingCycleUnit,
  isPaidUntilInRange,
  PAID_UNTIL_MAX,
  PAID_UNTIL_MIN,
  sanitizeCurrencyInput,
  sanitizeCycleCountInput,
  type BillingFieldErrors,
  type ServerBillingForm,
} from "@/lib/serverBilling";

interface BillingFieldsProps {
  /** 同一页面可能同时存在新建与编辑弹窗，id 必须区分。 */
  idPrefix: string;
  value: ServerBillingForm;
  onChange: (next: ServerBillingForm) => void;
  /** 字段 → 已翻译的文案；由页面把前端校验 / 后端错误码映射进来。 */
  errors?: BillingFieldErrors;
  disabled?: boolean;
}

/**
 * 服务器「费用与到期」表单组（新建与编辑共用）。
 *
 * 字段都是可选的公开展示数据：填了会出现在公开探针页，因此只要有一个
 * 非空就显示一句「填写后会在公开状态页展示」。价格用「元」输入、提交转「分」；
 * 币种给出三个常用项 + 自定义（后端只要求 3 位大写字母）。
 *
 * 计费周期是「数量 + 单位」一行：数量 1–1200 的整数，单位 个月 / 年 / 一次性；
 * 选「一次性」时数量固定 1 并禁用。两者都留空 = 未填写（提交两个 null），
 * 只填一半会在行内报错。
 *
 * 错误只落在对应字段下方（`FormField` 的 error），不走全局 toast —— 用户能
 * 立刻知道是哪一格不对。清空按钮只在有内容时可点，清空后提交会把所有字段
 * 一起发成 null，真正把旧值删掉。
 */
export function BillingFields({
  idPrefix,
  value,
  onChange,
  errors,
  disabled,
}: BillingFieldsProps) {
  const { t } = useI18n();
  const anyFilled = hasAnyBillingField(value);
  const currencyChoice = currencySelectValue(value.currency);
  // 原生 `min`/`max` 会在提交前挡住越界日期，页面自己的校验因此没有机会跑；
  // 日期一改就做同样的范围校验，错误能立刻落在字段下方。
  const [dateRangeError, setDateRangeError] = useState<string | null>(null);

  const update = (patch: Partial<ServerBillingForm>) =>
    onChange({ ...value, ...patch });

  const paidUntilId = `${idPrefix}-paid-until`;
  const priceId = `${idPrefix}-price`;
  const currencyId = `${idPrefix}-currency`;
  const currencyCustomId = `${idPrefix}-currency-custom`;
  const cycleCountId = `${idPrefix}-cycle-count`;
  const cycleUnitId = `${idPrefix}-cycle-unit`;

  const dateError = errors?.paid_until ?? dateRangeError ?? undefined;
  const currencyError = errors?.currency;
  // 数量 / 单位是一对：行内只显示一条，数量优先（缺数量时用户先看到它）。
  const cycleError =
    errors?.billing_cycle_count ?? errors?.billing_cycle_unit ?? undefined;
  const cycleOnce = value.cycleUnit === "once";

  return (
    <div
      role="group"
      aria-labelledby={`${idPrefix}-title`}
      className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3
          id={`${idPrefix}-title`}
          className="text-sm font-medium text-foreground"
        >
          {t("servers.billing.title")}
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => {
            setDateRangeError(null);
            onChange(EMPTY_BILLING_FORM);
          }}
          disabled={disabled || !anyFilled}
        >
          {t("servers.billing.clear")}
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          label={t("servers.billing.paidUntil")}
          htmlFor={paidUntilId}
          error={dateError}
        >
          <Input
            id={paidUntilId}
            type="date"
            min={PAID_UNTIL_MIN}
            max={PAID_UNTIL_MAX}
            value={value.paidUntil}
            onChange={(event) => {
              const next = event.target.value;
              update({ paidUntil: next });
              setDateRangeError(
                next !== "" && !isPaidUntilInRange(next)
                  ? t("servers.billing.errors.paidUntil")
                  : null,
              );
            }}
            disabled={disabled}
          />
        </FormField>

        <FormField
          label={t("servers.billing.price")}
          htmlFor={priceId}
          error={errors?.price_cents}
        >
          <Input
            id={priceId}
            value={value.price}
            onChange={(event) => update({ price: event.target.value })}
            placeholder={t("servers.billing.pricePlaceholder")}
            inputMode="decimal"
            autoComplete="off"
            disabled={disabled}
          />
        </FormField>

        <FormField
          label={t("servers.billing.currency")}
          htmlFor={currencyId}
          error={currencyError}
        >
          <div className="flex items-center gap-2">
            <Select
              value={currencyChoice}
              onValueChange={(next) => {
                if (next === CURRENCY_NONE) {
                  update({ currency: "" });
                  return;
                }
                if (next === CURRENCY_CUSTOM) {
                  // 从已知币种切到自定义：清掉旧代码，别把 CNY 当自定义值。
                  update({
                    currency: currencyChoice === CURRENCY_CUSTOM
                      ? value.currency
                      : "",
                  });
                  return;
                }
                update({ currency: next });
              }}
              disabled={disabled}
            >
              <SelectTrigger
                id={currencyId}
                className="w-full"
                aria-label={t("servers.billing.currency")}
                aria-invalid={Boolean(currencyError)}
                aria-describedby={
                  currencyError ? `${currencyId}-error` : undefined
                }
              >
                <SelectValue
                  placeholder={t("servers.billing.currencyPlaceholder")}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={CURRENCY_NONE}>
                  {t("servers.billing.none")}
                </SelectItem>
                {BILLING_CURRENCIES.map((code) => (
                  <SelectItem key={code} value={code}>
                    {code}
                  </SelectItem>
                ))}
                <SelectItem value={CURRENCY_CUSTOM}>
                  {t("servers.billing.currencyCustom")}
                </SelectItem>
              </SelectContent>
            </Select>

            {currencyChoice === CURRENCY_CUSTOM ? (
              <Input
                id={currencyCustomId}
                value={value.currency}
                onChange={(event) =>
                  update({
                    currency: sanitizeCurrencyInput(event.target.value),
                  })
                }
                placeholder={t("servers.billing.currencyCustomPlaceholder")}
                aria-label={t("servers.billing.currencyCustom")}
                aria-invalid={Boolean(currencyError)}
                aria-describedby={
                  currencyError ? `${currencyId}-error` : undefined
                }
                autoComplete="off"
                maxLength={3}
                className="w-20 shrink-0 font-mono uppercase"
                disabled={disabled}
              />
            ) : null}
          </div>
        </FormField>

        <FormField
          label={t("servers.billing.cycle")}
          htmlFor={cycleCountId}
          error={cycleError}
        >
          {/* 一行两个控件：数量 + 单位。选「一次性」时数量固定 1 并禁用，
              宽度保持不变，避免整行跳动。 */}
          <div className="flex items-center gap-2">
            <Input
              id={cycleCountId}
              value={value.cycleCount}
              onChange={(event) =>
                update({
                  cycleCount: sanitizeCycleCountInput(event.target.value),
                })
              }
              placeholder={t("servers.billing.cycleCountPlaceholder")}
              inputMode="numeric"
              autoComplete="off"
              maxLength={4}
              aria-label={t("servers.billing.cycleCount")}
              aria-invalid={Boolean(cycleError)}
              className="tnum w-20 shrink-0"
              disabled={disabled || cycleOnce}
            />

            <Select
              value={value.cycleUnit || BILLING_NONE}
              onValueChange={(next) => {
                if (next === BILLING_NONE) {
                  // 「未填写」= 两者一起清空，提交时两列都是 null。
                  update({ cycleCount: "", cycleUnit: "" });
                  return;
                }
                if (!isBillingCycleUnit(next)) return;
                update({
                  cycleUnit: next,
                  cycleCount: cycleCountForUnit(next, value.cycleCount),
                });
              }}
              disabled={disabled}
            >
              <SelectTrigger
                id={cycleUnitId}
                className="min-w-0 flex-1"
                aria-label={t("servers.billing.cycleUnit")}
                aria-invalid={Boolean(cycleError)}
                aria-describedby={
                  cycleError ? `${cycleCountId}-error` : undefined
                }
              >
                <SelectValue
                  placeholder={t("servers.billing.cyclePlaceholder")}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={BILLING_NONE}>
                  {t("servers.billing.none")}
                </SelectItem>
                <SelectItem value="month">
                  {t("servers.billing.cycleUnitMonth")}
                </SelectItem>
                <SelectItem value="year">
                  {t("servers.billing.cycleUnitYear")}
                </SelectItem>
                <SelectItem value="once">
                  {t("servers.billing.cycleUnitOnce")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </FormField>
      </div>

      {anyFilled ? (
        <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
          <GlobeIcon
            className="mt-0.5 size-3 shrink-0"
            aria-hidden="true"
          />
          {t("servers.billing.publicHint")}
        </p>
      ) : null}
    </div>
  );
}
