import { z } from "zod";
import {
  isCombinationAllowed,
  NODE_PROTOCOLS,
  NODE_SECURITIES,
  NODE_TRANSPORTS,
} from "@/lib/protocols";
import { dateInputToUnixEndOfDay } from "@/lib/time";

const gbField = z.string().refine((value) => {
  const trimmed = value.trim();
  if (!trimmed) return true;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0;
}, "请输入不小于 0 的数字");

function optionalIntField(min: number, max: number, message: string) {
  return z.string().refine((value) => {
    const trimmed = value.trim();
    if (!trimmed) return true;
    if (!/^\d+$/.test(trimmed)) return false;
    const parsed = Number(trimmed);
    return parsed >= min && parsed <= max;
  }, message);
}

const optionalDateField = z
  .string()
  .refine(
    (value) => value === "" || dateInputToUnixEndOfDay(value) !== null,
    "请选择有效日期",
  );

export function userFormSchema(mode: "create" | "edit") {
  return z
    .object({
      username: z
        .string()
        .trim()
        .min(3, "用户名至少 3 个字符")
        .max(32, "用户名最多 32 个字符"),
      password: z.string(),
      role: z.enum(["admin", "user"]),
      quota_gb: gbField,
    })
    .superRefine((values, ctx) => {
      if (mode === "create" && values.password.length < 8) {
        ctx.addIssue({
          code: "custom",
          path: ["password"],
          message: "密码至少 8 位",
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
          message: "密码至少 8 位，留空表示不修改",
        });
      }
    });
}

export type UserFormValues = z.infer<ReturnType<typeof userFormSchema>>;
export type UserFormMode = "create" | "edit";

export const resetPasswordSchema = z.object({
  password: z.string().min(8, "密码至少 8 位"),
});

export type ResetPasswordValues = z.infer<typeof resetPasswordSchema>;

export const packageFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "请输入套餐名称")
    .max(64, "套餐名称最多 64 个字符"),
  quota_gb: gbField,
  period_days: optionalIntField(1, 3650, "周期需在 1–3650 天之间"),
  direction: z.enum(["both", "upload", "download"]),
  node_ratio: z.string().refine((value) => {
    const trimmed = value.trim();
    if (!trimmed) return false;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 10;
  }, "节点倍率需在 0–10 之间"),
});

export type PackageFormValues = z.infer<typeof packageFormSchema>;

const packageTermFields = {
  expires_at: optionalDateField,
  quota_override_gb: gbField,
  reset_day: optionalIntField(1, 31, "重置日需在 1–31 之间"),
};

export const bindUserPackageSchema = z.object({
  package_id: z.string().min(1, "请选择套餐模板"),
  ...packageTermFields,
});

export type BindUserPackageValues = z.infer<typeof bindUserPackageSchema>;

export const editUserPackageSchema = z.object(packageTermFields);

export type EditUserPackageValues = z.infer<typeof editUserPackageSchema>;

export const nodeFormSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "请输入节点名称")
      .max(64, "节点名称最多 64 个字符"),
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
    }, "端口需为 1–65535 的整数"),
    enabled: z.boolean(),
  })
  .superRefine((values, ctx) => {
    if (
      !isCombinationAllowed(values.protocol, values.transport, values.security)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["transport"],
        message: "当前协议不支持这个传输方式与安全层的组合",
      });
    }
    if (values.security === "tls" && !values.cert_id.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["cert_id"],
        message: "TLS 节点必须绑定证书",
      });
    }
  });

export type NodeFormValues = z.infer<typeof nodeFormSchema>;

/**
 * 证书上传的前端基础校验：只看 PEM 头，真正的解析（含私钥匹配）以后端为准。
 * 后端 400 的中文错误会原样透出到表单。
 */
export const certificateFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "请输入证书名称")
    .max(64, "证书名称最多 64 个字符"),
  cert_pem: z
    .string()
    .trim()
    .min(1, "请粘贴证书 PEM")
    .refine(
      (value) => value.includes("-----BEGIN CERTIFICATE-----"),
      "证书 PEM 里找不到 -----BEGIN CERTIFICATE-----",
    ),
  key_pem: z
    .string()
    .trim()
    .min(1, "请粘贴私钥 PEM")
    .refine(
      (value) => value.includes("-----BEGIN"),
      "私钥 PEM 里找不到 -----BEGIN",
    ),
});

export type CertificateFormValues = z.infer<typeof certificateFormSchema>;
