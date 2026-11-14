import { ApiError } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { t } from "@/i18n";

/** 自助接口与后端并行开发，404 给一句能看懂的提示，不写 mock。 */
export function meErrorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status === 404) {
    return t("me.apiNotReady");
  }
  return errorText(error, fallback);
}
