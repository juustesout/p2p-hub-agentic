import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PluginHost } from "./plugin-host";

const ECHO_MANIFEST = {
  id: "testnode",
  version: "1.0.0",
  kind: "generic",
  permissions: ["network:skill:testnode.echo", "network:public:testnode.echo"],
  entry: "./index.mjs",
};

const ECHO_SOURCE = `export default function activate(ctx) {
  ctx.skills.register("echo", async (payload) => ({ echoed: payload }), {
    localOnly: false,
    remote: { gate: "any" },
  });
  return {
    sendEcho(peerId) {
      return ctx.network.sendTask(peerId, {
        id: "echo-test",
        skill: "testnode.echo",
        payload: { hello: "world" },
      });
    },
  };
}`;

interface EchoApi {
  sendEcho(peerId: string): Promise<{
    taskId: string;
    status: "ok" | "error";
    result?: unknown;
    error?: string;
  }>;
}

async function writeTestNodePlugin(root: string): Promise<void> {
  const dir = path.join(root, "plugins", "testnode");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify(ECHO_MANIFEST, null, 2),
  );
  await fs.writeFile(path.join(dir, "index.mjs"), ECHO_SOURCE);
}

const MIXED_MANIFEST = {
  id: "mixed",
  version: "1.0.0",
  kind: "generic",
  permissions: ["network:skill:mixed.public", "network:public:mixed.public"],
  entry: "./index.mjs",
};

const MIXED_SOURCE = `export default function activate(ctx) {
  ctx.skills.register("public", async () => "ok", { localOnly: false, remote: { gate: "any" } });
  ctx.skills.register("secret", async () => "shh");
  return {};
}`;

async function writeMixedPlugin(root: string): Promise<void> {
  const dir = path.join(root, "plugins", "mixed");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify(MIXED_MANIFEST, null, 2),
  );
  await fs.writeFile(path.join(dir, "index.mjs"), MIXED_SOURCE);
}

async function waitFor<T>(
  check: () => T | null | undefined,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null | undefined;
  while (Date.now() < deadline) {
    last = check();
    if (last) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

test("enableNetworking defaults to false: boot leaves the registry empty", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "host-net-off-"));
  await writeTestNodePlugin(root);

  const host = new PluginHost({
    pluginsDir: path.join(root, "plugins"),
    dataDir: path.join(root, "data"),
  });
  await host.boot();

  assert.equal(host.networkRegistry().list().length, 0);
  assert.equal(host.networkRegistry().selectActive(), null);
  assert.ok(host.getActivated("testnode") !== undefined);
});

test("two hosts reach each other's network-exposed skill via ctx.network", async () => {
  const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "host-net-a-"));
  const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "host-net-b-"));
  await writeTestNodePlugin(rootA);
  await writeTestNodePlugin(rootB);

  const hostA = new PluginHost({
    pluginsDir: path.join(rootA, "plugins"),
    dataDir: path.join(rootA, "data"),
    enableNetworking: true,
  });
  const hostB = new PluginHost({
    pluginsDir: path.join(rootB, "plugins"),
    dataDir: path.join(rootB, "data"),
    enableNetworking: true,
  });

  try {
    await hostA.boot();
    await hostB.boot();

    const peerB = (await hostB.identityManager().getOrCreateIdentity()).peerId;

    await waitFor(() =>
      hostA
        .networkRegistry()
        .selectActive()
        ?.listPeers?.()
        .some((peer) => peer.peerId === peerB)
        ? true
        : null,
    );

    const nodeA = hostA.getActivated("testnode") as EchoApi;
    const result = await nodeA.sendEcho(peerB);

    assert.equal(result.status, "ok");
    assert.deepEqual(result.result, { echoed: { hello: "world" } });
  } finally {
    await hostA.stop();
    await hostB.stop();
  }
});

test("network-light's capability set excludes local-only skills and is not broadcast", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "host-net-adv-"));
  await writeMixedPlugin(root);

  const host = new PluginHost({
    pluginsDir: path.join(root, "plugins"),
    dataDir: path.join(root, "data"),
    enableNetworking: true,
  });

  try {
    await host.boot();

    const provider = host.networkRegistry().selectActive();
    assert.ok(provider, "network provider should be active after boot");
    const capabilities = (provider as { capabilities?: string[] }).capabilities;
    assert.ok(capabilities, "provider should expose its configured capabilities");
    assert.ok(
      capabilities.includes("mixed.public"),
      "network-exposed skill should be in the capability set",
    );
    assert.ok(
      !capabilities.includes("mixed.secret"),
      "local-only skill must never be in the capability set",
    );
    // Fase 0C: the capability set is configured, but it is never broadcast —
    // mDNS announces identity/address only. What actually reaches the wire is
    // covered by the network-light provider tests (discovered peers expose no
    // skills).
  } finally {
    await host.stop();
  }
});

test("a network start failure does not block plugin boot", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "host-net-fail-"));
  await writeTestNodePlugin(root);

  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  const host = new PluginHost({
    pluginsDir: path.join(root, "plugins"),
    dataDir: path.join(root, "data"),
    enableNetworking: true,
    networkProviderFactory: () => ({
      id: "failing-transport",
      priority: 0,
      start: async () => {
        throw new Error("simulated transport failure");
      },
      stop: async () => {},
      isReady: () => false,
      discover: async () => [],
      sendTask: async () => {
        throw new Error("unreachable");
      },
      onTask: () => {},
    }),
  });

  try {
    await host.boot();
    assert.ok(host.getActivated("testnode") !== undefined);
    assert.ok(
      errors.some((message) => message.includes("networking")),
      "expected a log noting the network failure",
    );
    assert.equal(host.networkRegistry().selectActive(), null);
  } finally {
    console.error = original;
  }
});
