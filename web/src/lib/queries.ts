import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  api,
  ApiError,
  type AgentUpgrade,
  type AgentUpgradeBatch,
  type AgentUpgradeBatchDetail,
  type AgentUpgradeInput,
  type AlertTestResponse,
  type ApplyResult,
  type AuditListQuery,
  type BackupInfo,
  type BindUserPackageInput,
  type Certificate,
  type ChangePasswordInput,
  type Chain,
  type CreateAgentUpgradeBatchInput,
  type CreateCertificateInput,
  type CreateChainInput,
  type CreateForwardInput,
  type CreateNodeInput,
  type CreateOutboundInput,
  type CreatePackageInput,
  type CreateRoutingRuleInput,
  type CreateRuleTemplateInput,
  type CreateServerResponse,
  type CreateUserInput,
  type EnforcementEvent,
  type Forward,
  type Health,
  type MeSummary,
  type MeTraffic,
  type Node,
  type NodeSummary,
  type NodeTraffic,
  type NodeTrafficDetail,
  type Outbound,
  type OverviewData,
  type OverviewStats,
  type Package,
  type PublicStatus,
  type RoutingRule,
  type RuleTemplate,
  type ResetSubscriptionResponse,
  type RestoreBackupResponse,
  type Server,
  type SessionUser,
  type Settings,
  type Subscription,
  type TrafficStats,
  type UpdateChainInput,
  type UpdateForwardInput,
  type UpdateNodeInput,
  type UpdateOutboundInput,
  type UpdatePackageInput,
  type UpdateRoutingRuleInput,
  type UpdateRuleTemplateInput,
  type UpdateServerInput,
  type UpdateSettingsInput,
  type UpdateUserInput,
  type UpdateUserPackageInput,
  type UserPackageView,
  type UserView,
} from "@/lib/api";
import { compareRoutingRules } from "@/lib/outbounds";
import { hasPendingAgentUpgrade } from "@/lib/agentUpgrade";
import { shouldPollAgentBatch } from "@/lib/agentUpgradeBatch";

/** P4：有升级在途时，服务器列表与升级历史的轮询间隔。 */
const AGENT_UPGRADE_POLL_MS = 15_000;

/** P5：批量升级进度面板的轮询间隔。 */
const AGENT_BATCH_POLL_MS = 5_000;

export const queryKeys = {
  me: ["me"] as const,
  meSummary: ["me", "summary"] as const,
  meTraffic: (days: number) => ["me", "traffic", days] as const,
  meEvents: (limit: number) => ["me", "events", limit] as const,
  health: ["health"] as const,
  /** P10：公开状态页；不需要登录态，单独缓存。 */
  publicStatus: ["public-status"] as const,
  statsOverview: ["stats", "overview"] as const,
  /** 概览聚合（P14）：窗口天数进 key，切换窗口即换查询。 */
  overview: (days: number) => ["overview", days] as const,
  statsTraffic: (days: number) => ["stats", "traffic", days] as const,
  statsNodes: (serverId: string, days: number) =>
    ["stats", "nodes", { serverId, days }] as const,
  statsNode: (nodeId: string, days: number, top: number) =>
    ["stats", "node", nodeId, { days, top }] as const,
  servers: ["servers"] as const,
  agentUpgrades: (serverId: string) =>
    ["agent-upgrades", serverId] as const,
  /** P5：批次列表与单批次详情分开缓存，详情轮询不牵动列表。 */
  agentUpgradeBatches: (limit: number) =>
    ["agent-upgrade-batches", limit] as const,
  agentUpgradeBatch: (batchId: string) =>
    ["agent-upgrade-batch", batchId] as const,
  enforcementEvents: (limit: number) =>
    ["enforcement", "events", limit] as const,
  /**
   * 审计日志：筛选条件与每页条数都进 key，切换筛选即换一条查询（列表自动重置）。
   * 分页游标不进 key，由 infinite query 的 `pageParam` 管理。
   */
  auditLog: (query: AuditListQuery) =>
    [
      "audit",
      query.limit,
      query.action ?? "",
      query.actor ?? "",
      query.target ?? "",
    ] as const,
  ruleTemplates: ["rule-templates"] as const,
  nodes: (serverId: string) => ["nodes", serverId] as const,
  /** 全局节点列表：不属于任何单台服务器，单独一个 key。 */
  allNodes: ["nodes", "all"] as const,
  outbounds: (serverId: string) => ["outbounds", serverId] as const,
  forwards: (serverId: string) => ["forwards", serverId] as const,
  /** 转发链是全局资源，与服务器无关，单独一个 key。 */
  chains: ["chains"] as const,
  routingRules: (serverId: string) =>
    ["routing-rules", serverId] as const,
  certificates: ["certificates"] as const,
  users: (q: string) => ["users", { q }] as const,
  /** P6：订阅列表带生效规则模板；与用户列表分开缓存，避免互相污染。 */
  subscriptions: (q: string) => ["subscriptions", { q }] as const,
  packages: ["packages"] as const,
  userPackages: (userId: string) => ["user", userId, "packages"] as const,
  settings: ["settings"] as const,
  /** P7：备份信息（当前库大小 + 待恢复状态），与设置分开缓存。 */
  backupInfo: ["backup", "info"] as const,
};

/** 401 统一由 QueryCache / MutationCache 的全局 onError 处理。 */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

export function useMe() {
  return useQuery<SessionUser>({
    queryKey: queryKeys.me,
    queryFn: async () => (await api.me()).user,
    retry: false,
    staleTime: 60_000,
  });
}

/**
 * 面板名称：登录页与侧边栏都要显示，但未登录时拿不到 /settings，
 * 所以走公开的 /health。拿不到时回落到 "pierwave"，不要让标题空着。
 */
export function usePanelName(): string {
  const health = useHealth();
  const name = health.data?.panel_name?.trim();
  return name && name.length > 0 ? name : "pierwave";
}

export function useHealth() {
  return useQuery<Health>({
    queryKey: queryKeys.health,
    queryFn: api.health,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

/**
 * P10：公开状态页数据。
 *
 * 30 秒自动刷新与后端缓存窗口对齐；`retry: false` 让「开关关闭」的 404
 * 立刻落到「状态页已关闭」空态，而不是先转一圈重试。
 */
export function usePublicStatus() {
  return useQuery<PublicStatus>({
    queryKey: queryKeys.publicStatus,
    queryFn: api.publicStatus,
    retry: false,
    staleTime: 25_000,
    refetchInterval: 30_000,
  });
}

/** 既有概览统计：第一行 KPI 与告警计数。后端接口可能尚未上线，页面自行处理 404 文案。 */
export function useOverviewStats() {
  return useQuery<OverviewStats>({
    queryKey: queryKeys.statsOverview,
    queryFn: api.stats.overview,
    staleTime: 30_000,
  });
}

/**
 * 概览聚合（P14）：图表、协议分布、链路告警与 Top 5。
 *
 * 与 `useOverviewStats` 分开缓存：新接口尚未上线时只让新增卡片降级，
 * 既有 KPI / 告警卡仍可用。`days` 必须为正数。
 */
export function useOverview(days: number) {
  return useQuery<OverviewData>({
    queryKey: queryKeys.overview(days),
    queryFn: () => api.overview.get(days),
    enabled: days > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

/** 近 N 天流量趋势；后端会把缺数据的日期补 0。 */
export function useTraffic(days: number) {
  return useQuery<TrafficStats>({
    queryKey: queryKeys.statsTraffic(days),
    queryFn: () => api.stats.traffic(days),
    enabled: days > 0,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

/**
 * 单台服务器的节点流量列表（P2）。
 *
 * 后端可能暂时 404：这里不重试，由节点列表把失败降级成「—」，
 * 详情 Sheet 再给出可重试的中文错误态。
 */
export function useNodeTraffic(serverId: string, days: number) {
  return useQuery<NodeTraffic[]>({
    queryKey: queryKeys.statsNodes(serverId, days),
    queryFn: async () => (await api.stats.nodes({ days, serverId })).items,
    enabled: Boolean(serverId) && days > 0,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
  });
}

/** 单个节点的流量趋势与 Top 用户（P2）。 */
export function useNodeTrafficDetail(nodeId: string, days: number, top: number) {
  return useQuery<NodeTrafficDetail>({
    queryKey: queryKeys.statsNode(nodeId, days, top),
    queryFn: () => api.stats.nodeDetail(nodeId, { days, top }),
    enabled: Boolean(nodeId) && days > 0,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
  });
}

/** 用户自助摘要。后端接口可能尚未上线，页面自行处理 404 文案。 */
export function useMeSummary() {
  return useQuery<MeSummary>({
    queryKey: queryKeys.meSummary,
    queryFn: api.me.summary,
    staleTime: 15_000,
  });
}

/** 用户自助的近 N 天流量；只统计会话用户自己的节点。 */
export function useMeTraffic(days: number) {
  return useQuery<MeTraffic>({
    queryKey: queryKeys.meTraffic(days),
    queryFn: () => api.me.traffic(days),
    enabled: days > 0,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

/** 自己的断流 / 恢复事件；后端按 `user_id` 过滤，前端不再筛。 */
export function useMeEvents(limit: number) {
  return useQuery<EnforcementEvent[]>({
    queryKey: queryKeys.meEvents(limit),
    queryFn: async () => (await api.me.events(limit)).items,
    enabled: limit > 0,
    staleTime: 30_000,
    retry: false,
  });
}

/** 重置自己的订阅短码：成功后 summary 与事件缓存都要刷新。 */
export function useResetSubscription() {
  const queryClient = useQueryClient();

  return useMutation<ResetSubscriptionResponse, Error, void>({
    mutationFn: () => api.me.resetSubscription(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

/**
 * 面板设置（管理员）。
 *
 * 后端接口可能尚未上线：不重试，由设置页把 404 兜底成中文并给「重试」按钮。
 */
export function useSettings() {
  return useQuery<Settings>({
    queryKey: queryKeys.settings,
    queryFn: async () => (await api.settings.get()).items,
    retry: false,
    staleTime: 60_000,
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();

  return useMutation<Settings, Error, UpdateSettingsInput>({
    mutationFn: async (input) => (await api.settings.patch(input)).items,
    onSuccess: (items) => {
      // PATCH 的返回值就是权威值：直接覆盖缓存，页面再用它 reset 表单。
      queryClient.setQueryData(queryKeys.settings, items);
    },
  });
}

/**
 * P13：发送告警测试消息。
 *
 * 只负责请求；结果在卡片里用 `normalizeAlertTestResults` 归一化，
 * 避免把纯前端逻辑带进入口 chunk（设置页是懒加载的）。
 */
export function useTestAlerts() {
  return useMutation<AlertTestResponse, Error, void>({
    mutationFn: api.alerts.test,
  });
}

/**
 * P7：备份信息（当前库大小 + 是否有待恢复文件）。
 *
 * 后端可能暂时 404：不重试，由备份卡片展示中文错误态与「重试」。
 */
export function useBackupInfo() {
  return useQuery<BackupInfo>({
    queryKey: queryKeys.backupInfo,
    queryFn: api.backup.info,
    retry: false,
    staleTime: 15_000,
  });
}

/**
 * P7：上传备份并安排恢复。
 *
 * 后端只保证 `restart_required`，所以先用文件大小乐观写入 pending，
 * 让卡片立即切到「已就绪」；info 刷新后再用后端的上传时间覆盖。
 */
export function useRestoreBackup() {
  const queryClient = useQueryClient();

  return useMutation<RestoreBackupResponse, Error, File>({
    mutationFn: (file) => api.backup.restore(file),
    onSuccess: (result, file) => {
      if (result.restart_required) {
        queryClient.setQueryData<BackupInfo>(
          queryKeys.backupInfo,
          (current) =>
            current
              ? {
                  ...current,
                  pending: result.pending ?? {
                    uploaded_at: Math.floor(Date.now() / 1_000),
                    bytes: file.size,
                  },
                }
              : current,
        );
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.backupInfo });
    },
  });
}

/** P7：取消待恢复；先清掉缓存里的 pending，再等 info 的权威值。 */
export function useCancelRestore() {
  const queryClient = useQueryClient();

  return useMutation<{ ok: true }, Error, void>({
    mutationFn: api.backup.cancelRestore,
    onSuccess: () => {
      queryClient.setQueryData<BackupInfo>(queryKeys.backupInfo, (current) =>
        current ? { ...current, pending: null } : current,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.backupInfo });
    },
  });
}

/**
 * 修改当前登录用户的密码。
 *
 * 后端会吊销该用户的其它会话、保留当前这条；所以成功后不跳登录，
 * 但缓存里属于旧密码时期的业务数据一律作废（保留 `me`，避免整屏闪回验证会话）。
 */
export function useChangePassword() {
  const queryClient = useQueryClient();

  return useMutation<{ ok: true }, Error, ChangePasswordInput>({
    mutationFn: (input) => api.me.changePassword(input),
    onSuccess: () => {
      // 旧密码时期的业务缓存一律作废；保留 `me` 命名空间（会话与本人自助数据），
      // 避免清空后整屏闪回「正在验证会话」。
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== queryKeys.me[0],
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

export function useServers() {
  return useQuery<Server[]>({
    queryKey: queryKeys.servers,
    queryFn: async () => (await api.servers()).items,
    staleTime: 5_000,
    // 只有存在「已下发但未收敛」的目标版本时才轮询；升级成功后自动停止。
    refetchInterval: (query) =>
      query.state.data?.some(hasPendingAgentUpgrade)
        ? AGENT_UPGRADE_POLL_MS
        : false,
    refetchIntervalInBackground: false,
  });
}

/** P4：修改服务器设置（目前只有「允许下发升级」）。 */
export function useUpdateServer() {
  const queryClient = useQueryClient();

  return useMutation<
    Server,
    Error,
    { id: string; input: UpdateServerInput }
  >({
    mutationFn: async ({ id, input }) => (await api.updateServer(id, input)).server,
    onSuccess: (server) => {
      // PATCH 返回完整 server：合并进缓存，避免列表短暂闪回旧开关。
      queryClient.setQueryData<Server[]>(queryKeys.servers, (current) =>
        current?.map((item) =>
          item.id === server.id ? { ...item, ...server } : item,
        ),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.servers });
    },
  });
}

/**
 * P4：单台服务器的升级历史。
 *
 * 后端可能暂时 404：不重试，由 Dialog 展示可重试的中文错误态；
 * 有 pending 记录时每 15 秒刷新，直到出现 succeeded / failed。
 */
export function useAgentUpgrades(serverId: string, enabled = true) {
  return useQuery<AgentUpgrade[]>({
    queryKey: queryKeys.agentUpgrades(serverId),
    queryFn: async () => (await api.agentUpgrades.list(serverId)).items,
    enabled: Boolean(serverId) && enabled,
    staleTime: 5_000,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.some((item) => item.status === "pending")
        ? AGENT_UPGRADE_POLL_MS
        : false,
  });
}

/** P4：下发 Agent 升级；成功后立刻在列表上标出目标版本，让轮询启动。 */
export function useTriggerAgentUpgrade(serverId: string) {
  const queryClient = useQueryClient();

  return useMutation<AgentUpgrade, Error, AgentUpgradeInput>({
    mutationFn: async (input) =>
      (await api.agentUpgrades.create(serverId, input)).upgrade,
    onSuccess: (upgrade, input) => {
      const target = upgrade.to_version || input.version;
      if (target) {
        // 不立刻 invalidate：后端刚写入时列表可能还没读到目标版本，
        // 过早刷新会把乐观标记冲掉、让轮询停掉。等 15 秒后的轮询取权威值。
        queryClient.setQueryData<Server[]>(queryKeys.servers, (current) =>
          current?.map((server) =>
            server.id === serverId
              ? { ...server, agent_target_version: target }
              : server,
          ),
        );
      } else {
        void queryClient.invalidateQueries({ queryKey: queryKeys.servers });
      }
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agentUpgrades(serverId),
      });
    },
  });
}

/**
 * P5：批量升级批次列表，按创建时间倒序。
 *
 * 后端可能暂时 404：不重试，由进度面板展示可重试的中文错误态。
 */
export function useAgentUpgradeBatches(limit = 20, enabled = true) {
  return useQuery<AgentUpgradeBatch[]>({
    queryKey: queryKeys.agentUpgradeBatches(limit),
    queryFn: async () => (await api.agentUpgradeBatches.list(limit)).items,
    enabled,
    staleTime: 5_000,
    retry: false,
  });
}

/**
 * P5：单批次详情（批次 + 每台结果）。
 *
 * 批次还在 running、或还有 queued/running 的服务器时每 5 秒刷新一次；
 * 批次与所有服务器都进入终态后自动停止轮询。
 */
export function useAgentUpgradeBatch(batchId: string, enabled = true) {
  return useQuery<AgentUpgradeBatchDetail>({
    queryKey: queryKeys.agentUpgradeBatch(batchId),
    queryFn: () => api.agentUpgradeBatches.get(batchId),
    enabled: Boolean(batchId) && enabled,
    staleTime: 1_000,
    retry: false,
    refetchInterval: (query) => {
      const detail = query.state.data;
      if (!detail) return false;
      return shouldPollAgentBatch(detail.batch.status, detail.items)
        ? AGENT_BATCH_POLL_MS
        : false;
    },
  });
}

/** P5：创建批次；只返回批次本身，进度面板打开后自行拉详情。 */
export function useCreateAgentUpgradeBatch() {
  const queryClient = useQueryClient();

  return useMutation<
    AgentUpgradeBatch,
    Error,
    CreateAgentUpgradeBatchInput
  >({
    mutationFn: async (input) =>
      (await api.agentUpgradeBatches.create(input)).batch,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["agent-upgrade-batches"],
      });
      // 升级流水要等 runner 触发后才写回目标版本，先刷新一次列表，
      // 让已经有目标版本的服务器立刻进入 15 秒轮询。
      void queryClient.invalidateQueries({ queryKey: queryKeys.servers });
    },
  });
}

/** P5：取消批次；剩余排队项由后端标记为 cancelled。 */
export function useCancelAgentUpgradeBatch(batchId: string) {
  const queryClient = useQueryClient();

  return useMutation<AgentUpgradeBatch, Error, void>({
    mutationFn: async () => (await api.agentUpgradeBatches.cancel(batchId)).batch,
    onSuccess: (batch) => {
      // 立刻用返回的批次覆盖详情，让按钮和状态条不用等下一次轮询。
      queryClient.setQueryData<AgentUpgradeBatchDetail>(
        queryKeys.agentUpgradeBatch(batchId),
        (current) => (current ? { ...current, batch } : current),
      );
      void queryClient.invalidateQueries({
        queryKey: ["agent-upgrade-batches"],
      });
    },
  });
}

export function useCreateServer() {
  const queryClient = useQueryClient();

  return useMutation<
    CreateServerResponse,
    Error,
    {
      name: string;
      address: string;
      xray_mode: string;
      /** ISO 3166-1 alpha-2；省略或空串 = 不填。 */
      country_code?: string;
    }
  >({
    mutationFn: api.createServer,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.servers });
    },
  });
}

/** 断流 / 恢复事件，按条数取最新记录；筛选在页面内完成。 */
export function useEnforcementEvents(limit: number) {
  return useQuery<EnforcementEvent[]>({
    queryKey: queryKeys.enforcementEvents(limit),
    queryFn: async () => (await api.enforcement.events(limit)).items,
    enabled: limit > 0,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

/**
 * 审计日志：服务端筛选 + `(created_at, id)` 稳定游标分页（「加载更多」）。
 *
 * `queryKey` 包含全部筛选条件，所以切换分类 / 操作者 / 对象 / 每页条数时
 * 会得到一条全新的查询，列表从第一页重新开始。
 */
export function useAuditLog(query: AuditListQuery) {
  return useInfiniteQuery({
    queryKey: queryKeys.auditLog(query),
    queryFn: ({ pageParam }) => api.audit.list({ ...query, before: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_before ?? undefined,
    enabled: query.limit > 0,
    staleTime: 15_000,
  });
}

/**
 * 管理员维护的规则模板列表。
 *
 * 后端可能暂时 404：这里不重试，由页面展示中文错误态与「重试」；
 * 订阅页的下拉在拿不到列表时保持禁用，链接回落到默认模板。
 */
export function useRuleTemplates() {
  return useQuery<RuleTemplate[]>({
    queryKey: queryKeys.ruleTemplates,
    queryFn: async () => (await api.ruleTemplates.list()).items,
    staleTime: 30_000,
    retry: false,
  });
}

/** 增删改都只影响 `["rule-templates"]`，不动用户、套餐等无关缓存。 */
function invalidateRuleTemplates(
  queryClient: ReturnType<typeof useQueryClient>,
) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.ruleTemplates });
}

export function useCreateRuleTemplate() {
  const queryClient = useQueryClient();

  return useMutation<RuleTemplate, Error, CreateRuleTemplateInput>({
    mutationFn: async (input) =>
      (await api.ruleTemplates.create(input)).template,
    onSuccess: () => invalidateRuleTemplates(queryClient),
  });
}

export function useUpdateRuleTemplate() {
  const queryClient = useQueryClient();

  return useMutation<
    RuleTemplate,
    Error,
    { id: string; input: UpdateRuleTemplateInput }
  >({
    mutationFn: async ({ id, input }) =>
      (await api.ruleTemplates.update(id, input)).template,
    onSuccess: () => invalidateRuleTemplates(queryClient),
  });
}

export function useDeleteRuleTemplate() {
  const queryClient = useQueryClient();

  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => api.ruleTemplates.remove(id),
    onSuccess: () => invalidateRuleTemplates(queryClient),
  });
}

export function useNodes(serverId: string) {
  return useQuery<Node[]>({
    queryKey: queryKeys.nodes(serverId),
    queryFn: async () => (await api.nodes(serverId)).items,
    enabled: Boolean(serverId),
    staleTime: 5_000,
  });
}

/**
 * 全局节点列表（管理员），套餐的节点范围选择器用。
 *
 * 后端接口可能暂时 404：这里不重试，由调用方展示中文错误与「重试」，
 * 并保证「全部节点」这类不依赖该列表的范围仍然可以保存。
 */
export function useAllNodes() {
  return useQuery<NodeSummary[]>({
    queryKey: queryKeys.allNodes,
    queryFn: async () => (await api.nodes.listAll()).items,
    staleTime: 30_000,
    retry: false,
  });
}

export function useCreateNode(serverId: string) {
  const queryClient = useQueryClient();

  return useMutation<Node, Error, CreateNodeInput>({
    mutationFn: async (input) => (await api.createNode(serverId, input)).node,
    onSuccess: () => {
      // 新节点只影响该服务器的节点列表，不碰其它缓存。
      void queryClient.invalidateQueries({
        queryKey: queryKeys.nodes(serverId),
      });
      // 套餐范围选择器读的是跨服务器的全局列表。
      void queryClient.invalidateQueries({ queryKey: queryKeys.allNodes });
      // 证书的引用数变了（删除被引用的证书会被后端拒绝），保持列表新鲜。
      void queryClient.invalidateQueries({
        queryKey: queryKeys.certificates,
      });
    },
  });
}

export function useUpdateNode(serverId: string) {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.nodes(serverId);

  return useMutation<
    Node,
    Error,
    { id: string; input: UpdateNodeInput },
    { previous?: Node[] }
  >({
    mutationFn: async ({ id, input }) => (await api.updateNode(id, input)).node,
    onMutate: async ({ id, input }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<Node[]>(queryKey);

      if (previous) {
        queryClient.setQueryData<Node[]>(
          queryKey,
          previous.map((node) =>
            node.id === id
              ? {
                  ...node,
                  ...(input.enabled !== undefined
                    ? { enabled: input.enabled }
                    : {}),
                  ...(input.name !== undefined ? { name: input.name } : {}),
                  ...(input.port !== undefined ? { port: input.port } : {}),
                  ...(input.config !== undefined
                    ? { config: input.config }
                    : {}),
                  ...(input.cert_id !== undefined
                    ? { cert_id: input.cert_id }
                    : {}),
                  ...(input.bandwidth_kbps !== undefined
                    ? { bandwidth_kbps: input.bandwidth_kbps }
                    : {}),
                }
              : node,
          ),
        );
      }

      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
    onSuccess: (node) => {
      queryClient.setQueryData<Node[]>(queryKey, (current) =>
        current?.map((item) => (item.id === node.id ? node : item)),
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
      // 全局节点列表里的名称 / 启用状态 / 限速也跟着变。
      void queryClient.invalidateQueries({ queryKey: queryKeys.allNodes });
      // 增删节点会改变证书的引用关系。
      void queryClient.invalidateQueries({
        queryKey: queryKeys.certificates,
      });
    },
  });
}

export function useDeleteNode(serverId: string) {
  const queryClient = useQueryClient();

  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => api.deleteNode(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.nodes(serverId),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.allNodes });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.certificates,
      });
    },
  });
}

export function useApplyServer(serverId: string) {
  const queryClient = useQueryClient();

  return useMutation<ApplyResult, Error, void>({
    mutationFn: () => api.applyServer(serverId),
    onSuccess: (result) => {
      // 节点列表可能因 credentials 注入而变化；服务器列表的 config_version 也变了。
      void queryClient.invalidateQueries({
        queryKey: queryKeys.nodes(serverId),
      });
      // 转发规则和 Xray 配置一起随期望态下发，apply 后要重新拉运行时状态。
      void queryClient.invalidateQueries({
        queryKey: queryKeys.forwards(serverId),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.servers });
      queryClient.setQueryData<Server[]>(queryKeys.servers, (current) =>
        current?.map((server) =>
          server.id === serverId
            ? { ...server, config_version: result.config_version }
            : server,
        ),
      );
    },
  });
}

/**
 * 单台服务器的自定义出站。
 *
 * 后端可能暂时 404：不重试，由页面展示中文错误态与「重试」。
 */
export function useOutbounds(serverId: string) {
  return useQuery<Outbound[]>({
    queryKey: queryKeys.outbounds(serverId),
    queryFn: async () => (await api.outbounds.list(serverId)).items,
    enabled: Boolean(serverId),
    staleTime: 5_000,
    retry: false,
  });
}

/** 出站的增删改也会影响路由规则里的出站下拉与引用关系。 */
function invalidateOutboundViews(
  queryClient: ReturnType<typeof useQueryClient>,
  serverId: string,
) {
  void queryClient.invalidateQueries({
    queryKey: queryKeys.outbounds(serverId),
  });
  void queryClient.invalidateQueries({
    queryKey: queryKeys.routingRules(serverId),
  });
}

function applyOutboundInput(
  outbound: Outbound,
  input: UpdateOutboundInput,
): Outbound {
  return {
    ...outbound,
    ...(input.tag !== undefined ? { tag: input.tag } : {}),
    ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
    ...(input.config !== undefined ? { config: input.config } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
  };
}

export function useCreateOutbound(serverId: string) {
  const queryClient = useQueryClient();

  return useMutation<Outbound, Error, CreateOutboundInput>({
    mutationFn: async (input) =>
      (await api.outbounds.create(serverId, input)).outbound,
    onSuccess: () => invalidateOutboundViews(queryClient, serverId),
  });
}

export function useUpdateOutbound(serverId: string) {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.outbounds(serverId);

  return useMutation<
    Outbound,
    Error,
    { id: string; input: UpdateOutboundInput },
    { previous?: Outbound[] }
  >({
    mutationFn: async ({ id, input }) =>
      (await api.outbounds.update(id, input)).outbound,
    onMutate: async ({ id, input }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<Outbound[]>(queryKey);

      if (previous) {
        queryClient.setQueryData<Outbound[]>(
          queryKey,
          previous.map((item) =>
            item.id === id ? applyOutboundInput(item, input) : item,
          ),
        );
      }

      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
    onSuccess: (outbound) => {
      queryClient.setQueryData<Outbound[]>(queryKey, (current) =>
        current?.map((item) => (item.id === outbound.id ? outbound : item)),
      );
    },
    onSettled: () => invalidateOutboundViews(queryClient, serverId),
  });
}

export function useDeleteOutbound(serverId: string) {
  const queryClient = useQueryClient();

  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => api.outbounds.remove(id),
    onSuccess: () => invalidateOutboundViews(queryClient, serverId),
  });
}

/**
 * 单台服务器的端口转发规则。
 *
 * 后端可能暂时 404：不重试，由页面展示中文错误态与「重试」。
 * 写操作成功后统一失效列表，让下一次心跳的 `runtime` 覆盖旧状态。
 */
export function useForwards(serverId: string) {
  return useQuery<Forward[]>({
    queryKey: queryKeys.forwards(serverId),
    queryFn: async () => (await api.forwards.list(serverId)).items,
    enabled: Boolean(serverId),
    staleTime: 5_000,
    retry: false,
  });
}

function invalidateForwardViews(
  queryClient: ReturnType<typeof useQueryClient>,
  serverId: string,
) {
  void queryClient.invalidateQueries({
    queryKey: queryKeys.forwards(serverId),
  });
  // 每次写操作都会推高 config_version，服务器列表也要跟着刷新。
  void queryClient.invalidateQueries({ queryKey: queryKeys.servers });
}

function applyForwardInput(forward: Forward, input: UpdateForwardInput): Forward {
  return {
    ...forward,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.listen_port !== undefined
      ? { listen_port: input.listen_port }
      : {}),
    ...(input.target_host !== undefined
      ? { target_host: input.target_host }
      : {}),
    ...(input.target_port !== undefined
      ? { target_port: input.target_port }
      : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.engine !== undefined ? { engine: input.engine } : {}),
  };
}

export function useCreateForward(serverId: string) {
  const queryClient = useQueryClient();

  return useMutation<Forward, Error, CreateForwardInput>({
    mutationFn: async (input) =>
      (await api.forwards.create(serverId, input)).forward,
    onSuccess: () => invalidateForwardViews(queryClient, serverId),
  });
}

export function useUpdateForward(serverId: string) {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.forwards(serverId);

  return useMutation<
    Forward,
    Error,
    { id: string; input: UpdateForwardInput },
    { previous?: Forward[] }
  >({
    mutationFn: async ({ id, input }) =>
      (await api.forwards.update(id, input)).forward,
    onMutate: async ({ id, input }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<Forward[]>(queryKey);

      if (previous) {
        queryClient.setQueryData<Forward[]>(
          queryKey,
          previous.map((item) =>
            item.id === id ? applyForwardInput(item, input) : item,
          ),
        );
      }

      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
    onSettled: () => {
      // 返回值不带 runtime，合并会丢状态；直接让列表重新拉权威值。
      void invalidateForwardViews(queryClient, serverId);
    },
  });
}

export function useDeleteForward(serverId: string) {
  const queryClient = useQueryClient();

  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => api.forwards.remove(id),
    onSuccess: () => invalidateForwardViews(queryClient, serverId),
  });
}

/**
 * 线性多跳转发链。列表里的 `listening` / `target_ok` 来自 Agent 心跳，
 * 所以写操作完成后让列表重新拉权威值，而不是本地拼接运行时状态。
 */
export function useChains() {
  return useQuery<Chain[]>({
    queryKey: queryKeys.chains,
    queryFn: async () => (await api.chains.list()).items,
    staleTime: 5_000,
    retry: false,
  });
}

function invalidateChainViews(
  queryClient: ReturnType<typeof useQueryClient>,
) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.chains });
  // 每次写操作都会推高所有涉及服务器的 config_version，服务器列表也要刷新。
  void queryClient.invalidateQueries({ queryKey: queryKeys.servers });
}

/**
 * 只合并配置字段：`degraded` / `groups[].members[].listening` 这类运行时状态
 * 由心跳维护，不能用表单值覆盖。组与成员的增删在 `onSettled` 里由重新拉取兜底。
 */
function applyChainInput(chain: Chain, input: UpdateChainInput): Chain {
  return {
    ...chain,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.target_host !== undefined
      ? { target_host: input.target_host }
      : {}),
    ...(input.target_port !== undefined
      ? { target_port: input.target_port }
      : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.engine !== undefined ? { engine: input.engine } : {}),
    ...(input.transport !== undefined
      ? { transport: input.transport }
      : {}),
  };
}

export function useCreateChain() {
  const queryClient = useQueryClient();

  return useMutation<Chain, Error, CreateChainInput>({
    mutationFn: async (input) => (await api.chains.create(input)).chain,
    onSuccess: () => invalidateChainViews(queryClient),
  });
}

export function useUpdateChain() {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.chains;

  return useMutation<
    Chain,
    Error,
    { id: string; input: UpdateChainInput },
    { previous?: Chain[] }
  >({
    mutationFn: async ({ id, input }) =>
      (await api.chains.update(id, input)).chain,
    onMutate: async ({ id, input }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<Chain[]>(queryKey);

      if (previous) {
        queryClient.setQueryData<Chain[]>(
          queryKey,
          previous.map((item) =>
            item.id === id ? applyChainInput(item, input) : item,
          ),
        );
      }

      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
    onSettled: () => {
      // 返回值不含每组成员运行时状态，合并会丢状态；直接让列表重新拉权威值。
      void invalidateChainViews(queryClient);
    },
  });
}

export function useDeleteChain() {
  const queryClient = useQueryClient();

  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => api.chains.remove(id),
    onSuccess: () => invalidateChainViews(queryClient),
  });
}

/** 路由规则列表：统一按 sort_order 排序，后端返回顺序不稳定时也一致。 */
export function useRoutingRules(serverId: string) {
  return useQuery<RoutingRule[]>({
    queryKey: queryKeys.routingRules(serverId),
    queryFn: async () =>
      (await api.routingRules.list(serverId)).items
        .slice()
        .sort(compareRoutingRules),
    enabled: Boolean(serverId),
    staleTime: 5_000,
    retry: false,
  });
}

function applyRoutingRuleInput(
  rule: RoutingRule,
  input: UpdateRoutingRuleInput,
): RoutingRule {
  return {
    ...rule,
    ...(input.sort_order !== undefined
      ? { sort_order: input.sort_order }
      : {}),
    ...(input.inbound_tag !== undefined
      ? { inbound_tag: input.inbound_tag }
      : {}),
    ...(input.domain !== undefined ? { domain: input.domain } : {}),
    ...(input.ip !== undefined ? { ip: input.ip } : {}),
    ...(input.outbound_tag !== undefined
      ? { outbound_tag: input.outbound_tag }
      : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
  };
}

export function useCreateRoutingRule(serverId: string) {
  const queryClient = useQueryClient();

  return useMutation<RoutingRule, Error, CreateRoutingRuleInput>({
    mutationFn: async (input) =>
      (await api.routingRules.create(serverId, input)).rule,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.routingRules(serverId),
      });
    },
  });
}

export function useUpdateRoutingRule(serverId: string) {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.routingRules(serverId);

  return useMutation<
    RoutingRule,
    Error,
    { id: string; input: UpdateRoutingRuleInput },
    { previous?: RoutingRule[] }
  >({
    mutationFn: async ({ id, input }) =>
      (await api.routingRules.update(id, input)).rule,
    onMutate: async ({ id, input }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<RoutingRule[]>(queryKey);

      if (previous) {
        queryClient.setQueryData<RoutingRule[]>(
          queryKey,
          previous.map((item) =>
            item.id === id ? applyRoutingRuleInput(item, input) : item,
          ),
        );
      }

      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
    onSuccess: (rule) => {
      queryClient.setQueryData<RoutingRule[]>(queryKey, (current) =>
        current?.map((item) => (item.id === rule.id ? rule : item)),
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });
}

export function useDeleteRoutingRule(serverId: string) {
  const queryClient = useQueryClient();

  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => api.routingRules.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.routingRules(serverId),
      });
    },
  });
}

export interface RoutingRuleOrderPatch {
  id: string;
  sort_order: number;
}

/**
 * 调整路由规则顺序。
 *
 * 后端只有 `sort_order` 一个维度，且新建规则可能都拿到默认 0，
 * 所以这里不做「两两交换」，而是按当前表格顺序重新编号成 0..n-1：
 * 只 PATCH 编号真正变化的规则，重复的 sort_order 也能被纠正。
 */
export function useReorderRoutingRules(serverId: string) {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.routingRules(serverId);

  return useMutation<
    void,
    Error,
    { ordered: RoutingRule[]; patches: RoutingRuleOrderPatch[] },
    { previous?: RoutingRule[] }
  >({
    mutationFn: async ({ patches }) => {
      // 串行 PATCH：SQLite 并发写容易撞锁，而重编号本身对请求顺序不敏感。
      for (const patch of patches) {
        await api.routingRules.update(patch.id, {
          sort_order: patch.sort_order,
        });
      }
    },
    onMutate: async ({ ordered }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<RoutingRule[]>(queryKey);
      queryClient.setQueryData(queryKey, [...ordered].sort(compareRoutingRules));
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });
}

/** 证书元数据列表；私钥不会下发到前端。 */
export function useCertificates() {
  return useQuery<Certificate[]>({
    queryKey: queryKeys.certificates,
    queryFn: async () => (await api.certificates.list()).items,
    staleTime: 30_000,
  });
}

/** 证书增删都会影响概览的 `expiring_certs` 告警。 */
function invalidateCertificateViews(
  queryClient: ReturnType<typeof useQueryClient>,
) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.certificates });
  void queryClient.invalidateQueries({ queryKey: queryKeys.statsOverview });
}

export function useCreateCertificate() {
  const queryClient = useQueryClient();

  return useMutation<Certificate, Error, CreateCertificateInput>({
    mutationFn: async (input) =>
      (await api.certificates.create(input)).certificate,
    onSuccess: () => invalidateCertificateViews(queryClient),
  });
}

export function useDeleteCertificate() {
  const queryClient = useQueryClient();

  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => api.certificates.remove(id),
    onSuccess: () => invalidateCertificateViews(queryClient),
  });
}

export function useUsers(q: string) {
  return useQuery<UserView[]>({
    queryKey: queryKeys.users(q),
    queryFn: async () => (await api.users(q)).items,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
}

/**
 * P6：订阅列表（管理员），每行带生效规则模板。
 *
 * 后端可能暂时 404：不重试，由订阅页展示中文错误态与「重试」。
 * 用户、套餐或套餐实例变化都会影响「生效模板」的解析结果，相关 mutation 会
 * 统一失效 `["subscriptions"]` 前缀的缓存。
 */
export function useSubscriptions(q: string) {
  return useQuery<Subscription[]>({
    queryKey: queryKeys.subscriptions(q),
    queryFn: async () => (await api.subscriptions(q)).items,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
    retry: false,
  });
}

/**
 * 用户 / 套餐 / 套餐实例的改动都会改变订阅的「生效规则模板」：
 * 用户绑定、套餐绑定、当前套餐实例都可能被解析顺序命中，所以统一失效订阅列表。
 */
function invalidateSubscriptionViews(
  queryClient: ReturnType<typeof useQueryClient>,
) {
  void queryClient.invalidateQueries({ queryKey: ["subscriptions"] });
}

export function useCreateUser() {
  const queryClient = useQueryClient();

  return useMutation<UserView, Error, CreateUserInput>({
    mutationFn: async (input) => (await api.createUser(input)).user,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["users"] });
      invalidateSubscriptionViews(queryClient);
    },
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();

  return useMutation<UserView, Error, { id: string; input: UpdateUserInput }>({
    mutationFn: async ({ id, input }) => (await api.updateUser(id, input)).user,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["users"] });
      // 规则模板绑定变了，订阅列表里展示的「生效模板」也会变。
      invalidateSubscriptionViews(queryClient);
    },
  });
}

export function useDeleteUser() {
  const queryClient = useQueryClient();

  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => api.deleteUser(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["users"] });
      invalidateSubscriptionViews(queryClient);
    },
  });
}

export function usePackages() {
  return useQuery<Package[]>({
    queryKey: queryKeys.packages,
    queryFn: async () => (await api.packages()).items,
    staleTime: 10_000,
  });
}

export function useCreatePackage() {
  const queryClient = useQueryClient();

  return useMutation<Package, Error, CreatePackageInput>({
    mutationFn: async (input) => (await api.createPackage(input)).package,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["packages"] });
      invalidateSubscriptionViews(queryClient);
    },
  });
}

export function useUpdatePackage() {
  const queryClient = useQueryClient();

  return useMutation<
    Package,
    Error,
    { id: string; input: UpdatePackageInput }
  >({
    mutationFn: async ({ id, input }) =>
      (await api.updatePackage(id, input)).package,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["packages"] });
      void queryClient.invalidateQueries({ queryKey: ["users"] });
      // 套餐名/额度会嵌在用户的套餐视图里，刷新已打开的用户抽屉。
      void queryClient.invalidateQueries({ queryKey: ["user"] });
      // 套餐的默认规则模板变了，订阅列表的生效模板也要重算。
      invalidateSubscriptionViews(queryClient);
    },
  });
}

export function useDeletePackage() {
  const queryClient = useQueryClient();

  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => api.deletePackage(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["packages"] });
      invalidateSubscriptionViews(queryClient);
    },
  });
}

export function useUserPackages(userId: string) {
  return useQuery<UserPackageView[]>({
    queryKey: queryKeys.userPackages(userId),
    queryFn: async () => (await api.userPackages(userId)).items,
    enabled: Boolean(userId),
    staleTime: 5_000,
  });
}

function invalidateUserPackages(
  queryClient: ReturnType<typeof useQueryClient>,
  userId: string,
) {
  void queryClient.invalidateQueries({
    queryKey: queryKeys.userPackages(userId),
  });
  void queryClient.invalidateQueries({ queryKey: ["users"] });
  // 「当前套餐」参与生效规则模板的解析，绑定/解绑后订阅列表要刷新。
  invalidateSubscriptionViews(queryClient);
}

export function useBindUserPackage(userId: string) {
  const queryClient = useQueryClient();

  return useMutation<UserPackageView, Error, BindUserPackageInput>({
    mutationFn: async (input) => (await api.bindUserPackage(userId, input)).item,
    onSuccess: () => invalidateUserPackages(queryClient, userId),
  });
}

export function useUpdateUserPackage(userId: string) {
  const queryClient = useQueryClient();

  return useMutation<
    UserPackageView,
    Error,
    { id: string; input: UpdateUserPackageInput }
  >({
    mutationFn: async ({ id, input }) =>
      (await api.updateUserPackage(id, input)).item,
    onSuccess: () => invalidateUserPackages(queryClient, userId),
  });
}

export function useUnbindUserPackage(userId: string) {
  const queryClient = useQueryClient();

  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => api.unbindUserPackage(id),
    onSuccess: () => invalidateUserPackages(queryClient, userId),
  });
}

export function useLogin() {
  const queryClient = useQueryClient();

  return useMutation<SessionUser, Error, { username: string; password: string }>(
    {
      mutationFn: async ({ username, password }) =>
        (await api.login(username, password)).user,
      onSuccess: (user) => {
        queryClient.setQueryData(queryKeys.me, user);
        void queryClient.invalidateQueries({ queryKey: queryKeys.servers });
      },
    },
  );
}

export function useLogout() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.logout,
    onSettled: () => {
      queryClient.clear();
    },
  });
}
