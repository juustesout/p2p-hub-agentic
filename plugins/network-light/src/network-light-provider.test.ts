import { test } from "node:test";
import assert from "node:assert/strict";
import * as tls from "node:tls";
import * as net from "node:net";
import * as crypto from "node:crypto";
import * as forge from "node-forge";
import type { Service } from "bonjour-service";
import { NetworkLightProvider } from "./network-light-provider";
import type { DiscoveredPeer, NetworkLightOptions } from "./network-light-provider";
import type { NetworkPeer, PeerIdentity } from "@p2p-hub/sdk";
import {
  buildIdentityBindingMessage,
  normalizeFingerprint,
  randomNonce,
} from "./wire-contract";

// Real mDNS multicast discovery depends on the environment delivering
// multicast to a second socket on the same host. GitHub-hosted macOS runners
// do not (the discovery waits time out there), while ubuntu/windows runners
// do. Discovery-dependent tests are skipped on darwin with this visible
// reason; the raw-TLS and abuse-limit tests still run on every OS.
const MDNS_SKIP =
  process.platform === "darwin" &&
  "real mDNS multicast discovery is not delivered on GitHub macOS runners; raw-TLS tests still run";

function framePayload(json: string): Buffer {
  const body = Buffer.from(json, "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  check: () => Promise<T | null | undefined>,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null | undefined;
  while (Date.now() < deadline) {
    last = await check();
    if (last) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

function generateSelfSignedCert(): { key: string; cert: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01" + forge.util.bytesToHex(forge.random.getBytesSync(16));
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  cert.setSubject([{ name: "commonName", value: "p2p-hub" }]);
  cert.setIssuer([{ name: "commonName", value: "p2p-hub" }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  };
}

function listen(server: tls.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

function close(server: tls.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** A fresh Ed25519 identity plus a signer proving possession of its key. */
function makeIdentity(): { identity: PeerIdentity; signer: (data: Buffer) => Promise<Buffer> } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  const peerId = Buffer.from(jwk.x, "base64url").toString("hex");
  return {
    identity: { peerId, publicKeyHex: peerId },
    signer: async (data: Buffer) => crypto.sign(null, data, privateKey),
  };
}

/** A provider that is always equipped with identity + signer (mandatory). */
function makeProvider(
  options: Omit<NetworkLightOptions, "identity" | "identitySigner"> = {},
): NetworkLightProvider {
  const keyPair = makeIdentity();
  return new NetworkLightProvider({
    ...options,
    identity: keyPair.identity,
    identitySigner: keyPair.signer,
  });
}

async function waitForPeerWithId(
  provider: NetworkLightProvider,
  peerId: string,
  excludeId?: string,
  timeoutMs = 10_000,
): Promise<DiscoveredPeer> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = provider
      .listPeers()
      .find((peer) => peer.peerId === peerId && peer.id !== excludeId);
    if (found) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`peer with id ${peerId} not discovered within ${timeoutMs}ms`);
}

/**
 * Open a raw TLS connection to a provider and complete a full identity-bound
 * handshake (hello -> hello_ack -> auth). Resolves once the connection is
 * authenticated; the wire peerId of this connection is `clientKey`'s peerId.
 */
async function openAuthenticatedConnection(
  provider: NetworkLightProvider,
  clientKey: ReturnType<typeof makeIdentity>,
): Promise<tls.TLSSocket> {
  const { key, cert } = generateSelfSignedCert();
  const certFingerprint = normalizeFingerprint(
    new crypto.X509Certificate(cert).fingerprint256,
  );
  const clientNonce = randomNonce();

  const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
    const raw = tls.connect(
      { host: "127.0.0.1", port: provider.port, key, cert, rejectUnauthorized: false },
      () => resolve(raw),
    );
    raw.once("error", reject);
  });
  const serverNoncePromise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no hello_ack received")), 3_000);
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (text.includes("hello_ack")) {
        const parsed = JSON.parse(text.slice(text.indexOf("{"))) as {
          body: { nonce?: string };
        };
        clearTimeout(timer);
        socket.off("data", onData);
        resolve(parsed.body.nonce ?? "");
      }
    };
    socket.on("data", onData);
  });
  socket.write(
    framePayload(
      JSON.stringify({
        protocol: "p2p-hub:network",
        version: 1,
        type: "hello",
        body: { versions: [1], capabilities: [], nonce: clientNonce },
      }),
    ),
  );
  const serverNonce = await serverNoncePromise;

  const signature = await clientKey.signer(
    buildIdentityBindingMessage(clientNonce, serverNonce, certFingerprint),
  );
  socket.write(
    framePayload(
      JSON.stringify({
        protocol: "p2p-hub:network",
        version: 1,
        type: "auth",
        body: {
          peerId: clientKey.identity.peerId,
          certFingerprint,
          signature: signature.toString("hex"),
        },
      }),
    ),
  );
  return socket;
}

/** Read the next JSON envelope(s) already on the wire, if any are present. */
function readEnvelopes(chunks: Buffer[]): Array<Record<string, unknown>> {
  const all = Buffer.concat(chunks).toString("utf8");
  const envelopes: Array<Record<string, unknown>> = [];
  for (const part of all.split("\n")) {
    const match = part.match(/\{.*\}/);
    if (match) {
      envelopes.push(JSON.parse(match[0]) as Record<string, unknown>);
    }
  }
  return envelopes;
}

test("two local instances discover each other and exchange a task", { skip: MDNS_SKIP }, async () => {
  const alice = makeProvider({ port: 0, skills: ["echo"] });
  const bob = makeProvider({ port: 0, skills: ["echo"] });

  bob.onTask(async (task) => ({
    taskId: task.id,
    status: "ok",
    result: `pong:${String(task.payload)}`,
  }));

  await alice.start();
  await bob.start();

  try {
    assert.equal(alice.isReady(), true);
    assert.equal(bob.isReady(), true);

    const peers = await waitFor<NetworkPeer[]>(async () => {
      const found = await alice.discover("echo");
      return found.length > 0 ? found : null;
    });

    assert.equal(peers.length, 1);
    // Fase 0C: mDNS must not leak skill names. Fase 1A: the authenticated
    // handshake reveals what the peer offers, so the peer's skills are now
    // known and populated — but they arrived over the TLS connection, never
    // via the mDNS advertisement.
    assert.deepEqual(
      peers[0].skills,
      ["echo"],
      "skills are learned via the authenticated handshake, not mDNS",
    );

    const result = await alice.sendTask(peers[0], {
      id: "task-1",
      skill: "echo",
      payload: "hello",
    });

    assert.equal(result.status, "ok");
    assert.equal(result.result, "pong:hello");
  } finally {
    await alice.stop();
    await bob.stop();
  }
});

test("discovery survives the heartbeat TTL via periodic re-announcement", { skip: MDNS_SKIP }, async () => {
  // Short TTL + sweep so the prune and re-announce timers run fast. Without
  // the provider's own re-announce heartbeat, bonjour's built-in announce
  // chain backs off (1s, 4s, 13s…) and the 1.5s prune would drop bob within a
  // few seconds. With it, bob stays discoverable indefinitely.
  const bobIdentity = makeIdentity();
  const alice = makeProvider({
    port: 0,
    skills: ["echo"],
    heartbeatTtlMs: 1_500,
    sweepIntervalMs: 500,
  });
  const bob = new NetworkLightProvider({
    port: 0,
    skills: ["echo"],
    identity: bobIdentity.identity,
    identitySigner: bobIdentity.signer,
    heartbeatTtlMs: 1_500,
    sweepIntervalMs: 500,
  });

  await alice.start();
  await bob.start();

  try {
    const bobPeer = await waitForPeerWithId(alice, bobIdentity.identity.peerId);
    assert.ok(bobPeer);

    // Wait well past several heartbeat-TTL windows.
    await delay(5_000);

    const stillThere = await waitForPeerWithId(
      alice,
      bobIdentity.identity.peerId,
      undefined,
      5_000,
    );
    assert.ok(stillThere, "bob must still be discovered long past the heartbeat TTL");
  } finally {
    await alice.stop();
    await bob.stop();
  }
});

test("a peer with an identity advertises both certFingerprint and peerId", { skip: MDNS_SKIP }, async () => {
  const bobKey = makeIdentity();
  const alice = makeProvider({ port: 0, skills: ["echo"] });
  const bob = new NetworkLightProvider({
    port: 0,
    skills: ["echo"],
    identity: bobKey.identity,
    identitySigner: bobKey.signer,
  });

  await alice.start();
  await bob.start();

  try {
    const bobPeer = await waitForPeerWithId(alice, bobKey.identity.peerId);

    assert.equal(bobPeer.peerId, bobKey.identity.peerId);
    // The per-boot certificate fingerprint is still announced alongside the
    // persistent identity — neither replaces the other.
    assert.ok(bobPeer.certFingerprint);
  } finally {
    await alice.stop();
    await bob.stop();
  }
});

test("peerId is stable across restarts while certFingerprint changes", { skip: MDNS_SKIP }, async () => {
  const keyPair = makeIdentity();
  const alice = makeProvider({ port: 0, skills: ["echo"] });
  const bob1 = new NetworkLightProvider({
    port: 0,
    skills: ["echo"],
    identity: keyPair.identity,
    identitySigner: keyPair.signer,
  });

  await alice.start();
  await bob1.start();

  try {
    const bob1Peer = await waitForPeerWithId(alice, keyPair.identity.peerId);
    assert.ok(bob1Peer.certFingerprint);

    // Stop the first instance and bring up a second one with the *same*
    // identity. The peerId must remain identical; the certificate is a new
    // per-boot self-signed cert and therefore must differ.
    await bob1.stop();

    const bob2 = new NetworkLightProvider({
      port: 0,
      skills: ["echo"],
      identity: keyPair.identity,
      identitySigner: keyPair.signer,
    });
    await bob2.start();
    try {
      // Exclude bob1's instance id so we wait specifically for the new
      // instance (bob1's "down" event may not have been processed yet).
      const bob2Peer = await waitForPeerWithId(
        alice,
        keyPair.identity.peerId,
        bob1Peer.id,
      );
      assert.equal(bob2Peer.peerId, bob1Peer.peerId);
      assert.notEqual(bob2Peer.certFingerprint, bob1Peer.certFingerprint);
    } finally {
      await bob2.stop();
    }
  } finally {
    await alice.stop();
  }
});

test("task to a peer with a mismatched certificate fingerprint is rejected", { skip: MDNS_SKIP }, async () => {
  const alice = makeProvider({ port: 0, skills: ["echo"] });
  const bob = makeProvider({ port: 0, skills: ["echo"] });
  bob.onTask(async (task) => ({
    taskId: task.id,
    status: "ok",
    result: `pong:${String(task.payload)}`,
  }));

  await alice.start();
  await bob.start();

  let malloryServer: tls.Server | null = null;
  try {
    const peers = await waitFor<NetworkPeer[]>(async () => {
      const found = await alice.discover("echo");
      return found.length > 0 ? found : null;
    });
    const bobPeer = peers[0];

    // A third party presents its own self-signed cert while impersonating bob.
    const { key, cert } = generateSelfSignedCert();
    malloryServer = tls.createServer({ key, cert }, (socket) => {
      socket.on("data", () => {
        // Should never be reached: alice must reject before sending the task.
      });
    });
    const malloryPort = await listen(malloryServer);

    const result = await alice.sendTask(
      { ...bobPeer, address: `127.0.0.1:${malloryPort}` },
      { id: "task-mitm", skill: "echo", payload: "hello" },
    );

    assert.equal(result.status, "error");
    assert.equal(result.error, "certificate fingerprint mismatch");
  } finally {
    if (malloryServer) {
      await close(malloryServer);
    }
    await alice.stop();
    await bob.stop();
  }
});

test("discover filters by handshake-negotiated capabilities", { skip: MDNS_SKIP }, async () => {
  const alice = makeProvider({ port: 0, skills: ["echo", "ping"] });
  const bob = makeProvider({ port: 0, skills: ["echo"] });
  await bob.start();
  await alice.start();

  try {
    const echoPeers = await waitFor<NetworkPeer[]>(async () => {
      const found = await alice.discover("echo");
      return found.length > 0 ? found : null;
    });

    assert.equal(echoPeers.length, 1);
    assert.deepEqual(
      echoPeers[0].skills,
      ["echo"],
      "capabilities come from the authenticated handshake, not mDNS",
    );

    const pingPeers = await alice.discover("ping");
    assert.equal(
      pingPeers.length,
      0,
      "bob does not offer ping — capability probing must filter it out",
    );
  } finally {
    await alice.stop();
    await bob.stop();
  }
});

test("a peer's advertised maxPayloadBytes limit is honored before sending", { skip: MDNS_SKIP }, async () => {
  const alice = makeProvider({ port: 0, skills: ["echo"] });
  const bob = makeProvider({
    port: 0,
    skills: ["echo"],
    maxPayloadBytes: 128,
  });
  let handled = false;
  bob.onTask(async (task) => {
    handled = true;
    return { taskId: task.id, status: "ok", result: `pong:${String(task.payload)}` };
  });

  await alice.start();
  await bob.start();

  try {
    const peers = await waitFor<NetworkPeer[]>(async () => {
      const found = await alice.discover("echo");
      return found.length > 0 ? found : null;
    });

    const big = await alice.sendTask(peers[0], {
      id: "big",
      skill: "echo",
      payload: "x".repeat(512),
    });
    assert.equal(big.status, "error");
    assert.match(big.error ?? "", /exceeds peer's limit/);
    assert.equal(handled, false, "oversized task must never reach the remote handler");

    const ok = await alice.sendTask(peers[0], {
      id: "ok",
      skill: "echo",
      payload: "hi",
    });
    assert.equal(ok.status, "ok");
    assert.equal(ok.result, "pong:hi");
  } finally {
    await alice.stop();
    await bob.stop();
  }
});

test("a server denies an unsupported protocol version and closes the connection", { skip: MDNS_SKIP }, async () => {
  const bobKey = makeIdentity();
  const alice = makeProvider({ port: 0, skills: ["echo"] });
  const bob = new NetworkLightProvider({
    port: 0,
    skills: ["echo"],
    identity: bobKey.identity,
    identitySigner: bobKey.signer,
  });
  let handled = false;
  bob.onTask(async (task) => {
    handled = true;
    return { taskId: task.id, status: "ok", result: "pong" };
  });

  await alice.start();
  await bob.start();

  let raw: tls.TLSSocket | null = null;
  try {
    const bobPeer = await waitForPeerWithId(alice, bobKey.identity.peerId);
    const bobPort = Number(bobPeer.address.split(":").pop());

    raw = tls.connect(
      { host: "127.0.0.1", port: bobPort, rejectUnauthorized: false },
      () => {
        // Version 2 is not supported by this server — default-deny.
        // The envelope itself is the supported version 1 so the denial comes
        // from the strict version-membership gate, not from envelope parsing.
        raw!.write(
          framePayload(
            JSON.stringify({
              protocol: "p2p-hub:network",
              version: 1,
              type: "hello",
              body: { versions: [2], capabilities: [], nonce: randomNonce() },
            }),
          ),
        );
      },
    );
    raw.once("data", () => {
      raw!.destroy();
    });
    const closed = new Promise<void>((resolve) => {
      raw!.once("close", () => resolve());
    });

    await Promise.race([
      closed,
      delay(3_000).then(() => {
        throw new Error("server did not close the connection for an unsupported version");
      }),
    ]);
    assert.equal(handled, false, "nothing may be dispatched to an unsupported peer");
  } finally {
    raw?.destroy();
    await alice.stop();
    await bob.stop();
  }
});

test("a server closes the connection when a task arrives before the handshake", { skip: MDNS_SKIP }, async () => {
  const bobKey = makeIdentity();
  const alice = makeProvider({ port: 0, skills: ["echo"] });
  const bob = new NetworkLightProvider({
    port: 0,
    skills: ["echo"],
    identity: bobKey.identity,
    identitySigner: bobKey.signer,
  });
  let handled = false;
  bob.onTask(async (task) => {
    handled = true;
    return { taskId: task.id, status: "ok", result: "pong" };
  });

  await alice.start();
  await bob.start();

  let raw: tls.TLSSocket | null = null;
  try {
    const bobPeer = await waitForPeerWithId(alice, bobKey.identity.peerId);
    const bobPort = Number(bobPeer.address.split(":").pop());

    raw = tls.connect(
      { host: "127.0.0.1", port: bobPort, rejectUnauthorized: false },
      () => {
        // A task without a preceding hello violates the contract.
        raw!.write(
          framePayload(
            JSON.stringify({
              protocol: "p2p-hub:network",
              version: 1,
              type: "task",
              body: { id: "early", skill: "echo", payload: "hi" },
            }),
          ),
        );
      },
    );
    const closed = new Promise<void>((resolve) => {
      raw!.once("close", () => resolve());
    });

    await Promise.race([
      closed,
      delay(3_000).then(() => {
        throw new Error("server did not close a task-before-hello connection");
      }),
    ]);
    assert.equal(handled, false, "task-before-hello must never be dispatched");
  } finally {
    raw?.destroy();
    await alice.stop();
    await bob.stop();
  }
});

test("a server closes the connection on a malformed frame", { skip: MDNS_SKIP }, async () => {
  const bobKey = makeIdentity();
  const alice = makeProvider({ port: 0, skills: ["echo"] });
  const bob = new NetworkLightProvider({
    port: 0,
    skills: ["echo"],
    identity: bobKey.identity,
    identitySigner: bobKey.signer,
  });
  let handled = false;
  bob.onTask(async (task) => {
    handled = true;
    return { taskId: task.id, status: "ok", result: "pong" };
  });

  await alice.start();
  await bob.start();

  let raw: tls.TLSSocket | null = null;
  try {
    const bobPeer = await waitForPeerWithId(alice, bobKey.identity.peerId);
    const bobPort = Number(bobPeer.address.split(":").pop());

    raw = tls.connect(
      { host: "127.0.0.1", port: bobPort, rejectUnauthorized: false },
      () => {
        // A length prefix far beyond the allowed maximum.
        raw!.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00]));
      },
    );
    const closed = new Promise<void>((resolve) => {
      raw!.once("close", () => resolve());
    });

    await Promise.race([
      closed,
      delay(3_000).then(() => {
        throw new Error("server did not close the connection on a malformed frame");
      }),
    ]);
    assert.equal(handled, false, "malformed input must never be dispatched");
  } finally {
    raw?.destroy();
    await alice.stop();
    await bob.stop();
  }
});

test("identity binding: peers verify each other's claimed peerId", { skip: MDNS_SKIP }, async () => {
  const aliceKey = makeIdentity();
  const bobKey = makeIdentity();
  const alice = new NetworkLightProvider({
    port: 0,
    skills: ["echo"],
    identity: aliceKey.identity,
    identitySigner: aliceKey.signer,
  });
  const bob = new NetworkLightProvider({
    port: 0,
    skills: ["echo"],
    identity: bobKey.identity,
    identitySigner: bobKey.signer,
  });
  let inboundPeerId: string | undefined;
  bob.onTask(async (task) => {
    inboundPeerId = task.peerId;
    return { taskId: task.id, status: "ok", result: `pong:${String(task.payload)}` };
  });

  await alice.start();
  await bob.start();

  try {
    const peers = await waitFor<NetworkPeer[]>(async () => {
      const found = await alice.discover("echo");
      return found.length > 0 ? found : null;
    });

    // The capability probe verified bob's identity over the handshake.
    assert.equal(peers[0].peerId, bobKey.identity.peerId, "server identity verified via handshake");

    const result = await alice.sendTask(peers[0], {
      id: "bound",
      skill: "echo",
      payload: "hi",
    });
    assert.equal(result.status, "ok");
    assert.equal(result.result, "pong:hi");
    assert.equal(
      inboundPeerId,
      aliceKey.identity.peerId,
      "server sees the client's verified identity, not an anonymous peer",
    );
  } finally {
    await alice.stop();
    await bob.stop();
  }
});

test("identity binding: an auth claiming a peerId the signer does not hold is denied", async () => {
  const bobKey = makeIdentity();
  const bob = new NetworkLightProvider({
    port: 0,
    skills: ["echo"],
    identity: bobKey.identity,
    identitySigner: bobKey.signer,
  });
  let handled = false;
  bob.onTask(async (task) => {
    handled = true;
    return { taskId: task.id, status: "ok", result: "pong" };
  });

  await bob.start();

  // The impostor presents its own certificate and signs the binding message
  // with its own key, but CLAIMS a victim peerId it does not hold.
  const impostorKey = makeIdentity();
  const victimKey = makeIdentity();
  const { key, cert } = generateSelfSignedCert();
  const impostorCertFp = normalizeFingerprint(
    new crypto.X509Certificate(cert).fingerprint256,
  );

  let raw: tls.TLSSocket | null = null;
  try {
    const bobPort = bob.port;
    let serverNonce = "";
    const clientNonce = randomNonce();

    raw = tls.connect(
      { host: "127.0.0.1", port: bobPort, key, cert, rejectUnauthorized: false },
      () => {
        raw!.write(
          framePayload(
            JSON.stringify({
              protocol: "p2p-hub:network",
              version: 1,
              type: "hello",
              body: { versions: [1], capabilities: [], nonce: clientNonce },
            }),
          ),
        );
      },
    );

    const ackReceived = new Promise<void>((resolve) => {
      raw!.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        if (text.includes("hello_ack")) {
          const ack = JSON.parse(text.slice(text.indexOf("{"))) as {
            body: { nonce?: string };
          };
          serverNonce = ack.body.nonce ?? "";
          resolve();
        }
      });
    });
    await Promise.race([
      ackReceived,
      delay(3_000).then(() => {
        throw new Error("did not receive hello_ack");
      }),
    ]);

    // Sign with the impostor's own key, but claim the victim's peerId.
    const signature = await impostorKey.signer(
      buildIdentityBindingMessage(clientNonce, serverNonce, impostorCertFp),
    );
    raw!.write(
      framePayload(
        JSON.stringify({
          protocol: "p2p-hub:network",
          version: 1,
          type: "auth",
          body: {
            peerId: victimKey.identity.peerId,
            certFingerprint: impostorCertFp,
            signature: signature.toString("hex"),
          },
        }),
      ),
    );

    const closed = new Promise<void>((resolve) => {
      raw!.once("close", () => resolve());
    });
    await Promise.race([
      closed,
      delay(3_000).then(() => {
        throw new Error("server did not close the connection on a spoofed identity");
      }),
    ]);
    assert.equal(handled, false, "spoofed identity must never dispatch a task");
  } finally {
    raw?.destroy();
    await bob.stop();
  }
});

test("start() fails loudly without identity or identitySigner (no anonymous mode)", async () => {
  const anonymous = new NetworkLightProvider({ port: 0, skills: ["echo"] });
  await assert.rejects(anonymous.start(), /identity/);

  const noSigner = new NetworkLightProvider({
    port: 0,
    skills: ["echo"],
    identity: makeIdentity().identity,
  });
  await assert.rejects(noSigner.start(), /identitySigner/);
});

test("identity binding: a task without prior identity auth is denied (default-deny)", async () => {
  // There is no anonymous mode: the server closes the connection the moment a
  // task arrives on a connection that never produced a valid auth.
  const bobKey = makeIdentity();
  const bob = new NetworkLightProvider({
    port: 0,
    skills: ["echo"],
    identity: bobKey.identity,
    identitySigner: bobKey.signer,
  });
  let handled = false;
  bob.onTask(async (task) => {
    handled = true;
    return { taskId: task.id, status: "ok", result: "pong" };
  });

  await bob.start();

  let raw: tls.TLSSocket | null = null;
  try {
    const bobPort = bob.port;
    const clientNonce = randomNonce();

    raw = tls.connect(
      { host: "127.0.0.1", port: bobPort, rejectUnauthorized: false },
      () => {
        raw!.write(
          framePayload(
            JSON.stringify({
              protocol: "p2p-hub:network",
              version: 1,
              type: "hello",
              body: { versions: [1], capabilities: [], nonce: clientNonce },
            }),
          ),
        );
      },
    );

    const ackReceived = new Promise<void>((resolve) => {
      raw!.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        if (text.includes("hello_ack")) {
          resolve();
        }
      });
    });
    await Promise.race([
      ackReceived,
      delay(3_000).then(() => {
        throw new Error("did not receive hello_ack");
      }),
    ]);

    // A task with NO preceding auth must be refused and the connection torn
    // down — the anonymous traffic path is dead.
    raw!.write(
      framePayload(
        JSON.stringify({
          protocol: "p2p-hub:network",
          version: 1,
          type: "task",
          body: { id: "t1", skill: "echo", payload: "hi" },
        }),
      ),
    );

    const closed = new Promise<void>((resolve) => {
      raw!.once("close", () => resolve());
    });
    await Promise.race([
      closed,
      delay(3_000).then(() => {
        throw new Error("server did not close a task-without-auth connection");
      }),
    ]);
    assert.equal(handled, false, "an unauthenticated task must never be dispatched");
  } finally {
    raw?.destroy();
    await bob.stop();
  }
});

test("a sub_req without prior identity auth is denied (default-deny)", async () => {
  const bobKey = makeIdentity();
  const bob = new NetworkLightProvider({
    port: 0,
    skills: ["echo"],
    identity: bobKey.identity,
    identitySigner: bobKey.signer,
  });
  let subHandled = false;
  bob.onEventMessage(async () => {
    subHandled = true;
    return { subscriptionId: "sub-1", topic: "calendar:eventAdded", accepted: true };
  });

  await bob.start();

  let raw: tls.TLSSocket | null = null;
  try {
    const clientNonce = randomNonce();
    raw = tls.connect(
      { host: "127.0.0.1", port: bob.port, rejectUnauthorized: false },
      () => {
        raw!.write(
          framePayload(
            JSON.stringify({
              protocol: "p2p-hub:network",
              version: 1,
              type: "hello",
              body: { versions: [1], capabilities: [], nonce: clientNonce },
            }),
          ),
        );
      },
    );
    const ackReceived = new Promise<void>((resolve) => {
      raw!.on("data", (chunk) => {
        if (chunk.toString("utf8").includes("hello_ack")) resolve();
      });
    });
    await Promise.race([
      ackReceived,
      delay(3_000).then(() => {
        throw new Error("did not receive hello_ack");
      }),
    ]);

    // No auth has been sent — a subscription request is anonymous traffic and
    // must be refused with the connection torn down.
    raw!.write(
      framePayload(
        JSON.stringify({
          protocol: "p2p-hub:network",
          version: 1,
          type: "sub_req",
          body: {
            subscriptionId: "sub-1",
            topic: "calendar:eventAdded",
            action: "subscribe",
            ttlMs: 300_000,
          },
        }),
      ),
    );
    const closed = new Promise<void>((resolve) => {
      raw!.once("close", () => resolve());
    });
    await Promise.race([
      closed,
      delay(3_000).then(() => {
        throw new Error("server did not close a sub_req-without-auth connection");
      }),
    ]);
    assert.equal(subHandled, false, "an unauthenticated sub_req must never reach the handler");
  } finally {
    raw?.destroy();
    await bob.stop();
  }
});

test("an event_emit without prior identity auth is denied (default-deny)", async () => {
  const bobKey = makeIdentity();
  const bob = new NetworkLightProvider({
    port: 0,
    skills: ["echo"],
    identity: bobKey.identity,
    identitySigner: bobKey.signer,
  });
  let eventHandled = false;
  bob.onEventMessage(async () => {
    eventHandled = true;
    return { subscriptionId: "sub-1", topic: "calendar:eventAdded", accepted: true };
  });

  await bob.start();

  let raw: tls.TLSSocket | null = null;
  try {
    const clientNonce = randomNonce();
    raw = tls.connect(
      { host: "127.0.0.1", port: bob.port, rejectUnauthorized: false },
      () => {
        raw!.write(
          framePayload(
            JSON.stringify({
              protocol: "p2p-hub:network",
              version: 1,
              type: "hello",
              body: { versions: [1], capabilities: [], nonce: clientNonce },
            }),
          ),
        );
      },
    );
    const ackReceived = new Promise<void>((resolve) => {
      raw!.on("data", (chunk) => {
        if (chunk.toString("utf8").includes("hello_ack")) resolve();
      });
    });
    await Promise.race([
      ackReceived,
      delay(3_000).then(() => {
        throw new Error("did not receive hello_ack");
      }),
    ]);

    raw!.write(
      framePayload(
        JSON.stringify({
          protocol: "p2p-hub:network",
          version: 1,
          type: "event_emit",
          body: {
            subscriptionId: "sub-1",
            topic: "calendar:eventAdded",
            publisherPeerId: "b".repeat(64),
            timestamp: Date.now(),
            sequenceNumber: 1,
            payload: { x: 1 },
          },
        }),
      ),
    );
    const closed = new Promise<void>((resolve) => {
      raw!.once("close", () => resolve());
    });
    await Promise.race([
      closed,
      delay(3_000).then(() => {
        throw new Error("server did not close an event_emit-without-auth connection");
      }),
    ]);
    assert.equal(eventHandled, false, "an unauthenticated event_emit must never reach the handler");
  } finally {
    raw?.destroy();
    await bob.stop();
  }
});

test("an event_emit claiming a publisherPeerId the connection does not hold is denied", async () => {
  const bobKey = makeIdentity();
  const bob = new NetworkLightProvider({
    port: 0,
    skills: ["echo"],
    identity: bobKey.identity,
    identitySigner: bobKey.signer,
  });
  let eventHandled = false;
  bob.onEventMessage(async () => {
    eventHandled = true;
    return { subscriptionId: "sub-1", topic: "calendar:eventAdded", accepted: true };
  });

  await bob.start();

  const clientKey = makeIdentity();
  const victimPeerId = makeIdentity().identity.peerId;
  let raw: tls.TLSSocket | null = null;
  try {
    raw = await openAuthenticatedConnection(bob, clientKey);

    // The frame claims a peerId this connection does not hold — a spoof that
    // must close the connection before the handler ever runs.
    raw.write(
      framePayload(
        JSON.stringify({
          protocol: "p2p-hub:network",
          version: 1,
          type: "event_emit",
          body: {
            subscriptionId: "sub-1",
            topic: "calendar:eventAdded",
            publisherPeerId: victimPeerId,
            timestamp: Date.now(),
            sequenceNumber: 1,
            payload: { x: 1 },
          },
        }),
      ),
    );
    const closed = new Promise<void>((resolve) => {
      raw!.once("close", () => resolve());
    });
    await Promise.race([
      closed,
      delay(3_000).then(() => {
        throw new Error("server did not close a spoofed-publisher connection");
      }),
    ]);
    assert.equal(eventHandled, false, "a spoofed publisher identity must never reach the handler");
  } finally {
    raw?.destroy();
    await bob.stop();
  }
});

test("a verified peer's sub_req is answered with a sub_ack and reaches the handler with its verified identity", async () => {
  const bobKey = makeIdentity();
  const bob = new NetworkLightProvider({
    port: 0,
    skills: ["echo"],
    identity: bobKey.identity,
    identitySigner: bobKey.signer,
  });
  let inbound: { peerId?: string; type?: string; body?: unknown } | undefined;
  bob.onEventMessage(async (message) => {
    inbound = message;
    return {
      subscriptionId: (message.body as { subscriptionId: string }).subscriptionId,
      topic: (message.body as { topic: string }).topic,
      accepted: true,
      ttlMs: 60_000,
    };
  });

  await bob.start();

  const clientKey = makeIdentity();
  let raw: tls.TLSSocket | null = null;
  try {
    raw = await openAuthenticatedConnection(bob, clientKey);
    const received: Buffer[] = [];
    raw.on("data", (chunk) => received.push(chunk as Buffer));

    raw.write(
      framePayload(
        JSON.stringify({
          protocol: "p2p-hub:network",
          version: 1,
          type: "sub_req",
          body: {
            subscriptionId: "sub-1",
            topic: "calendar:eventAdded",
            action: "subscribe",
            ttlMs: 300_000,
          },
        }),
      ),
    );

    const ack = await waitFor(async () => {
      for (const envelope of readEnvelopes(received)) {
        if (envelope.type === "sub_ack") return envelope;
      }
      return null;
    });
    const ackBody = ack.body as {
      subscriptionId: string;
      topic: string;
      accepted: boolean;
      ttlMs: number;
    };
    assert.equal(ackBody.subscriptionId, "sub-1");
    assert.equal(ackBody.topic, "calendar:eventAdded");
    assert.equal(ackBody.accepted, true);
    assert.equal(ackBody.ttlMs, 60_000);
    assert.equal(inbound?.peerId, clientKey.identity.peerId, "handler sees the verified peerId");
    assert.equal(inbound?.type, "sub_req");
  } finally {
    raw?.destroy();
    await bob.stop();
  }
});

test("an event_emit from a verified peer reaches the handler with its verified identity", async () => {
  const bobKey = makeIdentity();
  const bob = new NetworkLightProvider({
    port: 0,
    skills: ["echo"],
    identity: bobKey.identity,
    identitySigner: bobKey.signer,
  });
  let inbound: { peerId?: string; type?: string; body?: unknown } | undefined;
  bob.onEventMessage(async (message) => {
    inbound = message;
    return { subscriptionId: "sub-1", topic: "calendar:eventAdded", accepted: true };
  });

  await bob.start();

  const clientKey = makeIdentity();
  let raw: tls.TLSSocket | null = null;
  try {
    raw = await openAuthenticatedConnection(bob, clientKey);

    raw.write(
      framePayload(
        JSON.stringify({
          protocol: "p2p-hub:network",
          version: 1,
          type: "event_emit",
          body: {
            subscriptionId: "sub-1",
            topic: "calendar:eventAdded",
            publisherPeerId: clientKey.identity.peerId,
            timestamp: 1_700_000_000_000,
            sequenceNumber: 7,
            payload: { hello: "world" },
          },
        }),
      ),
    );

    await waitFor(async () => (inbound ? true : null));
    assert.ok(inbound, "handler must have been invoked");
    assert.equal(inbound.peerId, clientKey.identity.peerId, "handler sees the verified publisher peerId");
    assert.equal(inbound.type, "event_emit");
    const body = inbound.body as {
      subscriptionId: string;
      topic: string;
      sequenceNumber: number;
      payload: { hello: string };
    };
    assert.equal(body.subscriptionId, "sub-1");
    assert.equal(body.topic, "calendar:eventAdded");
    assert.equal(body.sequenceNumber, 7);
    assert.deepEqual(body.payload, { hello: "world" });
  } finally {
    raw?.destroy();
    await bob.stop();
  }
});

test("a sub_req on a server with no event handler is fail-closed rejected", async () => {
  const bobKey = makeIdentity();
  const bob = new NetworkLightProvider({
    port: 0,
    skills: ["echo"],
    identity: bobKey.identity,
    identitySigner: bobKey.signer,
  });
  await bob.start();

  const clientKey = makeIdentity();
  let raw: tls.TLSSocket | null = null;
  try {
    raw = await openAuthenticatedConnection(bob, clientKey);
    const received: Buffer[] = [];
    raw.on("data", (chunk) => received.push(chunk as Buffer));

    raw.write(
      framePayload(
        JSON.stringify({
          protocol: "p2p-hub:network",
          version: 1,
          type: "sub_req",
          body: {
            subscriptionId: "sub-1",
            topic: "calendar:eventAdded",
            action: "subscribe",
            ttlMs: 300_000,
          },
        }),
      ),
    );

    const ack = await waitFor(async () => {
      for (const envelope of readEnvelopes(received)) {
        if (envelope.type === "sub_ack") return envelope;
      }
      return null;
    });
    const ackBody = ack.body as { subscriptionId: string; accepted: boolean; reason: string };
    assert.equal(ackBody.subscriptionId, "sub-1");
    assert.equal(ackBody.accepted, false);
    assert.equal(ackBody.reason, "no event handler");
  } finally {
    raw?.destroy();
    await bob.stop();
  }
});

test("abuse limits: connection flood is capped per IP", async () => {
  const bobKey = makeIdentity();
  const bob = new NetworkLightProvider({
    port: 0,
    skills: ["echo"],
    identity: bobKey.identity,
    identitySigner: bobKey.signer,
    peerLimits: { maxConnectionsPerIp: 2 },
  });
  await bob.start();

  const sockets: tls.TLSSocket[] = [];
  try {
    const open = () =>
      new Promise<tls.TLSSocket>((resolve, reject) => {
        const socket = tls.connect(
          { host: "127.0.0.1", port: bob.port, rejectUnauthorized: false },
          () => resolve(socket),
        );
        socket.once("error", reject);
      });

    const s1 = await open();
    sockets.push(s1);
    const s2 = await open();
    sockets.push(s2);

    // The third and fourth connections exceed the per-IP budget and must be
    // destroyed by the server immediately after the TLS handshake. Close
    // listeners attach synchronously so a fast destroy is never missed.
    const s3 = tls.connect({
      host: "127.0.0.1",
      port: bob.port,
      rejectUnauthorized: false,
    });
    const s3Closed = new Promise<void>((resolve) => {
      s3.once("close", () => resolve());
    });
    sockets.push(s3);

    const s4 = tls.connect({
      host: "127.0.0.1",
      port: bob.port,
      rejectUnauthorized: false,
    });
    const s4Closed = new Promise<void>((resolve) => {
      s4.once("close", () => resolve());
    });
    sockets.push(s4);

    await Promise.race([
      Promise.all([s3Closed, s4Closed]),
      delay(3_000).then(() => {
        throw new Error("overflow connections were not closed");
      }),
    ]);
    assert.equal(s1.destroyed, false, "first connection stays within budget");
    assert.equal(s2.destroyed, false, "second connection stays within budget");
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await bob.stop();
  }
});

test("abuse limits: concurrent task cap refuses the overflow task", { skip: MDNS_SKIP }, async () => {
  const alice = makeProvider({ port: 0, skills: ["echo"] });
  const bob = makeProvider({
    port: 0,
    skills: ["echo"],
    peerLimits: { maxConcurrentTasksPerIp: 1 },
  });
  let inflight = 0;
  let maxInflight = 0;
  bob.onTask(async (task) => {
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    await delay(150);
    inflight -= 1;
    return { taskId: task.id, status: "ok", result: "pong" };
  });

  await alice.start();
  await bob.start();

  try {
    const peers = await waitFor<NetworkPeer[]>(async () => {
      const found = await alice.discover("echo");
      return found.length > 0 ? found : null;
    });

    const first = alice.sendTask(peers[0], { id: "t1", skill: "echo", payload: "a" });
    await delay(100);
    const second = await alice.sendTask(peers[0], { id: "t2", skill: "echo", payload: "b" });
    const firstResult = await first;

    assert.equal(firstResult.status, "ok");
    assert.equal(second.status, "error");
    assert.match(second.error ?? "", /too many concurrent tasks/);
    assert.equal(maxInflight, 1, "handler never runs two tasks concurrently");
  } finally {
    await alice.stop();
    await bob.stop();
  }
});

/**
 * Read the next complete frame(s) from a raw TLS socket. Resolves with the
 * first frame so callers can chain reads (hello_ack then nothing further).
 */
function readNextFrame(socket: tls.TLSSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer: Buffer = Buffer.alloc(0);
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for a frame")),
      5_000,
    );
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        if (buffer.length < 4) {
          return;
        }
        const len = buffer.readUInt32BE(0);
        if (buffer.length < 4 + len) {
          return;
        }
        const raw = buffer.subarray(4, 4 + len).toString("utf8");
        clearTimeout(timer);
        socket.removeListener("data", onData);
        resolve(JSON.parse(raw));
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    };
    socket.on("data", onData);
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function helloFrame(
  nonce: string,
  hints?: { instanceId?: string; listenPort?: number },
): Buffer {
  return framePayload(
    JSON.stringify({
      protocol: "p2p-hub:network",
      version: 1,
      type: "hello",
      body: {
        versions: [1],
        capabilities: [],
        nonce,
        ...(hints?.instanceId !== undefined ? { instanceId: hints.instanceId } : {}),
        ...(hints?.listenPort !== undefined ? { listenPort: hints.listenPort } : {}),
      },
    }),
  );
}

test("a verified inbound handshake reverse-registers the client into the discovered map", async () => {
  const bobKey = makeIdentity();
  const bob = new NetworkLightProvider({
    port: 0,
    skills: ["echo"],
    identity: bobKey.identity,
    identitySigner: bobKey.signer,
  });
  await bob.start();

  const clientKey = makeIdentity();
  const { key, cert } = generateSelfSignedCert();
  const clientCertFp = normalizeFingerprint(
    new crypto.X509Certificate(cert).fingerprint256,
  );
  const clientInstanceId = "client-inst-1";
  const clientListenPort = 43210;

  let raw: tls.TLSSocket | null = null;
  try {
    const clientNonce = randomNonce();
    raw = tls.connect(
      { host: "127.0.0.1", port: bob.port, key, cert, rejectUnauthorized: false },
      () => {
        raw!.write(helloFrame(clientNonce, { instanceId: clientInstanceId, listenPort: clientListenPort }));
      },
    );

    const ack = (await readNextFrame(raw)) as { body: { nonce: string } };
    const serverNonce = ack.body.nonce;
    const signature = await clientKey.signer(
      buildIdentityBindingMessage(clientNonce, serverNonce, clientCertFp),
    );
    raw.write(
      framePayload(
        JSON.stringify({
          protocol: "p2p-hub:network",
          version: 1,
          type: "auth",
          body: {
            peerId: clientKey.identity.peerId,
            certFingerprint: clientCertFp,
            signature: signature.toString("hex"),
          },
        }),
      ),
    );

    const registered = await waitFor<DiscoveredPeer>(async () => {
      const peer = bob.listPeers().find((p) => p.id === clientInstanceId);
      return peer ?? null;
    });

    // The route points back at the client's announced listen port, keyed by
    // its mDNS instance id, with the *verified* identity and the certificate
    // fingerprint that was actually presented on the wire.
    assert.equal(registered.peerId, clientKey.identity.peerId);
    assert.equal(registered.address, `127.0.0.1:${clientListenPort}`);
    assert.equal(registered.certFingerprint, clientCertFp);
  } finally {
    raw?.destroy();
    await bob.stop();
  }
});

test("an inbound handshake without a verified auth registers nothing (default-deny)", async () => {
  const bobKey = makeIdentity();
  const bob = new NetworkLightProvider({
    port: 0,
    skills: ["echo"],
    identity: bobKey.identity,
    identitySigner: bobKey.signer,
  });
  await bob.start();

  const { key, cert } = generateSelfSignedCert();
  const clientInstanceId = "client-inst-noauth";
  const clientListenPort = 44444;

  let raw: tls.TLSSocket | null = null;
  try {
    raw = tls.connect(
      { host: "127.0.0.1", port: bob.port, key, cert, rejectUnauthorized: false },
      () => {
        raw!.write(helloFrame(randomNonce(), { instanceId: clientInstanceId, listenPort: clientListenPort }));
      },
    );
    // The server answers the handshake but the client never proves its
    // identity — no `auth`. Wait for the ack, then close.
    await readNextFrame(raw);
    raw.destroy();

    await delay(300);
    assert.equal(
      bob.listPeers().find((p) => p.id === clientInstanceId),
      undefined,
      "an unauthenticated peer must never be reverse-registered",
    );
  } finally {
    raw?.destroy();
    await bob.stop();
  }
});

test("hearing an mDNS announcement triggers a unicast hello+auth reply to the sender", async () => {
  const aliceKey = makeIdentity();
  const alice = new NetworkLightProvider({
    port: 0,
    skills: ["echo"],
    identity: aliceKey.identity,
    identitySigner: aliceKey.signer,
  });
  await alice.start();

  // Fake remote peer: a TLS server that completes the hello_ack handshake and
  // records the client's hello (with reverse-registration hints) and auth.
  const bobKey = makeIdentity();
  const { key, cert } = generateSelfSignedCert();
  const bobCertFp = normalizeFingerprint(
    new crypto.X509Certificate(cert).fingerprint256,
  );
  const received: {
    hello?: { instanceId?: string; listenPort?: number; capabilities?: string[] };
    auth?: { peerId?: string };
  } = {};
  const server = tls.createServer({ key, cert }, (socket) => {
    let buffer: Buffer = Buffer.alloc(0);
    socket.on("data", async (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        for (;;) {
          if (buffer.length < 4) {
            return;
          }
          const len = buffer.readUInt32BE(0);
          if (buffer.length < 4 + len) {
            return;
          }
          const raw = buffer.subarray(4, 4 + len).toString("utf8");
          buffer = buffer.subarray(4 + len);
          const envelope = JSON.parse(raw) as { type: string; body: Record<string, unknown> };
          if (envelope.type === "hello") {
            received.hello = envelope.body as never;
            const serverNonce = randomNonce();
            const signature = await bobKey.signer(
              buildIdentityBindingMessage(
                String(envelope.body.nonce),
                serverNonce,
                bobCertFp,
              ),
            );
            socket.write(
              framePayload(
                JSON.stringify({
                  protocol: "p2p-hub:network",
                  version: 1,
                  type: "hello_ack",
                  body: {
                    version: 1,
                    capabilities: ["echo"],
                    nonce: serverNonce,
                    identity: {
                      peerId: bobKey.identity.peerId,
                      certFingerprint: bobCertFp,
                      signature: signature.toString("hex"),
                    },
                  },
                }),
              ),
            );
          } else if (envelope.type === "auth") {
            received.auth = envelope.body as never;
            socket.end();
          }
        }
      } catch {
        socket.destroy();
      }
    });
    socket.on("error", () => socket.destroy());
  });
  const fakePort = await listen(server);

  try {
    const fakeService = {
      name: "p2p-hub-fake",
      txt: {
        id: "fake-instance",
        certFingerprint: bobCertFp,
        version: "1",
        peerId: bobKey.identity.peerId,
      },
      addresses: ["127.0.0.1"],
      port: fakePort,
      host: "fake.local",
    } as unknown as Service;

    // Simulate hearing the announcement: the handler registers the peer and
    // fires the proactive unicast reply.
    (alice as unknown as { onServiceUp(service: Service): void }).onServiceUp(fakeService);

    await waitFor(async () => (received.auth ? true : null));

    // The unicast reply carries the reverse-registration hints so the sender
    // can register us, and proves our identity so that registration is
    // accepted (default-deny on the receiving side).
    assert.equal(
      received.hello?.instanceId,
      (alice as unknown as { instanceId: string }).instanceId,
      "hello must carry our mDNS instance id",
    );
    assert.equal(
      received.hello?.listenPort,
      alice.port,
      "hello must carry our listening port",
    );
    assert.deepEqual(received.hello?.capabilities, ["echo"]);
    assert.equal(
      received.auth?.peerId,
      aliceKey.identity.peerId,
      "auth must prove our identity so the sender registers us",
    );
  } finally {
    await close(server);
    await alice.stop();
  }
});
