import { test } from "node:test";
import assert from "node:assert/strict";
import * as tls from "node:tls";
import * as net from "node:net";
import * as forge from "node-forge";
import { NetworkLightProvider } from "./network-light-provider";
import type { NetworkPeer } from "@p2p-hub/sdk";

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
  const keys = forge.pki.rsa.generateKeyPair(1024);
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
