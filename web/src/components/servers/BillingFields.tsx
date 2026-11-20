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
  EMPTY_BILLING_FORM,
  hasAnyBillingField,
  sanitizeCurrencyInput,
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
 * 四个字段都是可选的公开展示数据：填了会出现在公开探针页，因此只要有一个
 * 非空就显示一句「填写后会在公开状态页展示」。价格用「元」输入、提交转「分」；
 * 币种给出三个常用项 + 自定义（后端只要求 3 位大写字母）；周期可留空。
 *
 * 错误只落在对应字段下方（`FormField` 的 error），不走全局 toast —— 用户能
 * 立刻知道是哪一格不对。清空按钮只在有内容时可点，清空后提交会把四个字段
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

  const update = (patch: Partial<ServerBillingForm>) =>
    onChange({ ...value, ...patch });

  const paidUntilId = `${idPrefix}-paid-until`;
  const priceId = `${idPrefix}-price`;
  const currencyId = `${idPrefix}-currency`;
  const currencyCustomId = `${idPrefix}-currency-custom`;
  const cycleId = `${idPrefix}-cycle`;

  const currencyError = errors?.currency;
  const cycleError = errors?.billing_cycle;

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
          onClick={() => onChange(EMPTY_BILLING_FORM)}
          disabled={disabled || !anyFilled}
        >
          {t("servers.billing.clear")}
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          label={t("servers.billing.paidUntil")}
          htmlFor={paidUntilId}
          error={errors?.paid_until}
        >
          <Input
            id={paidUntilId}
            type="date"
            value={value.paidUntil}
            onChange={(event) =>
              update({ paidUntil: event.target.value })
            }
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
          htmlFor={cycleId}
          error={cycleError}
        >
          <Select
            value={value.cycle || BILLING_NONE}
            onValueChange={(next) =>
              update({ cycle: next === BILLING_NONE ? "" : next })
            }
            disabled={disabled}
          >
            <SelectTrigger
              id={cycleId}
              className="w-full"
              aria-label={t("servers.billing.cycle")}
              aria-invalid={Boolean(cycleError)}
              aria-describedby={cycleError ? `${cycleId}-error` : undefined}
            >
              <SelectValue placeholder={t("servers.billing.cyclePlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={BILLING_NONE}>
                {t("servers.billing.none")}
              </SelectItem>
              <SelectItem value="monthly">
                {t("servers.billing.cycleMonthly")}
              </SelectItem>
              <SelectItem value="yearly">
                {t("servers.billing.cycleYearly")}
              </SelectItem>
              <SelectItem value="once">
                {t("servers.billing.cycleOnce")}
              </SelectItem>
            </SelectContent>
          </Select>
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
