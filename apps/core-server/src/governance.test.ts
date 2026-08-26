import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  PluginHost,
  StorageCorruptionError,
  TaskBroker,
  TrustConfirmationDeniedError,
} from "@p2p-hub/core";
import { CoreServer } from "./app";
import {
  ABSOLUTE_MAX_RATE_LIMIT,
  AccessDeniedError,
  InvalidRateLimitError,
  PeerMatrixStore,
} from "./governance/matrix";
import { GovernanceService } from "./governance/service";
import { GovernanceStream } from "./governance/stream";

const BOOT_TOKEN = "governance-glue-token";
const PEER_ID = "a".repeat(64);
const OTHER_ID = "b".repeat(64);

const TEST_TMP_ROOT = path.resolve(
  __dirname,
  "../../../node_modules/.cache/p2p-hub-test",
);
const CONTACTS_SRC = path.resolve(__dirname, "../../../plugins/contacts");
const CALENDAR_SRC = path.resolve(__dirname, "../../../plugins/calendar");

async function tmpMatrixDir(): Promise<string> {
  await fs.mkdir(TEST_TMP_ROOT, { recursive: true });
  return fs.mkdtemp(path.join(TEST_TMP_ROOT, "governance-matrix-"));
}

function catalogValidators(broker: TaskBroker) {
  return {
    validateSkill: (skill: string) =>
      broker
        .listSkills()
        .some(
          (s) =>
            s.skill === skill &&
            !s.localOnly &&
            !s.httpBridgeOnly &&
            s.remote !== undefined,
        ),
    validateTopic: (topic: string) => topic === "chat:messageReceived",
  };
}

function brokerWithCalendar(): TaskBroker {
  const broker = new TaskBroker();
  broker.registerSkill("calendar.listEvents", async () => [], {
    localOnly: false,
    remote: { gate: "any" },
  });
  broker.registerSkill("calendar.addEvent", async () => ({ ok: true }));
  return broker;
}

async function makeMatrix(): Promise<{ matrix: PeerMatrixStore; dir: string }> {
  const dir = await tmpMatrixDir();
  const matrix = new PeerMatrixStore({
    filePath: path.join(dir, "matrix.json"),
    ...catalogValidators(brokerWithCalendar()),
  });
  await matrix.load();
  return { matrix, dir };
}

// ---------------------------------------------------------------------------
// Part A — matrix store
// ---------------------------------------------------------------------------

test("matrix rejects a skill the manifest does not expose (intersection)", async () => {
  const { matrix, dir } = await makeMatrix();
  try {
    await assert.rejects(
      matrix.set(PEER_ID, { skills: ["calendar.addEvent"], topics: [] }),
      (err: unknown) =>
        err instanceof AccessDeniedError && err.kind === "skill",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("matrix rejects an over-cap customRateLimit (never 'unlimited')", async () => {
  const { matrix, dir } = await makeMatrix();
  try {
    await assert.rejects(
      matrix.set(PEER_ID, {
        skills: ["calendar.listEvents"],
        topics: [],
        customRateLimit: ABSOLUTE_MAX_RATE_LIMIT + 1,
      }),
      InvalidRateLimitError,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("matrix persists entries and reloads them", async () => {
  const dir = await tmpMatrixDir();
  try {
    const filePath = path.join(dir, "matrix.json");
    const first = new PeerMatrixStore({
      filePath,
      ...catalogValidators(brokerWithCalendar()),
    });
    await first.load();
    const entry = await first.set(PEER_ID, {
      skills: ["calendar.listEvents"],
      topics: ["chat:messageReceived"],
      customRateLimit: 42,
    });
    assert.ok(entry.updatedAt > 0);

    const second = new PeerMatrixStore({
      filePath,
      ...catalogValidators(brokerWithCalendar()),
    });
    await second.load();
    const reloaded = second.entry(PEER_ID);
    assert.ok(reloaded, "entry should survive a reload");
    assert.deepEqual(reloaded!.skills, ["calendar.listEvents"]);
    assert.deepEqual(reloaded!.topics, ["chat:messageReceived"]);
    assert.equal(reloaded!.customRateLimit, 42);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("isAllowed defaults to allow and narrows to the entry", async () => {
  const { matrix, dir } = await makeMatrix();
  try {
    assert.equal(await matrix.isAllowed(PEER_ID, "calendar.listEvents"), true);
    await matrix.set(PEER_ID, { skills: ["calendar.listEvents"], topics: [] });
    assert.equal(await matrix.isAllowed(PEER_ID, "calendar.listEvents"), true);
    assert.equal(await matrix.isAllowed(PEER_ID, "calendar.addEvent"), false);
    assert.equal(await matrix.isAllowed(OTHER_ID, "calendar.addEvent"), true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt matrix file throws StorageCorruptionError, not silent empty", async () => {
  const dir = await tmpMatrixDir();
  try {
    const filePath = path.join(dir, "matrix.json");
    await fs.writeFile(filePath, "{ not json", "utf8");
    const matrix = new PeerMatrixStore({
      filePath,
      ...catalogValidators(brokerWithCalendar()),
    });
    await assert.rejects(() => matrix.load(), StorageCorruptionError);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Part B — governance service (fake host)
// ---------------------------------------------------------------------------

interface FakeTopologyPeer {
  id: string;
  peerId?: string;
  peerIdVerified?: boolean;
  name?: string;
  lastSeen?: number;
}

function fakeContactsApi(verifyResult?: { verified: boolean; error?: string }) {
  return {
    listContacts: async () => [],
    verifyPeer: async () => verifyResult ?? { verified: true },
  };
}

function fakeHost(opts: {
  contacts?: unknown;
  broker?: TaskBroker;
  peers?: FakeTopologyPeer[];
  subscriptions?: Array<{ peerId: string; topic: string; ttlMs: number }>;
}): PluginHost {
  const broker = opts.broker ?? brokerWithCalendar();
  const registry = {
    list: () =>
      opts.peers?.length
        ? [
            {
              id: "test-provider",
              priority: 1,
              isReady: () => true,
              listPeers: () => opts.peers,
            },
          ]
        : [],
  };
  return {
    getActivated: () => opts.contacts ?? null,
    taskBroker: () => broker,
    exposedEventTopics: () => ["chat:messageReceived"],
    listEventSubscriptions: async () => opts.subscriptions ?? [],
    networkRegistry: () => registry,
  } as unknown as PluginHost;
}

test("service verifyPeer requires tier-2 confirmation (denied without)", async () => {
  const { matrix, dir } = await makeMatrix();
  try {
    const service = new GovernanceService({
      host: fakeHost({ contacts: fakeContactsApi() }),
      matrix,
      authorizeTier2: async () => {
        throw new TrustConfirmationDeniedError(2, "denied by user");
      },
    });
    await assert.rejects(
      () => service.verifyPeer(PEER_ID),
      TrustConfirmationDeniedError,
    );
    await assert.rejects(
      () => service.setPermissions(PEER_ID, { skills: ["calendar.listEvents"], topics: [] }),
      TrustConfirmationDeniedError,
    );
    assert.equal(matrix.has(PEER_ID), false, "a denied write must not persist");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("service setPermissions validates the catalog after tier-2", async () => {
  const { matrix, dir } = await makeMatrix();
  try {
    const service = new GovernanceService({
      host: fakeHost({ contacts: fakeContactsApi() }),
      matrix,
      authorizeTier2: async () => {},
    });
    await assert.rejects(
      () => service.setPermissions(PEER_ID, { skills: ["calendar.addEvent"], topics: [] }),
      AccessDeniedError,
    );
    const entry = await service.setPermissions(PEER_ID, {
      skills: ["calendar.listEvents"],
      topics: [],
    });
    assert.deepEqual(entry.skills, ["calendar.listEvents"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("topology exposes only functional fields (no address/RTT/bandwidth)", async () => {
  const { matrix, dir } = await makeMatrix();
  try {
    const service = new GovernanceService({
      host: fakeHost({
        contacts: fakeContactsApi(),
        peers: [
          {
            id: "inst-1",
            peerId: PEER_ID,
            peerIdVerified: true,
            name: "Alice's Laptop",
            lastSeen: 123456,
          },
        ],
        subscriptions: [{ peerId: PEER_ID, topic: "chat:messageReceived", ttlMs: 1000 }],
      }),
      matrix,
      authorizeTier2: async () => {},
    });
    await matrix.set(PEER_ID, { skills: ["calendar.listEvents"], topics: [] });

    const [entry] = await service.topology();
    assert.ok(entry, "the discovered peer should appear");
    assert.equal(entry.peerId, PEER_ID);
    assert.equal(entry.instanceId, "inst-1");
    assert.equal(entry.displayName, "Alice's Laptop");
    assert.equal(entry.peerIdVerified, true);
    assert.equal(entry.lastSeen, 123456);
    assert.equal(entry.activeSubscriptions, 1);
    assert.ok(entry.matrix, "a set matrix entry should ride along");
    assert.equal(entry.trustState, "pending", "verified identity without a contact record reads as pending");

    const serialized = JSON.stringify(entry);
    assert.ok(!serialized.includes("address"), "topology must never leak the transport address");
    assert.ok(!serialized.includes("rtt"), "topology must never leak RTT");
    assert.ok(!serialized.includes("bandwidth"), "topology must never leak bandwidth");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Part C — CoreServer HTTP surface
// ---------------------------------------------------------------------------

async function bootGovernanceServer(opts: { confirmTier2?: boolean } = {}): Promise<{
  server: CoreServer;
  port: number;
}> {
  await fs.mkdir(TEST_TMP_ROOT, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(TEST_TMP_ROOT, "core-server-governance-"));
  const pluginsDir = path.join(dataDir, "plugins");
  await fs.mkdir(pluginsDir, { recursive: true });
  await fs.cp(CONTACTS_SRC, path.join(pluginsDir, "contacts"), { recursive: true });
  await fs.cp(CALENDAR_SRC, path.join(pluginsDir, "calendar"), { recursive: true });

  const server = new CoreServer({
    pluginsDir,
    dataDir,
    host: "127.0.0.1",
    port: 0,
    bootToken: BOOT_TOKEN,
    networking: false,
    // Tests that exercise a successful write provide a confirmer; tests that
    // assert the fail-closed posture (no tier-2 confirmer) omit it — matching
    // the default production shape.
    ...(opts.confirmTier2
      ? { trustConfirmation: { confirmTier2: async () => true } }
      : {}),
  });
  await server.start();
  const addr = server.address();
  assert.ok(addr, "server should report its bound address");
  return { server, port: addr.port };
}

async function api(port: number, method: string, pathname: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BOOT_TOKEN}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
}

test("catalog lists only manifest-exposed network skills", async () => {
  const { server, port } = await bootGovernanceServer();
  try {
    const { status, body } = await api(port, "GET", "/api/governance/v1/catalog");
    assert.equal(status, 200);
    const catalog = body as { skills: Array<{ skill: string }>; topics: string[] };
    const skills = catalog.skills.map((s) => s.skill).sort();
    assert.ok(skills.includes("contacts.signChallenge"), "peer-facing contacts skill is exposed");
    assert.ok(skills.includes("calendar.listEvents"), "calendar.listEvents is network-exposed");
    assert.ok(!skills.includes("calendar.addEvent"), "local-only skills stay out of the catalog");
    assert.deepEqual(catalog.topics, [], "no copied plugin exposes events");
  } finally {
    await server.stop();
  }
});

test("permissions endpoint rejects a non-exposed skill with 403", async () => {
  const { server, port } = await bootGovernanceServer({ confirmTier2: true });
  try {
    const { status, body } = await api(port, "PUT", `/api/governance/v1/peers/${PEER_ID}/permissions`, {
      skills: ["calendar.addEvent"],
      topics: [],
    });
    assert.equal(status, 403);
    assert.equal((body as { kind?: string }).kind, "skill");
  } finally {
    await server.stop();
  }
});

test("permissions endpoint rejects an over-cap rate limit with 422", async () => {
  const { server, port } = await bootGovernanceServer({ confirmTier2: true });
  try {
    const { status } = await api(port, "PUT", `/api/governance/v1/peers/${PEER_ID}/permissions`, {
      skills: ["calendar.listEvents"],
      topics: [],
      customRateLimit: ABSOLUTE_MAX_RATE_LIMIT + 1,
    });
    assert.equal(status, 422);
  } finally {
    await server.stop();
  }
});

test("a valid permissions write round-trips through GET /matrix", async () => {
  const { server, port } = await bootGovernanceServer({ confirmTier2: true });
  try {
    const put = await api(port, "PUT", `/api/governance/v1/peers/${PEER_ID}/permissions`, {
      skills: ["calendar.listEvents"],
      topics: [],
      customRateLimit: 50,
    });
    assert.equal(put.status, 200);
    assert.equal((put.body as { ok?: boolean }).ok, true);

    const got = await api(port, "GET", "/api/governance/v1/matrix");
    assert.equal(got.status, 200);
    const entries = (got.body as { entries: Array<{ peerId: string; skills: string[] }> }).entries;
    const entry = entries.find((e) => e.peerId === PEER_ID);
    assert.ok(entry, "the written entry should be readable");
    assert.deepEqual(entry!.skills, ["calendar.listEvents"]);

    const del = await api(port, "DELETE", `/api/governance/v1/peers/${PEER_ID}/permissions`);
    assert.equal(del.status, 200);
  } finally {
    await server.stop();
  }
});

test("verify endpoint refuses without a tier-2 confirmer (fail-closed 403)", async () => {
  const { server, port } = await bootGovernanceServer();
  try {
    const { status, body } = await api(port, "POST", `/api/governance/v1/peers/${PEER_ID}/verify`, {});
    assert.equal(status, 403);
    assert.ok((body as { error?: string }).error?.includes("confirmation"), "denial reason is explicit");
  } finally {
    await server.stop();
  }
});

test("topology endpoint works with no provider", async () => {
  const { server, port } = await bootGovernanceServer();
  try {
    const { status, body } = await api(port, "GET", "/api/governance/v1/topology");
    assert.equal(status, 200);
    assert.deepEqual((body as { peers: unknown[] }).peers, []);
  } finally {
    await server.stop();
  }
});

test("governance routes are unreachable without the boot token", async () => {
  const { server, port } = await bootGovernanceServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/governance/v1/matrix`);
    assert.equal(res.status, 401);
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// Part D — SSE stream
// ---------------------------------------------------------------------------

function fakeSseResponse() {
  const frames: string[] = [];
  const emitter = new EventEmitter();
  return {
    frames,
    res: {
      frames,
      writableEnded: false,
      destroyed: false,
      write: (chunk: string) => {
        frames.push(chunk);
        return true;
      },
      on: emitter.on.bind(emitter),
      once: emitter.once.bind(emitter),
    } as unknown as Parameters<GovernanceStream["subscribe"]>[0],
  };
}

test("stream replays matrix deltas and sends heartbeat keepalives", async () => {
  const { frames, res } = fakeSseResponse();
  const stream = new GovernanceStream({ heartbeatMs: 60_000, now: () => 1000 });
  stream.subscribe(res);

  stream.tick([]);
  stream.tick([
    { peerId: PEER_ID, skills: ["calendar.listEvents"], topics: [], updatedAt: 1 },
  ]);
  stream.tick([
    { peerId: PEER_ID, skills: ["calendar.listEvents"], topics: [], updatedAt: 1 },
  ]);
  stream.tick([
    { peerId: PEER_ID, skills: ["calendar.listEvents"], topics: [], updatedAt: 1 },
    { peerId: OTHER_ID, skills: [], topics: [], updatedAt: 2 },
  ]);
  stream.stop();

  const text = frames.join("");
  assert.ok(text.includes("event: heartbeat"));
  const updates = (text.match(/event: matrix:update/g) ?? []).length;
  assert.equal(updates, 2, "two distinct snapshots → two matrix:update events");
  assert.ok(text.includes(`"peerId":"${PEER_ID}"`));
});

test("stream replays the current snapshot to a fresh subscriber", async () => {
  const stream = new GovernanceStream({ heartbeatMs: 60_000, now: () => 1 });
  // A snapshot must exist before replay: the stream only replays state it has
  // actually ticked (the persisted matrix is the source of truth, never a
  // fabricated one).
  stream.tick([{ peerId: PEER_ID, skills: ["calendar.listEvents"], topics: [], updatedAt: 1 }]);

  const { frames, res } = fakeSseResponse();
  const client = stream.subscribe(res);
  assert.ok(frames.join("").includes("event: matrix:update"), "fresh subscriber gets the snapshot");
  stream.unsubscribe(client);
  stream.stop();
});

test("stream start() uses the live snapshot provider on every tick", async () => {
  const { frames, res } = fakeSseResponse();
  const stream = new GovernanceStream({ heartbeatMs: 60_000, now: () => 1 });
  stream.subscribe(res);

  let snapshot: Array<{ peerId: string; skills: string[]; topics: string[]; updatedAt: number }> = [];
  stream.start(() => snapshot);
  snapshot = [{ peerId: PEER_ID, skills: ["calendar.listEvents"], topics: [], updatedAt: 1 }];
  stream.tick();
  snapshot = [
    { peerId: PEER_ID, skills: ["calendar.listEvents"], topics: [], updatedAt: 1 },
    { peerId: OTHER_ID, skills: [], topics: [], updatedAt: 2 },
  ];
  stream.tick();
  stream.stop();

  const text = frames.join("");
  assert.equal((text.match(/event: matrix:update/g) ?? []).length, 2);
});
