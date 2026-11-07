import { ApiError, type OutboundProtocol } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { t } from "@/i18n";

/**
 * 出站协议的契约常量（与后端白名单一致）。
 *
 * 组件的下拉框、表单校验与表格展示都从这里取值，避免 whitelist 散落。
 */
export const OUTBOUND_PROTOCOLS = [
  "socks",
  "http",
  "vmess",
  "vless",
  "trojan",
  "shadowsocks",
  "freedom",
  "blackhole",
] as const;

/** tag 只能是小写字母、数字、- 与 _，长度 1–32。 */
export const OUTBOUND_TAG_PATTERN = /^[a-z0-9_-]{1,32}$/;

/** 内置出站与系统规则占用的 tag，自定义出站不能占用。 */
export const RESERVED_OUTBOUND_TAGS = ["direct", "blocked", "api"] as const;

/** Radix Select 不接受空字符串 item，用哨兵表示「不限入站」。 */
export const ANY_INBOUND_TAG = "__any__";

export function isOutboundProtocol(value: string): value is OutboundProtocol {
  return (OUTBOUND_PROTOCOLS as readonly string[]).includes(value);
}

export function isReservedOutboundTag(value: string): boolean {
  return (RESERVED_OUTBOUND_TAGS as readonly string[]).includes(value);
}

/** 表格里的协议列；技术名保留大写，未知值原样兜底。 */
export function outboundProtocolLabel(value: string): string {
  return isOutboundProtocol(value) ? value.toUpperCase() : value;
}

/**
 * 协议对应的最小配置示例，仅作为 config 输入框的 placeholder。
 *
 * 不会自动写入 textarea：用户必须自己确认配置内容，避免把示例误保存成真实出站。
 * 所有示例都按 Xray 出站的真实层级书写：业务参数放在顶层 `settings` 下，
 * 传输层放在顶层 `stream` 下；`tag` / `protocol` 由后端按数据库值注入，示例里不写。
 */
const UUID_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

const TLS_STREAM = {
  network: "tcp",
  security: "tls",
  tlsSettings: { serverName: "example.com" },
};

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function outboundConfigPlaceholder(
  protocol: OutboundProtocol,
): string {
  switch (protocol) {
    case "socks":
      return prettyJson({
        settings: {
          servers: [{ address: "1.2.3.4", port: 1080 }],
        },
      });
    case "http":
      return prettyJson({
        settings: {
          servers: [{ address: "1.2.3.4", port: 8080 }],
        },
      });
    case "vmess":
      return prettyJson({
        settings: {
          vnext: [
            {
              address: "1.2.3.4",
              port: 443,
              users: [
                {
                  id: UUID_PLACEHOLDER,
                  security: "auto",
                },
              ],
            },
          ],
        },
        streamSettings: TLS_STREAM,
      });
    case "vless":
      return prettyJson({
        settings: {
          vnext: [
            {
              address: "1.2.3.4",
              port: 443,
              users: [
                {
                  id: UUID_PLACEHOLDER,
                  encryption: "none",
                },
              ],
            },
          ],
        },
        streamSettings: TLS_STREAM,
      });
    case "trojan":
      return prettyJson({
        settings: {
          servers: [
            { address: "1.2.3.4", port: 443, password: "***" },
          ],
        },
        streamSettings: TLS_STREAM,
      });
    case "shadowsocks":
      return prettyJson({
        settings: {
          servers: [
            {
              address: "1.2.3.4",
              port: 8388,
              method: "aes-256-gcm",
              password: "***",
            },
          ],
        },
      });
    case "freedom":
    case "blackhole":
      return prettyJson({ settings: {} });
  }
}

/**
 * 出站 / 路由接口的错误文案。
 *
 * 后端可能还没上线：404 统一翻译成「接口暂未就绪」，其它错误保留后端中文。
 */
export function outboundErrorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status === 404) {
    return t("outbounds.notReady");
  }
  return errorText(error, fallback);
}

/** 路由规则的展示顺序：sort_order → created_at → id，保证同序时也稳定。 */
export function compareRoutingRules(
  a: { sort_order: number; created_at: number; id: string },
  b: { sort_order: number; created_at: number; id: string },
): number {
  return (
    a.sort_order - b.sort_order ||
    a.created_at - b.created_at ||
    a.id.localeCompare(b.id)
  );
}
