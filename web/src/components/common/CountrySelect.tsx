import { useMemo, useState } from "react";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  ISO_COUNTRY_CODES,
  countryCodeToFlag,
  countryDisplayName,
  filterCountries,
} from "@/lib/country";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";

/**
 * 国家/地区选择器：搜索框 + 可滚动列表。
 *
 * 为什么不用原生 `<datalist>`：浏览器原生下拉一次只显示十来个条目、样式不可控、
 * 且和面板的视觉语言完全不搭。这里给一个可搜索、可键盘操作、和表单其它 Select 一致的外观。
 */
export function CountrySelect({
  value,
  onChange,
  disabled,
  id,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  id?: string;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  // 名字按当前语言生成一次，过滤时直接用，避免每次按键都重建 Intl 对象。
  const all = useMemo(
    () =>
      ISO_COUNTRY_CODES.map((code) => ({
        code,
        name: countryDisplayName(code, locale) ?? code,
      })),
    [locale],
  );
  const options = useMemo(() => filterCountries(all, query), [all, query]);

  const selectedName = value ? (countryDisplayName(value, locale) ?? value) : "";

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={t("servers.country")}
          disabled={disabled}
          className={cn(
            "h-9 w-44 justify-between font-normal",
            !value && "text-muted-foreground",
          )}
        >
          {value ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <span aria-hidden="true">{countryCodeToFlag(value) ?? ""}</span>
              <span className="truncate">
                {selectedName} · {value}
              </span>
            </span>
          ) : (
            <span>{t("servers.countryPlaceholder")}</span>
          )}
          <ChevronsUpDownIcon className="icon-sm shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={4}
        avoidCollisions={false}
        className="w-64 p-0"
      >
        <div className="border-b border-border p-2">
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("servers.countrySearch")}
            aria-label={t("servers.countrySearch")}
            className="h-8"
          />
        </div>
        <ul className="max-h-60 overflow-y-auto p-1" role="listbox">
          {options.length === 0 ? (
            <li className="px-2 py-6 text-center text-xs text-muted-foreground">
              {t("servers.countryNoMatch")}
            </li>
          ) : (
            options.map((option) => {
              const active = option.code === value;
              return (
                <li key={option.code}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => {
                      onChange(option.code);
                      setOpen(false);
                      setQuery("");
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors duration-150 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none",
                      active && "bg-muted/60 font-medium",
                    )}
                  >
                    <span aria-hidden="true">
                      {countryCodeToFlag(option.code) ?? ""}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{option.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {option.code}
                    </span>
                    {active ? <CheckIcon className="icon-sm text-primary" /> : null}
                  </button>
                </li>
              );
            })
          )}
        </ul>
        {value ? (
          <div className="border-t border-border p-1">
            <button
              type="button"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
              className="w-full rounded-sm px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
            >
              {t("servers.countryClear")}
            </button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
