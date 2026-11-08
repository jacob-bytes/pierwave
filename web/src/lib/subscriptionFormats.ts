/**
 * 订阅输出格式。
 *
 * 顺序必须与后端 `subscribe::exporter_ids()` 的注册表一致：
 * - `clash` 是默认值（链接上不带 `target`）；
 * - 其余格式统一拼 `?target=<id>`。
 *
 * 管理端订阅页与用户自助页共用这一份，避免两处各写一份后漂移。
 */
export const SUBSCRIPTION_FORMATS = [
  "clash",
  "stash",
  "surge",
  "surfboard",
  "loon",
  "qx",
  "singbox",
  "shadowrocket",
  "v2ray",
] as const;

export type SubscriptionFormat = (typeof SUBSCRIPTION_FORMATS)[number];

/** 默认格式：链接保持干净，不带 `target`。 */
export const DEFAULT_SUBSCRIPTION_FORMAT: SubscriptionFormat = "clash";

/**
 * 给订阅地址加上 `?target=`（默认格式不加）。
 *
 * 入参可能是站内相对路径，`URL` 会按 `window.location.origin` 补全；
 * 传入非法地址时原样返回，交给调用方的复制/二维码兜底。
 */
export function withSubscriptionFormat(
  url: string,
  format: SubscriptionFormat,
): string {
  if (!url || format === DEFAULT_SUBSCRIPTION_FORMAT) return url;
  try {
    const parsed = new URL(url, window.location.origin);
    parsed.searchParams.set("target", format);
    return parsed.toString();
  } catch {
    return url;
  }
}
