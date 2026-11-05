import { ApiError } from "@/lib/api";

/**
 * 只展示后端给出的中文错误（{"error":"中文"}）；网络层异常统一用中文兜底，
 * 避免把 "Failed to fetch" 之类的英文直接抛给用户。
 */
export function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.message.trim()) {
    return error.message;
  }
  return fallback;
}
