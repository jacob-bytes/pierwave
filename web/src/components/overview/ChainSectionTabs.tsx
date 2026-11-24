import { useSearchParams } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  CHAIN_SECTIONS,
  applyChainSection,
  resolveChainSection,
  type ChainSection,
} from "@/lib/chainSections";
import { t, useI18n } from "@/i18n";

const SECTION_LABEL: Record<ChainSection, string> = {
  chains: "overview.chainLatency.sections.chains",
  templates: "overview.chainLatency.sections.templates",
};

/**
 * 「链路时延」主 tab 的二级子页：转发链 / 转发模板。
 *
 * 位置在主 tab 行、服务器筛选器的右侧（`│` 分隔），只在链路时延 tab 渲染；
 * URL 是子页的唯一来源（`?view=chain&section=chains|templates`），默认
 * 「转发链」不写参数。切换用 `replace`，刷新 / 分享后保持。
 *
 * 窄屏由外层 flex 换行到筛选器下一行并右对齐，子 tab 自身 `shrink-0`，
 * 不挤压筛选框。
 */
export function ChainSectionTabs() {
  useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const section = resolveChainSection(searchParams.get("section"));

  function changeSection(value: string) {
    setSearchParams(
      (previous) => applyChainSection(previous, resolveChainSection(value)),
      { replace: true },
    );
  }

  return (
    <Tabs
      value={section}
      onValueChange={changeSection}
      className="shrink-0"
      data-chain-sections
    >
      <TabsList
        aria-label={t("overview.chainLatency.sections.aria")}
        data-chain-section-tabs
        className="h-8 shrink-0"
      >
        {CHAIN_SECTIONS.map((value) => (
          <TabsTrigger
            key={value}
            value={value}
            className="px-2 text-xs"
          >
            {t(SECTION_LABEL[value])}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
