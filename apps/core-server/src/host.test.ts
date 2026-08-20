import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CoreServer } from "./app";
import { decideBindHost, isLoopbackHost } from "./host";

test("loopback hosts are recognised", () => {
  for (const host of ["127.0.0.1", "127.0.0.2", "localhost", "::1", " 127.0.0.1 "]) {
    assert.equal(isLoopbackHost(host), true, `expected ${host} to be loopback`);
  }
});

test("non-loopback hosts are rejected without an explicit opt-in", () => {
  for (const host of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.5"]) {
    const decision = decideBindHost(host, undefined);
    assert.ok("error" in decision, `expected ${host} to require opt-in`);
  }
});

test("non-loopback hosts are allowed only with P2P_HUB_EXPOSE=1", () => {
  assert.deepEqual(decideBindHost("0.0.0.0", "1"), { host: "0.0.0.0", exposed: true });

  const notOptedIn = decideBindHost("0.0.0.0", "true");
  assert.ok("error" in notOptedIn, "expose must be exactly \"1\"");
});

test("the default host is loopback and never needs an opt-in", () => {
  assert.deepEqual(decideBindHost(undefined, undefined), {
    host: "127.0.0.1",
    exposed: false,
  });
});

// ---------------------------------------------------------------------------
// Local-only mode (Fase 0D): `networking: false` must not touch the vault at
// all — no identity is created, so a corrupt vault cannot fail the boot.
// ---------------------------------------------------------------------------

async function bootLocalOnly(dataDir: string): Promise<{
  server: CoreServer;
  port: number;
}> {
  await fs.mkdir(path.join(dataDir, "plugins"), { recursive: true });
  const server = new CoreServer({
    pluginsDir: path.join(dataDir, "plugins"),
    dataDir,
    host: "127.0.0.1",
    port: 0,
    bootToken: "local-only-token",
    networking: false,
  });
  await server.start();
  const addr = server.address();
  assert.ok(addr, "server should report its bound address");
  return { server, port: addr.port };
}

test("local-only core-server boots and serves HTTP with a corrupt vault", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-server-localonly-"));
  await fs.writeFile(path.join(dataDir, "vault.json"), "{ not valid json !!!");

  const { server, port } = await bootLocalOnly(dataDir);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Authorization: "Bearer local-only-token" },
    });
    // Boot-token auth still guards the bridge; the point is that the server
    // *started at all* despite the corrupt vault (no identity was required).
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);
  } finally {
    await server.stop();
  }
});

test("local-only core-server never creates a peer identity (no vault write)", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-server-localonly-"));
  await bootLocalOnly(dataDir).then(({ server }) => server.stop());

  // The identity lives in the vault; with networking disabled nothing should
  // have been created or persisted at all.
  const vaultFile = path.join(dataDir, "vault.json");
  await assert.rejects(() => fs.stat(vaultFile), /ENOENT/);
});

test("networking-enabled core-server fails loudly on a corrupt vault", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-server-corruptvault-"));
  await fs.writeFile(path.join(dataDir, "vault.json"), "{ nope }");
  await fs.mkdir(path.join(dataDir, "plugins"), { recursive: true });

  const server = new CoreServer({
    pluginsDir: path.join(dataDir, "plugins"),
    dataDir,
    host: "127.0.0.1",
    port: 0,
  });
  await assert.rejects(
    () => server.start(),
    /StorageCorruptionError|cannot be parsed|corrupt/i,
  );
});
