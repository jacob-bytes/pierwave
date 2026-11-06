import { ApiError, type RuleTemplate } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { t } from "@/i18n";

/** 单条规则的最大字符数；后端按 Unicode 字符算，前端也按码点计数。 */
export const RULE_LINE_MAX_LENGTH = 200;

/** 新建模板时的示例，同时用于输入框占位与提示区。 */
export const RULE_TEMPLATE_EXAMPLE = "GEOIP,CN,DIRECT\nMATCH,PROXY";

/** 同时兼容 LF / CRLF / CR，避免从旧系统粘贴的规则被当成一整行。 */
function splitRuleText(text: string): string[] {
  return text.split(/\r\n?|\n/);
}

/**
 * 多行文本 → 规则数组：按行拆分，trim 后丢掉空行。
 * 提交给后端之前统一走这里，保证“校验用的”和“落库用的”是同一份数据。
 */
export function parseRuleLines(text: string): string[] {
  return splitRuleText(text)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 与后端 `chars().count()` 对齐：按 Unicode 码点计数，而不是 UTF-16 长度。 */
export function ruleCharCount(rule: string): number {
  return Array.from(rule).length;
}

/**
 * 找出第一条超长规则的**文本行号**（1-based），便于在 textarea 里定位。
 * 空行被跳过，但行号仍按用户看到的行计算。
 */
export function findFirstOverlongRuleLine(text: string): number | null {
  const lines = splitRuleText(text);
  for (let index = 0; index < lines.length; index += 1) {
    const rule = lines[index].trim();
    if (!rule) continue;
    if (ruleCharCount(rule) > RULE_LINE_MAX_LENGTH) return index + 1;
  }
  return null;
}

/** 默认模板排在最前（后端已排序）；没有默认标记时退回到第一条。 */
export function pickDefaultRuleTemplate(
  templates: RuleTemplate[],
): RuleTemplate | null {
  return templates.find((item) => item.is_default) ?? templates[0] ?? null;
}

/**
 * 规则模板接口可能暂时 404：404 给专门的“尚未就绪”，其余错误原样透出后端中文。
 */
export function ruleTemplateErrorText(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return t("rules.unavailable");
  }
  return errorText(error, t("rules.loadError"));
}
