import * as os from "node:os";
import * as path from "node:path";
import { CoreServer } from "./app";
import { decideBindHost } from "./host";

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

/**
 * Resolve the bind host, refusing non-loopback addresses unless the operator
 * has explicitly set `P2P_HUB_EXPOSE=1`. Binding to `0.0.0.0` would expose a
 * token-guarded bridge to every host on the network; that is a real trust
 * change and must never happen as a side effect of a plain env var.
 */
function resolveHost(): string {
  const decision = decideBindHost(process.env.P2P_HUB_HOST, process.env.P2P_HUB_EXPOSE);
  if ("error" in decision) {
    console.error(`[core-server] ${decision.error}`);
    process.exit(1);
  }
  if (decision.exposed) {
    console.warn(
      `[core-server] WARNING: binding the HTTP/WS bridge to non-loopback ` +
        `"${decision.host}". Any host able to reach this port can now talk to ` +
        `the bridge, which is guarded only by the per-boot token. Keep the ` +
        `token secret and treat the surrounding network as untrusted.`,
    );
  }
  return decision.host;
}

async function main(): Promise<void> {
  const host = resolveHost();
  const networking = process.env.P2P_HUB_NETWORKING !== "0";
  const server = new CoreServer({
    pluginsDir: resolvePluginsDir(),
    dataDir: resolveDataDir(),
    host,
    port: process.env.P2P_HUB_PORT
      ? Number(process.env.P2P_HUB_PORT)
      : 8787,
    masterKey: process.env.P2P_HUB_VAULT_KEY,
    networking,
  });

  await server.start();

  const port = process.env.P2P_HUB_PORT ? Number(process.env.P2P_HUB_PORT) : 8787;
  console.log(
    `[core-server] listening on http://${host}:${port}` +
      (networking ? "" : " (networking disabled: local-only)"),
  );

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
