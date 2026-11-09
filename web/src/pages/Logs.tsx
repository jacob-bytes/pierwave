import { useSearchParams } from "react-router-dom";
import { AuditPanel } from "@/components/logs/AuditPanel";
import { EventsPanel } from "@/components/logs/EventsPanel";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  logsTabParam,
  resolveLogsTab,
  type LogsTabId,
} from "@/lib/logsTabs";
import { useI18n } from "@/i18n";

/** tab 顺序即 URL 回落的顺序（第一个是默认 tab）。 */
const LOGS_TABS = [
  { value: "events", labelKey: "logs.tabs.events" },
  { value: "audit", labelKey: "logs.tabs.audit" },
] as const satisfies readonly { value: LogsTabId; labelKey: string }[];

/**
 * `/logs`：把「系统事件」与「操作审计」收进一个菜单。
 * URL 是 tab 的唯一来源（`?tab=events|audit`，缺省为 events），
 * 刷新、前进/后退与旧书签重定向后都停在同一个 tab。
 */
export default function LogsPage() {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = resolveLogsTab(searchParams.get("tab"));

  function handleTabChange(value: string) {
    const next = new URLSearchParams(searchParams);
    // 两个 tab 都写显式参数，旧路由重定向来的 `?tab=...` 保持原样。
    next.set("tab", logsTabParam(resolveLogsTab(value)));
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }

  return (
    <div className="animate-in space-y-6 fade-in-0 slide-in-from-bottom-1 duration-150">
      <div>
        <h1 className="text-xl leading-tight font-semibold tracking-tight">
          {t("logs.title")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("logs.subtitle")}
        </p>
      </div>

      <Tabs value={tab} onValueChange={handleTabChange} className="gap-4">
        <TabsList
          aria-label={t("logs.tabs.ariaLabel")}
          className="max-w-full overflow-x-auto"
        >
          {LOGS_TABS.map((option) => (
            <TabsTrigger key={option.value} value={option.value}>
              {t(option.labelKey)}
            </TabsTrigger>
          ))}
        </TabsList>

        {/*
          forceMount：两个面板的筛选、分页与已加载记录在切走再切回时保留，
          与设置页的 tab 行为一致；非激活面板由 data-[state=inactive] 隐藏。
        */}
        <TabsContent
          value="events"
          forceMount
          aria-label={t("logs.tabs.events")}
          className="data-[state=inactive]:hidden"
        >
          <EventsPanel />
        </TabsContent>

        <TabsContent
          value="audit"
          forceMount
          aria-label={t("logs.tabs.audit")}
          className="data-[state=inactive]:hidden"
        >
          <AuditPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
