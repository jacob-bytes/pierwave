import en from "../i18n/en.ts";
import { getLocale } from "../i18n/locale.ts";
import type { Locale } from "../i18n/locale.ts";
import zh from "../i18n/zh-CN.ts";
import type { Messages } from "../i18n/zh-CN.ts";
import { ApiError } from "./apiError.ts";

/**
 * `errors` 词典在两种语言里是同一组扁平 key（如 `agent.upgrade.not_newer`），
 * 直接按完整 code 取值，不能走 `t()` 的逐段查找——那样会把 code 里的点
 * 当成嵌套层级。`hasOwn` + `typeof` 才是真的探测，不能拿 `t()` 的返回值
 * 去和键名比较（缺失时它本来就返回键名）。
 */
const dictionaries: Record<Locale, Messages> = {
  "zh-CN": zh,
  en,
};

function errorDictionary(locale: Locale): Record<string, unknown> {
  return dictionaries[locale].errors as unknown as Record<string, unknown>;
}

function lookupError(locale: Locale, code: string): string | undefined {
  const dictionary = errorDictionary(locale);
  if (!Object.hasOwn(dictionary, code)) return undefined;
  const value = dictionary[code];
  return typeof value === "string" ? value : undefined;
}

/** 当前语言词典里是否有这个错误码；供测试与调试使用。 */
export function hasErrorCode(code: string): boolean {
  return lookupError(getLocale(), code) !== undefined;
}

/**
 * 按 code 取当前语言文案；英文缺键时回落到中文（与 i18n 的兜底顺序一致）。
 */
function translatedError(locale: Locale, code: string): string | undefined {
  return (
    lookupError(locale, code) ??
    (locale === "zh-CN" ? undefined : lookupError("zh-CN", code))
  );
}

function stringifyParam(value: unknown, locale: Locale): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map((item) => stringifyParam(item, locale));
    if (parts.some((part) => part === undefined)) return undefined;
    // 后端会把 server_ids / servers / node_ids 这类列表直接放进 params；
    // 列表分隔符跟着当前语言走，避免英文界面里出现「、」。
    return parts.join(locale === "zh-CN" ? "、" : ", ");
  }
  return undefined;
}

/**
 * 翻译模板里所有 `{name}` 都拿到值时返回插值结果；缺任意一个参数时返回
 * `null`，由调用方回落到后端已经渲染好的 `error` 原文。
 */
function interpolateError(
  template: string,
  locale: Locale,
  params?: Record<string, unknown>,
): string | null {
  let missing = false;
  const text = template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = stringifyParam(params?.[name], locale);
    if (value === undefined) {
      missing = true;
      return match;
    }
    return value;
  });
  return missing ? null : text;
}

/**
 * 展示后端错误：有 code 且词典命中 → 当前语言翻译 + params 插值；
 * 否则回落到后端 `error` 原文；两者都没有才用 fallback。
 *
 * 参数缺失时选择回落到 `error` 原文，而不是把 `{current}` 字面量渲染给用户：
 * 后端原文里已经带好了实际值，即使语言是英文也比露占位符可读。
 */
export function errorText(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) {
    return fallback;
  }

  const original = error.message.trim();

  if (error.code) {
    const locale = getLocale();
    const template = translatedError(locale, error.code);
    if (template) {
      const translated = interpolateError(template, locale, error.params);
      if (translated !== null) return translated;
    }
  }

  return original || fallback;
}

/** 接口与后端并行开发时，404 通常表示该能力尚未上线。 */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}
