import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CoreServer } from "./app";
import { PluginHost } from "@p2p-hub/core";

const BOOT_TOKEN = "contacts-glue-token";

const PEER_ID = "a".repeat(64);
const OTHER_ID = "b".repeat(64);

// Real mDNS multicast discovery is not delivered on GitHub-hosted macOS
// runners, so the two-node discovery-based test is skipped there (same rule as
// the network-light / plugin-host networking suites).
const MDNS_SKIP =
  process.platform === "darwin" &&
  "real mDNS multicast discovery is not delivered on GitHub macOS runners; the raw-TLS tests still run";

/**
 * Temp dirs that boot a real PluginHost — under node_modules/.cache so the
 * copied contacts plugin's `require("@p2p-hub/*")` resolves (same trick as
 * the media glue tests).
 */
const TEST_TMP_ROOT = path.resolve(__dirname, "../../../node_modules/.cache/p2p-hub-test");

/** Source of the compiled contacts plugin, copied into each temp pluginsDir. */
const CONTACTS_SRC = path.resolve(__dirname, "../../../plugins/contacts");

async function bootContactsServer(): Promise<{ server: CoreServer; port: number }> {
  await fs.mkdir(TEST_TMP_ROOT, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(TEST_TMP_ROOT, "core-server-contacts-glue-"));
  const pluginsDir = path.join(dataDir, "plugins");
  await fs.mkdir(pluginsDir, { recursive: true });
  await fs.cp(CONTACTS_SRC, path.join(pluginsDir, "contacts"), { recursive: true });

  const server = new CoreServer({
    pluginsDir,
    dataDir,
    host: "127.0.0.1",
    port: 0,
    bootToken: BOOT_TOKEN,
    networking: false,
  });
  await server.start();
  const addr = server.address();
  assert.ok(addr, "server should report its bound address");
  return { server, port: addr.port };
}

/** CoreServer with the P2P transport enabled (provider wired for plugins). */
async function bootContactsNetworkingServer(): Promise<{ server: CoreServer; port: number }> {
  await fs.mkdir(TEST_TMP_ROOT, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(TEST_TMP_ROOT, "core-server-contacts-net-"));
  const pluginsDir = path.join(dataDir, "plugins");
  await fs.mkdir(pluginsDir, { recursive: true });
  await fs.cp(CONTACTS_SRC, path.join(pluginsDir, "contacts"), { recursive: true });

  const server = new CoreServer({
    pluginsDir,
    dataDir,
    host: "127.0.0.1",
    port: 0,
    bootToken: BOOT_TOKEN,
    networking: true,
  });
  await server.start();
  const addr = server.address();
  assert.ok(addr, "server should report its bound address");
  return { server, port: addr.port };
}

/** A second P2P node running the contacts plugin (serves signChallenge). */
async function bootPeerHost(): Promise<{ host: PluginHost; peerId: string }> {
  await fs.mkdir(TEST_TMP_ROOT, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(TEST_TMP_ROOT, "contacts-peer-"));
  const pluginsDir = path.join(dataDir, "plugins");
  await fs.mkdir(pluginsDir, { recursive: true });
  await fs.cp(CONTACTS_SRC, path.join(pluginsDir, "contacts"), { recursive: true });

  const host = new PluginHost({
    pluginsDir,
    dataDir,
    enableNetworking: true,
  });
  await host.boot();
  const peerId = (await host.identityManager().getOrCreateIdentity()).peerId;
  return { host, peerId };
}

async function waitFor<T>(
  check: () => Promise<T | null>,
  timeoutMs = 15_000,
  intervalMs = 150,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

async function execute(
  port: number,
  body: { serviceId: string; method: string; arguments?: unknown },
): Promise<{ status: string; result?: unknown; error?: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BOOT_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as { status: string; result?: unknown; error?: string };
}

test("contacts management skills are httpBridgeOnly (HTTP-exposed, never network)", async () => {
  const { server, port } = await bootContactsServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/capabilities`, {
      headers: { Authorization: `Bearer ${BOOT_TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      local: {
        skills: Array<{
          skill: string;
          localOnly: boolean;
          httpExposed: boolean;
          httpBridgeOnly: boolean;
        }>;
      };
    };

    for (const skill of [
      "contacts.addContact",
      "contacts.listContacts",
      "contacts.removeContact",
      "contacts.verifyPeer",
      "contacts.blockContact",
      "contacts.unblockContact",
    ]) {
      const record = body.local.skills.find((s) => s.skill === skill);
      assert.ok(record, `${skill} should be registered`);
      assert.equal(record.httpBridgeOnly, true, `${skill} must be httpBridgeOnly`);
      assert.equal(record.httpExposed, true, `${skill} must be reachable over HTTP`);
      assert.equal(record.localOnly, true, `${skill} must stay local-only`);
    }

    const signChallenge = body.local.skills.find((s) => s.skill === "contacts.signChallenge");
    assert.ok(signChallenge, "signChallenge should be registered");
    assert.equal(signChallenge.httpExposed, false, "the peer-facing skill is never HTTP-exposed");
    assert.equal(signChallenge.localOnly, false, "signChallenge stays network-exposed for peers");
  } finally {
    await server.stop();
  }
});

test("a full contact lifecycle works over the HTTP bridge with the boot token", async () => {
  const { server, port } = await bootContactsServer();
  try {
    const added = await execute(port, {
      serviceId: "contacts",
      method: "addContact",
      arguments: { peerId: PEER_ID, publicKeyHex: PEER_ID, displayName: "Alice" },
    });
    assert.equal(added.status, "ok");
    assert.equal((added.result as { trustState?: string }).trustState, "pending");

    const listed = await execute(port, { serviceId: "contacts", method: "listContacts" });
    assert.equal(listed.status, "ok");
    const list = listed.result as Array<{ peerId: string; trustState: string }>;
    assert.equal(list.length, 1);
    assert.equal(list[0].peerId, PEER_ID);

    const blocked = await execute(port, {
      serviceId: "contacts",
      method: "blockContact",
      arguments: { peerId: PEER_ID },
    });
    assert.equal(blocked.status, "ok");
    assert.equal((blocked.result as { trustState?: string }).trustState, "blocked");

    const unblocked = await execute(port, {
      serviceId: "contacts",
      method: "unblockContact",
      arguments: { peerId: PEER_ID },
    });
    assert.equal(unblocked.status, "ok");
    assert.equal((unblocked.result as { trustState?: string }).trustState, "pending");

    const removed = await execute(port, {
      serviceId: "contacts",
      method: "removeContact",
      arguments: { peerId: PEER_ID },
    });
    assert.equal(removed.status, "ok");
    assert.equal(removed.result, true);

    const after = await execute(port, { serviceId: "contacts", method: "listContacts" });
    assert.deepEqual(after.result, []);
  } finally {
    await server.stop();
  }
});

test("verifyPeer over HTTP returns the graceful no-network error, never a throw", async () => {
  const { server, port } = await bootContactsServer();
  try {
    await execute(port, {
      serviceId: "contacts",
      method: "addContact",
      arguments: { peerId: OTHER_ID, publicKeyHex: OTHER_ID, displayName: "Bob" },
    });

    const verified = await execute(port, {
      serviceId: "contacts",
      method: "verifyPeer",
      arguments: { peerId: OTHER_ID },
    });
    assert.equal(verified.status, "ok");
    // CoreServer always wires a (provider-less) network capability, so the
    // graceful failure is the stub's "no active network provider", never a throw.
    assert.deepEqual(verified.result, { verified: false, error: "no active network provider" });
  } finally {
    await server.stop();
  }
});

test("verifyPeer over HTTP reaches a real peer once the transport is wired into the plugin host registry", { skip: MDNS_SKIP }, async () => {
  const { server, port } = await bootContactsNetworkingServer();
  const peer = await bootPeerHost();
  try {
    // Wait until the core-server's transport has discovered the peer node.
    await waitFor(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/capabilities`, {
        headers: { Authorization: `Bearer ${BOOT_TOKEN}` },
      });
      if (res.status !== 200) {
        return null;
      }
      const body = (await res.json()) as {
        remote?: { peers?: Array<{ peerId?: string }> };
      };
      return (body.remote?.peers ?? []).some((p) => p.peerId === peer.peerId)
        ? true
        : null;
    });

    await execute(port, {
      serviceId: "contacts",
      method: "addContact",
      arguments: { peerId: peer.peerId, publicKeyHex: peer.peerId, displayName: "Peer B" },
    });

    // The contacts plugin's `ctx.network` must resolve the CoreServer's real
    // provider (registered into the host's network registry), route the
    // challenge to the peer's signChallenge skill, verify the returned
    // signature and promote the contact to "verified". Before the registry
    // wiring this returned "no active network provider" even though the
    // transport was healthy.
    const verified = await execute(port, {
      serviceId: "contacts",
      method: "verifyPeer",
      arguments: { peerId: peer.peerId },
    });
    assert.equal(verified.status, "ok");
    assert.deepEqual(verified.result, { verified: true });

    const listed = await execute(port, { serviceId: "contacts", method: "listContacts" });
    const records = listed.result as Array<{ peerId: string; trustState: string }>;
    const promoted = records.find((c) => c.peerId === peer.peerId);
    assert.equal(promoted?.trustState, "verified");

    // End-to-end transport smoke: the peer node's own transport invokes
    // `core.echo` (localOnly: false, remote gate "any") back on the
    // CoreServer. This proves the full loop — mDNS discovery, TLS +
    // identity-binding handshake, broker dispatch — independent of the
    // contacts plugin, and it exercises the reverse direction (peer →
    // CoreServer) of the wiring.
    const serverHost = server as unknown as { host: PluginHost };
    const serverPeerId = (await serverHost.host.identityManager().getOrCreateIdentity()).peerId;
    const active = peer.host.networkRegistry().selectActive();
    assert.ok(active, "peer node should have an active network provider");
    const target = await waitFor(async () => {
      const peers = active.listPeers ? active.listPeers() : [];
      return peers.find((p) => p.peerId === serverPeerId) ?? null;
    });
    const echoed = await active.sendTask(target, {
      id: "echo-1",
      skill: "core.echo",
      payload: "remote round-trip",
    });
    assert.equal(echoed.status, "ok");
    assert.equal(echoed.result, "remote round-trip");
  } finally {
    await peer.host.stop();
    await server.stop();
  }
});

test("contacts management skills are rejected over the network path (never reachable from a peer)", async () => {
  const { server } = await bootContactsServer();
  try {
    // Reach the real broker's network gate through the private host seam (same
    // pattern as the media glue tests): with networking disabled the CoreServer
    // never wires a transport, so this exercises the boundary the way
    // `wireNetworkToBroker` would — proving a bridge-only skill cannot be
    // dispatched for a remote peer no matter how the caller addresses it.
    const host = server as unknown as {
      host: {
        broker: {
          handleRemote: (t: {
            id: string;
            skill: string;
            payload: unknown;
            peerId: string;
          }) => Promise<{ status: string; error?: string }>;
        };
      };
    };
    const result = await host.host.broker.handleRemote({
      id: "remote-1",
      skill: "contacts.addContact",
      payload: { peerId: PEER_ID, publicKeyHex: PEER_ID, displayName: "Eve" },
      peerId: OTHER_ID,
    });
    assert.equal(result.status, "error");
    assert.match(result.error ?? "", /local-only/);
  } finally {
    await server.stop();
  }
});
