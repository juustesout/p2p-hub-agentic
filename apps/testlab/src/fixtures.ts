import * as fs from "node:fs/promises";
import * as path from "node:path";

const TESTNODE_MANIFEST = {
  id: "testnode",
  version: "1.0.0",
  kind: "generic",
  permissions: [
    "network:skill:testnode.echo",
    "network:skill:testnode.forward",
    "network:public:testnode.echo",
    "network:public:testnode.forward",
  ],
  entry: "./index.mjs",
};

const TESTNODE_SOURCE = `export default function activate(ctx) {
  if (!ctx.network) {
    throw new Error("testlab: networking is not enabled");
  }
  ctx.skills.register("echo", async (payload) => ({ echoed: payload }), {
    localOnly: false,
    remote: { gate: "any" },
  });
  ctx.skills.register(
    "forward",
    async (payload) => {
      const targetPeerId = String((payload && payload.targetPeerId) || "");
      if (!targetPeerId) {
        return { error: "forward: missing targetPeerId" };
      }
      const result = await ctx.network.sendTask(targetPeerId, {
        id: "testlab-forward",
        skill: "testnode.echo",
        payload: payload && payload.inner,
      });
      return result.status === "ok" ? result.result : { error: result.error };
    },
    { localOnly: false, remote: { gate: "any" } },
  );
  return {
    sendEcho(peerId) {
      return ctx.network.sendTask(peerId, {
        id: "testlab-echo",
        skill: "testnode.echo",
        payload: { hello: "direct" },
      });
    },
    sendForward(forwarderPeerId, targetPeerId, inner) {
      return ctx.network.sendTask(forwarderPeerId, {
        id: "testlab-forward",
        skill: "testnode.forward",
        payload: { targetPeerId, inner },
      });
    },
  };
}`;

/**
 * Write the shared testnode plugin (a network-exposed `echo` and `forward`
 * skill) into `root/plugins`. Returns the plugins dir.
 */
export async function writeTestNodePlugin(root: string): Promise<string> {
  const pluginsDir = path.join(root, "plugins");
  const dir = path.join(pluginsDir, "testnode");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify(TESTNODE_MANIFEST, null, 2),
  );
  await fs.writeFile(path.join(dir, "index.mjs"), TESTNODE_SOURCE);
  return pluginsDir;
}

const SITECLI_MANIFEST = {
  id: "sitecli",
  version: "1.0.0",
  kind: "generic",
  permissions: [],
  entry: "./index.mjs",
};

/**
 * A minimal local-only outbound client for the Fase 2A peer-app toetssteen. It
 * exposes one skill, `sitecli.sendTask`, that forwards a remote task to a given
 * peerId — the consumer's own outbound capability, never network-reachable
 * itself. No imports: everything it needs comes from `ctx`.
 */
const SITECLI_SOURCE = `export default function activate(ctx) {
  if (!ctx.network) {
    throw new Error("testlab: networking is not enabled");
  }
  function sendTask(peerId, skill, args) {
    return ctx.network.sendTask(peerId, {
      id: "sitecli-" + Math.random().toString(36).slice(2),
      skill,
      payload: args,
    });
  }
  ctx.skills.register("sendTask", async (payload) => {
    const peerId = String((payload && payload.peerId) || "");
    const skill = String((payload && payload.skill) || "");
    if (!peerId || !skill) {
      return { taskId: "sitecli", status: "error", error: "sitecli: missing peerId or skill" };
    }
    return sendTask(peerId, skill, payload && payload.args);
  }, { localOnly: true });
  return { sendTask };
}`;

export interface SiteCliApi {
  sendTask(peerId: string, skill: string, args: unknown): Promise<{
    taskId: string;
    status: "ok" | "error";
    result?: unknown;
    error?: string;
  }>;
}

/**
 * Write the sitecli consumer plugin (local-only outbound task sender) into
 * `root/plugins`. Returns the plugins dir.
 */
export async function writeSiteCliPlugin(root: string): Promise<string> {
  const pluginsDir = path.join(root, "plugins");
  const dir = path.join(pluginsDir, "sitecli");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify(SITECLI_MANIFEST, null, 2),
  );
  await fs.writeFile(path.join(dir, "index.mjs"), SITECLI_SOURCE);
  return pluginsDir;
}

/**
 * Copy a built first-party plugin (`plugins/<id>/manifest.json` +
 * `plugins/<id>/dist/index.js`) into `pluginsDir/<id>`. Used by the peer-app
 * toetssteen to run the real peersite/contacts plugins inside an independent
 * host. NOTE: the host root must live under `apps/testlab/node_modules/.cache`
 * so the copied plugin's `@p2p-hub/core` import resolves via walk-up to the
 * hoisted workspace symlink (same trick the core-server peersite harness uses).
 */
export async function installBuiltPlugin(
  pluginsDir: string,
  pluginId: string,
  repoPluginsDir: string,
): Promise<void> {
  const sourceDir = path.join(repoPluginsDir, pluginId);
  const destDir = path.join(pluginsDir, pluginId, "dist");
  await fs.mkdir(destDir, { recursive: true });
  await fs.copyFile(
    path.join(sourceDir, "manifest.json"),
    path.join(pluginsDir, pluginId, "manifest.json"),
  );
  await fs.copyFile(path.join(sourceDir, "dist", "index.js"), path.join(destDir, "index.js"));
}
