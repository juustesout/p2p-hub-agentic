import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { VaultManager } from "@p2p-hub/core";
import { CoreServer } from "./app";

const TOKEN = "vault-gate-test-token";
const MASTER_KEY = "correct horse battery staple";

/**
 * Boot a CoreServer on a fresh temp data dir with networking enabled (the
 * default) and an empty plugins dir. The lock gate only engages when a vault
 * exists AND networking is on — the desktop-shell configuration.
 */
async function bootServer(
  dataDir: string,
): Promise<{ server: CoreServer; port: number }> {
  const pluginsDir = path.join(dataDir, "plugins");
  await fs.mkdir(pluginsDir, { recursive: true });
  const server = new CoreServer({
    pluginsDir,
    dataDir,
    host: "127.0.0.1",
    port: 0,
    bootToken: TOKEN,
  });
  await server.start();
  const addr = server.address();
  assert.ok(addr, "server should report its bound address");
  return { server, port: addr.port };
}

function authed(port: number, pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
      ...((init?.headers as Record<string, string> | undefined) ?? {}),
    },
  });
}

async function getJson<T>(port: number, pathname: string): Promise<T> {
  const res = await authed(port, pathname);
  assert.equal(res.status, 200);
  return (await res.json()) as T;
}

/** Create a vault encrypted under a known key, as a previous run would have. */
async function seedVault(dataDir: string): Promise<void> {
  const vault = new VaultManager({ dataDir, masterKey: MASTER_KEY });
  await vault.setSecret("identity.privateKey", "seed-material");
  await vault.setSecret("ai.apiKey", "seed-ai-key");
}

test("first run (no vault) boots straight to ready", async () => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "vault-gate-fresh-"),
  );
  const { server, port } = await bootServer(dataDir);
  try {
    assert.equal(server.bootState(), "ready");
    const body = await getJson<{ locked: boolean; vaultExists: boolean }>(
      port,
      "/api/health",
    );
    assert.equal(body.locked, false);
    assert.equal(body.vaultExists, false);
  } finally {
    await server.stop();
  }
});

test("existing vault starts LOCKED: transports deferred, vault surface refused", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-gate-locked-"));
  await seedVault(dataDir);

  const { server, port } = await bootServer(dataDir);
  try {
    assert.equal(server.bootState(), "locked");

    // Health reports the lock without requiring the key.
    const health = await getJson<{ locked: boolean; vaultExists: boolean }>(
      port,
      "/api/health",
    );
    assert.equal(health.locked, true);
    assert.equal(health.vaultExists, true);

    // Plugin-storage (the vault HTTP surface) is refused while locked.
    assert.equal((await authed(port, "/api/vault/keys")).status, 403);
    assert.equal((await authed(port, "/api/vault/model")).status, 403);
    assert.equal(
      (
        await authed(port, "/api/vault/set", {
          method: "POST",
          body: JSON.stringify({ key: "a.b", value: "x" }),
        })
      ).status,
      403,
    );

    // A wrong key is a bare 401, never a hint at why (CLAUDE.md principle #7).
    const wrong = await authed(port, "/api/vault/unlock", {
      method: "POST",
      body: JSON.stringify({ masterKey: "not-the-key" }),
    });
    assert.equal(wrong.status, 401);
    const wrongBody = (await wrong.json()) as { ok?: boolean; error?: string };
    assert.equal(wrongBody.error, "invalid master key");
    assert.equal(server.bootState(), "locked");
  } finally {
    await server.stop();
  }
});

test("unlock with the correct key completes the boot and stores identity under the real key", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-gate-unlock-"));
  await seedVault(dataDir);

  const { server, port } = await bootServer(dataDir);
  try {
    assert.equal(server.bootState(), "locked");

    const ok = await authed(port, "/api/vault/unlock", {
      method: "POST",
      body: JSON.stringify({ masterKey: MASTER_KEY }),
    });
    assert.equal(ok.status, 200);

    assert.equal(server.bootState(), "ready");
    const health = await getJson<{ locked: boolean }>(port, "/api/health");
    assert.equal(health.locked, false);

    // The vault surface is live again.
    assert.equal((await authed(port, "/api/vault/keys")).status, 200);

    // The decisive property: `finishBoot` created the peer identity AFTER the
    // real key was installed, so it must decrypt under MASTER_KEY — not under
    // the boot-time placeholder key.
    const check = new VaultManager({ dataDir, masterKey: MASTER_KEY });
    const identity = await check.getSecret("identity.privateKey");
    assert.ok(identity, "identity must exist after unlock");
    assert.notEqual(identity, "seed-material");
  } finally {
    await server.stop();
  }
});

test("lock stops transports and re-gates the vault; unlock re-arms it", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-gate-relock-"));
  await seedVault(dataDir);

  const { server, port } = await bootServer(dataDir);
  try {
    await authed(port, "/api/vault/unlock", {
      method: "POST",
      body: JSON.stringify({ masterKey: MASTER_KEY }),
    });
    assert.equal(server.bootState(), "ready");

    const lock = await authed(port, "/api/vault/lock", { method: "POST" });
    assert.equal(lock.status, 200);
    assert.equal(server.bootState(), "locked");

    const health = await getJson<{ locked: boolean }>(port, "/api/health");
    assert.equal(health.locked, true);

    // Re-unlock (already-verified key) re-arms the full boot.
    const again = await authed(port, "/api/vault/unlock", {
      method: "POST",
      body: JSON.stringify({ masterKey: MASTER_KEY }),
    });
    assert.equal(again.status, 200);
    assert.equal(server.bootState(), "ready");
  } finally {
    await server.stop();
  }
});

test("network pause/resume toggles transports; pause while locked is refused", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-gate-pause-"));
  await seedVault(dataDir);

  const { server, port } = await bootServer(dataDir);
  try {
    // Locked: pausing is refused (nothing to pause, transports not up).
    assert.equal(
      (await authed(port, "/api/network/pause", { method: "POST" })).status,
      403,
    );

    await authed(port, "/api/vault/unlock", {
      method: "POST",
      body: JSON.stringify({ masterKey: MASTER_KEY }),
    });

    const pause = await authed(port, "/api/network/pause", { method: "POST" });
    assert.equal(pause.status, 200);
    const paused = await getJson<{ networkPaused: boolean; locked: boolean }>(
      port,
      "/api/health",
    );
    assert.equal(paused.networkPaused, true);
    assert.equal(paused.locked, false, "pausing must not lock the vault");

    const resume = await authed(port, "/api/network/resume", { method: "POST" });
    assert.equal(resume.status, 200);
    const resumed = await getJson<{ networkPaused: boolean }>(
      port,
      "/api/health",
    );
    assert.equal(resumed.networkPaused, false);
  } finally {
    await server.stop();
  }
});
