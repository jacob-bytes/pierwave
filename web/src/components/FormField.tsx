import {
  Children,
  cloneElement,
  isValidElement,
  useId,
} from "react";
import type { ReactElement, ReactNode } from "react";
import { TriangleAlertIcon } from "lucide-react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

interface FormFieldProps {
  label: ReactNode;
  htmlFor?: string;
  error?: string;
  hint?: ReactNode;
  required?: boolean;
  className?: string;
  children: ReactNode;
}

/** FormField 注入给控件（可能是 Input / PasswordInput 或包了一层的 div）的 ARIA。 */
type InjectSpec = {
  describedBy?: string;
  required?: boolean;
  error?: boolean;
  idFor?: string;
};

type AnyElement = ReactElement<Record<string, unknown>>;

/** 合并已有值与 FormField 生成的值，避免覆盖调用方手写的 aria-describedby。 */
function mergeAria(element: AnyElement, spec: InjectSpec): AnyElement {
  const props = element.props;
  const existingDescribedBy =
    typeof props["aria-describedby"] === "string"
      ? props["aria-describedby"]
      : undefined;
  const describedBy =
    [existingDescribedBy, spec.describedBy].filter(Boolean).join(" ") ||
    undefined;
  const hasId = typeof props.id === "string" && props.id.length > 0;

  return cloneElement(element, {
    ...(describedBy ? { "aria-describedby": describedBy } : {}),
    ...(spec.required ? { "aria-required": true } : {}),
    ...(spec.error ? { "aria-invalid": true } : {}),
    // Label 的 htmlFor 必须真的指向控件：包装层里的 Input 没有 id 时补一个。
    ...(spec.idFor && !hasId ? { id: spec.idFor } : {}),
  });
}

/**
 * 把 ARIA 注入到第一个真正的表单控件。
 *
 * 有些 FormField 的子节点是 `<div className="relative"><Input/><Button/></div>`
 * 这类包装层，直接 clone 子节点会把 aria-required 加在 div 上。这里递归下探，
 * 找到 input/textarea/select 后停止；自定义控件（Input / PasswordInput）按
 * 「透传 props」处理。
 */
function injectIntoControl(
  node: ReactNode,
  spec: InjectSpec,
  done: { value: boolean },
): ReactNode {
  if (done.value || !isValidElement(node)) return node;
  const element = node as AnyElement;
  const type = element.type;

  if (typeof type === "string") {
    if (type === "input" || type === "textarea" || type === "select") {
      done.value = true;
      return mergeAria(element, spec);
    }
    const children = element.props.children as ReactNode;
    if (children !== undefined) {
      return cloneElement(
        element,
        undefined,
        Children.map(children, (child) =>
          injectIntoControl(child, spec, done),
        ),
      );
    }
    return element;
  }

  done.value = true;
  return mergeAria(element, spec);
}

/**
 * Label + 控件 + 错误/提示的轻组合，不替代 shadcn 控件本身。
 *
 * 必填与错误语义在这里统一生成并注入控件：
 * - `aria-required`：必填字段（视觉上的 `*` 只是补充）；
 * - `aria-invalid` + `aria-describedby`：错误文本有稳定 id，读屏重新聚焦
 *   字段时仍能听到具体原因；没有错误时退回到 hint。
 *
 * 这样 11 个带 `*` 的字段不必逐处手写 id，也不会漏掉关联。
 */
export function FormField({
  label,
  htmlFor,
  error,
  hint,
  required,
  className,
  children,
}: FormFieldProps) {
  const generatedId = useId();
  const baseId = htmlFor ?? generatedId;
  const errorId = `${baseId}-error`;
  const hintId = `${baseId}-hint`;

  // 错误优先：错误出现时 hint 不渲染，描述只指向错误文本。
  const describedBy = error ? errorId : hint ? hintId : undefined;
  const done = { value: false };
  const control = injectIntoControl(
    children,
    { describedBy, required, error: Boolean(error), idFor: htmlFor },
    done,
  );

  return (
    <div className={cn("space-y-2", className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {required ? (
          <span aria-hidden="true" className="text-destructive">
            *
          </span>
        ) : null}
      </Label>
      {control}
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        // 用 div 承载：部分表单的 hint 是带示例代码块的富文本，不能塞进 <p>。
        <div id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

export function FormRootError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <Alert variant="destructive">
      <TriangleAlertIcon />
      <AlertTitle>{t("form.operationFailed")}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
