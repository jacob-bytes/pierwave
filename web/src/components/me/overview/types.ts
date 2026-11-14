import type { MePackageSummary, MeUsage } from "@/lib/api";
import type { OverviewTone } from "@/lib/meOverview";

/**
 * 概览卡的只读视图模型。
 *
 * 数据来源与阈值仍由 `Overview.tsx` 统一计算（`trafficTone` / `daysTone` /
 * `usagePercent` / `dailyAverage`），卡片只负责呈现。
 */
export interface OverviewCardProps {
  plan: MePackageSummary | null;
  usage: MeUsage;
  overQuota: boolean;
  /** 已用比例（0..100）；不限量时为 null。 */
  usedPercent: number | null;
  remainingTone: OverviewTone;
  expiryTone: OverviewTone;
  /** 今日计费流量；拿不到时为 null，右侧整项不渲染。 */
  todayBytes: number | null;
  /** 近 7 天日均；趋势未就绪 / 无数据时为 null，不显示占位 0。 */
  dailyAverageBytes: number | null;
  /** 卡片右下角的次要账号信息。 */
  username: string;
  /** 打开「修改密码」对话框；入口只保留在这个次要位置。 */
  onChangePassword: () => void;
}
