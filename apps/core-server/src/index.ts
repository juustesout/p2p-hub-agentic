import * as os from "node:os";
import * as path from "node:path";
import { CoreServer } from "./app";

function resolvePluginsDir(): string {
  const fromEnv = process.env.P2P_HUB_PLUGINS_DIR;
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  // In the monorepo the compiled server lives at apps/core-server/dist, so
  // the repo's `plugins/` directory is three levels up.
  return path.resolve(__dirname, "../../../plugins");
}

function resolveDataDir(): string {
  const fromEnv = process.env.P2P_HUB_DATA_DIR;
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return path.join(os.homedir(), ".p2p-hub");
}

async function main(): Promise<void> {
  const server = new CoreServer({
    pluginsDir: resolvePluginsDir(),
    dataDir: resolveDataDir(),
    host: process.env.P2P_HUB_HOST ?? "127.0.0.1",
    port: process.env.P2P_HUB_PORT
      ? Number(process.env.P2P_HUB_PORT)
      : 8787,
    masterKey: process.env.P2P_HUB_VAULT_KEY,
  });

  await server.start();

  const address = process.env.P2P_HUB_HOST ?? "127.0.0.1";
  const port = process.env.P2P_HUB_PORT ? Number(process.env.P2P_HUB_PORT) : 8787;
  console.log(`[core-server] listening on http://${address}:${port}`);

  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main().catch((err) => {
  console.error("[core-server] failed to start:", err);
  process.exit(1);
});
