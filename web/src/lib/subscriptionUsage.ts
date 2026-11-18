/**
 * 订阅列表「已用 / 额度」的取数规则。
 *
 * 订阅行展示的是**套餐实例合计**（与 `/users` 列表的「套餐流量」同一口径）：
 * 有套餐时用后端聚合好的 `package_used_bytes` / `package_quota_bytes`；
 * 没有套餐（或旧版后端没返回聚合字段）时才回落到账户级
 * `used_bytes` / `quota_bytes`。
 *
 * 单独抽成纯函数：页面里直接写三元表达式时，很容易再次误用账户级字段
 * （账户级 quota 通常为 null，会显示成「不限」）。
 */
export interface SubscriptionUsageSource {
  used_bytes: number;
  quota_bytes: number | null;
  package_count: number;
  package_used_bytes?: number | null;
  package_quota_bytes?: number | null;
}

export interface SubscriptionUsage {
  usedBytes: number;
  quotaBytes: number | null;
}

export function subscriptionUsage(
  user: SubscriptionUsageSource,
): SubscriptionUsage {
  if (user.package_count > 0 && user.package_used_bytes != null) {
    return {
      usedBytes: user.package_used_bytes ?? 0,
      quotaBytes: user.package_quota_bytes ?? null,
    };
  }
  return { usedBytes: user.used_bytes, quotaBytes: user.quota_bytes };
}
