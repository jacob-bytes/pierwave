/**
 * 服务器网卡选择的纯逻辑。
 *
 * 后端只保证 `interfaces` 是「该服务器最近一次上报的网卡」：
 * 从未上报过时 `nic_unverified` 为 true 且列表为空；上报过但没有网卡时
 * 列表是空数组。表单禁用文案与小标色调都从这里派生，页面不各自判断。
 */

/** 后端上报的单块网卡；字段可能来自旧后端，读取时按脏数据兜底。 */
export interface NicInterface {
  name: string;
  addresses?: readonly string[] | null;
}

/** `nicState()` 只关心这三个字段，测试可以只构造需要的部分。 */
export interface NicServerLike {
  nic_name?: string | null;
  interfaces?: readonly NicInterface[] | null;
  nic_unverified?: boolean | null;
}

/** 下拉选项：`label` 已拼好「eth0 · 10.0.0.2」。 */
export interface NicOption {
  name: string;
  label: string;
  addresses: string[];
}

/**
 * 表单 / 小标的四种状态：
 * - `unverified`：服务器从未上报网卡（或选的网卡已不在最新列表里）；
 * - `empty`：上报过，但没有任何可用网卡；
 * - `unset`：有可选网卡，但当前是「不限制」；
 * - `verified`：已选网卡仍在最新列表里。
 */
export type NicState = "unset" | "verified" | "unverified" | "empty";

/** 小标色调；`warning` 只用于无法校验的选择。 */
export type NicBadgeTone = "default" | "warning" | "muted";

const EMPTY_OPTIONS: NicOption[] = [];

/**
 * 把上报的网卡列表归一化成下拉选项。
 *
 * - 去首尾空格、丢掉空名；同名网卡只保留第一次上报；
 * - 地址同样去空白、丢空值，多个地址用逗号连接；
 * - 没有地址时 `label` 只显示网卡名，不留下孤零零的分隔符。
 */
export function nicOptions(
  interfaces: readonly NicInterface[] | null | undefined,
): NicOption[] {
  if (!Array.isArray(interfaces) || interfaces.length === 0) {
    return EMPTY_OPTIONS;
  }

  const seen = new Set<string>();
  const options: NicOption[] = [];

  for (const item of interfaces) {
    if (!item || typeof item.name !== "string") continue;

    const name = item.name.trim();
    if (name === "" || seen.has(name)) continue;
    seen.add(name);

    const addresses = Array.isArray(item.addresses)
      ? (item.addresses as readonly unknown[])
          .filter((address): address is string => typeof address === "string")
          .map((address) => address.trim())
          .filter((address) => address !== "")
      : [];

    options.push({
      name,
      addresses,
      label: addresses.length > 0 ? `${name} · ${addresses.join(", ")}` : name,
    });
  }

  return options.length > 0 ? options : EMPTY_OPTIONS;
}

/** 归一化已选网卡名：null / 空串 / 全空白都表示「不限制」。 */
export function nicLabel(nicName: string | null | undefined): string | null {
  if (typeof nicName !== "string") return null;
  const trimmed = nicName.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 由服务器数据推导状态。
 *
 * 注意 `interfaces` 缺失（旧后端）与空数组是两回事：
 * 缺失时无法校验，按 `unverified` 处理；空数组是「明确没有网卡」。
 */
export function nicState(server: NicServerLike): NicState {
  if (server.nic_unverified === true) return "unverified";
  if (!Array.isArray(server.interfaces)) return "unverified";

  const options = nicOptions(server.interfaces);
  const selected = nicLabel(server.nic_name);

  if (selected === null) {
    return options.length === 0 ? "empty" : "unset";
  }
  if (options.length === 0) return "empty";

  return options.some((option) => option.name === selected)
    ? "verified"
    : "unverified";
}

/** 小标色调：只有无法校验的选择需要 warning。 */
export function nicBadgeTone(state: NicState): NicBadgeTone {
  switch (state) {
    case "verified":
      return "default";
    case "unverified":
      return "warning";
    case "unset":
    case "empty":
      return "muted";
  }
}
