/**
 * 操作审计的分类收敛：12 个细分类合并成 4 组 + 全部。
 *
 * 后端按动作前缀（`LIKE 'prefix%'`）过滤，所以这里存的是前缀而不是动作名。
 * 用带点号的前缀（`user.`）而不是裸词（`user`）：裸词会把 `user_chain.*` /
 * `user_forward.*` 也吞进账号组，转发组就永远空着。
 *
 * 分组的依据与侧栏一致：账号（用户 / 套餐 / 套餐实例）、资源（服务器 / 节点 /
 * 证书 / 规则模板 / 出站）、转发（链 / 链模板 / 端口转发 / 用户自助转发）、
 * 系统（设置 / 登录 / 备份 / Agent 升级 / 事件清理 / 订阅模板）。
 */

export const AUDIT_CATEGORY_IDS = [
  "all",
  "account",
  "resource",
  "forwarding",
  "system",
] as const;

export type AuditCategory = (typeof AUDIT_CATEGORY_IDS)[number];

export interface AuditCategoryGroup {
  value: AuditCategory;
  /** `zh-CN.ts` / `en.ts` 里的词典键。 */
  labelKey: string;
  /** 后端 `action` 查询串；`all` 不传筛选。 */
  prefixes: readonly string[];
}

export const AUDIT_CATEGORY_GROUPS: readonly AuditCategoryGroup[] = [
  { value: "all", labelKey: "audit.category.all", prefixes: [] },
  {
    value: "account",
    labelKey: "audit.category.account",
    prefixes: ["user.", "user_package.", "package.", "package_instance."],
  },
  {
    value: "resource",
    labelKey: "audit.category.resource",
    prefixes: [
      "server.",
      "node.",
      "certificate.",
      "rule_template.",
      "routing_rule.",
      "outbound.",
    ],
  },
  {
    value: "forwarding",
    labelKey: "audit.category.forwarding",
    prefixes: [
      "chain.",
      "chain_template.",
      "forward.",
      "user_chain.",
      "user_forward.",
    ],
  },
  {
    value: "system",
    labelKey: "audit.category.system",
    prefixes: [
      "settings.",
      "password.",
      "config.apply",
      "agent.upgrade",
      "auth.",
      "backup.",
      "api_token.",
      "event.",
      "updates.",
      "subscription_template.",
    ],
  },
];

/** 分类对应的后端查询串；`all` 返回 `undefined`（不传筛选）。 */
export function auditCategoryAction(
  category: AuditCategory,
): string | undefined {
  const group = AUDIT_CATEGORY_GROUPS.find((item) => item.value === category);
  return group && group.prefixes.length > 0
    ? group.prefixes.join(",")
    : undefined;
}

/**
 * 一个动作属于哪一组；未知动作返回 `null`（不会掉进「全部」以外的组）。
 * 按前缀长度降序匹配，避免 `chain.` 抢在 `chain_template.` 前面误判。
 */
export function auditCategoryForAction(
  action: string,
): Exclude<AuditCategory, "all"> | null {
  let best: Exclude<AuditCategory, "all"> | null = null;
  let bestLength = -1;
  for (const group of AUDIT_CATEGORY_GROUPS) {
    if (group.value === "all") continue;
    for (const prefix of group.prefixes) {
      if (action.startsWith(prefix) && prefix.length > bestLength) {
        best = group.value;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}
