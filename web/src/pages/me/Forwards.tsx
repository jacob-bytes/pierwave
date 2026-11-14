import { MyForwardsCard } from "@/components/me/MyForwardsCard";
import { useMeShellSummary } from "@/lib/meShell";
import { useI18n } from "@/i18n";

/**
 * 我的转发：配额 + 列表 + 新建整块沿用 `MyForwardsCard`，
 * 四态（骨架 / 空态 / 错误 / 正常）与全部行内交互保持不变。
 */
export default function MeForwardsPage() {
  useI18n();
  const summary = useMeShellSummary();

  return (
    <div className="space-y-4">
      <MyForwardsCard summary={summary} />
    </div>
  );
}
