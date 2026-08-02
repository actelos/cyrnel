import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { ProxyOptions } from "vite";
import { defineConfig, loadEnv } from "vite";

const API_PATHS = [
  "/health",
  "/modules",
  "/services",
  "/tools",
  "/processes",
  "/environment",
] as const;

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiUrl = (
    process.env.CYRNEL_API_URL ??
    env.CYRNEL_API_URL ??
    "http://127.0.0.1:9371"
  ).replace(/\/+$/, "");
  const apiKey = process.env.CYRNEL_API_KEY ?? env.CYRNEL_API_KEY ?? "";

  const proxy: Record<string, ProxyOptions> = {};
  for (const path of API_PATHS) {
    proxy[path] = {
      target: apiUrl,
      changeOrigin: true,
      ...(apiKey ? { headers: { authorization: `Bearer ${apiKey}` } } : {}),
    };
  }

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": resolve(__dirname, "./src"),
      },
    },
    server: { proxy },
  };
});
