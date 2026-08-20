import { test } from "node:test";
import assert from "node:assert/strict";
import * as tls from "node:tls";
import * as net from "node:net";
import * as forge from "node-forge";
import { NetworkLightProvider } from "./network-light-provider";
import type { DiscoveredPeer } from "./network-light-provider";
import type { NetworkPeer, PeerIdentity } from "@p2p-hub/sdk";

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
    assert.equal(peers[0].skills.includes("echo"), true);

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
