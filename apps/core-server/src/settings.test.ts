import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CoreServer } from "./app";
import type { TrustConfirmation } from "@p2p-hub/core";

const TOKEN = "settings-test-token";

const CRITICAL = {
  p2pHubExposed: true,
  chatAutoNotify: true,
  unrestrictedRemoteSkills: true,
  allowExternalApiExecution: true,
  localVaultStorage: true,
  peersiteEnabled: false,
  peersiteLanExposed: false,
};

const SAFE = {
  p2pHubExposed: false,
  chatAutoNotify: false,
  unrestrictedRemoteSkills: false,
  allowExternalApiExecution: false,
  localVaultStorage: false,
  peersiteEnabled: false,
  peersiteLanExposed: false,
};

async function startServer(
  trustConfirmation?: TrustConfirmation,
): Promise<{ server: CoreServer; port: number; dataDir: string }> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-server-settings-"));
  const pluginsDir = path.join(dataDir, "plugins");
  await fs.mkdir(pluginsDir, { recursive: true });
  const server = new CoreServer({
    pluginsDir,
    dataDir,
    host: "127.0.0.1",
    port: 0,
    bootToken: TOKEN,
    trustConfirmation,
  });
  await server.start();
  const addr = server.address();
  assert.ok(addr, "server should report its bound address");
  return { server, port: addr.port, dataDir };
}

function headers(): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };
}

function apply(port: number, settings: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/settings/apply`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(settings),
  });
}

function getSettings(port: number): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/settings`, {
    headers: headers(),
  });
}

test("GET /api/settings returns safe defaults with no risk before first apply", async () => {
  const { server, port } = await startServer();
  try {
    const res = await getSettings(port);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      settings: Record<string, boolean>;
      risk: { aggregate: string };
    };
    assert.deepEqual(body.settings, SAFE);
    assert.equal(body.risk.aggregate, "none");
  } finally {
    await server.stop();
  }
});

test("apply safe settings is allowed and persisted", async () => {
  const { server, port } = await startServer();
  try {
    const res = await apply(port, { p2pHubExposed: true });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; risk: { aggregate: string } };
    assert.equal(body.ok, true);
    // p2pHubExposed alone (localVaultStorage false) triggers no rule.
    assert.equal(body.risk.aggregate, "none");

    const read = await getSettings(port);
    const stored = (await read.json()) as { settings: Record<string, boolean> };
    assert.equal(stored.settings.p2pHubExposed, true);
    assert.equal(stored.settings.localVaultStorage, false);
  } finally {
    await server.stop();
  }
});

test("critical settings are denied by default (no native confirmer)", async () => {
  const { server, port, dataDir } = await startServer();
  try {
    const res = await apply(port, CRITICAL);
    assert.equal(res.status, 403);
    const body = (await res.json()) as { ok: boolean; requiredTier: number };
    assert.equal(body.ok, false);
    assert.equal(body.requiredTier, 2);
    // Fail-closed: nothing persisted.
    const file = path.join(dataDir, "settings.json");
    await assert.rejects(fs.stat(file));
  } finally {
    await server.stop();
  }
});

test("critical settings are applied when the native confirmer approves", async () => {
  let summary = "";
  const confirmer: TrustConfirmation = {
    confirmTier2: async (s) => {
      summary = s;
      return true;
    },
  };
  const { server, port } = await startServer(confirmer);
  try {
    const res = await apply(port, CRITICAL);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; risk: { aggregate: string } };
    assert.equal(body.ok, true);
    assert.equal(body.risk.aggregate, "critical");
    assert.match(summary, /critical/);
    assert.match(summary, /ERR_EXPOSED_UNRESTRICTED_SKILL/);

    const read = await getSettings(port);
    const stored = (await read.json()) as { settings: Record<string, boolean> };
    assert.deepEqual(stored.settings, CRITICAL);
  } finally {
    await server.stop();
  }
});

test("critical settings are denied when the native confirmer declines", async () => {
  const confirmer: TrustConfirmation = { confirmTier2: async () => false };
  const { server, port } = await startServer(confirmer);
  try {
    const res = await apply(port, CRITICAL);
    assert.equal(res.status, 403);
  } finally {
    await server.stop();
  }
});

test("high-severity settings are allowed for an authenticated session without a native confirmer", async () => {
  const { server, port } = await startServer();
  try {
    const res = await apply(port, {
      allowExternalApiExecution: true,
      unrestrictedRemoteSkills: true,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; risk: { aggregate: string } };
    assert.equal(body.ok, true);
    assert.equal(body.risk.aggregate, "high");
  } finally {
    await server.stop();
  }
});

test("apply rejects non-object bodies", async () => {
  const { server, port } = await startServer();
  try {
    const res = await apply(port, ["not", "an", "object"]);
    assert.equal(res.status, 400);
  } finally {
    await server.stop();
  }
});
