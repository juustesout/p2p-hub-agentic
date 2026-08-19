import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The shell talks to @p2p-hub/core-server over a single origin. In dev the
// Vite server proxies /api and /ws to the local core server; in production
// (Tauri) the frontend is served statically and the same proxy/rewrite rules
// are applied at the deployment layer.
export default defineConfig({
  plugins: [react()],
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
      // @p2p-hub/sdk is a CommonJS workspace package symlinked out of
      // node_modules; include its dist so Rollup resolves the named exports
      // (e.g. `evaluateSettingsRisk`) instead of treating the barrel as an
      // empty ES module.
      include: [/node_modules/, /sdk\/dist/],
    },
  },
});
