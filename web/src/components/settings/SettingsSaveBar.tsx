import type { ReactNode } from "react";
import { Loader2Icon, SaveIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";

/**
 * 设置页三个表单 tab（常规 / 安全 / 通知）共用的页面级保存条。
 *
 * 只有一行：左侧弱化提示，右侧主按钮。没有边框、背景、圆角、阴影或
 * 额外的 padding 盒，直接融进页面背景；作为表单后的普通块随页面滚动，
 * 不 sticky / fixed，只有滚到最底部才可见。
 */
export function SettingsSaveBar({
  formId,
  pending,
  dirty,
}: {
  formId: string;
  pending: boolean;
  dirty: boolean;
}) {
  const { t } = useI18n();

  return (
    <div
      data-slot="settings-savebar"
      className="flex w-full items-center justify-between gap-3"
    >
      <p className="text-xs text-muted-foreground">{t("settings.saveHint")}</p>
      <Button type="submit" form={formId} disabled={pending || !dirty}>
        {pending ? (
          <Loader2Icon className="animate-spin" />
        ) : (
          <SaveIcon />
        )}
        {pending ? t("settings.saving") : t("common.save")}
      </Button>
    </div>
  );
}

/**
 * 表单 tab 的外壳：表单内容之后接保存条，全部在正常文档流里。
 * 两者之间留 24px，滚到底时最后一张卡不会贴住条。
 */
export function SettingsFormShell({
  children,
  footer,
}: {
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="space-y-6">
      {children}
      {footer}
    </div>
  );
}
