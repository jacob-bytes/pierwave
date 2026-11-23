/**
 * HTTP 层错误。放在独立模块里，是为了让 `errors.ts` 能在不依赖 React /
 * 网络代码的情况下被 Node 单测直接导入（`api.ts` 只做转发与请求封装）。
 */
export class ApiError extends Error {
  readonly status: number;
  /** 后端稳定错误码；旧接口没有 code 时为 undefined。 */
  readonly code?: string;
  /** 后端插值参数；只在 code 存在时参与前端翻译。 */
  readonly params?: Record<string, unknown>;

  constructor(
    message: string,
    status: number,
    code?: string,
    params?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

/**
 * 读取响应体：非 JSON 一律包成带状态码的 [`ApiError`]。
 *
 * 网关 / 旧主控的 404 经常返回 HTML；以前 `JSON.parse` 会抛 `SyntaxError`，
 * `isChainHealthUnsupported` / `isServerHealthUnsupported` 只认 `ApiError`，
 * 页面就会把「能力未上线」显示成解析失败。空 body 仍然是 `null`（成功但无内容）。
 */
export function parseJsonBody(
  text: string,
  status: number,
  fallbackMessage: string,
): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(fallbackMessage, status);
  }
}

/**
 * 错误响应体的统一解包：兼容两种形态。
 *
 * - 现有主控：`{ code, error, params }`（顶层）；
 * - 部分新接口 / 网关：`{ error: { code, message, params } }`（嵌套，
 *   例如入口端口冲突契约 `{ "error": { "code": "chain.entry_port_taken" } }`）。
 *
 * 只读取字符串字段；类型不对时忽略，绝不把对象塞进 `message`。
 */
export interface ErrorEnvelope {
  message?: string;
  code?: string;
  params?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function recordField(
  record: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  const value = record?.[key];
  return isRecord(value) ? value : null;
}

export function parseErrorEnvelope(body: unknown): ErrorEnvelope {
  const record = isRecord(body) ? body : null;
  const nested = recordField(record, "error");
  const nestedMessage = stringField(nested, "message");
  const topMessage = typeof record?.error === "string" ? record.error.trim() : "";
  const params = recordField(record, "params") ?? recordField(nested, "params");
  return {
    ...(topMessage || nestedMessage
      ? { message: topMessage || nestedMessage }
      : {}),
    ...(stringField(record, "code") ?? stringField(nested, "code")
      ? { code: stringField(record, "code") ?? stringField(nested, "code") }
      : {}),
    ...(params ? { params } : {}),
  };
}
