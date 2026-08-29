import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "./logger";
import { CoreServer } from "./app";
import { loadConfig } from "./config";
import {
  SIDECAR_READY_ENV,
  sidecarReadyLine,
} from "./sidecar";

// The SEA build stamps the version via an esbuild `define`; a plain tsc build
// (dev flow) has no such define, so `typeof` falls back to a dev marker. Using
// `typeof` keeps this safe on the identifier being absent entirely.
declare const __P2P_HUB_CORE_VERSION__: string;
const coreVersion =
  typeof __P2P_HUB_CORE_VERSION__ !== "undefined"
    ? __P2P_HUB_CORE_VERSION__
    : "0.0.0-dev";

function resolvePluginsDir(): string {
  const fromEnv = process.env.P2P_HUB_PLUGINS_DIR;
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  // In the monorepo the compiled server lives at apps/core-server/dist, so
  // the repo's `plugins/` directory is three levels up.
  const monorepo = path.resolve(__dirname, "../../../plugins");
  if (fs.existsSync(monorepo)) {
    return monorepo;
  }
  // Standalone / SEA deployment: no monorepo on the target machine. Fall back
  // to `<dataDir>/plugins` so the server boots plugin-less instead of failing
  // to find a plugins dir that can never exist here.
  return path.join(resolveDataDir(), "plugins");
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
    logger.error(`[core-server] ${loaded.error}`);
    process.exit(1);
  }
  const {
    host,
    exposed,
    allowedHosts,
    port,
    p2pPort,
    p2pBindHost,
    networking,
    wanEnabled,
    wanRelayAddr,
    wanListenAddrs,
  } = loaded.config;
  if (exposed) {
    logger.warn(
      `[core-server] WARNING: binding the HTTP/WS bridge to non-loopback ` +
        `"${host}". Any host able to reach this port can now talk to ` +
        `the bridge, which is guarded by the per-boot token (for /api and /ws) ` +
        `and by the Host-header allowlist (for the tokenless /site, /ui, ` +
        `/remote-site and /peersite surfaces). Keep the token secret and treat ` +
        `the surrounding network as untrusted.`,
    );
  }
  const pluginsDir = resolvePluginsDir();
  if (!fs.existsSync(pluginsDir)) {
    if (process.env.P2P_HUB_PLUGINS_DIR) {
      throw new Error(
        `[core-server] P2P_HUB_PLUGINS_DIR "${pluginsDir}" does not exist`,
      );
    }
    // Standalone/SEA boot with no monorepo and no bundled plugins: create an
    // empty dir so the plugin host scans an empty set instead of failing.
    fs.mkdirSync(pluginsDir, { recursive: true });
    logger.warn(
      `[core-server] no plugins found; created empty plugins dir "${pluginsDir}"`,
    );
  }
  const server = new CoreServer({
    pluginsDir,
    dataDir: resolveDataDir(),
    host,
    exposed,
    allowedHosts,
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
  logger.info(`[core-server] p2p-hub-core v${coreVersion}`);
  // The port reported in the log (and, when gated, the ready handshake) is the
  // *bound* one — with `P2P_HUB_PORT=0` the OS-assigned port is only known
  // after `listen()`.
  const bound = server.address();
  const boundPort = bound?.port ?? port;
  const boundHost = bound?.host ?? host;

  logger.info(
    `[core-server] listening on http://${boundHost}:${boundPort}` +
      (networking ? "" : " (networking disabled: local-only)") +
      (wanEnabled ? " (WAN transport enabled)" : ""),
  );

  // The shutdown handlers must be registered BEFORE the ready handshake is
  // emitted: the desktop shell (and the SEA regression suite) sends SIGTERM the
  // moment it reads the handshake line, so an unregistered handler in that
  // window would kill the process by default signal handling instead of a
  // clean `process.exit(0)`.
  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

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
}

void main().catch((err) => {
  logger.error(err, "[core-server] failed to start");
  process.exit(1);
});
