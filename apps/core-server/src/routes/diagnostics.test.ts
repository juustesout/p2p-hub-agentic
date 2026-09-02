import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CoreServer } from "../app";
import { diagnostics } from "../diagnostics/engine";

const TOKEN = "test-token-diagnostics";

const PEER = "9f2ab1c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80";

async function startServer(): Promise<{
  server: CoreServer;
  port: number;
  dataDir: string;
}> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-server-diag-"));
  const pluginsDir = path.join(dataDir, "plugins");
  await fs.mkdir(pluginsDir, { recursive: true });
  const server = new CoreServer({
    pluginsDir,
    dataDir,
    host: "127.0.0.1",
    port: 0,
    bootToken: TOKEN,
    networking: false,
  });
  await server.start();
  const addr = server.address();
  assert.ok(addr, "server should report its bound address");
  return { server, port: addr.port, dataDir };
}

function request(
  port: number,
  pathname: string,
  init?: RequestInit & { token?: string },
): Promise<Response> {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (init?.token !== undefined) {
    headers["Authorization"] = `Bearer ${init.token}`;
  }
  return fetch(`http://127.0.0.1:${port}${pathname}`, { ...init, headers });
}

async function withServer(fn: (ctx: { port: number }) => Promise<void>): Promise<void> {
  const { server, port } = await startServer();
  try {
    await fn({ port });
  } finally {
    await server.stop();
  }
}

test("GET /api/diagnostics/logs requires the boot token", async () => {
  await withServer(async ({ port }) => {
    const res = await request(port, "/api/diagnostics/logs");
    assert.equal(res.status, 401);
  });
});

test("GET /api/diagnostics/logs returns the register without the token flag", async () => {
  await withServer(async ({ port }) => {
    const res = await request(port, "/api/diagnostics/logs", { token: TOKEN });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      sources: Array<{ id: string; secure: boolean }>;
      records: Record<string, unknown[]>;
    };
    assert.equal(body.ok, true);
    const ids = body.sources.map((s) => s.id);
    assert.ok(ids.includes("vault"));
    assert.ok(ids.includes("identity"));
    assert.ok(ids.includes("core-server-log"));
    const vault = body.sources.find((s) => s.id === "vault");
    assert.equal(vault?.secure, true);
    assert.ok(typeof body.records === "object");
  });
});

test("a webview-forwarded message is visible in shell-ipc, redacted by default", async () => {
  await withServer(async ({ port }) => {
    // Seed the webview feed with a sensitive value via the existing debug/log
    // bridge — it lands in the same logger, then in the shell-ipc ring buffer.
    const seed = await request(port, "/api/debug/log", {
      method: "POST",
      token: TOKEN,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "warn", message: `peer ${PEER} misbehaving` }),
    });
    assert.equal(seed.status, 200);

    const res = await request(port, "/api/diagnostics/logs?source=shell-ipc", {
      token: TOKEN,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      records: Record<string, Array<{ msg: string }>>;
    };
    const records = body.records["shell-ipc"] ?? [];
    assert.ok(records.length > 0, "shell-ipc should have the forwarded record");
    assert.ok(
      records.every((r) => !r.msg.includes(PEER)),
      "raw peerId must never appear in the default (redacted) view",
    );
    assert.ok(
      records.some((r) => r.msg.includes("peer_9f2a…7f80")),
      "the masked peerId form should be present",
    );
  });
});

test("GET /api/diagnostics/logs rejects an unknown source id", async () => {
  await withServer(async ({ port }) => {
    const res = await request(port, "/api/diagnostics/logs?source=not-a-source", {
      token: TOKEN,
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /unknown diagnostics source/);
  });
});

test("PATCH /api/diagnostics/level validates against the pino level set", async () => {
  await withServer(async ({ port }) => {
    const bad = await request(port, "/api/diagnostics/level", {
      method: "PATCH",
      token: TOKEN,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "loud" }),
    });
    assert.equal(bad.status, 400);
    const badBody = (await bad.json()) as { error: string };
    assert.match(badBody.error, /unknown level/);

    const ok = await request(port, "/api/diagnostics/level", {
      method: "PATCH",
      token: TOKEN,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "debug" }),
    });
    assert.equal(ok.status, 200);
    const okBody = (await ok.json()) as { ok: boolean; level: string };
    assert.equal(okBody.ok, true);
    assert.equal(okBody.level, "debug");
    assert.equal(diagnostics.currentLevel(), "debug");
  });
});

test("PATCH /api/diagnostics/source refuses to disable security-relevant sources", async () => {
  await withServer(async ({ port }) => {
    const res = await request(port, "/api/diagnostics/source", {
      method: "PATCH",
      token: TOKEN,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "vault", enabled: false }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /security-relevant/);
  });
});

test("PATCH /api/diagnostics/source rejects unknown sources and wrong shapes", async () => {
  await withServer(async ({ port }) => {
    const unknown = await request(port, "/api/diagnostics/source", {
      method: "PATCH",
      token: TOKEN,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "nope", enabled: false }),
    });
    assert.equal(unknown.status, 400);

    const shape = await request(port, "/api/diagnostics/source", {
      method: "PATCH",
      token: TOKEN,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "chat" }),
    });
    assert.equal(shape.status, 400);
  });
});

test("diagnostics routes require the token gate (no bypass via level/source)", async () => {
  await withServer(async ({ port }) => {
    const level = await request(port, "/api/diagnostics/level", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "debug" }),
    });
    assert.equal(level.status, 401);
    const source = await request(port, "/api/diagnostics/source", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "chat", enabled: false }),
    });
    assert.equal(source.status, 401);
  });
});

test("GET /api/diagnostics/snapshot returns the fixed snapshot shape (token-gated)", async () => {
  await withServer(async ({ port }) => {
    const unauthorized = await request(port, "/api/diagnostics/snapshot");
    assert.equal(unauthorized.status, 401);

    const res = await request(port, "/api/diagnostics/snapshot", { token: TOKEN });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      summary: string;
      snapshot: {
        system: { platform: string };
        runtime: { nodeVersion: string };
        hardware: { gpu: unknown };
        network: { transportMode: string };
        vault: { locked: boolean };
        boot: { bootState: string };
        plugins: unknown[];
      };
    };
    assert.equal(body.ok, true);
    assert.ok(typeof body.summary === "string");
    const snap = body.snapshot;
    assert.equal(snap.system.platform, process.platform);
    assert.equal(snap.runtime.nodeVersion, process.version);
    assert.equal(snap.network.transportMode, "none"); // networking: false in tests
    assert.equal(typeof snap.vault.locked, "boolean");
    assert.ok(Array.isArray(snap.plugins));
    // lspci may or may not exist in CI; either is valid, never a crash.
    if (snap.hardware.gpu !== null) {
      assert.equal((snap.hardware.gpu as { source: string }).source, "lspci");
    }
  });
});

test("GET /api/diagnostics/snapshot never leaks a 64-hex (peerId/boot-token shape)", async () => {
  await withServer(async ({ port }) => {
    const res = await request(port, "/api/diagnostics/snapshot", { token: TOKEN });
    const body = (await res.json()) as { snapshot: unknown };
    const json = JSON.stringify(body.snapshot);
    assert.ok(!/\b[0-9a-f]{64}\b/.test(json), "snapshot must not contain a 64-hex value");
  });
});

test("POST /api/diagnostics/bundle returns one redacted bundle + clipboard text", async () => {
  await withServer(async ({ port }) => {
    // Seed a sensitive log record through the shell-ipc webview feed.
    const seed = await request(port, "/api/debug/log", {
      method: "POST",
      token: TOKEN,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "warn", message: `peer ${PEER} failed a handshake` }),
    });
    assert.equal(seed.status, 200);

    const res = await request(port, "/api/diagnostics/bundle", {
      method: "POST",
      token: TOKEN,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sections: ["system", "runtime", "network", "vault"],
        sources: ["shell-ipc"],
        userNote: "black screen on second display",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      bundle: {
        redacted: boolean;
        preview: { sections: string[]; logSources: Array<{ sourceId: string; recordCount: number }>; hasNote: boolean };
        logs: Array<{ records: Array<{ msg: string }> }>;
      };
      clipboardText: string;
    };
    assert.equal(body.ok, true);
    assert.equal(body.bundle.redacted, true);
    assert.deepEqual(body.bundle.preview.sections, ["system", "runtime", "network", "vault"]);
    assert.equal(body.bundle.preview.hasNote, true);
    const shellIpc = body.bundle.preview.logSources.find((s) => s.sourceId === "shell-ipc");
    assert.ok(shellIpc && shellIpc.recordCount > 0);

    const bundleJson = JSON.stringify(body.bundle);
    assert.ok(!bundleJson.includes(PEER), "bundle must be redacted end-to-end");
    assert.ok(
      body.bundle.logs.some((l) => l.records.some((r) => r.msg.includes("peer_9f2a…7f80"))),
      "the masked peerId form should be present in the bundle",
    );
    assert.match(body.clipboardText, /p2p-hub diagnostische bundel/);
    assert.ok(!body.clipboardText.includes(PEER), "clipboard text must be redacted");
  });
});

test("POST /api/diagnostics/bundle is token-gated and rejects bad shapes", async () => {
  await withServer(async ({ port }) => {
    const unauthorized = await request(port, "/api/diagnostics/bundle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sources: [] }),
    });
    assert.equal(unauthorized.status, 401);

    const badSections = await request(port, "/api/diagnostics/bundle", {
      method: "POST",
      token: TOKEN,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sections: ["secrets"] }),
    });
    assert.equal(badSections.status, 400);
    const badSectionsBody = (await badSections.json()) as { error: string };
    assert.match(badSectionsBody.error, /sections may only contain/);

    const badSources = await request(port, "/api/diagnostics/bundle", {
      method: "POST",
      token: TOKEN,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sources: [42] }),
    });
    assert.equal(badSources.status, 400);

    const badNote = await request(port, "/api/diagnostics/bundle", {
      method: "POST",
      token: TOKEN,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userNote: 123 }),
    });
    assert.equal(badNote.status, 400);
  });
});
