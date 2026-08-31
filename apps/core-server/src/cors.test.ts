import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CoreServer } from "./app";
import { corsAllowOrigin } from "./cors";

// ---------------------------------------------------------------------------
// Unit: the origin allowlist. Deny-by-default at the browser boundary.
// ---------------------------------------------------------------------------

test("loopback and Tauri shell origins are allowed", () => {
  for (const origin of [
    "http://tauri.localhost",
    "http://tauri.localhost:44619",
    "https://tauri.localhost",
    "tauri://localhost",
    "http://localhost",
    "http://localhost:5173",
    "http://127.0.0.1",
    "http://127.0.0.1:44619",
    "http://[::1]:8080",
  ]) {
    assert.equal(corsAllowOrigin(origin), origin, `expected ${origin} to be allowed`);
  }
});

test("arbitrary and spoofed origins are denied", () => {
  for (const origin of [
    undefined,
    "",
    "null",
    "https://evil.example",
    "http://evil.example",
    "file:///tmp/x",
    "http://tauri.localhost.evil.example",
    "https://tauri.localhost@evil.example",
    "http://127.0.0.1.evil.example",
    "tauri://not-localhost",
  ]) {
    assert.equal(corsAllowOrigin(origin), null, `expected ${String(origin)} to be denied`);
  }
});

// ---------------------------------------------------------------------------
// Integration: the loopback bridge answers the shell's cross-origin /api calls.
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
    bootToken: "cors-test-token",
    networking: false,
  });
  await server.start();
  const addr = server.address();
  assert.ok(addr, "server should report its bound address");
  return { server, port: addr.port };
}

test("OPTIONS preflight on /api/* is answered before the token gate (204, no token)", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-server-cors-"));
  const { server, port } = await bootLocalOnly(dataDir);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      method: "OPTIONS",
      headers: { Origin: "http://tauri.localhost" },
    });
    assert.equal(res.status, 204);
    assert.equal(
      res.headers.get("access-control-allow-origin"),
      "http://tauri.localhost",
    );
    assert.equal(res.headers.get("access-control-allow-methods"), "GET, POST, DELETE, OPTIONS");
    assert.equal(res.headers.get("access-control-allow-headers"), "Authorization, Content-Type");
  } finally {
    await server.stop();
  }
});

test("an actual /api request from a shell origin gets the CORS header", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-server-cors-"));
  const { server, port } = await bootLocalOnly(dataDir);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: {
        Origin: "http://tauri.localhost",
        Authorization: "Bearer cors-test-token",
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "http://tauri.localhost");
    assert.equal(res.headers.get("vary"), "Origin");
  } finally {
    await server.stop();
  }
});

test("a disallowed origin gets no CORS headers (preflight and request)", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-server-cors-"));
  const { server, port } = await bootLocalOnly(dataDir);
  try {
    // Preflight: bare 204, no CORS headers -> browser blocks the real request.
    const preflight = await fetch(`http://127.0.0.1:${port}/api/health`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), null);

    // Actual request: token still passes, but no CORS header -> browser cannot
    // read the response. The token gate remains the binding control.
    const request = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: {
        Origin: "https://evil.example",
        Authorization: "Bearer cors-test-token",
      },
    });
    assert.equal(request.status, 200);
    assert.equal(request.headers.get("access-control-allow-origin"), null);
  } finally {
    await server.stop();
  }
});

test("CORS headers are never attached outside /api/*", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-server-cors-"));
  const { server, port } = await bootLocalOnly(dataDir);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/definitely-not-a-route`, {
      headers: { Origin: "http://tauri.localhost" },
    });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  } finally {
    await server.stop();
  }
});
