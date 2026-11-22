import { ApiError } from "./apiError.ts";
import { errorText } from "./errors.ts";
import { t } from "../i18n/index.ts";

/**
 * 概览接口的错误文案：后端统计接口尚未上线时 404 单独给一句可理解的话，
 * 其余错误走当前语言的通用文案。
 */
export function statsErrorText(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return t("overview.statsNotReady");
  }
  return errorText(error, t("overview.statsError"));
}
