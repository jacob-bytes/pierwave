import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
  build: { outDir: "dist", sourcemap: false },
});
