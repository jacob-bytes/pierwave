/**
 * 对外端口（NAT）的纯展示逻辑：不依赖 React / DOM。
 *
 * `nodes.public_port` 只影响订阅与展示，**不改变监听**：
 * - `null` / 缺失 = 与监听端口相同（旧行为，逐字节不变）；
 * - 有值时展示 `内 → 外`，例如 `443 → 40001`；
 * - 脏值（0 / 越界 / 非整数）一律回落到监听端口，与后端订阅读路径一致。
 */

/** 端口范围：与后端 `validate_port` / `validate_public_port` 一致。 */
export const PORT_MIN = 1;
export const PORT_MAX = 65535;

/** 单段展示用的端口字符串：只接受整数数字，避免把 `0443` 当成非法值。 */
function digitPort(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) &&
    parsed >= PORT_MIN &&
    parsed <= PORT_MAX
    ? parsed
    : null;
}

/**
 * 表单输入校验：空串合法（= 不设置）；否则必须是 1–65535 的整数。
 *
 * 与 `nodeFormSchema` 的 `port` 规则一致，但允许留空。
 */
export function isValidPublicPortInput(value: string): boolean {
  return value.trim() === "" || digitPort(value) !== null;
}

/**
 * 表单输入 → 提交值：空串 = `null`（清空对外端口），非法输入 = `undefined`
 * （调用方应先通过 `isValidPublicPortInput` 拦截）。
 */
export function parsePublicPortInput(value: string): number | null | undefined {
  if (value.trim() === "") return null;
  return digitPort(value) ?? undefined;
}

/**
 * 实际给用户看的端口：合法的 `publicPort` 优先，否则回落到监听端口。
 *
 * 后端 `SubNode::effective_port` 使用同一口径，避免前端预览与订阅不一致。
 */
export function effectivePort(
  port: number,
  publicPort?: number | null,
): number {
  return typeof publicPort === "number" &&
    Number.isInteger(publicPort) &&
    publicPort >= PORT_MIN &&
    publicPort <= PORT_MAX
    ? publicPort
    : port;
}

/**
 * 端口展示文案：对外端口与监听端口不同时输出 `内 → 外`，否则只显示端口。
 *
 * 例：`portPairLabel(443, 40001) === "443 → 40001"`；
 * `portPairLabel(443, null) === "443"`（与旧 UI 完全一致）。
 */
export function portPairLabel(
  port: number,
  publicPort?: number | null,
): string {
  const shown = effectivePort(port, publicPort);
  return shown === port ? String(port) : `${port} → ${shown}`;
}
