import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CoreServer } from "./app";

const TOKEN = "ui-test-token";

interface Fixture {
  server: CoreServer;
  port: number;
  dataDir: string;
}

async function makeFixture(): Promise<Fixture> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-server-ui-"));
  const pluginsDir = path.join(dataDir, "plugins");
  const pluginDir = path.join(pluginsDir, "mywidget");
  await fs.mkdir(path.join(pluginDir, "dist"), { recursive: true });

  await fs.writeFile(
    path.join(pluginDir, "manifest.json"),
    JSON.stringify(
      {
        id: "mywidget",
        version: "1.0.0",
        kind: "generic",
        permissions: ["network:http:mywidget.ping"],
        entry: "./index.mjs",
        ui: {
          entry: "dist/index.html",
          skills: ["mywidget.ping"],
          defaultWidth: 400,
          defaultHeight: 300,
        },
      },
      null,
      2,
    ),
  );
  await fs.writeFile(
    path.join(pluginDir, "index.mjs"),
    `export default async function activate(ctx) {
      ctx.skills.register("ping", async () => "pong", { httpExposed: true });
      return {};
    }`,
  );
  await fs.writeFile(
    path.join(pluginDir, "dist", "index.html"),
    '<!doctype html><html><head><title>MyWidget</title></head><body><script src="app.js"></script></body></html>',
  );
  await fs.writeFile(
    path.join(pluginDir, "dist", "app.js"),
    'console.log("ui");',
  );
  // A secret file the UI root must never reach.
  await fs.writeFile(path.join(pluginDir, "secret.txt"), "top-secret");

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

test("GET /ui/<pluginId>/ serves the manifest entry document without a token", async () => {
  const { server, port } = await makeFixture();
  try {
    const res = await get(port, "/ui/mywidget/");
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /<title>MyWidget<\/title>/);
    assert.match(body, /<script src="app.js"><\/script>/);
  } finally {
    await server.stop();
  }
});

test("GET /ui/<pluginId> (no trailing slash) also serves the entry document", async () => {
  const { server, port } = await makeFixture();
  try {
    const res = await get(port, "/ui/mywidget");
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<title>MyWidget<\/title>/);
  } finally {
    await server.stop();
  }
});

test("the entry document carries the hardened UI CSP and no-store headers", async () => {
  const { server, port } = await makeFixture();
  try {
    const res = await get(port, "/ui/mywidget/");
    assert.equal(res.status, 200);
    const csp = res.headers.get("content-security-policy") ?? "";
    // The plugin UI must never make its own network calls — every capability
    // goes through the shell bridge.
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  } finally {
    await server.stop();
  }
});

test("GET /ui/<pluginId>/<asset> serves sibling UI assets", async () => {
  const { server, port } = await makeFixture();
  try {
    const res = await get(port, "/ui/mywidget/app.js");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
    assert.equal(await res.text(), 'console.log("ui");');
  } finally {
    await server.stop();
  }
});

test("HEAD /ui/<pluginId>/<asset> returns headers but no body", async () => {
  const { server, port } = await makeFixture();
  try {
    // fetch has no HEAD helper; issue it via the server directly is overkill —
    // verify the route accepts HEAD through a raw fetch.
    const head = await fetch(`http://127.0.0.1:${port}/ui/mywidget/app.js`, {
      method: "HEAD",
    });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  } finally {
    await server.stop();
  }
});

test("the UI root is contained: files outside the UI directory are 404", async () => {
  const { server, port } = await makeFixture();
  try {
    const manifest = await get(port, "/ui/mywidget/manifest.json");
    assert.equal(manifest.status, 404);
    const secret = await get(port, "/ui/mywidget/secret.txt");
    assert.equal(secret.status, 404);
  } finally {
    await server.stop();
  }
});

test("traversal and encoded dot segments are denied with 404", async () => {
  const { server, port } = await makeFixture();
  try {
    const denied = [
      "/ui/mywidget/../index.mjs",
      "/ui/mywidget/../../secret.txt",
      "/ui/mywidget/%2e%2e/index.mjs",
      "/ui/mywidget/..%2findex.mjs",
      "/ui/mywidget/sub/../../index.mjs",
      "/ui/mywidget/.env",
    ];
    for (const p of denied) {
      const res = await get(port, p);
      assert.equal(res.status, 404, `expected 404 for ${p}`);
    }
  } finally {
    await server.stop();
  }
});

test("an unknown plugin id is a 404", async () => {
  const { server, port } = await makeFixture();
  try {
    const res = await get(port, "/ui/does-not-exist/");
    assert.equal(res.status, 404);
  } finally {
    await server.stop();
  }
});

test("non-GET/HEAD methods on /ui are refused with 405", async () => {
  const { server, port } = await makeFixture();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ui/mywidget/`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(res.status, 405);
  } finally {
    await server.stop();
  }
});

test("/ui is served without the boot token while /api still requires it", async () => {
  const { server, port } = await makeFixture();
  try {
    const ui = await get(port, "/ui/mywidget/");
    assert.equal(ui.status, 200);

    const api = await get(port, "/api/health");
    assert.equal(api.status, 401);
  } finally {
    await server.stop();
  }
});

test("capabilities expose the manifest-declared ui surface (entry + skills allowlist)", async () => {
  const { server, port } = await makeFixture();
  try {
    const res = await get(port, "/api/capabilities", {
      Authorization: `Bearer ${TOKEN}`,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      local: { plugins: Array<Record<string, unknown>> };
    };
    const plugin = body.local.plugins.find((p) => p.id === "mywidget");
    assert.ok(plugin, "mywidget should be listed");
    assert.deepEqual(plugin.ui, {
      entry: "dist/index.html",
      defaultWidth: 400,
      defaultHeight: 300,
      skills: ["mywidget.ping"],
    });
  } finally {
    await server.stop();
  }
});

test("a plugin without a ui has ui: null in capabilities", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-server-ui-"));
  const pluginsDir = path.join(dataDir, "plugins");
  const pluginDir = path.join(pluginsDir, "headless");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "manifest.json"),
    JSON.stringify({
      id: "headless",
      version: "1.0.0",
      kind: "generic",
      permissions: [],
      entry: "./index.mjs",
    }),
  );
  await fs.writeFile(
    path.join(pluginDir, "index.mjs"),
    `export default function activate() { return {}; }`,
  );

  const server = new CoreServer({
    pluginsDir,
    dataDir,
    host: "127.0.0.1",
    port: 0,
    bootToken: TOKEN,
    networking: false,
  });
  try {
    await server.start();
    const addr = server.address();
    assert.ok(addr);
    const res = await get(addr.port, "/api/capabilities", {
      Authorization: `Bearer ${TOKEN}`,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      local: { plugins: Array<Record<string, unknown>> };
    };
    const plugin = body.local.plugins.find((p) => p.id === "headless");
    assert.ok(plugin, "headless should be listed");
    assert.equal(plugin.ui, null);

    const ui = await get(addr.port, "/ui/headless/");
    assert.equal(ui.status, 404);
  } finally {
    await server.stop();
  }
});
