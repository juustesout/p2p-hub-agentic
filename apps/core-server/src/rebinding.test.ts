import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { CoreServer } from "./app";
import { FixedWindowLimiter } from "./fixed-window";

const TOKEN = "rebinding-test-token";
const PEER_ID = "a".repeat(64);

interface Fixture {
  server: CoreServer;
  port: number;
  dataDir: string;
}

async function makeFixture(
  extra: Partial<ConstructorParameters<typeof CoreServer>[0]> = {},
): Promise<Fixture> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-server-rebinding-"));
  const pluginsDir = path.join(dataDir, "plugins");
  await fs.mkdir(pluginsDir, { recursive: true });

  // Seed a mirror so the /remote-site read path can actually serve on a
  // legitimate Host.
  const mirrorRoot = path.join(dataDir, "sites", PEER_ID);
  await fs.mkdir(mirrorRoot, { recursive: true });
  await fs.writeFile(
    path.join(mirrorRoot, "index.html"),
    "<h1>remote mirror</h1>",
  );

  const server = new CoreServer({
    pluginsDir,
    dataDir,
    host: "127.0.0.1",
    port: 0,
    bootToken: TOKEN,
    networking: false,
    ...extra,
  });
  await server.start();
  const addr = server.address();
  assert.ok(addr, "server should report its bound address");
  return { server, port: addr.port, dataDir };
}

/** Raw request so the exact Host header (and its absence) can be forced. */
function rawRequest(
  port: number,
  pathname: string,
  headers: Record<string, string>,
  method = "GET",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: pathname, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function wsConnect(
  port: number,
  hostHeader: string,
  token?: string,
): Promise<"accepted" | "rejected"> {
  return new Promise((resolve, reject) => {
    const url = token
      ? `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`
      : `ws://127.0.0.1:${port}/ws`;
    const ws = new WebSocket(url, { headers: { Host: hostHeader } });
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
// DNS-rebinding sweep: a rebinding page's requests carry the attacker's domain
// in the Host header (the browser derives it from the URL, never the resolved
// IP). Every route — tokenless and token-gated alike — must refuse those.
// ---------------------------------------------------------------------------

test("a DNS-rebinding Host header is refused on every route (403, nothing leaks)", async () => {
  const { server, port } = await makeFixture();
  try {
    const rebindingHosts = ["evil.com", "evil.com:8788", "attacker.io:8788"];
    for (const host of rebindingHosts) {
      for (const target of [
        { path: "/site/index.html", label: "/site" },
        { path: "/ui/mywidget/app.js", label: "/ui" },
        { path: `/remote-site/${PEER_ID}/`, label: "/remote-site" },
        { path: "/peersite/status", label: "/peersite" },
      ]) {
        const res = await rawRequest(port, target.path, { Host: host });
        assert.equal(
          res.status,
          403,
          `${target.label} must refuse rebinding Host "${host}"`,
        );
        assert.deepEqual(JSON.parse(res.body), { error: "forbidden" });
      }

      // The token gate must not be reachable through a rebinding origin either:
      // the host gate runs first, so even a valid boot token yields 403.
      const noToken = await rawRequest(port, "/api/health", { Host: host });
      assert.equal(noToken.status, 403, `/api without token, Host ${host}`);
      const withToken = await rawRequest(port, "/api/health", {
        Host: host,
        Authorization: `Bearer ${TOKEN}`,
      });
      assert.equal(withToken.status, 403, `/api with token, Host ${host}`);
    }
  } finally {
    await server.stop();
  }
});

test("a missing Host header is refused with 403 on every route", async () => {
  const { server, port } = await makeFixture();
  try {
    // HTTP/1.0 does not require a Host header, so it reaches the handler with
    // `req.headers.host` undefined — exactly the request a bare rebinding
    // socket could craft. It must be refused, not served.
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port }, () => {
        socket.write(
          `GET /remote-site/${PEER_ID}/ HTTP/1.0\r\nConnection: close\r\n\r\n`,
        );
      });
      let data = "";
      socket.on("data", (d) => (data += d.toString()));
      socket.on("end", () => {
        const status = Number((data.match(/^HTTP\/1\.\d (\d{3})/) ?? [])[1]);
        resolve({ status });
      });
      socket.on("error", reject);
    });
    assert.equal(res.status, 403, "a request without a Host header must be refused");
  } finally {
    await server.stop();
  }
});

test("legitimate loopback Host headers keep every route working", async () => {
  const { server, port } = await makeFixture();
  try {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      const site = await rawRequest(port, `/remote-site/${PEER_ID}/`, { Host: host });
      assert.equal(site.status, 200, `remote-site via Host ${host}`);
      assert.match(site.body, /remote mirror/);

      const api = await rawRequest(port, "/api/health", {
        Host: host,
        Authorization: `Bearer ${TOKEN}`,
      });
      assert.equal(api.status, 200, `/api/health via Host ${host}`);

      const unauthenticated = await rawRequest(port, "/api/health", { Host: host });
      assert.equal(unauthenticated.status, 401, "token gate still applies for legit Host");
    }
  } finally {
    await server.stop();
  }
});

test("the WebSocket bus applies the same Host gate as HTTP", async () => {
  const { server, port } = await makeFixture();
  try {
    assert.equal(await wsConnect(port, "evil.com"), "rejected");
    assert.equal(await wsConnect(port, "evil.com", TOKEN), "rejected");
    assert.equal(await wsConnect(port, `127.0.0.1:${port}`, TOKEN), "accepted");
  } finally {
    await server.stop();
  }
});

test("explicit allowedHosts extend the allowlist through the full HTTP path", async () => {
  // Loopback-only fixture (makeFixture binds 127.0.0.1, exposed=false):
  // operator allowlist entries are a deliberate, unconditional trust exception
  // (reverse-proxy/Tauri-hostname case), so a listed hostname is served while
  // any non-listed non-loopback hostname stays denied.
  const { server, port } = await makeFixture({
    allowedHosts: ["desktop-shell.local"],
  });
  try {
    const res = await rawRequest(port, `/remote-site/${PEER_ID}/`, {
      Host: `desktop-shell.local:${port}`,
    });
    assert.equal(res.status, 200, "an explicitly allowed hostname is served");
    const other = await rawRequest(port, `/remote-site/${PEER_ID}/`, {
      Host: `other.local:${port}`,
    });
    assert.equal(other.status, 403, "a non-allowed hostname is still refused");
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// /remote-site cache-miss proxy budget: the outbound peer fetch is an action,
// so it is capped even though the route itself is tokenless.
// ---------------------------------------------------------------------------

test("/remote-site cache-miss fetches are rate-capped (no unbounded proxy)", async () => {
  let consultations = 0;
  let grants = 0;
  const limiter = new FixedWindowLimiter(2, 60_000);
  const { server, port } = await makeFixture({
    remoteFetchLimiter: {
      allow: () => {
        consultations++;
        const allowed = limiter.allow();
        if (allowed) {
          grants++;
        }
        return allowed;
      },
    },
  });
  try {
    // Two misses are within budget; each attempts the (here impossible) P2P
    // fetch and comes back a quiet 404.
    for (const n of [1, 2]) {
      const res = await rawRequest(port, `/remote-site/${PEER_ID}/missing-${n}.html`, {
        Host: `127.0.0.1:${port}`,
      });
      assert.equal(res.status, 404, `miss ${n} within budget`);
    }
    // Once the budget is exhausted the route refuses to dial a peer: 429, and
    // the gate grants no further outbound fetches.
    for (const n of [3, 4, 5]) {
      const res = await rawRequest(port, `/remote-site/${PEER_ID}/missing-${n}.html`, {
        Host: `127.0.0.1:${port}`,
      });
      assert.equal(res.status, 429, `miss ${n} over the cap`);
    }
    assert.equal(consultations, 5, "the gate is consulted once per cache miss");
    assert.equal(grants, 2, "no outbound fetch is granted past the cap");

    // A mirror *hit* is a disk read, not a fetch — it still works past the cap.
    const hit = await rawRequest(port, `/remote-site/${PEER_ID}/`, {
      Host: `127.0.0.1:${port}`,
    });
    assert.equal(hit.status, 200);
    assert.equal(consultations, 5, "hits never consult the fetch budget");
    assert.equal(grants, 2);
  } finally {
    await server.stop();
  }
});
