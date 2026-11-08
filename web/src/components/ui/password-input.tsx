import { useState } from "react";
import type { ComponentProps } from "react";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

type PasswordInputProps = Omit<ComponentProps<"input">, "type">;

/**
 * 带可见性切换的密码输入框。
 *
 * 视觉上仍复用 shadcn 的 `Input`；按钮是 `type="button"`，不会误触发表单提交。
 * 切换按钮 28×28 命中区、`aria-pressed` 与中英双语名称都齐全。
 */
export function PasswordInput({ className, disabled, ...props }: PasswordInputProps) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  const label = visible ? t("common.hidePassword") : t("common.showPassword");

  return (
    <div className="relative" data-slot="password-input">
      <Input
        type={visible ? "text" : "password"}
        className={cn("pr-10", className)}
        disabled={disabled}
        {...props}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="absolute top-1/2 right-0.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        onClick={() => setVisible((value) => !value)}
        disabled={disabled}
        aria-label={label}
        aria-pressed={visible}
        title={label}
      >
        {visible ? (
          <EyeOffIcon className="size-4" />
        ) : (
          <EyeIcon className="size-4" />
        )}
      </Button>
    </div>
  );
}
