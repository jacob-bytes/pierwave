import { useEffect } from "react";

/**
 * 输入模态：用户最近一次是在用指针还是键盘操作页面。
 *
 * Chromium 在鼠标点击 tab / 文本输入框后，仍可能让 `activeElement` 匹配
 * `:focus-visible`，于是 `index.css` 里的统一焦点环会在点击后描一圈 2px
 * 蓝框，被误读成「选中态」。把最近一次输入记到 `<html data-input=...>` 上，
 * CSS 只在键盘模态显示焦点环：鼠标点击不描边，Tab / 方向键导航照常可见。
 */
export type InputModality = "pointer" | "keyboard";

/** `<html>` 上的属性名。 */
export const INPUT_MODALITY_ATTRIBUTE = "data-input";

/** `root.dataset` 上对应的键（`data-input` ↔ `dataset.input`）。 */
export const INPUT_MODALITY_DATASET_KEY = "input";

/**
 * 首帧按指针处理：刚进入页面时没有键盘操作，不该先亮一圈焦点环。
 * 与 `index.html` 里 `<html data-input="pointer">` 的初始值一致。
 */
export const DEFAULT_INPUT_MODALITY: InputModality = "pointer";

/** 只依赖 `dataset`，单测里可以用普通对象代替真实元素。 */
type ModalityRoot = { dataset: Record<string, string | undefined> };

/** 把模态写到根元素上；纯函数，便于单测。 */
export function applyInputModality(
  root: ModalityRoot,
  modality: InputModality,
): void {
  // 每次按键都写同一个值会多一次属性变更 / 样式重算；值没变就不动 DOM。
  if (root.dataset[INPUT_MODALITY_DATASET_KEY] === modality) return;
  root.dataset[INPUT_MODALITY_DATASET_KEY] = modality;
}

/**
 * 注册全局输入模态监听，返回卸载函数。
 *
 * 用捕获阶段：弹窗 / 画布等组件里的 `stopPropagation()` 不能把这次切换
 * 吞掉，否则「点完对话框再点 tab」会停在错误的模态上。
 */
export function registerInputModality(doc: Document): () => void {
  const root = doc.documentElement;
  applyInputModality(root, DEFAULT_INPUT_MODALITY);

  const onPointerDown = () => applyInputModality(root, "pointer");
  const onKeyDown = () => applyInputModality(root, "keyboard");

  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("keydown", onKeyDown, true);

  return () => {
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("keydown", onKeyDown, true);
  };
}

/**
 * 在应用根组件挂载时注册一次，卸载时移除监听。
 *
 * 挂在路由根 `App` 而不是 `AppShell`：登录页、公开状态页都不经过 AppShell，
 * 但共用同一套焦点环规则，只挂在 AppShell 会让登录表单在鼠标点击后仍然描边。
 * 服务端渲染没有 `document`，effect 本来就不会跑；显式判断让这个模块也能
 * 在 Node / SSR 环境里安全导入。
 */
export function useInputModality(): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    return registerInputModality(document);
  }, []);
}
