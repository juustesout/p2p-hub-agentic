import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { CoreServer } from "./app";
import {
  bootTokenFile,
  generateBootToken,
  safeTokenEqual,
  tokenFromAuthorization,
  tokenFromQuery,
  writeBootToken,
} from "./auth";

const TOKEN = "test-token-123";

/**
 * NTFS has no POSIX mode bits: chmod only toggles the read-only flag, so the
 * strongest observable guarantee on Windows is that the 0600 write left the
 * file owner-writeable. On POSIX the exact 0600 mode is asserted.
 */
function assertOwnerOnlyMode(stat: { mode: number }, file: string): void {
  if (process.platform === "win32") {
    assert.ok(
      (stat.mode & 0o200) !== 0,
      `${file} must be owner-writeable on Windows`,
    );
  } else {
    assert.equal(stat.mode & 0o777, 0o600, `${file} must be owner-only 0600`);
  }
}

async function startServer(
  token = TOKEN,
): Promise<{ server: CoreServer; port: number; dataDir: string }> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-server-token-"));
  const pluginsDir = path.join(dataDir, "plugins");
  await fs.mkdir(pluginsDir, { recursive: true });
  const server = new CoreServer({
    pluginsDir,
    dataDir,
    host: "127.0.0.1",
    port: 0,
    bootToken: token,
  });
  await server.start();
  const addr = server.address();
  assert.ok(addr, "server should report its bound address");
  return { server, port: addr.port, dataDir };
}

function request(
  port: number,
  pathname: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${pathname}`, init);
}

function authorizedHeaders(token = TOKEN): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

test("auth helpers parse bearer and query tokens and compare constant-time", () => {
  assert.equal(tokenFromAuthorization("Bearer abc"), "abc");
  assert.equal(tokenFromAuthorization("bearer abc"), null);
  assert.equal(tokenFromAuthorization(undefined), null);
  assert.equal(tokenFromAuthorization("Basic abc"), null);

  const req = { url: "/ws?token=abc" } as { url: string };
  assert.equal(tokenFromQuery(req), "abc");
  assert.equal(tokenFromQuery({ url: "/ws" } as { url: string }), null);

  assert.equal(safeTokenEqual("abc", "abc"), true);
  assert.equal(safeTokenEqual("abc", "abd"), false);
  assert.equal(safeTokenEqual(null, "abc"), false);
  assert.equal(safeTokenEqual("", "abc"), false);
  assert.ok(generateBootToken().length >= 64);
});

test("the boot token is persisted to a 0600 file in the data directory", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-server-file-"));
  const file = bootTokenFile(dataDir);
  const token = generateBootToken();
  const written = writeBootToken(dataDir, token);
  assert.equal(written, file);

  const stat = await fs.stat(file);
  assertOwnerOnlyMode(stat, file);
  assert.equal((await fs.readFile(file, "utf8")).trim(), token);

  // A file carried over from a prior boot with looser perms is normalised to
  // 0600 before the new token is written, so no secret ever sits world-readable.
  await fs.writeFile(file, "stale-token", { mode: 0o644 });
  const token2 = generateBootToken();
  writeBootToken(dataDir, token2);
  assertOwnerOnlyMode(await fs.stat(file), file);
  assert.equal((await fs.readFile(file, "utf8")).trim(), token2);
});

test("HTTP /api routes reject requests without a valid token", async () => {
  const { server, port } = await startServer();
  try {
    const noAuth = await request(port, "/api/health");
    assert.equal(noAuth.status, 401);

    const badAuth = await request(port, "/api/health", {
      headers: authorizedHeaders("wrong"),
    });
    assert.equal(badAuth.status, 401);

    const goodAuth = await request(port, "/api/health", {
      headers: authorizedHeaders(),
    });
    assert.equal(goodAuth.status, 200);
    const body = (await goodAuth.json()) as { ok: boolean };
    assert.equal(body.ok, true);
  } finally {
    await server.stop();
  }
});

test("HTTP /api/execute requires the token before reaching the broker", async () => {
  const { server, port } = await startServer();
  try {
    const noAuth = await request(port, "/api/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serviceId: "core", method: "echo", arguments: "hi" }),
    });
    assert.equal(noAuth.status, 401);

    const withAuth = await request(port, "/api/execute", {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ serviceId: "core", method: "echo", arguments: "hi" }),
    });
    assert.equal(withAuth.status, 200);
    const result = (await withAuth.json()) as { status: string; result: unknown };
    assert.equal(result.status, "ok");
    assert.equal(result.result, "hi");
  } finally {
    await server.stop();
  }
});

test("HTTP /api/vault/set refuses reserved namespaces over the bridge", async () => {
  const { server, port } = await startServer();
  try {
    for (const key of ["ai.apiKey", "identity.privateKey", "identity.publicKey"]) {
      const res = await request(port, "/api/vault/set", {
        method: "POST",
        headers: authorizedHeaders(),
        body: JSON.stringify({ key, value: "secret" }),
      });
      assert.equal(res.status, 403, `expected 403 for reserved key ${key}`);
      const body = (await res.json()) as { ok: boolean; error: string };
      assert.equal(body.ok, false);
      assert.match(body.error, /reserved namespace/);
    }
  } finally {
    await server.stop();
  }
});

test("HTTP /api/execute rejects unsafe serviceId/method/peerId identifiers", async () => {
  const { server, port } = await startServer();
  try {
    for (const body of [
      { serviceId: "core", method: "echo../etc/passwd", arguments: "x" },
      { serviceId: "core; rm -rf", method: "echo", arguments: "x" },
      { serviceId: "core", method: "echo", peerId: "peer<bad>", arguments: "x" },
    ]) {
      const res = await request(port, "/api/execute", {
        method: "POST",
        headers: authorizedHeaders(),
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 200);
      const result = (await res.json()) as { status: string; error: string };
      assert.equal(result.status, "error");
      assert.match(result.error, /safe identifier/);
    }
  } finally {
    await server.stop();
  }
});

test("HTTP /api/execute returns 400 for a deeply-nested JSON body, not 500", async () => {
  const { server, port } = await startServer();
  try {
    // ~200KB of nested arrays — within MAX_PAYLOAD_BYTES but deep enough to
    // overflow JSON.parse's call stack if it were parsed un-guarded.
    const deep = "[".repeat(100_000) + "1" + "]".repeat(100_000);
    const res = await request(port, "/api/execute", {
      method: "POST",
      headers: authorizedHeaders(),
      body: `{"serviceId":"core","method":"echo","arguments":${deep}}`,
    });
    assert.equal(res.status, 400, "deep JSON must be rejected cleanly, not crash");
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid request body");
  } finally {
    await server.stop();
  }
});

function wsConnect(port: number, token?: string): Promise<"accepted" | "rejected"> {
  return new Promise((resolve, reject) => {
    const url = token
      ? `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`
      : `ws://127.0.0.1:${port}/ws`;
    const ws = new WebSocket(url);
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.terminate();
        reject(new Error("ws connect timed out"));
      }
    }, 5000);

    ws.once("open", () => {
      // The server closes unauthorized sockets immediately after the upgrade;
      // wait briefly to distinguish rejection from a healthy connection.
      setTimeout(() => {
        if (!settled && ws.readyState === WebSocket.OPEN) {
          settled = true;
          clearTimeout(timeout);
          ws.close();
          resolve("accepted");
        }
      }, 200);
    });

    ws.once("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve("rejected");
      }
    });

    ws.once("error", () => {
      // `close` fires afterwards; ignore here.
    });
  });
}

test("WebSocket /ws rejects connections without the token and accepts with it", async () => {
  const { server, port } = await startServer();
  try {
    const rejected = await wsConnect(port);
    assert.equal(rejected, "rejected");

    const accepted = await wsConnect(port, TOKEN);
    assert.equal(accepted, "accepted");
  } finally {
    await server.stop();
  }
});

/**
 * The WS token travels in the query string (the browser WS API cannot set
 * headers); this is an accepted risk, mitigated operationally (loopback,
 * short-lived token, no `?token=` logging). A future access-log or full-URL
 * request logger would silently undo that mitigation, so this test captures
 * all console output while exercising the token-bearing paths and asserts the
 * token never appears in it.
 */
test("boot tokens never leak into server console output on any token-bearing path", async () => {
  const secret = `log-hygiene-secret-${Math.random().toString(36).slice(2)}`;
  const captured: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((m) => console[m]);
  for (const m of methods) {
    console[m] = (...args: unknown[]) => {
      captured.push(args.map((a) => String(a)).join(" "));
    };
  }

  const { server, port } = await startServer(secret);
  try {
    // The query-string token is accepted ONLY on /ws (browser WebSocket API
    // cannot set headers). On /api/* it must be rejected outright — a query
    // string would otherwise put the token in access logs / browser history.
    const tokenInUrl = await request(port, `/api/health?token=${secret}`);
    assert.equal(tokenInUrl.status, 401, "query-string token must not auth /api/*");

    const wrongTokenInUrl = await request(port, `/api/health?token=wrong-${secret}`);
    assert.equal(wrongTokenInUrl.status, 401);

    const wrongHeader = await request(port, "/api/health", {
      headers: { Authorization: `Bearer wrong-${secret}` },
    });
    assert.equal(wrongHeader.status, 401);

    const ok = await request(port, "/api/health", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    assert.equal(ok.status, 200);

    const malformedBody = await request(port, "/api/execute", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      body: "{not json",
    });
    assert.equal(malformedBody.status, 400);

    assert.equal(await wsConnect(port, secret), "accepted");

    const output = captured.join("\n");
    assert.ok(!output.includes(secret), "token leaked into console output");
    assert.ok(!output.includes("?token="), "full-URL logging would expose ?token=");
  } finally {
    await server.stop();
    for (let i = 0; i < methods.length; i++) {
      console[methods[i]] = originals[i];
    }
  }
});
