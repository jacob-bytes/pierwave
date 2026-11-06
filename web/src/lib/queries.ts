import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  api,
  ApiError,
  type ApplyResult,
  type BindUserPackageInput,
  type Certificate,
  type ChangePasswordInput,
  type CreateCertificateInput,
  type CreateNodeInput,
  type CreatePackageInput,
  type CreateServerResponse,
  type CreateUserInput,
  type EnforcementEvent,
  type Health,
  type MeSummary,
  type MeTraffic,
  type Node,
  type NodeSummary,
  type NodeTraffic,
  type NodeTrafficDetail,
  type OverviewStats,
  type Package,
  type Server,
  type SessionUser,
  type Settings,
  type TrafficStats,
  type UpdateNodeInput,
  type UpdatePackageInput,
  type UpdateSettingsInput,
  type UpdateUserInput,
  type UpdateUserPackageInput,
  type UserPackageView,
  type UserView,
} from "@/lib/api";

export const queryKeys = {
  me: ["me"] as const,
  meSummary: ["me", "summary"] as const,
  meTraffic: (days: number) => ["me", "traffic", days] as const,
  health: ["health"] as const,
  statsOverview: ["stats", "overview"] as const,
  statsTraffic: (days: number) => ["stats", "traffic", days] as const,
  statsNodes: (serverId: string, days: number) =>
    ["stats", "nodes", { serverId, days }] as const,
  statsNode: (nodeId: string, days: number, top: number) =>
    ["stats", "node", nodeId, { days, top }] as const,
  servers: ["servers"] as const,
  enforcementEvents: (limit: number) =>
    ["enforcement", "events", limit] as const,
  nodes: (serverId: string) => ["nodes", serverId] as const,
  /** 全局节点列表：不属于任何单台服务器，单独一个 key。 */
  allNodes: ["nodes", "all"] as const,
  certificates: ["certificates"] as const,
  users: (q: string) => ["users", { q }] as const,
  packages: ["packages"] as const,
  userPackages: (userId: string) => ["user", userId, "packages"] as const,
  settings: ["settings"] as const,
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

/** 概览统计。后端接口可能尚未上线，页面自行处理 404 文案。 */
export function useOverview() {
  return useQuery<OverviewStats>({
    queryKey: queryKeys.statsOverview,
    queryFn: api.stats.overview,
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
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
}

export function useCreateServer() {
  const queryClient = useQueryClient();

  return useMutation<
    CreateServerResponse,
    Error,
    { name: string; address: string; xray_mode: string }
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
      // 全局节点列表里的名称/启用状态也跟着变。
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

export function useCreateUser() {
  const queryClient = useQueryClient();

  return useMutation<UserView, Error, CreateUserInput>({
    mutationFn: async (input) => (await api.createUser(input)).user,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();

  return useMutation<UserView, Error, { id: string; input: UpdateUserInput }>({
    mutationFn: async ({ id, input }) => (await api.updateUser(id, input)).user,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });
}

export function useDeleteUser() {
  const queryClient = useQueryClient();

  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => api.deleteUser(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["users"] });
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
    },
  });
}

export function useDeletePackage() {
  const queryClient = useQueryClient();

  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => api.deletePackage(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["packages"] });
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
