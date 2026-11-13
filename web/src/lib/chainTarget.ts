/**
 * 建链时的「目标」便捷路径：从已纳管的节点里挑一个，把它所在服务器的地址
 * 与节点端口填进 `target_host` / `target_port`。纯逻辑，不依赖 React / DOM。
 *
 * 节点只是填值，不改链的保存契约：落库仍然是 `target_host` + `target_port`。
 */

/** 匹配 / 回填需要的最小节点形状（`GET /api/v1/nodes` 的 `NodeSummary`）。 */
export interface ChainTargetNode {
  id: string;
  /** 节点名，用于下拉展示。 */
  name?: string;
  /** 所属服务器名，用于下拉展示。 */
  server_name?: string;
  /** 所属服务器地址；主控在节点列表响应里 join servers 带出。 */
  server_address: string;
  /** 节点监听端口，代理服务通常就跑在这个端口上。 */
  port: number;
}

/** 选中节点后要写回表单的两个字段。 */
export interface ChainTargetValue {
  target_host: string;
  target_port: number;
}

/**
 * 地址比较口径：去首尾空白、忽略大小写、IPv6 的方括号不参与比较。
 * 不做完整 IPv6 规范化（`2001:0db8::1` 与 `2001:db8::1` 视为不同写法），
 * 避免在纯前端引入一套地址解析器。
 */
function normalizeHost(value: string): string {
  let host = value.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]") && host.length > 2) {
    host = host.slice(1, -1);
  }
  return host;
}

/** 端口必须是 1–65535 的整数；字符串形态（表单值）也接受。 */
function normalizePort(value: number | string): number | null {
  const port = typeof value === "string" ? Number(value.trim()) : value;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

/**
 * 在节点列表里找「服务器地址 + 节点端口」恰好等于当前目标的那一个。
 *
 * 只按端口猜会把同一端口的多台节点混在一起，所以必须地址与端口同时相等。
 * 返回列表中的第一个命中项（节点列表本身按服务器、创建时间排序）。
 */
export function matchTargetNode<T extends ChainTargetNode>(
  targetHost: string,
  targetPort: number | string,
  nodes: readonly T[],
): T | undefined {
  const host = normalizeHost(targetHost);
  const port = normalizePort(targetPort);
  if (host === "" || port === null) return undefined;

  return nodes.find((node) => {
    const nodePort = normalizePort(node.port);
    if (nodePort === null || nodePort !== port) return false;
    return normalizeHost(node.server_address) === host;
  });
}

/**
 * 选中节点后回填的值：服务器地址（去首尾空白）+ 节点端口。
 * 地址保持服务器上登记的写法，不在这里改写（例如 IPv6 是否带方括号）。
 */
export function nodeTargetValue(node: ChainTargetNode): ChainTargetValue {
  return {
    target_host: node.server_address.trim(),
    target_port: node.port,
  };
}
