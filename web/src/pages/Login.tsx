import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";

export default function LoginPage() {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const navigate = useNavigate();
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => api.login(username, password),
    onSuccess: (data) => {
      qc.setQueryData(["me"], data);
      navigate("/", { replace: true });
    },
  });

  return (
    <div className="grid h-full place-items-center">
      <form
        className="w-80 space-y-4 rounded-xl border border-white/10 bg-[var(--color-surface)] p-6"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
      >
        <div>
          <h1 className="text-lg font-semibold">登录 mmrust</h1>
          <p className="mt-1 text-xs text-white/50">首次启动的管理员密码见服务端日志</p>
        </div>
        <label className="block space-y-1.5">
          <span className="text-xs text-white/60">用户名</span>
          <input
            className="w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs text-white/60">密码</span>
          <input
            type="password"
            className="w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {mutation.isError && (
          <p className="text-xs text-red-400">{(mutation.error as Error).message}</p>
        )}
        <button
          type="submit"
          disabled={mutation.isPending}
          className="w-full rounded-md bg-[var(--color-accent)] px-3 py-2 text-sm font-medium text-black disabled:opacity-60"
        >
          {mutation.isPending ? "登录中…" : "登录"}
        </button>
      </form>
    </div>
  );
}
