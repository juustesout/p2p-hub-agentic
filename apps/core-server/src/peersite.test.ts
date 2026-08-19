import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { CoreServer } from "./app";
import type { TrustConfirmation } from "@p2p-hub/core";

const TOKEN = "peersite-test-token";

interface StartOptions {
  siteRoot?: string;
  host?: string;
  trustConfirmation?: TrustConfirmation;
  /** Pre-seeded settings.json contents, written before the server starts. */
  settings?: Record<string, boolean>;
}

async function startServer(opts: StartOptions = {}): Promise<{
  server: CoreServer;
  port: number;
  dataDir: string;
}> {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "core-server-peersite-data-"),
  );
  const pluginsDir = path.join(dataDir, "plugins");
  await fs.mkdir(pluginsDir, { recursive: true });
  if (opts.settings) {
    await fs.writeFile(
      path.join(dataDir, "settings.json"),
      JSON.stringify(opts.settings),
    );
  }
  const server = new CoreServer({
    pluginsDir,
    dataDir,
    host: opts.host ?? "127.0.0.1",
    port: 0,
    bootToken: TOKEN,
    siteRoot: opts.siteRoot,
    trustConfirmation: opts.trustConfirmation,
  });
  await server.start();
  const addr = server.address();
  assert.ok(addr, "server should report its bound address");
  return { server, port: addr.port, dataDir };
}

/** Send a raw GET with a hand-built path, bypassing `fetch` URL normalization. */
function rawGet(port: number, requestPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: requestPath, method: "GET" },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function makeSiteRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "peersite-site-"));
}

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

// ---------------------------------------------------------------------------
// Fase 1 — static serving
// ---------------------------------------------------------------------------

test("serves static files with correct content-type and security headers", async () => {
  const siteDir = await makeSiteRoot();
  await fs.writeFile(path.join(siteDir, "index.html"), "<h1>hello</h1>");
  await fs.writeFile(path.join(siteDir, "style.css"), "body { color: red }");
  const { server, port } = await startServer({ siteRoot: siteDir });
  try {
    const html = await fetch(`http://127.0.0.1:${port}/site/index.html`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(html.headers.get("x-content-type-options"), "nosniff");
    assert.match(
      html.headers.get("content-security-policy") ?? "",
      /default-src 'self'/,
    );
    assert.equal(await html.text(), "<h1>hello</h1>");

    const css = await fetch(`http://127.0.0.1:${port}/site/style.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);
    assert.equal(css.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await css.text(), "body { color: red }");
  } finally {
    await server.stop();
  }
});

test("directory requests resolve to index.html", async () => {
  const siteDir = await makeSiteRoot();
  await fs.writeFile(path.join(siteDir, "index.html"), "<title>root</title>");
  const { server, port } = await startServer({ siteRoot: siteDir });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/site/`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "<title>root</title>");
  } finally {
    await server.stop();
  }
});

test("path traversal returns 404 and leaks nothing outside the root", async () => {
  const siteDir = await makeSiteRoot();
  await fs.writeFile(path.join(siteDir, "index.html"), "<h1>ok</h1>");
  const { server, port } = await startServer({ siteRoot: siteDir });
  try {
    // Encoded dot-dot: URL parser collapses it before routing, still 404.
    const encoded = await fetch(
      `http://127.0.0.1:${port}/site/%2e%2e/%2e%2e/etc/passwd`,
    );
    assert.equal(encoded.status, 404);

    // Encoded-slash traversal reaches the handler guard, still 404.
    const slashy = await fetch(
      `http://127.0.0.1:${port}/site/a%2f..%2f..%2fetc%2fpasswd`,
    );
    assert.equal(slashy.status, 404);

    // Raw literal `..` sent without URL normalization.
    assert.equal(await rawGet(port, "/site/../../etc/passwd"), 404);
  } finally {
    await server.stop();
  }
});

test("symlink pointing outside the site root is denied", async () => {
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "peersite-out-"));
  await fs.writeFile(path.join(outsideDir, "secret.txt"), "top secret");
  const siteDir = await makeSiteRoot();
  await fs.symlink(path.join(outsideDir, "secret.txt"), path.join(siteDir, "leak.txt"));
  const { server, port } = await startServer({ siteRoot: siteDir });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/site/leak.txt`);
    assert.equal(res.status, 404);
    assert.ok(!(await res.text()).includes("top secret"));
  } finally {
    await server.stop();
  }
});

test("dotfiles and dot-directories are denied", async () => {
  const siteDir = await makeSiteRoot();
  await fs.writeFile(path.join(siteDir, ".env"), "SECRET=1");
  await fs.mkdir(path.join(siteDir, ".git"), { recursive: true });
  await fs.writeFile(path.join(siteDir, ".git", "config"), "[core]");
  const { server, port } = await startServer({ siteRoot: siteDir });
  try {
    for (const requestPath of ["/site/.env", "/site/.git/config"]) {
      const res = await fetch(`http://127.0.0.1:${port}${requestPath}`);
      assert.equal(res.status, 404, `expected 404 for ${requestPath}`);
    }
  } finally {
    await server.stop();
  }
});

test("siteRoot equal to the data directory is rejected at startup", async () => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "core-server-peersite-datadir-"),
  );
  const pluginsDir = path.join(dataDir, "plugins");
  await fs.mkdir(pluginsDir, { recursive: true });
  const server = new CoreServer({
    pluginsDir,
    dataDir,
    host: "127.0.0.1",
    port: 0,
    bootToken: TOKEN,
    siteRoot: dataDir,
  });
  await assert.rejects(server.start());
  await server.stop();
});

test("static serving is disabled when siteRoot is not configured", async () => {
  const { server, port } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/site/index.html`);
    assert.equal(res.status, 404);
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// Fase 2 — scoped agent API & LAN opt-in
// ---------------------------------------------------------------------------

test("scoped site token is rejected on /api and /ws (credential isolation)", async () => {
  const siteDir = await makeSiteRoot();
  await fs.writeFile(path.join(siteDir, "index.html"), "hi");
  const { server, port } = await startServer({ siteRoot: siteDir });
  try {
    const siteToken = server.siteCredential();
    assert.ok(siteToken.length >= 64);
    assert.notEqual(siteToken, TOKEN);

    // Site token on a boot-token-guarded settings route -> 401.
    const apply = await fetch(`http://127.0.0.1:${port}/api/settings/apply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${siteToken}`,
      },
      body: JSON.stringify({ p2pHubExposed: true }),
    });
    assert.equal(apply.status, 401);

    // Site token on general task execution -> 401.
    const execute = await fetch(`http://127.0.0.1:${port}/api/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${siteToken}`,
      },
      body: JSON.stringify({ serviceId: "core", method: "echo", arguments: "hi" }),
    });
    assert.equal(execute.status, 401);

    // Site token on the WebSocket upgrade -> rejected.
    assert.equal(await wsConnect(port, siteToken), "rejected");
  } finally {
    await server.stop();
  }
});

test("GET /peersite/status returns clean metadata without secrets", async () => {
  const siteDir = await makeSiteRoot();
  await fs.writeFile(path.join(siteDir, "index.html"), "hi");
  const { server, port, dataDir } = await startServer({ siteRoot: siteDir });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/peersite/status`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.online, true);
    assert.equal(typeof body.peerName, "string");
    assert.equal(typeof body.activePluginsCount, "number");

    const text = JSON.stringify(body);
    assert.ok(!text.includes(TOKEN), "boot token must not leak");
    assert.ok(!text.includes(dataDir), "internal paths must not leak");
    assert.ok(!text.includes("apiKey"), "vault keys must not leak");
    assert.ok(!text.includes("boot-token"));

    assert.deepEqual(
      Object.keys(body).sort(),
      ["activePluginsCount", "online", "peerName"],
    );
  } finally {
    await server.stop();
  }
});

test("POST /peersite/execute-skill fails closed without tier-2 confirmation", async () => {
  const siteDir = await makeSiteRoot();
  await fs.writeFile(path.join(siteDir, "index.html"), "hi");
  const { server, port } = await startServer({ siteRoot: siteDir });
  try {
    const siteToken = server.siteCredential();
    const res = await fetch(`http://127.0.0.1:${port}/peersite/execute-skill`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${siteToken}`,
      },
      body: JSON.stringify({ serviceId: "core", method: "echo", arguments: "hi" }),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as {
      ok: boolean;
      requiredTier: number;
      error: string;
    };
    assert.equal(body.ok, false);
    assert.equal(body.requiredTier, 2);
    assert.match(body.error, /confirmation/);
  } finally {
    await server.stop();
  }
});

test("POST /peersite/execute-skill succeeds when tier-2 confirmation approves", async () => {
  const siteDir = await makeSiteRoot();
  await fs.writeFile(path.join(siteDir, "index.html"), "hi");
  const confirmer: TrustConfirmation = { confirmTier2: async () => true };
  const { server, port } = await startServer({
    siteRoot: siteDir,
    trustConfirmation: confirmer,
  });
  try {
    const siteToken = server.siteCredential();
    const res = await fetch(`http://127.0.0.1:${port}/peersite/execute-skill`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${siteToken}`,
      },
      body: JSON.stringify({ serviceId: "core", method: "echo", arguments: "hi" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; result: unknown };
    assert.equal(body.status, "ok");
    assert.equal(body.result, "hi");
  } finally {
    await server.stop();
  }
});

test("POST /peersite/message requires the site token and is rate-limited", async () => {
  const siteDir = await makeSiteRoot();
  await fs.writeFile(path.join(siteDir, "index.html"), "hi");
  const { server, port } = await startServer({ siteRoot: siteDir });
  try {
    const siteToken = server.siteCredential();
    const post = (token: string | null, message: string) =>
      fetch(`http://127.0.0.1:${port}/peersite/message`, {
        method: "POST",
        headers: token
          ? { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
          : { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });

    // Without the site token -> 401.
    assert.equal((await post(null, "hi")).status, 401);

    // With the site token -> 200, up to the rate limit.
    const first = await post(siteToken, "hello");
    assert.equal(first.status, 200);

    // Drive past the fixed-window limit (30/min): the tail must be 429.
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      statuses.push((await post(siteToken, `m${i}`)).status);
    }
    assert.equal(statuses[0], 200);
    assert.equal(statuses[statuses.length - 1], 429);
  } finally {
    await server.stop();
  }
});

test("non-loopback binding refuses the site unless peersite flags are set", async () => {
  const siteDir = await makeSiteRoot();
  await fs.writeFile(path.join(siteDir, "index.html"), "<h1>lan</h1>");
  // No settings -> peersiteLanExposed false -> site refused on 0.0.0.0.
  const { server, port } = await startServer({
    siteRoot: siteDir,
    host: "0.0.0.0",
  });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/site/index.html`);
    assert.equal(res.status, 404);
    const status = await fetch(`http://127.0.0.1:${port}/peersite/status`);
    assert.equal(status.status, 404);
  } finally {
    await server.stop();
  }
});

test("non-loopback binding serves the site when peersite flags are enabled", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = ((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  }) as typeof console.warn;
  try {
    const siteDir = await makeSiteRoot();
    await fs.writeFile(path.join(siteDir, "index.html"), "<h1>lan</h1>");
    const { server, port } = await startServer({
      siteRoot: siteDir,
      host: "0.0.0.0",
      settings: { peersiteEnabled: true, peersiteLanExposed: true },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/site/index.html`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "<h1>lan</h1>");
    } finally {
      await server.stop();
    }
    assert.ok(
      warnings.some((w) => /EXPOSING/.test(w)),
      "expected a loud exposure warning on LAN opt-in",
    );
  } finally {
    console.warn = originalWarn;
  }
});
