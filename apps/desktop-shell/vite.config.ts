import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The shell talks to @p2p-hub/core-server over a single origin. In dev the
// Vite server proxies /api and /ws to the local core server; in production
// (Tauri) the frontend is served statically and the same proxy/rewrite rules
// are applied at the deployment layer.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Consume @p2p-hub/sdk from its TypeScript source so both dev (esbuild)
      // and build (Rollup) treat it as ESM. The compiled SDK is CommonJS whose
      // `__exportStar` barrel has no statically-analyzable named exports, so
      // Vite otherwise fails with "doesn't provide an export named:
      // 'evaluateSettingsRisk'". The SDK is browser-safe (no Node built-ins).
      "@p2p-hub/sdk": fileURLToPath(
        new URL("../../sdk/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    host: true,
    allowedHosts: [".monkeycode-ai.live"],
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://127.0.0.1:8787",
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    commonjsOptions: {
      include: [/node_modules/],
    },
  },
});
