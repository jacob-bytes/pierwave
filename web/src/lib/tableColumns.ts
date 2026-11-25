import type { TFunction } from "../i18n/index.ts";

/**
 * 服务器表的列定义：真实表头与加载骨架共用同一份顺序、可见性和近似宽度。
 *
 * 之前骨架固定画 12 列等宽，真实表在 1440 宽度只有 11 列（模式列要 2xl），
 * 加载完成时列数 / 列宽都会跳一下。把列元数据收在这里，骨架直接复用。
 *
 * Column metadata shared by the real table header and its skeleton. Keeping one
 * source of truth prevents the column count / widths from jumping when loading
 * finishes (the mode column is hidden below 2xl, etc.).
 */
export const SERVER_TABLE_COLUMN_KEYS = [
  "select",
  "name",
  "address",
  "mode",
  "status",
  "xray",
  "heartbeat",
  "version",
  "load",
  "memory",
  "rate",
  "actions",
] as const;

export type ServerTableColumnKey = (typeof SERVER_TABLE_COLUMN_KEYS)[number];

export interface ServerTableColumn {
  key: ServerTableColumnKey;
  label: string;
  /** 真实表头的附加类（响应式可见性 / 对齐）。 */
  headClassName: string;
  /** 骨架单元格的响应式可见性与近似宽度。 */
  skeletonClassName: string;
  /** 骨架条自身的宽度。 */
  skeletonWidth: string;
  /** 表头 title；用于解释「Agent 版本」里还带配置版本。 */
  title?: string;
  sticky?: "left" | "right";
}

export function serverTableColumns(t: TFunction): ServerTableColumn[] {
  return [
    {
      key: "select",
      label: "",
      // 真实列宽必须就是 40px：名称列用 left-10 贴住它，列宽被压窄会让
      // sticky 名称列右移、盖住地址列。
      headClassName: "w-10 min-w-10 pr-0",
      skeletonClassName: "w-10 min-w-10",
      skeletonWidth: "w-4",
      sticky: "left",
    },
    {
      key: "name",
      label: t("common.name"),
      // 紧贴复选框列固定：复选框列 40px（w-10），所以 left-10。
      // w-52 给出目标宽度、max-w-52 防止 auto layout 按内容把列撑宽；
      // 右侧 1px 分隔线由 index.css 的 .pw-sticky-name 画。
      headClassName: "left-10 w-52 max-w-52 pw-sticky-name",
      skeletonClassName: "w-52 max-w-52",
      skeletonWidth: "w-28",
      sticky: "left",
    },
    {
      key: "address",
      label: t("common.address"),
      // 地址列至少 160px，IPv6 可以继续撑宽；名称列收窄后地址是唯一
      // 需要「完整可读」的标识列。
      headClassName: "hidden lg:table-cell min-w-40",
      skeletonClassName: "hidden lg:table-cell w-40 min-w-40",
      skeletonWidth: "w-28",
    },
    {
      key: "mode",
      label: t("servers.mode.column"),
      headClassName: "hidden 2xl:table-cell",
      skeletonClassName: "hidden 2xl:table-cell w-24",
      skeletonWidth: "w-14",
    },
    {
      key: "status",
      label: t("common.status"),
      headClassName: "",
      skeletonClassName: "w-24",
      skeletonWidth: "w-14",
    },
    {
      key: "xray",
      label: "Xray",
      headClassName: "",
      skeletonClassName: "w-20",
      skeletonWidth: "w-12",
    },
    {
      key: "heartbeat",
      label: t("servers.detail.lastHeartbeat"),
      headClassName: "",
      skeletonClassName: "w-28",
      skeletonWidth: "w-16",
    },
    {
      key: "version",
      label: t("servers.agentVersion"),
      title: t("servers.detail.configVersion"),
      headClassName: "hidden xl:table-cell",
      skeletonClassName: "hidden xl:table-cell w-40",
      skeletonWidth: "w-20",
    },
    {
      key: "load",
      label: t("servers.detail.load"),
      headClassName: "hidden text-right xl:table-cell",
      skeletonClassName: "hidden text-right xl:table-cell w-16",
      skeletonWidth: "w-8",
    },
    {
      key: "memory",
      label: t("servers.detail.memory"),
      headClassName: "hidden text-right xl:table-cell",
      skeletonClassName: "hidden text-right xl:table-cell w-28",
      skeletonWidth: "w-16",
    },
    {
      key: "rate",
      label: t("servers.detail.rate"),
      headClassName: "hidden whitespace-nowrap text-right xl:table-cell",
      skeletonClassName: "hidden whitespace-nowrap text-right xl:table-cell w-32",
      skeletonWidth: "w-20",
    },
    {
      key: "actions",
      label: t("common.actions"),
      headClassName: "",
      skeletonClassName: "w-24",
      skeletonWidth: "w-10",
      sticky: "right",
    },
  ];
}
