/**
 * 节点协议 × 传输 × 安全层的能力表。
 *
 * 后端只校验三个枚举各自在不在白名单里，组合是否可用由前端负责；
 * 所有联动规则都必须从这里派生，组件里不许再散落 if/else。
 *
 * 约束：
 * - REALITY 只允许走 TCP（与后端配置生成 / 订阅的假设一致）；
 * - VMess 不支持 REALITY，Shadowsocks 不支持 TLS/REALITY；
 * - SOCKS 只支持 TCP/WS/gRPC，其余协议覆盖全部传输方式。
 */

import { SS_DEFAULT_METHOD, SS_DEFAULT_NETWORK } from "@/lib/shadowsocks";

export const NODE_PROTOCOLS = [
  "vless",
  "vmess",
  "trojan",
  "shadowsocks",
  "socks",
  "http",
] as const;

export const NODE_TRANSPORTS = [
  "tcp",
  "ws",
  "grpc",
  "http",
  "h2",
  "quic",
  "kcp",
  "httpupgrade",
  "xhttp",
] as const;

export const NODE_SECURITIES = ["none", "tls", "reality"] as const;

export type NodeProtocol = (typeof NODE_PROTOCOLS)[number];
export type NodeTransport = (typeof NODE_TRANSPORTS)[number];
export type NodeSecurity = (typeof NODE_SECURITIES)[number];

export type ProtocolMatrix = Record<
  NodeProtocol,
  Partial<Record<NodeTransport, readonly NodeSecurity[]>>
>;

/** 值 = 该 (协议, 传输) 下允许的安全层。数组顺序就是下拉框顺序。 */
export const PROTOCOL_MATRIX: ProtocolMatrix = {
  vless: {
    tcp: ["none", "tls", "reality"],
    ws: ["none", "tls"],
    grpc: ["none", "tls"],
    http: ["none", "tls"],
    h2: ["none", "tls"],
    quic: ["tls"],
    kcp: ["none"],
    httpupgrade: ["none", "tls"],
    xhttp: ["none", "tls"],
  },
  vmess: {
    tcp: ["none", "tls"],
    ws: ["none", "tls"],
    grpc: ["none", "tls"],
    http: ["none", "tls"],
    h2: ["none", "tls"],
    quic: ["tls"],
    kcp: ["none"],
    httpupgrade: ["none", "tls"],
    xhttp: ["none", "tls"],
  },
  trojan: {
    tcp: ["none", "tls", "reality"],
    ws: ["tls"],
    grpc: ["tls"],
    http: ["tls"],
    h2: ["tls"],
    quic: ["tls"],
    kcp: ["tls"],
    httpupgrade: ["tls"],
    xhttp: ["tls"],
  },
  shadowsocks: {
    tcp: ["none"],
    ws: ["none"],
    grpc: ["none"],
    http: ["none"],
    h2: ["none"],
    quic: ["none"],
    kcp: ["none"],
    httpupgrade: ["none"],
    xhttp: ["none"],
  },
  socks: {
    tcp: ["none", "tls"],
    ws: ["none", "tls"],
    grpc: ["none", "tls"],
  },
  http: {
    tcp: ["none", "tls"],
    ws: ["none", "tls"],
    grpc: ["none", "tls"],
    http: ["none", "tls"],
    h2: ["none", "tls"],
    quic: ["tls"],
    kcp: ["none"],
    httpupgrade: ["none", "tls"],
    xhttp: ["none", "tls"],
  },
};

export function isNodeProtocol(value: string): value is NodeProtocol {
  return (NODE_PROTOCOLS as readonly string[]).includes(value);
}

export function isNodeTransport(value: string): value is NodeTransport {
  return (NODE_TRANSPORTS as readonly string[]).includes(value);
}

export function isNodeSecurity(value: string): value is NodeSecurity {
  return (NODE_SECURITIES as readonly string[]).includes(value);
}

/** 协议下所有可用传输；传 security 时只看该安全层支持的传输。 */
export function allowedTransports(
  protocol: NodeProtocol,
  security?: NodeSecurity,
): NodeTransport[] {
  const row = PROTOCOL_MATRIX[protocol];
  return NODE_TRANSPORTS.filter((transport) => {
    const securities = row[transport];
    if (!securities) return false;
    return security ? securities.includes(security) : true;
  });
}

/** 某 (协议, 传输) 下允许的安全层。未知组合返回空数组。 */
export function allowedSecurities(
  protocol: NodeProtocol,
  transport: NodeTransport,
): NodeSecurity[] {
  return [...(PROTOCOL_MATRIX[protocol][transport] ?? [])];
}

export function isCombinationAllowed(
  protocol: NodeProtocol,
  transport: NodeTransport,
  security: NodeSecurity,
): boolean {
  return PROTOCOL_MATRIX[protocol][transport]?.includes(security) ?? false;
}

/** 切换协议时的默认传输：取能力表里第一个可用的。 */
export function defaultTransport(protocol: NodeProtocol): NodeTransport {
  return allowedTransports(protocol)[0] ?? "tcp";
}

/** 切换协议/传输时的默认安全层：取能力表里第一个可用的。 */
export function defaultSecurity(
  protocol: NodeProtocol,
  transport: NodeTransport,
): NodeSecurity {
  return allowedSecurities(protocol, transport)[0] ?? "none";
}

const PROTOCOL_LABELS: Record<NodeProtocol, string> = {
  vless: "VLESS",
  vmess: "VMESS",
  trojan: "TROJAN",
  shadowsocks: "SHADOWSOCKS",
  socks: "SOCKS",
  http: "HTTP",
};

const TRANSPORT_LABELS: Record<NodeTransport, string> = {
  tcp: "TCP",
  ws: "WS",
  grpc: "gRPC",
  http: "HTTP",
  h2: "H2",
  quic: "QUIC",
  kcp: "mKCP",
  httpupgrade: "HTTPUpgrade",
  xhttp: "XHTTP",
};

const SECURITY_LABELS: Record<NodeSecurity, string> = {
  none: "NONE",
  tls: "TLS",
  reality: "REALITY",
};

export function protocolLabel(value: string): string {
  return isNodeProtocol(value) ? PROTOCOL_LABELS[value] : value.toUpperCase();
}

export function transportLabel(value: string): string {
  return isNodeTransport(value) ? TRANSPORT_LABELS[value] : value.toUpperCase();
}

export function securityLabel(value: string): string {
  return isNodeSecurity(value) ? SECURITY_LABELS[value] : value.toUpperCase();
}

/** 表格里的 `VLESS · TCP · REALITY`。 */
export function nodeSummary(
  protocol: string,
  transport: string,
  security: string,
): string {
  return `${protocolLabel(protocol)} · ${transportLabel(transport)} · ${securityLabel(security)}`;
}

const TRANSPORT_SETTINGS: Partial<
  Record<NodeTransport, readonly [string, Record<string, unknown>]>
> = {
  ws: ["wsSettings", { path: "/" }],
  grpc: ["grpcSettings", { serviceName: "" }],
  http: ["httpSettings", { path: "/" }],
  h2: ["httpSettings", { path: "/" }],
  quic: ["quicSettings", { security: "none", key: "" }],
  kcp: [
    "kcpSettings",
    {
      mtu: 1350,
      tti: 50,
      uplinkCapacity: 5,
      downlinkCapacity: 20,
      congestion: false,
      readBufferSize: 1,
      writeBufferSize: 1,
      header: { type: "none" },
      seed: "",
    },
  ],
  httpupgrade: ["httpupgradeSettings", { path: "/", host: "" }],
  xhttp: ["xhttpSettings", { path: "/" }],
};

function protocolSettings(protocol: NodeProtocol): Record<string, unknown> {
  switch (protocol) {
    case "vless":
      return { clients: [], decryption: "none" };
    case "vmess":
    case "trojan":
      return { clients: [] };
    case "shadowsocks":
      return {
        method: SS_DEFAULT_METHOD,
        password: "",
        network: SS_DEFAULT_NETWORK,
      };
    case "socks":
      return { auth: "noauth", udp: false };
    case "http":
      return { accounts: [] };
  }
}

/**
 * 生成后端 `config` 字段的最小可用骨架（只含 settings 与 stream）。
 *
 * 后端会把 tag/port/protocol 覆盖成数据库字段，所以这里不生成这三项；
 * 用户之后可以在对话框里手动补齐证书、REALITY 私钥、WS 路径等。
 */
export function buildConfigSkeleton(
  protocol: NodeProtocol,
  transport: NodeTransport,
  security: NodeSecurity,
): Record<string, unknown> {
  const stream: Record<string, unknown> = {
    network: transport,
    security,
  };

  const transportSettings = TRANSPORT_SETTINGS[transport];
  if (transportSettings) {
    const [key, value] = transportSettings;
    stream[key] = structuredClone(value);
  }

  if (security === "tls") {
    stream.tlsSettings = {
      serverName: "",
      certificates: [{ certificateFile: "", keyFile: "" }],
    };
  }

  if (security === "reality") {
    stream.realitySettings = {
      show: false,
      dest: "www.example.com:443",
      xver: 0,
      serverNames: ["www.example.com"],
      privateKey: "",
      shortIds: [""],
    };
  }

  return {
    settings: protocolSettings(protocol),
    // Xray 的字段名是 streamSettings；后端也兼容历史的 stream 写法
    streamSettings: stream,
  };
}
