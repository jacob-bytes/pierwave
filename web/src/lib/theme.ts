/**
 * 主题状态的纯模块：不依赖 React，供入口（main.tsx）与顶栏菜单共享。
 *
 * 三种选择：light / dark / system；`system` 跟随
 * `prefers-color-scheme`，并在系统外观变化时实时重算。
 *
 * `<html>` 上同时维护 `data-theme`（CSS 覆盖用）与 `.dark`
 * （Tailwind `dark:` 变体用），两者永远由 `applyTheme` 一起写入。
 */
export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "pierwave.theme";

/** 默认深色：与改造前的视觉基线一致，不让老截图失效。 */
export const DEFAULT_THEME: ThemeMode = "dark";

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

/** 纯函数：给定选择与系统偏好，算出实际主题。便于单测。 */
export function resolveThemeMode(
  mode: ThemeMode,
  prefersDark: boolean,
): ResolvedTheme {
  if (mode === "system") return prefersDark ? "dark" : "light";
  return mode;
}

function systemQuery(): MediaQueryList | null {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return null;
  }
  return window.matchMedia(DARK_QUERY);
}

/** localStorage → 默认深色；隐私模式下读取失败时静默回落。 */
export function detectTheme(): ThemeMode {
  try {
    const stored =
      typeof window === "undefined"
        ? null
        : window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeMode(stored)) return stored;
  } catch {
    // ignore storage access errors
  }
  return DEFAULT_THEME;
}

let currentTheme: ThemeMode = detectTheme();
let mediaListenerBound = false;

export function getTheme(): ThemeMode {
  return currentTheme;
}

export function getResolvedTheme(): ResolvedTheme {
  return resolveThemeMode(currentTheme, systemQuery()?.matches ?? true);
}

/** 切换实际主题：写 `data-theme`、`.dark`、原生控件配色与 meta。 */
export function applyTheme(mode: ThemeMode = currentTheme): ResolvedTheme {
  const resolved = resolveThemeMode(mode, systemQuery()?.matches ?? true);
  if (typeof document === "undefined") return resolved;

  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.classList.toggle("dark", resolved === "dark");
  // 原生控件（select、滚动条、日期选择器）跟随主题。
  root.style.colorScheme = resolved;

  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="color-scheme"]',
  );
  if (meta) meta.content = resolved;

  return resolved;
}

const listeners = new Set<() => void>();

/** 供 `useSyncExternalStore` 订阅；系统外观变化时也会触发。 */
export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * 绑定一次系统外观监听：只有当前选择是 `system` 时才重算并通知。
 * 在 `initTheme()` 与 `setTheme()` 里调用，保证直接调 setTheme 也不漏监听。
 */
function ensureSystemListener(): void {
  if (mediaListenerBound) return;
  const query = systemQuery();
  if (!query) return;
  mediaListenerBound = true;

  const onChange = () => {
    if (currentTheme !== "system") return;
    applyTheme(currentTheme);
    notify();
  };

  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", onChange);
  } else {
    // 旧版 Safari 只有 addListener。
    query.addListener(onChange);
  }
}

/** 首次渲染前调用：立刻套用主题并开始监听系统外观。 */
export function initTheme(): ResolvedTheme {
  ensureSystemListener();
  return applyTheme(currentTheme);
}

/** 用户显式切换：持久化、立即应用并通知订阅者。 */
export function setTheme(mode: ThemeMode): void {
  if (!isThemeMode(mode)) return;

  const changed = mode !== currentTheme;
  currentTheme = mode;

  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(THEME_STORAGE_KEY, mode);
    }
  } catch {
    // ignore storage access errors
  }

  ensureSystemListener();
  applyTheme(mode);

  if (changed) notify();
}
