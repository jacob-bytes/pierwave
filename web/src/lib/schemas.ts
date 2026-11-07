import { z } from "zod";
import type { TFunction } from "@/i18n";
import {
  ANY_INBOUND_TAG,
  isReservedOutboundTag,
  OUTBOUND_PROTOCOLS,
  OUTBOUND_TAG_PATTERN,
} from "@/lib/outbounds";
import {
  isCombinationAllowed,
  NODE_PROTOCOLS,
  NODE_SECURITIES,
  NODE_TRANSPORTS,
} from "@/lib/protocols";
import {
  findFirstOverlongRuleLine,
  parseRuleLines,
  RULE_LINE_MAX_LENGTH,
} from "@/lib/ruleTemplates";
import { dateInputToUnixEndOfDay } from "@/lib/time";

/**
 * 校验消息全部由 `t` 生成。
 *
 * 表单在 `useMemo` 里以 `locale` 为依赖重建 schema，切换语言后重新校验
 * 就会显示对应语言的错误；消息本身不缓存，避免出现「中英混排」。
 */

function gbField(t: TFunction) {
  return z.string().refine((value) => {
    const trimmed = value.trim();
    if (!trimmed) return true;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed >= 0;
  }, t("validation.gb"));
}

function optionalIntField(
  min: number,
  max: number,
  message: string,
) {
  return z.string().refine((value) => {
    const trimmed = value.trim();
    if (!trimmed) return true;
    if (!/^\d+$/.test(trimmed)) return false;
    const parsed = Number(trimmed);
    return parsed >= min && parsed <= max;
  }, message);
}

function requiredIntField(
  min: number,
  max: number,
  message: string,
) {
  return z.string().refine((value) => {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return false;
    const parsed = Number(trimmed);
    return parsed >= min && parsed <= max;
  }, message);
}

function optionalDateField(t: TFunction) {
  return z
    .string()
    .refine(
      (value) => value === "" || dateInputToUnixEndOfDay(value) !== null,
      t("validation.invalidDate"),
    );
}

export function userFormSchema(t: TFunction, mode: "create" | "edit") {
  return z
    .object({
      username: z
        .string()
        .trim()
        .min(3, t("validation.usernameMin"))
        .max(32, t("validation.usernameMax")),
      password: z.string(),
      role: z.enum(["admin", "user"]),
      quota_gb: gbField(t),
    })
    .superRefine((values, ctx) => {
      if (mode === "create" && values.password.length < 8) {
        ctx.addIssue({
          code: "custom",
          path: ["password"],
          message: t("validation.passwordMin"),
        });
      }
      if (
        mode === "edit" &&
        values.password.length > 0 &&
        values.password.length < 8
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["password"],
          message: t("validation.passwordMinOptional"),
        });
      }
    });
}

export type UserFormValues = z.infer<ReturnType<typeof userFormSchema>>;
export type UserFormMode = "create" | "edit";

export function resetPasswordSchema(t: TFunction) {
  return z.object({
    password: z.string().min(8, t("validation.passwordMin")),
  });
}

export type ResetPasswordValues = z.infer<
  ReturnType<typeof resetPasswordSchema>
>;

/** 当前登录用户修改自己的密码；成功后其它设备的会话会立即失效。 */
export function changePasswordSchema(t: TFunction) {
  return z
    .object({
      old_password: z.string().min(1, t("validation.oldPasswordRequired")),
      new_password: z.string().min(8, t("validation.newPasswordMin")),
      confirm_password: z.string().min(1, t("validation.confirmRequired")),
    })
    .superRefine((values, ctx) => {
      if (values.confirm_password !== values.new_password) {
        ctx.addIssue({
          code: "custom",
          path: ["confirm_password"],
          message: t("validation.confirmMismatch"),
        });
      }
      if (values.new_password && values.new_password === values.old_password) {
        ctx.addIssue({
          code: "custom",
          path: ["new_password"],
          message: t("validation.sameAsOld"),
        });
      }
    });
}

export type ChangePasswordValues = z.infer<
  ReturnType<typeof changePasswordSchema>
>;

/**
 * 设置页表单：数值字段先用字符串承接，提交时再转数字。
 * 范围与后端白名单一致：次数 1–20、锁定 60–86400 秒、会话 1–720 小时。
 */
export function settingsFormSchema(t: TFunction) {
  return z.object({
    panel_name: z
      .string()
      .trim()
      .min(1, t("validation.panelNameRequired"))
      .max(64, t("validation.panelNameMax")),
    login_max_attempts: requiredIntField(
      1,
      20,
      t("validation.attemptsRange"),
    ),
    login_lock_secs: requiredIntField(60, 86400, t("validation.lockRange")),
    session_ttl_hours: requiredIntField(
      1,
      720,
      t("validation.sessionRange"),
    ),
  });
}

export type SettingsFormValues = z.infer<
  ReturnType<typeof settingsFormSchema>
>;

/** 套餐节点范围的三态：全部 / 指定 / 一个都不给。 */
export const PACKAGE_NODE_SCOPES = ["all", "selected", "none"] as const;

export type PackageNodeScope = (typeof PACKAGE_NODE_SCOPES)[number];

export function packageFormSchema(t: TFunction) {
  return z
    .object({
      name: z
        .string()
        .trim()
        .min(1, t("validation.packageNameRequired"))
        .max(64, t("validation.packageNameMax")),
      quota_gb: gbField(t),
      period_days: optionalIntField(1, 3650, t("validation.periodRange")),
      direction: z.enum(["both", "upload", "download"]),
      node_ratio: z.string().refine((value) => {
        const trimmed = value.trim();
        if (!trimmed) return false;
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) && parsed > 0 && parsed <= 10;
      }, t("validation.ratioRange")),
      node_scope: z.enum(PACKAGE_NODE_SCOPES),
      node_ids: z.array(z.string()),
    })
    .superRefine((values, ctx) => {
      // 「一个都不给」用空数组表达，是合法状态；只有「指定」才要求至少一个。
      if (values.node_scope === "selected" && values.node_ids.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["node_ids"],
          message: t("validation.selectNode"),
        });
      }
    });
}

export type PackageFormValues = z.infer<
  ReturnType<typeof packageFormSchema>
>;

function packageTermFields(t: TFunction) {
  return {
    expires_at: optionalDateField(t),
    quota_override_gb: gbField(t),
    reset_day: optionalIntField(1, 31, t("validation.resetDayRange")),
  };
}

export function bindUserPackageSchema(t: TFunction) {
  return z.object({
    package_id: z.string().min(1, t("validation.selectPackage")),
    ...packageTermFields(t),
  });
}

export type BindUserPackageValues = z.infer<
  ReturnType<typeof bindUserPackageSchema>
>;

export function editUserPackageSchema(t: TFunction) {
  return z.object(packageTermFields(t));
}

export type EditUserPackageValues = z.infer<
  ReturnType<typeof editUserPackageSchema>
>;

export function nodeFormSchema(t: TFunction) {
  return z
    .object({
      name: z
        .string()
        .trim()
        .min(1, t("validation.nodeNameRequired"))
        .max(64, t("validation.nodeNameMax")),
      protocol: z.enum(NODE_PROTOCOLS),
      transport: z.enum(NODE_TRANSPORTS),
      security: z.enum(NODE_SECURITIES),
      /** 只有 `security = "tls"` 时才有意义；其它安全层提交时必须省略。 */
      cert_id: z.string(),
      port: z.string().refine((value) => {
        const trimmed = value.trim();
        if (!/^\d+$/.test(trimmed)) return false;
        const parsed = Number(trimmed);
        return parsed >= 1 && parsed <= 65535;
      }, t("validation.portRange")),
      enabled: z.boolean(),
    })
    .superRefine((values, ctx) => {
      if (
        !isCombinationAllowed(values.protocol, values.transport, values.security)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["transport"],
          message: t("validation.comboInvalid"),
        });
      }
      if (values.security === "tls" && !values.cert_id.trim()) {
        ctx.addIssue({
          code: "custom",
          path: ["cert_id"],
          message: t("validation.certRequired"),
        });
      }
    });
}

export type NodeFormValues = z.infer<ReturnType<typeof nodeFormSchema>>;

/**
 * 出站表单：tag / 协议 / 启用状态。
 *
 * config 是 JSON 文本，复用 `lib/json.ts` 的解析器在对话框里做行号级校验，
 * 不放进 zod（那里拿不到原始文本的定位信息）。
 */
export function outboundFormSchema(t: TFunction) {
  return z.object({
    tag: z
      .string()
      .trim()
      .min(1, t("validation.outboundTagRequired"))
      .regex(OUTBOUND_TAG_PATTERN, t("validation.outboundTagInvalid"))
      .refine(
        (value) => !isReservedOutboundTag(value),
        t("validation.outboundTagReserved"),
      ),
    protocol: z.enum(OUTBOUND_PROTOCOLS),
    enabled: z.boolean(),
  });
}

export type OutboundFormValues = z.infer<
  ReturnType<typeof outboundFormSchema>
>;

/**
 * 路由规则表单：三个匹配条件至少填一个，否则规则会吞掉所有流量。
 *
 * 空字符串在提交时统一转成 null；入站下拉的「不限」用对话框内的哨兵值承接。
 */
export function routingRuleFormSchema(t: TFunction) {
  return z
    .object({
      inbound_tag: z.string(),
      domain: z.string(),
      ip: z.string(),
      outbound_tag: z.string(),
      enabled: z.boolean(),
    })
    .superRefine((values, ctx) => {
      const hasInbound =
        values.inbound_tag.trim() !== "" &&
        values.inbound_tag !== ANY_INBOUND_TAG;
      if (!hasInbound && !values.domain.trim() && !values.ip.trim()) {
        ctx.addIssue({
          code: "custom",
          path: ["domain"],
          message: t("validation.routingConditionRequired"),
        });
      }
    });
}

export type RoutingRuleFormValues = z.infer<
  ReturnType<typeof routingRuleFormSchema>
>;

/**
 * 规则模板表单：多行文本在校验与提交时都按行拆分、trim、去空行。
 *
 * 规则与后端保持一致：非空、每条 1–200 字符、最后一条以大写 `MATCH` 开头。
 * 错误挂在 `rules_text` 上，由对话框内联展示。
 */
export function ruleTemplateFormSchema(t: TFunction) {
  return z
    .object({
      name: z
        .string()
        .trim()
        .min(1, t("validation.ruleTemplateNameRequired")),
      description: z.string(),
      rules_text: z.string(),
      is_default: z.boolean(),
    })
    .superRefine((values, ctx) => {
      const rules = parseRuleLines(values.rules_text);

      if (rules.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["rules_text"],
          message: t("validation.rulesRequired"),
        });
        return;
      }

      const tooLongLine = findFirstOverlongRuleLine(values.rules_text);
      if (tooLongLine !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["rules_text"],
          message: t("validation.ruleLineMax", {
            line: tooLongLine,
            max: RULE_LINE_MAX_LENGTH,
          }),
        });
        return;
      }

      if (!rules[rules.length - 1].startsWith("MATCH")) {
        ctx.addIssue({
          code: "custom",
          path: ["rules_text"],
          message: t("validation.rulesLastMatch"),
        });
      }
    });
}

export type RuleTemplateFormValues = z.infer<
  ReturnType<typeof ruleTemplateFormSchema>
>;

/**
 * 证书上传的前端基础校验：只看 PEM 头，真正的解析（含私钥匹配）以后端为准。
 * 后端的中文错误会原样透出到表单。
 */
export function certificateFormSchema(t: TFunction) {
  return z.object({
    name: z
      .string()
      .trim()
      .min(1, t("validation.certNameRequired"))
      .max(64, t("validation.certNameMax")),
    cert_pem: z
      .string()
      .trim()
      .min(1, t("validation.certPemRequired"))
      .refine(
        (value) => value.includes("-----BEGIN CERTIFICATE-----"),
        t("validation.certPemInvalid"),
      ),
    key_pem: z
      .string()
      .trim()
      .min(1, t("validation.keyPemRequired"))
      .refine(
        (value) => value.includes("-----BEGIN"),
        t("validation.keyPemInvalid"),
      ),
  });
}

export type CertificateFormValues = z.infer<
  ReturnType<typeof certificateFormSchema>
>;
