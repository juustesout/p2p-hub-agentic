import { test } from "node:test";
import assert from "node:assert/strict";
import * as tls from "node:tls";
import * as net from "node:net";
import * as crypto from "node:crypto";
import * as forge from "node-forge";
import { NetworkLightProvider } from "./network-light-provider";
import type { DiscoveredPeer } from "./network-light-provider";
import type { NetworkPeer, PeerIdentity } from "@p2p-hub/sdk";
import {
  buildIdentityBindingMessage,
  normalizeFingerprint,
  randomNonce,
} from "./wire-contract";

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

// A stable identity: peerId = 64 hex chars (32-byte Ed25519 public key).
const STABLE_IDENTITY: PeerIdentity = {
  peerId: "a".repeat(64),
  publicKeyHex: "a".repeat(64),
};

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

test("two local instances discover each other and exchange a task", async () => {
  const alice = new NetworkLightProvider({ port: 0, skills: ["echo"] });
  const bob = new NetworkLightProvider({ port: 0, skills: ["echo"] });

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

test("a peer with an identity advertises both certFingerprint and peerId", async () => {
  const alice = new NetworkLightProvider({ port: 0, skills: ["echo"] });
  const bob = new NetworkLightProvider({
    port: 0,
    skills: ["echo"],
    identity: STABLE_IDENTITY,
  });

  await alice.start();
  await bob.start();

  try {
    const bobPeer = await waitForPeerWithId(alice, STABLE_IDENTITY.peerId);

    assert.equal(bobPeer.peerId, STABLE_IDENTITY.peerId);
    // The per-boot certificate fingerprint is still announced alongside the
    // persistent identity — neither replaces the other.
    assert.ok(bobPeer.certFingerprint);
  } finally {
    await alice.stop();
    await bob.stop();
  }
});

test("peerId is stable across restarts while certFingerprint changes", async () => {
  const alice = new NetworkLightProvider({ port: 0, skills: ["echo"] });
  const bob1 = new NetworkLightProvider({
    port: 0,
    skills: ["echo"],
    identity: STABLE_IDENTITY,
  });

  await alice.start();
  await bob1.start();

  try {
    const bob1Peer = await waitForPeerWithId(alice, STABLE_IDENTITY.peerId);
    assert.ok(bob1Peer.certFingerprint);

    // Stop the first instance and bring up a second one with the *same*
    // identity. The peerId must remain identical; the certificate is a new
    // per-boot self-signed cert and therefore must differ.
    await bob1.stop();

    const bob2 = new NetworkLightProvider({
      port: 0,
      skills: ["echo"],
      identity: STABLE_IDENTITY,
    });
    await bob2.start();
    try {
      // Exclude bob1's instance id so we wait specifically for the new
      // instance (bob1's "down" event may not have been processed yet).
      const bob2Peer = await waitForPeerWithId(
        alice,
        STABLE_IDENTITY.peerId,
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

test("task to a peer with a mismatched certificate fingerprint is rejected", async () => {
  const alice = new NetworkLightProvider({ port: 0, skills: ["echo"] });
  const bob = new NetworkLightProvider({ port: 0, skills: ["echo"] });
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

test("discover filters by handshake-negotiated capabilities", async () => {
  const alice = new NetworkLightProvider({ port: 0, skills: ["echo", "ping"] });
  const bob = new NetworkLightProvider({ port: 0, skills: ["echo"] });
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

test("a peer's advertised maxPayloadBytes limit is honored before sending", async () => {
  const alice = new NetworkLightProvider({ port: 0, skills: ["echo"] });
  const bob = new NetworkLightProvider({
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

test("a server denies an unsupported protocol version and closes the connection", async () => {
  const alice = new NetworkLightProvider({ port: 0, skills: ["echo"] });
  const bob = new NetworkLightProvider({
    port: 0,
    skills: ["echo"],
    identity: STABLE_IDENTITY,
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
    const bobPeer = await waitForPeerWithId(alice, STABLE_IDENTITY.peerId);
    const bobPort = Number(bobPeer.address.split(":").pop());

    raw = tls.connect(
      { host: "127.0.0.1", port: bobPort, rejectUnauthorized: false },
      () => {
        // Version 2 is not supported by this server — default-deny.
        raw!.write(
          framePayload(
            JSON.stringify({
              protocol: "p2p-hub:network",
              version: 2,
              type: "hello",
              body: { versions: [2], capabilities: [] },
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

test("a server closes the connection when a task arrives before the handshake", async () => {
  const alice = new NetworkLightProvider({ port: 0, skills: ["echo"] });
  const bob = new NetworkLightProvider({
    port: 0,
    skills: ["echo"],
    identity: STABLE_IDENTITY,
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
    const bobPeer = await waitForPeerWithId(alice, STABLE_IDENTITY.peerId);
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

test("a server closes the connection on a malformed frame", async () => {
  const alice = new NetworkLightProvider({ port: 0, skills: ["echo"] });
  const bob = new NetworkLightProvider({
    port: 0,
    skills: ["echo"],
    identity: STABLE_IDENTITY,
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
    const bobPeer = await waitForPeerWithId(alice, STABLE_IDENTITY.peerId);
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

test("identity binding: peers verify each other's claimed peerId", async () => {
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

test("identity binding: auth after a task is denied (default-deny)", async () => {
  const bob = new NetworkLightProvider({
    port: 0,
    skills: ["echo"],
  });
  let handled = false;
  bob.onTask(async (task) => {
    handled = true;
    return { taskId: task.id, status: "ok", result: "pong" };
  });

  await bob.start();

  const clientKey = makeIdentity();
  const { key, cert } = generateSelfSignedCert();
  const clientCertFp = normalizeFingerprint(
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

    // Send a task first (anonymous is legal).
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

    // Now try to authenticate — too late, the connection already saw a task.
    const signature = await clientKey.signer(
      buildIdentityBindingMessage(clientNonce, serverNonce, clientCertFp),
    );
    raw!.write(
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

    const closed = new Promise<void>((resolve) => {
      raw!.once("close", () => resolve());
    });
    await Promise.race([
      closed,
      delay(3_000).then(() => {
        throw new Error("server did not close the connection on auth-after-task");
      }),
    ]);
    assert.equal(handled, true, "the anonymous task itself is legal");
  } finally {
    raw?.destroy();
    await bob.stop();
  }
});

test("abuse limits: connection flood is capped per IP", async () => {
  const bob = new NetworkLightProvider({
    port: 0,
    skills: ["echo"],
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

test("abuse limits: concurrent task cap refuses the overflow task", async () => {
  const alice = new NetworkLightProvider({ port: 0, skills: ["echo"] });
  const bob = new NetworkLightProvider({
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
