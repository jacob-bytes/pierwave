import { useCallback, useEffect, useSyncExternalStore } from "react";
// 显式带 `.ts` 后缀：`node --test` 不解析 tsconfig paths 与无后缀导入，
// 纯逻辑模块（如 `lib/auditChanges.ts`）需要能直接 import 本模块的 `t()`。
import en from "./en.ts";
import {
  getLocale,
  persistLocale,
  SUPPORTED_LOCALES,
  setCurrentLocale,
} from "./locale.ts";
import type { Locale } from "./locale.ts";
import zh from "./zh-CN.ts";

export { detectLocale } from "./locale.ts";
export type { Locale } from "./locale.ts";

export type Messages = typeof zh;

/** 插值参数，例如 `t("users.count", { n: 3 })`。 */
export type InterpolationValues = Record<string, string | number>;

export type TFunction = (
  key: string,
  values?: InterpolationValues,
) => string;

const dictionaries: Record<Locale, Messages> = {
  "zh-CN": zh,
  en,
};

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 切换语言：写 localStorage、同步 `<html lang>`、通知所有订阅者。
 * 页面标题由 `useDocumentTitle` 在重渲染时更新，这里也主动重放一次。
 */
export function setLocale(locale: Locale): void {
  if (!SUPPORTED_LOCALES.includes(locale)) return;

  const changed = setCurrentLocale(locale);
  persistLocale(locale);

  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
    document.title = titleBuilder?.() ?? document.title;
  }

  if (changed) {
    for (const listener of listeners) listener();
  }
}

/** 当前语言下面板标题的构造器；由 `useDocumentTitle` 注册。 */
let titleBuilder: (() => string) | null = null;

/**
 * 设置 document.title，并在语言切换时自动改用新语言。
 * `title` 变化（例如面板名从 /health 返回）时也会同步。
 */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const build = () => title;
    titleBuilder = build;
    document.title = title;
    return () => {
      if (titleBuilder === build) titleBuilder = null;
    };
  }, [title]);
}

function lookup(messages: Messages, key: string): string | undefined {
  let node: unknown = messages;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

function interpolate(text: string, values?: InterpolationValues): string {
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * 取嵌套键并做插值。缺失时回落到中文，再回落到键名本身，
 * 保证 UI 不会因为漏词直接渲染空字符串。
 */
function translateFor(
  locale: Locale,
  key: string,
  values?: InterpolationValues,
): string {
  const text =
    lookup(dictionaries[locale], key) ??
    lookup(dictionaries["zh-CN"], key) ??
    key;
  return interpolate(text, values);
}

/** 模块级翻译函数：事件回调与纯函数里直接调用，总是读当前语言。 */
export function t(key: string, values?: InterpolationValues): string {
  return translateFor(getLocale(), key, values);
}

/**
 * 组件里使用：订阅语言变化并触发重渲染。
 * 返回的 `t` 绑定当前语言，可安全放进 useMemo/useEffect 依赖；
 * 纯函数与事件回调仍可用模块级 `t()`，总是读当前语言。
 */
export function useI18n(): {
  t: TFunction;
  locale: Locale;
  setLocale: (locale: Locale) => void;
} {
  const locale = useSyncExternalStore(subscribe, getLocale, getLocale);
  // 绑定当前语言的 t：身份随 locale 变化，可以安全放进 useMemo/useEffect 依赖。
  const translate = useCallback<TFunction>(
    (key, values) => translateFor(locale, key, values),
    [locale],
  );
  return { t: translate, locale, setLocale };
}

// 首次加载就把 <html lang> 对齐到实际语言，屏幕阅读器与浏览器翻译都依赖它。
if (typeof document !== "undefined") {
  document.documentElement.lang = getLocale();
}
