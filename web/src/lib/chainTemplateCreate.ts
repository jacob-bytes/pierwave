/**
 * 「从模板创建转发链」的旧主控降级判定：纯逻辑，不依赖 React / DOM。
 *
 * 新主控接受 `POST /api/v1/chains` 的 `template_id`；旧主控不认识这个字段，
 * 会把请求当成「没有 groups 的手建链」，返回 400（典型是
 * `chain.hop_count_invalid` / `chain.groups_missing`）。前端只能在**提交后**
 * 根据错误形状判断——版本号比较会误伤预览版 / 自编译主控，所以不猜版本。
 *
 * 判定必须收得很窄：
 * - 只认 400 / 404 / 422，409 端口冲突与 403 权限不足都不是「不支持」；
 * - 明确的 `chain.template_unsupported`；或
 * - 错误码 / 原文里出现 `template_id` / `unknown field` / `missing field`
 *   （serde 拒绝未知字段）以及「旧主控忽略 template_id 后缺少 groups」的
 *   专属错误码 `chain.hop_count_invalid` / `chain.groups_missing`。
 */

import { ApiError } from "./apiError.ts";

const UNSUPPORTED_STATUS = new Set([400, 404, 422]);

/** 旧主控把「带 template_id、无 groups」的请求当成空手建链时的错误码。 */
const UNSUPPORTED_CODES = new Set([
  "chain.template_unsupported",
  "chain.hop_count_invalid",
  "chain.groups_missing",
]);

/**
 * 原文 / 错误码里的特征词。`not_found` 只在错误码里出现时才看，避免把
 * 「目标服务器不存在」这类正常校验错误误判成旧主控。
 */
const UNSUPPORTED_PATTERN =
  /(unknown[ _]field|missing[ _]field|template_id|template unsupported|hop_count|groups_missing)/i;

/** 404 才把 `not_found` 当「接口不存在」；400 里的 not_found 仍是普通校验错误。 */
const NOT_FOUND_PATTERN = /not_found/i;

/** `chain.entry_port_taken` 等冲突信号必须先排除，不能被当成能力缺失。 */
export function isEntryPortConflict(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.code === "chain.entry_port_taken"
  );
}

/**
 * 这个错误是否表示「主控还不支持从模板创建」。
 *
 * 调用方只在**模板创建请求**失败时使用，因此 `hop_count_invalid` 不会被
 * 误读：模板请求本来就不提交 groups。
 */
export function isTemplateUnsupported(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (!UNSUPPORTED_STATUS.has(error.status)) return false;
  if (isEntryPortConflict(error)) return false;

  const code = error.code?.trim() ?? "";
  if (UNSUPPORTED_CODES.has(code)) return true;

  const message = error.message.trim();
  if (UNSUPPORTED_PATTERN.test(code) || UNSUPPORTED_PATTERN.test(message)) {
    return true;
  }
  return error.status === 404 && NOT_FOUND_PATTERN.test(code);
}
