import { Component, type ErrorInfo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { HomeIcon, RotateCcwIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { deriveErrorState } from "./errorBoundaryState";

type ErrorBoundaryProps = {
  children: ReactNode;
  /** 「回到概览」的落点：管理员是 `/`，普通用户是 `/me`。 */
  homePath: string;
};

type ErrorBoundaryState = {
  error: Error | null;
  message: string;
  componentStack: string;
};

/**
 * 路由级错误边界。
 *
 * AppShell 里的 Outlet 按 `location.pathname` 作为 key：切换路由时
 * 整个边界重新挂载，上一页的错误状态不会带到下一页；页面内部仍可
 * 用四态处理接口错误，这里只兜住「渲染时抛异常」导致的整页白屏。
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = {
    error: null,
    message: "",
    componentStack: "",
  };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return deriveErrorState(error);
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 不引入监控依赖：错误在控制台留一份带组件栈的记录，便于用户反馈。
    console.error("[ErrorBoundary]", error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? "" });
  }

  private handleRetry = (): void => {
    this.setState({ error: null, message: "", componentStack: "" });
  };

  render(): ReactNode {
    const { error, message, componentStack } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        data-slot="route-error-boundary"
        className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border bg-card px-6 py-16 text-center"
      >
        <div className="grid size-12 place-items-center rounded-full bg-destructive/10 text-destructive">
          <TriangleAlertIcon className="size-6" aria-hidden="true" />
        </div>
        <div className="max-w-md space-y-1">
          <h2 className="text-base leading-tight font-semibold">{t("errorBoundary.title")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("errorBoundary.description")}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button onClick={this.handleRetry}>
            <RotateCcwIcon className="size-4" />
            {t("errorBoundary.retry")}
          </Button>
          <Button variant="outline" asChild>
            <Link to={this.props.homePath}>
              <HomeIcon className="size-4" />
              {t("errorBoundary.backHome")}
            </Link>
          </Button>
        </div>
        <details className="w-full max-w-xl text-left">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {t("errorBoundary.details")}
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono type-micro leading-normal break-words whitespace-pre-wrap text-muted-foreground">
            <span className="font-medium">
              {t("errorBoundary.errorLabel")}: {message}
            </span>
            {componentStack ? `\n${componentStack}` : ""}
          </pre>
        </details>
      </div>
    );
  }
}
