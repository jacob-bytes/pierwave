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
  type CreateNodeInput,
  type CreatePackageInput,
  type CreateServerResponse,
  type CreateUserInput,
  type Health,
  type Node,
  type Package,
  type Server,
  type SessionUser,
  type UpdateNodeInput,
  type UpdatePackageInput,
  type UpdateUserInput,
  type UpdateUserPackageInput,
  type UserPackageView,
  type UserView,
} from "@/lib/api";

export const queryKeys = {
  me: ["me"] as const,
  health: ["health"] as const,
  servers: ["servers"] as const,
  nodes: (serverId: string) => ["nodes", serverId] as const,
  users: (q: string) => ["users", { q }] as const,
  packages: ["packages"] as const,
  userPackages: (userId: string) => ["user", userId, "packages"] as const,
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

export function useHealth() {
  return useQuery<Health>({
    queryKey: queryKeys.health,
    queryFn: api.health,
    retry: false,
    staleTime: 5 * 60_000,
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

export function useNodes(serverId: string) {
  return useQuery<Node[]>({
    queryKey: queryKeys.nodes(serverId),
    queryFn: async () => (await api.nodes(serverId)).items,
    enabled: Boolean(serverId),
    staleTime: 5_000,
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
