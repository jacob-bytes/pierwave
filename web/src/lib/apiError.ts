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
