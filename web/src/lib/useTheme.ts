import { useSyncExternalStore } from "react";
import {
  getResolvedTheme,
  getTheme,
  setTheme,
  subscribeTheme,
  type ResolvedTheme,
  type ThemeMode,
} from "./theme";

export interface ThemeState {
  /** 用户选择：light / dark / system。 */
  theme: ThemeMode;
  /** 实际生效的主题；system 下由系统外观决定。 */
  resolvedTheme: ResolvedTheme;
  setTheme: (mode: ThemeMode) => void;
}

/**
 * 组件里读取主题。订阅两次快照：选择变化与系统外观变化都会触发重渲染，
 * 但返回给 UI 的仍然是最小的两个字符串。
 */
export function useTheme(): ThemeState {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getTheme);
  const resolvedTheme = useSyncExternalStore(
    subscribeTheme,
    getResolvedTheme,
    getResolvedTheme,
  );

  return { theme, resolvedTheme, setTheme };
}
