import type { MeSummary } from "@/lib/api";
import {
  DEFAULT_SUBSCRIPTION_FORMAT,
  withSubscriptionFormat,
  type SubscriptionFormat,
} from "@/lib/subscriptionFormats";

/**
 * 订阅地址是后端返回的站内相对路径；复制、二维码都要绝对 URL。
 * 概览的快捷复制与订阅页共用，避免两处拼出不同链接。
 */
export function absoluteSubscriptionUrl(summary: MeSummary): string {
  const raw = summary.subscription?.url || summary.subscription_url;
  const fallback = `${window.location.origin}/api/v1/sub/${encodeURIComponent(
    summary.user.short_code,
  )}`;
  if (!raw) return fallback;
  try {
    return new URL(raw, window.location.origin).toString();
  } catch {
    return fallback;
  }
}

/** 默认格式（clash）不写 `?target=`，与订阅页初始状态一致。 */
export function subscriptionUrl(
  summary: MeSummary,
  format: SubscriptionFormat = DEFAULT_SUBSCRIPTION_FORMAT,
): string {
  return withSubscriptionFormat(absoluteSubscriptionUrl(summary), format);
}
