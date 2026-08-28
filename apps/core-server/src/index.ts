import * as os from "node:os";
import * as path from "node:path";
import { CoreServer } from "./app";
import { loadConfig } from "./config";
import {
  SIDECAR_READY_ENV,
  sidecarReadyLine,
} from "./sidecar";

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
  const loaded = loadConfig(process.env);
  if ("error" in loaded) {
    console.error(`[core-server] ${loaded.error}`);
    process.exit(1);
  }
  const {
    host,
    exposed,
    port,
    p2pPort,
    p2pBindHost,
    networking,
    wanEnabled,
    wanRelayAddr,
    wanListenAddrs,
  } = loaded.config;
  if (exposed) {
    console.warn(
      `[core-server] WARNING: binding the HTTP/WS bridge to non-loopback ` +
        `"${host}". Any host able to reach this port can now talk to ` +
        `the bridge, which is guarded only by the per-boot token. Keep the ` +
        `token secret and treat the surrounding network as untrusted.`,
    );
  }
  const server = new CoreServer({
    pluginsDir: resolvePluginsDir(),
    dataDir: resolveDataDir(),
    host,
    port,
    p2pPort,
    p2pBindHost,
    masterKey: process.env.P2P_HUB_VAULT_KEY,
    networking,
    wanEnabled,
    wanRelayAddr,
    wanListenAddrs,
  });

  await server.start();

  // The port reported in the log (and, when gated, the ready handshake) is the
  // *bound* one — with `P2P_HUB_PORT=0` the OS-assigned port is only known
  // after `listen()`.
  const bound = server.address();
  const boundPort = bound?.port ?? port;
  const boundHost = bound?.host ?? host;

  console.log(
    `[core-server] listening on http://${boundHost}:${boundPort}` +
      (networking ? "" : " (networking disabled: local-only)") +
      (wanEnabled ? " (WAN transport enabled)" : ""),
  );

  // Sidecar handshake (desktop shell): a single machine-readable line on
  // stdout carrying the bound port + boot token. Gated on the env flag so a
  // normal terminal run never puts the token on an unwatched stdout. The
  // prefix is delimiter-anchored in `sidecarReadyLine`; the host scans for the
  // exact `[P2P_HUB_READY] ` line.
  if (process.env[SIDECAR_READY_ENV]) {
    process.stdout.write(
      sidecarReadyLine({
        port: boundPort,
        token: server.getBootToken(),
        state: server.bootState(),
      }) + "\n",
    );
  }

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
