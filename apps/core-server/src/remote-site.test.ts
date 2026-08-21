import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CoreServer } from "./app";

const TOKEN = "remote-site-test-token";
const PEER_ID = "a".repeat(64);

interface Fixture {
  server: CoreServer;
  port: number;
  dataDir: string;
}

async function makeFixture(): Promise<Fixture> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-server-remote-site-"));
  const pluginsDir = path.join(dataDir, "plugins");
  await fs.mkdir(pluginsDir, { recursive: true });

  // Pre-seed the mirror for one peer (as if the assets had been fetched over
  // the P2P website capability): index.html + a nested binary asset.
  const mirrorRoot = path.join(dataDir, "sites", PEER_ID);
  await fs.mkdir(path.join(mirrorRoot, "img"), { recursive: true });
  await fs.writeFile(
    path.join(mirrorRoot, "index.html"),
    '<h1>hello from the remote peer</h1>',
  );
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0xff]);
  await fs.writeFile(path.join(mirrorRoot, "img", "logo.png"), png);
  // A file outside any mirror root that must never be reachable.
  await fs.writeFile(path.join(dataDir, "secret.txt"), "top-secret");

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

function get(port: number, pathname: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${pathname}`, { headers });
}

test("GET /remote-site/<peerId>/ serves the mirrored site without a token", async () => {
  const { server, port } = await makeFixture();
  try {
    const res = await get(port, `/remote-site/${PEER_ID}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /hello from the remote peer/);
  } finally {
    await server.stop();
  }
});

test("mirrored assets are byte-exact and get an extension-derived content type", async () => {
  const { server, port } = await makeFixture();
  try {
    const res = await get(port, `/remote-site/${PEER_ID}/img/logo.png`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /image\/png/);
    const body = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual(
      Array.from(body),
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0xff],
    );
  } finally {
    await server.stop();
  }
});

test("mirrored responses carry the hardened UI CSP (connect-src 'none', no-store)", async () => {
  const { server, port } = await makeFixture();
  try {
    const res = await get(port, `/remote-site/${PEER_ID}/index.html`);
    assert.equal(res.status, 200);
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  } finally {
    await server.stop();
  }
});

test("HEAD on a mirrored asset returns headers without a body", async () => {
  const { server, port } = await makeFixture();
  try {
    const head = await fetch(`http://127.0.0.1:${port}/remote-site/${PEER_ID}/img/logo.png`, {
      method: "HEAD",
    });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  } finally {
    await server.stop();
  }
});

test("a malformed or unknown peerId is a 404", async () => {
  const { server, port } = await makeFixture();
  try {
    assert.equal((await get(port, "/remote-site/not-a-peer/")).status, 404);
    assert.equal(
      (await get(port, `/remote-site/${"b".repeat(64)}/`)).status,
      404,
      "a peer without a mirror is not found",
    );
  } finally {
    await server.stop();
  }
});

test("traversal and encoded dot segments on the mirror are denied with 404", async () => {
  const { server, port } = await makeFixture();
  try {
    const denied = [
      `/remote-site/${PEER_ID}/../secret.txt`,
      `/remote-site/${PEER_ID}/../../etc/passwd`,
      `/remote-site/${PEER_ID}/%2e%2e/secret.txt`,
      `/remote-site/${PEER_ID}/..%2fsecret.txt`,
      `/remote-site/${PEER_ID}/img/../../secret.txt`,
      `/remote-site/${PEER_ID}/.env`,
    ];
    for (const p of denied) {
      const res = await get(port, p);
      assert.equal(res.status, 404, `expected 404 for ${p}`);
    }
  } finally {
    await server.stop();
  }
});

test("non-GET/HEAD methods on the mirror are refused with 405", async () => {
  const { server, port } = await makeFixture();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/remote-site/${PEER_ID}/`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(res.status, 405);
  } finally {
    await server.stop();
  }
});

test("a mirror miss with no network returns a quiet 404 (fetch-on-miss over P2P)", async () => {
  const { server, port, dataDir } = await makeFixture();
  try {
    // An asset that is not yet mirrored, with networking disabled: the outbound
    // P2P fetch cannot happen, so the miss is a 404 — never a leak or a hang.
    const res = await get(port, `/remote-site/${PEER_ID}/missing.html`);
    assert.equal(res.status, 404);
    assert.equal(
      await fs.stat(path.join(dataDir, "sites", PEER_ID, "missing.html")).then(
        () => true,
        () => false,
      ),
      false,
      "a failed fetch must not leave a partial mirror file",
    );
  } finally {
    await server.stop();
  }
});

test("the mirror is served without the boot token while /api still requires it", async () => {
  const { server, port } = await makeFixture();
  try {
    const site = await get(port, `/remote-site/${PEER_ID}/`);
    assert.equal(site.status, 200);

    const api = await get(port, "/api/health");
    assert.equal(api.status, 401);
  } finally {
    await server.stop();
  }
});
