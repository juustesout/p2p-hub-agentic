import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import type { PeerIdentity, TaskHandler } from "@p2p-hub/sdk";
import { createLibp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { circuitRelayServer } from "@libp2p/circuit-relay-v2";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { multiaddr } from "@multiformats/multiaddr";
import {
  HANDSHAKE_TIMEOUT_MS,
  NETWORK_PROTOCOL_VERSION,
  buildIdentityBindingMessage,
  encodeHello,
  randomNonce,
} from "@p2p-hub/network-light/dist/wire-contract.js";
import { NetworkLibp2pProvider } from "./network-libp2p-provider.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A fresh Ed25519 p2p-hub identity plus a signer proving possession of its key. */
function makeIdentity(): {
  identity: PeerIdentity;
  signer: (data: Buffer) => Promise<Buffer>;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  const peerId = Buffer.from(jwk.x, "base64url").toString("hex");
  return {
    identity: { peerId, publicKeyHex: peerId },
    signer: async (data: Buffer) => crypto.sign(null, data, privateKey),
  };
}

async function waitFor<T>(
  probe: () => T | null | undefined,
  timeoutMs = 10_000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** A local circuit-relay v2 relay node bound to loopback (no public infra). */
async function startLocalRelay(): Promise<Awaited<ReturnType<typeof createLibp2p>>> {
  return createLibp2p({
    addresses: { listen: ["/ip4/127.0.0.1/tcp/0"] },
    transports: [tcp()],
    streamMuxers: [yamux()],
    connectionEncrypters: [noise()],
    services: { relay: circuitRelayServer() },
  });
}

/** First advertised multiaddr of the relay (loopback TCP + its peer id). */
function relayAddress(relay: Awaited<ReturnType<typeof createLibp2p>>): string {
  return relay.getMultiaddrs()[0].toString();
}

/** A provider that is always equipped with identity + signer + rate-limit gate. */
function makeProvider(
  options: ConstructorParameters<typeof NetworkLibp2pProvider>[0] & {
    rateLimited?: boolean;
  } = {},
): NetworkLibp2pProvider {
  const keys = makeIdentity();
  return new NetworkLibp2pProvider({
    listenAddresses: ["/ip4/127.0.0.1/tcp/0"],
    identity: keys.identity,
    identitySigner: keys.signer,
    hasBrokerRateLimiting: () => options.rateLimited ?? true,
    ...options,
  });
}

async function waitForRelayedAddress(provider: NetworkLibp2pProvider): Promise<string> {
  return waitFor(
    () =>
      provider
        .getListeningAddresses()
        .find((address) => address.includes("/p2p-circuit")) ?? null,
  );
}

function directAddress(provider: NetworkLibp2pProvider): string {
  const address = provider
    .getListeningAddresses()
    .find((a) => a.startsWith("/ip4/") && !a.includes("/p2p-circuit"));
  assert.ok(address, "provider must advertise a direct TCP address");
  return address;
}

// ---------------------------------------------------------------------------
// Start gates (Deel 2 is code-gated on Deel 1)
// ---------------------------------------------------------------------------

test("start refuses when the broker does not report per-peer rate limiting", async () => {
  const keys = makeIdentity();
  const provider = new NetworkLibp2pProvider({
    identity: keys.identity,
    identitySigner: keys.signer,
    hasBrokerRateLimiting: () => false,
  });

  await assert.rejects(() => provider.start(), /per-peer rate limiting/);
  assert.equal(provider.isReady(), false);
});

test("start refuses when no rate-limiting gate is wired at all (fail-closed)", async () => {
  const keys = makeIdentity();
  const provider = new NetworkLibp2pProvider({
    identity: keys.identity,
    identitySigner: keys.signer,
  });

  await assert.rejects(() => provider.start(), /per-peer rate limiting/);
});

test("start refuses without identity and identitySigner", async () => {
  const provider = new NetworkLibp2pProvider({ hasBrokerRateLimiting: () => true });
  await assert.rejects(() => provider.start(), /identity and identitySigner/);
});

test("start succeeds with the rate-limiting gate and identity in place", async () => {
  const provider = makeProvider();
  try {
    await provider.start();
    assert.equal(provider.isReady(), true);
    assert.ok(provider.transportPeerId);
  } finally {
    await provider.stop();
  }
});

// ---------------------------------------------------------------------------
// Happy path: full wire-contract roundtrip through a local relay (NAT sim)
// ---------------------------------------------------------------------------

test("a task roundtrips through a local relay using the same wire contract", async () => {
  const relay = await startLocalRelay();
  try {
    const serverKeys = makeIdentity();
    const server = new NetworkLibp2pProvider({
      listenAddresses: ["/ip4/127.0.0.1/tcp/0"],
      relayAddresses: [relayAddress(relay)],
      skills: ["demo.echo"],
      identity: serverKeys.identity,
      identitySigner: serverKeys.signer,
      hasBrokerRateLimiting: () => true,
    });
    server.onTask(async (task) => ({
      taskId: task.id,
      status: "ok",
      result: `pong:${String(task.payload)}`,
    }));
    await server.start();

    // Simulated NAT: the server is only reached via its relayed circuit
    // address — the client never learns a direct TCP address.
    const relayedAddress = await waitForRelayedAddress(server);

    const client = makeProvider();
    await client.start();

    const result = await client.sendTask(
      { id: "relayed-peer", address: relayedAddress, skills: [] },
      { id: "task-1", skill: "demo.echo", payload: "hello" },
    );

    assert.equal(result.status, "ok");
    assert.equal(result.result, "pong:hello");

    await client.stop();
    await server.stop();
  } finally {
    await relay.stop();
  }
});

test("the handler receives the transport-verified p2p-hub peerId, never a wire echo", async () => {
  const relay = await startLocalRelay();
  try {
    const serverKeys = makeIdentity();
    const server = new NetworkLibp2pProvider({
      listenAddresses: ["/ip4/127.0.0.1/tcp/0"],
      relayAddresses: [relayAddress(relay)],
      identity: serverKeys.identity,
      identitySigner: serverKeys.signer,
      hasBrokerRateLimiting: () => true,
    });
    const seenPeerIds: Array<string | undefined> = [];
    server.onTask(async (task) => {
      seenPeerIds.push(task.peerId);
      return { taskId: task.id, status: "ok", result: task.peerId };
    });
    await server.start();
    const relayedAddress = await waitForRelayedAddress(server);

    const clientKeys = makeIdentity();
    const client = new NetworkLibp2pProvider({
      identity: clientKeys.identity,
      identitySigner: clientKeys.signer,
      hasBrokerRateLimiting: () => true,
    });
    await client.start();

    const result = await client.sendTask(
      { id: "relayed-peer", address: relayedAddress, skills: [] },
      { id: "task-2", skill: "demo.whoami", payload: { peerId: "forged" } },
    );

    assert.equal(result.status, "ok");
    // The p2p-hub identity the server saw must be the *client's* verified
    // identity — never the caller-supplied payload field.
    assert.equal(seenPeerIds[0], clientKeys.identity.peerId);
    assert.equal(result.result, clientKeys.identity.peerId);

    await client.stop();
    await server.stop();
  } finally {
    await relay.stop();
  }
});

// ---------------------------------------------------------------------------
// Server-side default-deny on the wire contract (raw libp2p client)
// ---------------------------------------------------------------------------

/** A hand-rolled libp2p client used to send arbitrary (malformed) wire bytes. */
class RawClient {
  private readonly node: Awaited<ReturnType<typeof createLibp2p>>;
  private readonly stream: import("@libp2p/interface").Stream;
  private buffer: Buffer = Buffer.alloc(0);

  private constructor(
    node: Awaited<ReturnType<typeof createLibp2p>>,
    stream: import("@libp2p/interface").Stream,
  ) {
    this.node = node;
    this.stream = stream;
  }

  static async dial(address: string): Promise<RawClient> {
    const node = await createLibp2p({
      addresses: { listen: [] },
      transports: [tcp()],
      streamMuxers: [yamux()],
      connectionEncrypters: [noise()],
    });
    const stream = await node.dialProtocol(multiaddr(address), "/p2p-hub/network/1.0.0", {
      runOnLimitedConnection: true,
    });
    return new RawClient(node, stream);
  }

  sendFrame(text: string): void {
    const body = Buffer.from(text, "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    this.stream.send(Buffer.concat([header, body]));
  }

  /** Read one complete frame, or null on timeout/EOF. */
  async readFrame(timeoutMs: number): Promise<unknown | null> {
    const deadline = Date.now() + timeoutMs;
    const iterator = this.stream[Symbol.asyncIterator]();
    for (;;) {
      const frame = this.tryDecode();
      if (frame !== null) {
        return frame;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return null;
      }
      const raced = (await Promise.race([
        iterator.next(),
        new Promise((resolve) =>
          setTimeout(() => resolve({ timedOut: true }), remaining),
        ),
      ]).catch(() => ({ reset: true }))) as
        | { done: true; value?: undefined }
        | { done: false; value: Uint8Array | { subarray(): Uint8Array } }
        | { timedOut: true }
        | { reset: true };
      if ("timedOut" in raced || "reset" in raced) {
        return null;
      }
      if (raced.done) {
        return null;
      }
      const chunk =
        raced.value instanceof Uint8Array
          ? Buffer.from(raced.value)
          : Buffer.from(raced.value.subarray());
      this.buffer = Buffer.concat([this.buffer, chunk]);
    }
  }

  private tryDecode(): unknown | null {
    if (this.buffer.length < 4) {
      return null;
    }
    const length = this.buffer.readUInt32BE(0);
    if (this.buffer.length < 4 + length) {
      return null;
    }
    const body = this.buffer.subarray(4, 4 + length);
    this.buffer = this.buffer.subarray(4 + length);
    return JSON.parse(body.toString("utf8"));
  }

  async close(): Promise<void> {
    try {
      this.stream.abort(new Error("test client closed"));
    } catch {
      // already closed
    }
    await this.node.stop();
  }
}

async function startRejectionServer(
  onTask: TaskHandler,
): Promise<{ provider: NetworkLibp2pProvider; address: string }> {
  const server = makeProvider({ skills: ["demo.echo"] });
  server.onTask(onTask);
  await server.start();
  return { provider: server, address: directAddress(server) };
}

test("server refuses a task from a client with an invalid identity signature", async () => {
  let dispatched = 0;
  const { provider, address } = await startRejectionServer(async (task) => {
    dispatched += 1;
    return { taskId: task.id, status: "ok", result: "never" };
  });
  try {
    const attacker = makeIdentity();
    const client = await RawClient.dial(address);

    client.sendFrame(encodeHello([NETWORK_PROTOCOL_VERSION], [], randomNonce()));
    const ack = (await client.readFrame(HANDSHAKE_TIMEOUT_MS)) as
      | { type: string; body: { nonce?: string } }
      | null;
    assert.ok(ack && ack.type === "hello_ack");

    const serverNonce = ack.body.nonce as string;
    const clientNonce = randomNonce();
    // Sign over a *different* context than the one the server expects, so the
    // signature verifies under the attacker's key but the binding fails.
    const garbageSignature = await attacker.signer(
      buildIdentityBindingMessage(clientNonce, serverNonce, "ff".repeat(32)),
    );
    const forged = {
      protocol: "p2p-hub:network",
      version: NETWORK_PROTOCOL_VERSION,
      type: "auth",
      body: {
        peerId: attacker.identity.peerId,
        certFingerprint: "00".repeat(32),
        signature: garbageSignature.toString("hex"),
      },
    };
    client.sendFrame(JSON.stringify(forged));
    client.sendFrame(
      JSON.stringify({
        protocol: "p2p-hub:network",
        version: NETWORK_PROTOCOL_VERSION,
        type: "task",
        body: { id: "evil", skill: "demo.echo", payload: "x" },
      }),
    );

    // The server must close without dispatching: no result frame arrives.
    const result = await client.readFrame(2_000);
    assert.equal(result, null);
    assert.equal(dispatched, 0);

    await client.close();
  } finally {
    await provider.stop();
  }
});

test("server refuses a task sent without an auth (no anonymous traffic)", async () => {
  let dispatched = 0;
  const { provider, address } = await startRejectionServer(async (task) => {
    dispatched += 1;
    return { taskId: task.id, status: "ok", result: "never" };
  });
  try {
    const client = await RawClient.dial(address);

    client.sendFrame(encodeHello([NETWORK_PROTOCOL_VERSION], [], randomNonce()));
    const ack = (await client.readFrame(HANDSHAKE_TIMEOUT_MS)) as
      | { type: string }
      | null;
    assert.ok(ack && ack.type === "hello_ack");

    // Task straight after the handshake, no auth in between.
    client.sendFrame(
      JSON.stringify({
        protocol: "p2p-hub:network",
        version: NETWORK_PROTOCOL_VERSION,
        type: "task",
        body: { id: "anon", skill: "demo.echo", payload: "x" },
      }),
    );

    const result = await client.readFrame(2_000);
    assert.equal(result, null);
    assert.equal(dispatched, 0);

    await client.close();
  } finally {
    await provider.stop();
  }
});

test("server closes a stream whose first message is not hello", async () => {
  let dispatched = 0;
  const { provider, address } = await startRejectionServer(async (task) => {
    dispatched += 1;
    return { taskId: task.id, status: "ok", result: "never" };
  });
  try {
    const client = await RawClient.dial(address);

    client.sendFrame(
      JSON.stringify({
        protocol: "p2p-hub:network",
        version: NETWORK_PROTOCOL_VERSION,
        type: "task",
        body: { id: "early", skill: "demo.echo", payload: "x" },
      }),
    );

    const result = await client.readFrame(2_000);
    assert.equal(result, null);
    assert.equal(dispatched, 0);

    await client.close();
  } finally {
    await provider.stop();
  }
});

// ---------------------------------------------------------------------------
// Provider surface
// ---------------------------------------------------------------------------

test("discover returns nothing and listPeers is empty (no WAN discovery)", async () => {
  const provider = makeProvider();
  await provider.start();
  try {
    assert.deepEqual(await provider.discover(), []);
    assert.deepEqual(provider.listPeers(), []);
  } finally {
    await provider.stop();
  }
});

test("sendTask reports an error when the transport is stopped", async () => {
  const provider = makeProvider();
  const result = await provider.sendTask(
    { id: "p", address: "/ip4/127.0.0.1/tcp/1/p2p/12D3KooWAbCdEfGhIjKlMnOpQrStUvWxYz1234567890abc", skills: [] },
    { id: "t", skill: "demo.echo", payload: "x" },
  );
  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /not started/);
});

test("sendTask rejects a peer address without a /p2p/ peer id", async () => {
  const provider = makeProvider();
  await provider.start();
  try {
    const result = await provider.sendTask(
      { id: "p", address: "/ip4/127.0.0.1/tcp/9999", skills: [] },
      { id: "t", skill: "demo.echo", payload: "x" },
    );
    assert.equal(result.status, "error");
    assert.match(result.error ?? "", /peer address has no \/p2p\/ peer id/);
  } finally {
    await provider.stop();
  }
});

test("priority is low so the registry never auto-promotes this transport", () => {
  const provider = makeProvider();
  assert.ok(provider.priority < 10, "must stay below network-light's priority 10");
  assert.equal(provider.id, "network-libp2p");
});
