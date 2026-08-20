import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PluginHost } from "@p2p-hub/core";
import { writeTestNodePlugin } from "./fixtures";

/**
 * Manual multi-peer lab runner (also used locally on Windows to "see what
 * works"): boots three independent PluginHosts over real network-light,
 * waits for full mesh discovery, runs a direct A->C call and a chained
 * A->B->C call, prints a report, then tears everything down.
 */

interface TaskResultLike {
  taskId: string;
  status: "ok" | "error";
  result?: unknown;
  error?: string;
}

interface TestNodeApi {
  sendEcho(peerId: string): Promise<TaskResultLike>;
  sendForward(
    forwarderPeerId: string,
    targetPeerId: string,
    inner: unknown,
  ): Promise<TaskResultLike>;
}

interface Peer {
  host: PluginHost;
  peerId: string;
  node: TestNodeApi;
}

async function bootPeer(tag: string): Promise<Peer> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `testlab-${tag}-`));
  await writeTestNodePlugin(root);
  const host = new PluginHost({
    pluginsDir: path.join(root, "plugins"),
    dataDir: path.join(root, "data"),
    enableNetworking: true,
  });
  await host.boot();
  const peerId = (await host.identityManager().getOrCreateIdentity()).peerId;
  const node = host.getActivated("testnode") as unknown as TestNodeApi;
  return { host, peerId, node };
}

function knownPeerIds(peer: Peer): Set<string> {
  const peers = new Set<string>();
  const provider = peer.host.networkRegistry().selectActive();
  for (const discovered of provider?.listPeers?.() ?? []) {
    if (discovered.peerId) {
      peers.add(discovered.peerId);
    }
  }
  return peers;
}

async function waitFor(
  check: () => boolean,
  timeoutMs = 20_000,
  intervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

async function main(): Promise<void> {
  console.log("[testlab] booting three peers A, B, C (real mDNS + TLS transport)...");
  const a = await bootPeer("a");
  const b = await bootPeer("b");
  const c = await bootPeer("c");
  console.log(`[testlab] A peerId=${a.peerId}`);
  console.log(`[testlab] B peerId=${b.peerId}`);
  console.log(`[testlab] C peerId=${c.peerId}`);

  console.log("[testlab] waiting for full mesh discovery...");
  await waitFor(() => knownPeerIds(a).has(b.peerId) && knownPeerIds(a).has(c.peerId));
  await waitFor(() => knownPeerIds(b).has(a.peerId) && knownPeerIds(b).has(c.peerId));
  await waitFor(() => knownPeerIds(c).has(a.peerId) && knownPeerIds(c).has(b.peerId));

  const mesh = (tag: string, peer: Peer) => {
    console.log(`[testlab] ${tag} sees ${knownPeerIds(peer).size} peer(s): ${[...knownPeerIds(peer)].sort().join(", ")}`);
  };
  mesh("A", a);
  mesh("B", b);
  mesh("C", c);

  console.log("[testlab] direct A -> C echo...");
  const direct = await a.node.sendEcho(c.peerId);
  console.log(`[testlab] direct: ${JSON.stringify(direct)}`);

  console.log("[testlab] chained A -> B -> C forward...");
  const chained = await a.node.sendForward(b.peerId, c.peerId, { hello: "chain" });
  console.log(`[testlab] chain : ${JSON.stringify(chained)}`);

  await Promise.allSettled([a.host.stop(), b.host.stop(), c.host.stop()]);

  const ok = direct.status === "ok" && chained.status === "ok";
  console.log(
    ok
      ? "[testlab] SUCCESS: multi-peer mesh and chained capability call work"
      : "[testlab] FAILURE: see results above",
  );
  process.exit(ok ? 0 : 1);
}

void main();
