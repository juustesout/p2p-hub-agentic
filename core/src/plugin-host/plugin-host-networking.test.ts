import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PluginHost } from "./plugin-host";

// Real mDNS discovery is not delivered on GitHub-hosted macOS runners, so the
// two-host discovery-based test is skipped there.
const MDNS_SKIP =
  process.platform === "darwin" &&
  "real mDNS multicast discovery is not delivered on GitHub macOS runners";

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

test("two hosts reach each other's network-exposed skill via ctx.network", { skip: MDNS_SKIP }, async () => {
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

// ---------------------------------------------------------------------------
// Stap 5: cross-host event pub/sub via `ctx.events`.
// ---------------------------------------------------------------------------

const VIEWER_MANIFEST = {
  id: "viewer",
  version: "1.0.0",
  kind: "generic",
  permissions: [],
  entry: "./index.mjs",
};

const VIEWER_SOURCE = `export default function activate(ctx) {
  const received = [];
  const subscribe = async (peerId, topic) => {
    const sub = await ctx.events.subscribeRemote(peerId, topic, (event) =>
      received.push(event),
    );
    return { subscriptionId: sub.subscriptionId };
  };
  const subscribeDenied = async (peerId, topic) => {
    try {
      await ctx.events.subscribeRemote(peerId, topic, () => {});
      return { denied: false };
    } catch (err) {
      return { denied: true, reason: err.name };
    }
  };
  ctx.skills.register("subscribe", (payload) =>
    subscribe(payload.peerId, payload.topic),
  );
  ctx.skills.register("subscribeDenied", (payload) =>
    subscribeDenied(payload.peerId, payload.topic),
  );
  return {
    subscribe,
    subscribeDenied,
    received: () => received,
  };
}`;

const SENSOR_MANIFEST = {
  id: "sensor",
  version: "1.0.0",
  kind: "generic",
  permissions: [],
  exposedEvents: ["sensor:update"],
  entry: "./index.mjs",
};

const SENSOR_SOURCE = `export default function activate(ctx) {
  const publish = async (payload) => {
    await ctx.events.publishRemote("sensor:update", payload);
    return { ok: true };
  };
  const publishNotExposed = async () => {
    try {
      await ctx.events.publishRemote("sensor:other", { nope: true });
      return { threw: false };
    } catch (err) {
      return { threw: true, name: err.name };
    }
  };
  ctx.skills.register("publish", (payload) => publish(payload));
  ctx.skills.register("publishNotExposed", () => publishNotExposed());
  return { publish, publishNotExposed };
}`;

interface ViewerEvent {
  peerId: string;
  subscriptionId: string;
  topic: string;
  timestamp: number;
  sequenceNumber: number;
  payload: { reading: number };
}

interface ViewerApi {
  subscribe(peerId: string, topic: string): Promise<{ subscriptionId: string }>;
  subscribeDenied(
    peerId: string,
    topic: string,
  ): Promise<{ denied: boolean; reason: string }>;
  received(): ViewerEvent[];
}

interface SensorApi {
  publish(payload: { reading: number }): Promise<{ ok: boolean }>;
  publishNotExposed(): Promise<{ threw: boolean; name?: string }>;
}

async function writeViewerPlugin(root: string): Promise<void> {
  const dir = path.join(root, "plugins", "viewer");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify(VIEWER_MANIFEST, null, 2),
  );
  await fs.writeFile(path.join(dir, "index.mjs"), VIEWER_SOURCE);
}

async function writeSensorPlugin(root: string): Promise<void> {
  const dir = path.join(root, "plugins", "sensor");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify(SENSOR_MANIFEST, null, 2),
  );
  await fs.writeFile(path.join(dir, "index.mjs"), SENSOR_SOURCE);
}

async function bootEventHosts(rootA: string, rootB: string): Promise<{
  hostA: PluginHost;
  hostB: PluginHost;
}> {
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
  await hostA.boot();
  await hostB.boot();
  return { hostA, hostB };
}

test(
  "events: A subscribes to B's exposed topic and receives publishRemote payloads",
  { skip: MDNS_SKIP },
  async () => {
    const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "host-ev-a-"));
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "host-ev-b-"));
    await writeViewerPlugin(rootA);
    await writeSensorPlugin(rootB);

    const { hostA, hostB } = await bootEventHosts(rootA, rootB);
    try {
      const peerB = (await hostB.identityManager().getOrCreateIdentity()).peerId;

      // A must have discovered (and handshake-verified) B before it can
      // subscribe — `subscribeRemote` resolves the peer from `listPeers`.
      await waitFor(() =>
        hostA
          .networkRegistry()
          .selectActive()
          ?.listPeers?.()
          .some((peer) => peer.peerId === peerB)
          ? true
          : null,
      );

      const viewer = hostA.getActivated("viewer") as ViewerApi;
      const sensor = hostB.getActivated("sensor") as SensorApi;

      const subResult = await viewer.subscribe(peerB, "sensor:update");
      assert.ok(subResult.subscriptionId, "subscription should be accepted");
      assert.match(subResult.subscriptionId, /^sub-[a-f0-9]+$/);

      // B publishes twice; A receives both payloads in order.
      await sensor.publish({ reading: 1 });
      await sensor.publish({ reading: 2 });

      await waitFor(() =>
        viewer.received().length >= 2 ? viewer.received() : null,
      );

      const events = viewer.received();
      assert.deepEqual(
        events.map((event) => event.payload),
        [{ reading: 1 }, { reading: 2 }],
      );
      assert.equal(events[0].topic, "sensor:update");
      assert.equal(events[0].peerId, peerB, "publisherPeerId = B's verified id");
      assert.ok(
        events[1].sequenceNumber > events[0].sequenceNumber,
        "per-subscription monotonic sequence numbers",
      );
    } finally {
      await hostA.stop();
      await hostB.stop();
    }
  },
);

test(
  "events: non-exposed subscribe and publish both fail closed",
  { skip: MDNS_SKIP },
  async () => {
    const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "host-ev-neg-a-"));
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "host-ev-neg-b-"));
    await writeViewerPlugin(rootA);
    await writeSensorPlugin(rootB);

    const { hostA, hostB } = await bootEventHosts(rootA, rootB);
    try {
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

      const viewer = hostA.getActivated("viewer") as ViewerApi;
      const sensor = hostB.getActivated("sensor") as SensorApi;

      // A's subscription to a topic B does not expose is rejected by B's hub.
      const denied = await viewer.subscribeDenied(peerB, "sensor:secret");
      assert.equal(denied.denied, true);
      assert.equal(denied.reason, "SubscriptionRejectedError");
      assert.equal(viewer.received().length, 0, "no event ever dispatched");

      // B cannot publish on an exposed topic that is not in its manifest.
      const publish = await sensor.publishNotExposed();
      assert.equal(publish.threw, true);
      assert.equal(publish.name, "TopicNotExposedError");
    } finally {
      await hostA.stop();
      await hostB.stop();
    }
  },
);
