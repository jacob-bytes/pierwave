import { Navigate, Route, Routes } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "./lib/api";
import LoginPage from "./pages/Login";
import ServersPage from "./pages/Servers";
import AppShell from "./components/AppShell";

export default function App() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });

  if (me.isLoading) {
    return <div className="grid h-full place-items-center text-sm text-white/50">加载中…</div>;
  }

  if (me.isError) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route element={<AppShell user={me.data!.user} />}>
        <Route index element={<div className="text-sm text-white/60">概览（待实现）</div>} />
        <Route path="/servers" element={<ServersPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
