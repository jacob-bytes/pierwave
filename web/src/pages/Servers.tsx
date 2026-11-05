import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Copy, Check } from "lucide-react";
import { api, type CreateServerResponse } from "../lib/api";

export default function ServersPage() {
  const qc = useQueryClient();
  const servers = useQuery({ queryKey: ["servers"], queryFn: api.servers });
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [xrayMode, setXrayMode] = useState("external");
  const [created, setCreated] = useState<CreateServerResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const create = useMutation({
    mutationFn: () => api.createServer({ name, address, xray_mode: xrayMode }),
    onSuccess: (data) => {
      setCreated(data);
      setName("");
      setAddress("");
      qc.invalidateQueries({ queryKey: ["servers"] });
    },
  });

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-lg font-semibold">服务器</h1>
          <p className="mt-1 text-xs text-white/50">Agent 主动连入主控，无需开放入站端口</p>
        </div>
      </header>

      <form
        className="flex flex-wrap items-end gap-3 rounded-xl border border-white/10 bg-[var(--color-surface)] p-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <label className="space-y-1.5">
          <span className="block text-xs text-white/60">名称</span>
          <input
            className="rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="hk-1"
          />
        </label>
        <label className="space-y-1.5">
          <span className="block text-xs text-white/60">地址</span>
          <input
            className="rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="1.2.3.4"
          />
        </label>
        <label className="space-y-1.5">
          <span className="block text-xs text-white/60">Xray 模式</span>
          <select
            className="rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none"
            value={xrayMode}
            onChange={(e) => setXrayMode(e.target.value)}
          >
            <option value="external">外置</option>
            <option value="embedded">内联</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={create.isPending || !name || !address}
          className="flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-2 text-sm font-medium text-black disabled:opacity-50"
        >
          <Plus size={14} /> 添加服务器
        </button>
        {create.isError && (
          <p className="w-full text-xs text-red-400">{(create.error as Error).message}</p>
        )}
      </form>

      {created && (
        <div className="space-y-2 rounded-xl border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/5 p-4 text-xs">
          <p className="text-white/70">配对 token 只显示这一次，请立刻保存：</p>
          <code className="block break-all rounded bg-black/30 p-2 text-[11px]">{created.token}</code>
          <button
            onClick={() => {
              navigator.clipboard.writeText(created.install_command);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="flex items-center gap-1.5 text-white/70 hover:text-white"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? "已复制" : "复制安装命令"}
          </button>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-white/10">
        <table className="w-full text-sm">
          <thead className="bg-white/5 text-left text-xs text-white/50">
            <tr>
              <th className="px-4 py-2 font-medium">名称</th>
              <th className="px-4 py-2 font-medium">地址</th>
              <th className="px-4 py-2 font-medium">模式</th>
              <th className="px-4 py-2 font-medium">状态</th>
              <th className="px-4 py-2 font-medium">配置版本</th>
            </tr>
          </thead>
          <tbody>
            {servers.data?.items.map((s) => (
              <tr key={s.id} className="border-t border-white/5">
                <td className="px-4 py-2">{s.name}</td>
                <td className="px-4 py-2 text-white/60">{s.address}</td>
                <td className="px-4 py-2 text-white/60">{s.xray_mode}</td>
                <td className="px-4 py-2">
                  <span
                    className={
                      s.status === "online"
                        ? "rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300"
                        : "rounded-full bg-white/10 px-2 py-0.5 text-xs text-white/50"
                    }
                  >
                    {s.status === "online" ? "在线" : "离线"}
                  </span>
                </td>
                <td className="px-4 py-2 text-white/40">v{s.config_version}</td>
              </tr>
            ))}
            {servers.data?.items.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-xs text-white/40">
                  还没有服务器
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
