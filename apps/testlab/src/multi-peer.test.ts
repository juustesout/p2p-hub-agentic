import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PluginHost } from "@p2p-hub/core";
import { writeTestNodePlugin } from "./fixtures";

/**
 * Multi-peer integration layer, separate from the unit-test suites:
 * "378 unit tests green" does not prove the P2P system works. This suite boots
 * several fully independent PluginHosts (each with its own identity, data dir
 * and real mDNS/TLS network-light transport) and exercises real
 * network-exposed capability calls between them.
 *
 * Scenario: A <-> B <-> C form a full mesh, A calls C directly, and A routes a
 * chained call A -> B -> C (B forwards to C over the wire).
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

test("three peers A<->B<->C form a full mesh and route a chained capability call", async () => {
  const a = await bootPeer("a");
  const b = await bootPeer("b");
  const c = await bootPeer("c");

  try {
    await waitFor(
      () => knownPeerIds(a).has(b.peerId) && knownPeerIds(a).has(c.peerId),
    );
    await waitFor(
      () => knownPeerIds(b).has(a.peerId) && knownPeerIds(b).has(c.peerId),
    );
    await waitFor(
      () => knownPeerIds(c).has(a.peerId) && knownPeerIds(c).has(b.peerId),
    );

    const direct = await a.node.sendEcho(c.peerId);
    assert.equal(direct.status, "ok");
    assert.deepEqual(direct.result, { echoed: { hello: "direct" } });

    const chained = await a.node.sendForward(b.peerId, c.peerId, {
      hello: "chain",
    });
    assert.equal(chained.status, "ok");
    assert.deepEqual(chained.result, { echoed: { hello: "chain" } });
  } finally {
    await Promise.allSettled([a.host.stop(), b.host.stop(), c.host.stop()]);
  }
});
