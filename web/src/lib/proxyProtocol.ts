/**
 * PROXY protocol v2 开关的纯逻辑：可见性、可用性、提交时的归一化。
 *
 * 该开关只对 **TCP + native** 有意义：
 * - UDP / both 的数据报没有「首包前插头」的位置；
 * - realm / nftables / tunnel 不在用户态持有到目标的连接，无法注入头。
 *
 * 后端会再次校验并返回稳定错误码；这里保证界面不会提交一个必然 400 的组合。
 */

/**
 * 当前协议 / 引擎 / 跳数是否允许开启 PROXY protocol v2。
 *
 * 第三个参数只在链上使用：多跳链的落地只能看到上一跳地址，语义与
 * 「真实来源」不符，后端会返回 `chain.proxy_protocol_requires_single_hop`。
 * 缺省 1 保持独立转发（本身单跳）的旧调用不变。
 */
export function proxyProtocolAvailable(
  protocol: unknown,
  engine: unknown,
  hops: number = 1,
): boolean {
  return protocol === "tcp" && engine === "native" && hops === 1;
}

/**
 * 提交前的归一化：只有「用户开启 + 组合合法」才发送 true。
 *
 * 用户在切换协议 / 引擎 / 跳数的瞬间可能还留着旧的开启状态；归一化保证
 * 请求要么是合法的 true，要么明确是 false，不会把非法组合发给后端。
 */
export function normalizeProxyProtocol(
  value: unknown,
  protocol: unknown,
  engine: unknown,
  hops: number = 1,
): boolean {
  return value === true && proxyProtocolAvailable(protocol, engine, hops);
}

/** 列表徽标只在开关真正打开时显示；旧后端缺失 / false 都不显示。 */
export function proxyProtocolBadgeVisible(value: unknown): boolean {
  return value === true;
}
