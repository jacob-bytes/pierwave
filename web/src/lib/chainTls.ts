/**
 * 链的跳间加密（hop-to-hop TLS）纯逻辑：不依赖 React / DOM。
 *
 * 与后端契约（`crates/domain/src/hop_transport.rs`）对齐：
 * - `transport = tls` 只允许 realm 引擎、至少 2 组；
 * - 入口组（seq 0）的监听始终是明文，不允许证书；
 * - seq >= 1 的每组都必须带证书；
 * - 加密链不能同时开 UDP；
 * - `target_error` 是稳定的英文短串，由前端翻译；未知值不显示。
 */

import { normalizeEngine } from "./engines.ts";

export const CHAIN_TRANSPORTS = ["none", "tls"] as const;

export type ChainTransport = (typeof CHAIN_TRANSPORTS)[number];

export const DEFAULT_CHAIN_TRANSPORT: ChainTransport = "none";

/** 加密链的最少组数：入口组只管出站，至少还要一个加密落点。 */
export const CHAIN_TLS_MIN_GROUPS = 2;

/** 后端 `ForwardStatus.target_error` 的六个稳定短串。 */
export const TLS_ERROR_CODES = [
  "tcp_connect_failed",
  "cert_expired",
  "unknown_issuer",
  "name_mismatch",
  "handshake_failed",
  "timeout",
] as const;

export type TlsErrorCode = (typeof TLS_ERROR_CODES)[number];

/** 后端 / 旧数据可能出现的任意值；未知值视为明文。 */
export function normalizeTransport(value: unknown): ChainTransport {
  return value === "tls" ? "tls" : "none";
}

export function isTlsTransport(value: unknown): boolean {
  return normalizeTransport(value) === "tls";
}

/**
 * 开关是否可用：只有 realm 引擎、且至少 2 组的链才有「跳间链路」。
 *
 * 未知引擎（含旧后端缺失字段）按 `native` 处理，与 `normalizeEngine` 一致。
 */
export function tlsAvailable(engine: unknown, groupCount: number): boolean {
  return (
    normalizeEngine(engine) === "realm" &&
    groupCount >= CHAIN_TLS_MIN_GROUPS
  );
}

/**
 * 该组（0 起的 seq）是否需要绑定证书。
 * 入口组（seq 0）不显示证书字段；seq >= 1 必须选。
 */
export function needsCert(groupSeq: number): boolean {
  return groupSeq >= 1;
}

/** `target_error` 短串 → i18n 键；未知 / 空值返回 null，界面不渲染。 */
export function tlsErrorKey(code: unknown): string | null {
  if (typeof code !== "string") return null;
  const value = code.trim();
  return (TLS_ERROR_CODES as readonly string[]).includes(value)
    ? `chains.tlsError.${value}`
    : null;
}

export type TlsIssue =
  | {
      kind: "group_count";
      count: number;
      min: number;
    }
  | {
      kind: "udp_conflict";
    }
  | {
      kind: "cert_forbidden";
      groupSeq: number;
    }
  | {
      kind: "cert_missing";
      groupSeq: number;
    };

/** `validateTls` 只读表单里与加密有关的字段，方便直接单测。 */
export interface TlsFormLike {
  transport?: string | null;
  udp?: boolean | null;
  groups?: readonly {
    cert_id?: string | null;
  }[] | null;
}

/**
 * 保存前的加密规则校验。
 *
 * 返回的 issue 由表单 schema 翻译成当前语言的文案，并挂到对应字段：
 * - `group_count` → `groups` 根（加密至少 2 组）；
 * - `udp_conflict` → `udp`；
 * - `cert_forbidden` / `cert_missing` → `groups[seq].cert_id`。
 *
 * 非 tls 时直接返回空列表：明文链允许入口组没有证书，也不限制组数。
 */
export function validateTls(form: TlsFormLike): TlsIssue[] {
  if (!isTlsTransport(form.transport)) return [];

  const groups = form.groups ?? [];
  const issues: TlsIssue[] = [];

  if (groups.length < CHAIN_TLS_MIN_GROUPS) {
    issues.push({
      kind: "group_count",
      count: groups.length,
      min: CHAIN_TLS_MIN_GROUPS,
    });
  }

  if (form.udp) {
    issues.push({ kind: "udp_conflict" });
  }

  groups.forEach((group, groupSeq) => {
    const certId = (group.cert_id ?? "").trim();
    if (groupSeq === 0) {
      if (certId) issues.push({ kind: "cert_forbidden", groupSeq });
      return;
    }
    if (!certId) issues.push({ kind: "cert_missing", groupSeq });
  });

  return issues;
}
