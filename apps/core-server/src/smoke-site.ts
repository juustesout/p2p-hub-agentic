import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PluginHost } from "@p2p-hub/core";
import { CoreServer } from "./app";

/**
 * Local smoke harness for the Fase 2-eindcriterium "View site" flow.
 *
 * Boots two *independent* P2P peers in one process:
 *   - Peer A: a bare PluginHost running the real peersite + contacts plugins,
 *     publishing a local directory over `p2p-hub:website:v1`.
 *   - Peer B: the core-server the desktop shell talks to (HTTP/WS bridge).
 *
 * The script then performs the human step programmatically: A verifies B as a
 * contact (challenge-response via `contacts.signChallenge`), which is what
 * lets B's broker pass A's `verified-contact` gate on `peersite.fetchAsset`.
 * Once READY, opening `/remote-site/<peerIdA>/` from the shell triggers a
 * fetch-on-miss over the real P2P transport and mirrors the site locally.
 *
 * Dev-only smoke helper: the automatic contact verification replaces the
 * human Tier-2 confirm, and the site root comes from SMOKE_SITE_ROOT.
 */

const REPO_PLUGINS = path.resolve(__dirname, "../../../plugins");

async function installPlugin(pluginsDir: string, id: string): Promise<void> {
  const sourceDir = path.join(REPO_PLUGINS, id);
  const destDir = path.join(pluginsDir, id, "dist");
  await fs.mkdir(destDir, { recursive: true });
  await fs.copyFile(
    path.join(sourceDir, "manifest.json"),
    path.join(pluginsDir, id, "manifest.json"),
  );
  await fs.copyFile(path.join(sourceDir, "dist", "index.js"), path.join(destDir, "index.js"));
}

async function waitFor(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 30_000,
  intervalMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function main(): Promise<void> {
  const siteRoot = process.env.SMOKE_SITE_ROOT;
  if (!siteRoot) {
    throw new Error("SMOKE_SITE_ROOT (absolute path to the site to publish) is required");
  }

  // Peer A — site owner.
  const aRoot = path.join(
    __dirname,
    "../../node_modules/.cache",
    `smoke-a-${crypto.randomBytes(3).toString("hex")}`,
  );
  const aPluginsDir = path.join(aRoot, "plugins");
  await fs.mkdir(aPluginsDir, { recursive: true });
  await installPlugin(aPluginsDir, "peersite");
  await installPlugin(aPluginsDir, "contacts");
  const hostA = new PluginHost({
    pluginsDir: aPluginsDir,
    dataDir: path.join(aRoot, "data"),
    enableNetworking: true,
  });
  await hostA.boot();
  const peerIdA = (await hostA.identityManager().getOrCreateIdentity()).peerId;
  const peersiteA = hostA.getActivated("peersite") as {
    setSiteRoot(p: string): Promise<string>;
  };
  const realRoot = await peersiteA.setSiteRoot(siteRoot);

  // Peer B — the core-server behind the shell.
  const bRoot = await fs.mkdtemp(path.join(os.tmpdir(), "smoke-core-b-"));
  const port = process.env.P2P_HUB_PORT ? Number(process.env.P2P_HUB_PORT) : 8787;
  const server = new CoreServer({
    pluginsDir: REPO_PLUGINS,
    dataDir: bRoot,
    host: "127.0.0.1",
    port,
    networking: true,
    masterKey: crypto.randomBytes(16).toString("hex"),
  });
  await server.start();
  const bootToken = (await fs.readFile(path.join(bRoot, "boot-token"), "utf8")).trim();

  // A learns B's peerId from discovery, then verifies B as a contact
  // (simulating the human approving the relationship).
  const contactsA = hostA.getActivated("contacts") as {
    addContact(i: { peerId: string; publicKeyHex: string; displayName: string }): Promise<unknown>;
    verifyPeer(i: { peerId: string }): Promise<{ verified: boolean; error?: string }>;
  };
  const discovered = await waitFor(() => {
    const provider = hostA.networkRegistry().selectActive();
    const peers = provider?.listPeers?.() ?? [];
    return peers.some((p) => p.peerId && p.peerId !== peerIdA);
  });
  if (!discovered) {
    throw new Error("A never discovered B over the P2P transport");
  }
  const provider = hostA.networkRegistry().selectActive();
  const peerIdB = provider?.listPeers?.().find((p) => p.peerId && p.peerId !== peerIdA)?.peerId;
  if (!peerIdB) {
    throw new Error("discovered peer has no verified peerId");
  }
  await contactsA.addContact({
    peerId: peerIdB,
    publicKeyHex: peerIdB,
    displayName: "Core B (shell)",
  });
  const verified = await contactsA.verifyPeer({ peerId: peerIdB });
  if (!verified.verified) {
    throw new Error(`A could not verify B: ${verified.error ?? "unknown"}`);
  }

  // Confirm the shell-facing side can see A before declaring readiness.
  const capabilitiesUrl = `http://127.0.0.1:${port}/api/capabilities`;
  const listed = await waitFor(async () => {
    try {
      const res = await fetch(capabilitiesUrl, {
        headers: { Authorization: `Bearer ${bootToken}` },
      });
      if (res.status !== 200) {
        return false;
      }
      const body = (await res.json()) as {
        remote?: { peers?: Array<{ peerId?: string }> };
      };
      return (body.remote?.peers ?? []).some((p) => p.peerId === peerIdA);
    } catch {
      return false;
    }
  });
  if (!listed) {
    console.warn("[smoke] B does not (yet) list A in /api/capabilities — refresh the shell if absent");
  }

  console.log("[smoke] READY");
  console.log(`  Peer A (site owner)   : ${peerIdA}`);
  console.log(`  Peer B (shell server) : ${peerIdB}`);
  console.log(`  Site root (on A)      : ${realRoot}`);
  console.log(`  HTTP bridge           : http://127.0.0.1:${port}`);
  console.log(`  Boot token            : ${bootToken}`);
  console.log(`  Demo URL              : http://127.0.0.1:${port}/remote-site/${peerIdA}/`);
  console.log("  In the shell: Start Menu → Remote peer services → A → \"View site\".");

  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => resolve());
    process.on("SIGTERM", () => resolve());
  });
  await Promise.allSettled([hostA.stop(), server.stop()]);
}

void main().catch((err) => {
  console.error("[smoke] failed:", err);
  process.exit(1);
});
