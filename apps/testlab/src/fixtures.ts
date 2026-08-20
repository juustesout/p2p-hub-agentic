import * as fs from "node:fs/promises";
import * as path from "node:path";

const TESTNODE_MANIFEST = {
  id: "testnode",
  version: "1.0.0",
  kind: "generic",
  permissions: [
    "network:skill:testnode.echo",
    "network:skill:testnode.forward",
  ],
  entry: "./index.mjs",
};

const TESTNODE_SOURCE = `export default function activate(ctx) {
  if (!ctx.network) {
    throw new Error("testlab: networking is not enabled");
  }
  ctx.skills.register("echo", async (payload) => ({ echoed: payload }), {
    localOnly: false,
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
    { localOnly: false },
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
