/**
 * 语言状态的纯模块：不依赖 React / DOM，供 i18n 与纯逻辑（错误翻译）共享。
 * 当前语言只能有一份，统一由这里的 `currentLocale` 持有。
 */
export type Locale = "zh-CN" | "en";

export const SUPPORTED_LOCALES: readonly Locale[] = ["zh-CN", "en"];

const STORAGE_KEY = "pierwave.locale";

export function isLocale(value: string | null | undefined): value is Locale {
  return value === "zh-CN" || value === "en";
}

/**
 * 初始语言：localStorage → 浏览器语言（zh* 取中文）→ 英文。
 * localStorage 在隐私模式下可能抛错，读取失败时静默回落到浏览器语言。
 */
export function detectLocale(): Locale {
  try {
    const stored =
      typeof window === "undefined"
        ? null
        : window.localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // ignore storage access errors
  }

  const language =
    typeof navigator === "undefined" ? "" : navigator.language.toLowerCase();
  return language.startsWith("zh") ? "zh-CN" : "en";
}

let currentLocale: Locale = detectLocale();

export function getLocale(): Locale {
  return currentLocale;
}

/** 把语言写进 localStorage；隐私模式下会抛错，直接忽略。 */
export function persistLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // ignore storage access errors
  }
}

/** 只改内存里的语言；通知与 `<html lang>` 由 i18n 层负责。 */
export function setCurrentLocale(locale: Locale): boolean {
  if (!isLocale(locale) || locale === currentLocale) return false;
  currentLocale = locale;
  return true;
}
