/**
 * 转发协议模式（`tcp` / `udp` / `both`）的纯逻辑：不依赖 React / DOM。
 *
 * 与后端 `crates/domain/src/protocol.rs` 对齐：
 * - `tcp` 只监听 TCP；`udp` 只监听 UDP（TCP 端口不监听）；
 * - `both` 在同一端口号上同时监听 TCP 与 UDP；
 * - `realm` 固定双开，不接受「仅 UDP」（`forward.protocol_udp_requires_native`）；
 * - 加密链（`transport = tls`）只走 TCP，`udp` / `both` 都不可选。
 *
 * 旧布尔位 `udp` 只作为读取兼容：`true` = `both`、`false` = `tcp`，
 * 写路径始终发送 `protocol`。
 */

import type { ForwardProtocol } from "./api.ts";
import { normalizeEngine } from "./engines.ts";
import { isTlsTransport } from "./chainTls.ts";

/** 表单里的展示顺序；与后端 `protocol::NAMES` 一致。 */
export const PROTOCOL_MODES = [
  "tcp",
  "udp",
  "both",
] as const satisfies readonly ForwardProtocol[];

export type ProtocolMode = (typeof PROTOCOL_MODES)[number];

/** 新建转发 / 链时没填 `protocol` 的默认值。 */
export const DEFAULT_PROTOCOL: ForwardProtocol = "tcp";

function knownProtocol(value: string): ProtocolMode | null {
  return (PROTOCOL_MODES as readonly string[]).includes(value)
    ? (value as ProtocolMode)
    : null;
}

/**
 * 归一化协议模式。
 *
 * - 已知值（允许首尾空白）原样返回；
 * - `protocol` 缺失 / 空白 = 旧后端：旧 `udp: true` → `both`，否则 `tcp`；
 * - 未知值回落 `tcp`，与后端读路径 `protocol::from_db` 一致，
 *   保证 PATCH 不会把脏值写回去。
 */
export function normalizeProtocol(
  protocol: unknown,
  legacyUdp?: unknown,
): ForwardProtocol {
  if (typeof protocol === "string") {
    const trimmed = protocol.trim();
    const known = knownProtocol(trimmed);
    if (known) return known;
    // 非空但无法识别：按后端读路径回落，不再参考旧位。
    if (trimmed !== "") return DEFAULT_PROTOCOL;
  } else if (protocol !== null && protocol !== undefined) {
    return DEFAULT_PROTOCOL;
  }

  return legacyUdp ? "both" : DEFAULT_PROTOCOL;
}

/**
 * 列表徽标的文案键。未知 / 缺失与 normalizeProtocol 一样按 `tcp` 展示，
 * 不渲染空徽标。
 */
export function protocolLabelKey(protocol: unknown): string {
  return `common.protocol.${normalizeProtocol(protocol)}`;
}

/** 三种模式在当前引擎 / 链路加密下的可选项。 */
export interface ProtocolAvailability {
  tcp: boolean;
  udp: boolean;
  both: boolean;
}

/**
 * 计算协议模式的可选性。
 *
 * - `tcp` 恒可用（唯一在 realm 与 TLS 下都合法的模式）；
 * - `realm` 不能只开 UDP，但可以 `both`（它本来就双开）；
 * - `tls` 加密链只走 TCP，`udp` 与 `both` 都禁用。
 *
 * 未知引擎按 `native`、未知 transport 按 `none` 处理，与各自模块的回落一致。
 */
export function protocolAvailable(
  engine: unknown,
  transport?: unknown,
): ProtocolAvailability {
  const realm = normalizeEngine(engine) === "realm";
  const tls = isTlsTransport(transport);
  return {
    tcp: true,
    udp: !realm && !tls,
    both: !tls,
  };
}
