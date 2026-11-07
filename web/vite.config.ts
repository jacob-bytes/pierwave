import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // 开发时把 API 与 Agent 通道都转给本地 master
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: false,
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        // zod 只被 /servers 与 /settings 这类懒加载页用，但两个页面共享后会被
        // 提升到入口 chunk——首屏白等 40 多 kB。单独切出来，按需并行加载。
        manualChunks: (id) =>
          id.includes("node_modules/zod") ? "zod" : undefined,
      },
    },
  },
});
