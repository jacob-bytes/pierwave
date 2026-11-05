import React from "react";
import ReactDOM from "react-dom/client";
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { isUnauthorized } from "@/lib/queries";
import { loginUrlFor } from "@/lib/auth";
import "@/i18n";
import "./index.css";

/**
 * 会话过期统一回登录页：所有 query / mutation 的 401 都走这里，
 * 避免每个页面各写一遍。登录页自身的 401（密码错误）不重定向。
 */
function handleAuthError(error: unknown) {
  if (!isUnauthorized(error)) return;
  const { pathname, search, hash } = window.location;
  if (pathname === "/login") return;
  window.location.replace(loginUrlFor(pathname, search, hash));
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleAuthError }),
  mutationCache: new MutationCache({ onError: handleAuthError }),
  defaultOptions: {
    queries: {
      retry: (failureCount, error) =>
        !isUnauthorized(error) && failureCount < 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <BrowserRouter>
          <App />
          <Toaster />
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
