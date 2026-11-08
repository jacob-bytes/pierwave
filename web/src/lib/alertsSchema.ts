import { z } from "zod";
import type { TFunction } from "@/i18n";
import {
  ALERT_EVENTS,
  ALERT_COOLDOWN_MAX,
  ALERT_COOLDOWN_MIN,
  hasWhitespaceOrControl,
  isHttpUrl,
} from "@/lib/alerts";
import { requiredIntField } from "@/lib/schemas";

/**
 * P13：告警通知卡片的表单校验。
 *
 * 单独成文件，避免 `lib/schemas.ts`（被入口里的修改密码对话框间接引用）
 * 把整个 `lib/alerts.ts` 拉进入口 chunk；设置页是懒加载的。
 */
export function alertsSettingsSchema(t: TFunction) {
  return z.object({
    // 与后端一致：最多 256 字符，且不允许空白 / 控制字符（首尾空白先 trim）。
    telegram_bot_token: z
      .string()
      .trim()
      .max(256, t("settings.alerts.validation.token"))
      .refine(
        (value) => !hasWhitespaceOrControl(value),
        t("settings.alerts.validation.token"),
      ),
    telegram_chat_id: z
      .string()
      .trim()
      .max(128, t("settings.alerts.validation.chatId"))
      .refine(
        (value) => !hasWhitespaceOrControl(value),
        t("settings.alerts.validation.chatId"),
      ),
    webhook_url: z
      .string()
      .trim()
      .max(2048, t("settings.alerts.validation.webhookUrl"))
      .refine(
        (value) => value === "" || isHttpUrl(value),
        t("settings.alerts.validation.webhookUrl"),
      ),
    alert_events: z.array(z.enum(ALERT_EVENTS)),
    alert_cooldown_secs: requiredIntField(
      ALERT_COOLDOWN_MIN,
      ALERT_COOLDOWN_MAX,
      t("settings.alerts.validation.cooldown"),
    ),
  });
}

export type AlertsFormValues = z.infer<
  ReturnType<typeof alertsSettingsSchema>
>;
