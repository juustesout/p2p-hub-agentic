import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PluginHost } from "@p2p-hub/core";
import { CoreServer } from "../app";
import { CoreEventBus } from "../events/core-event-bus";
import { logger } from "../logger";
import { registerPalSkills } from "../routes/pal";
import { PALManager } from "./manager";
import { PALRuleStore, palRulesFile } from "./store";

const BOOT_TOKEN = "pal-test-token";

/** A minimal valid rule (shared by the integration tests). */
function validRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "e2e.rule",
    name: "invoice reminder e2e",
    trigger: { type: "invoice", event: "created" },
    where: { amount: { op: "gte", value: 100 } },
    action: {
      type: "propose_task",
      skill: "pale2e.onInvoice",
      payload: { kind: "reminder" },
    },
    ...overrides,
  };
}

async function makeTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "pal-integration-"));
}

/**
 * Write a plugin dir with an ESM entry. The plugin registers `pale2e.emit`
 * (local, emits onto the host's local event bus) and `pale2e.onInvoice`
 * (network-exposed, access-pass-gated, Tier-2 "approved" for agents — the
 * target skill a PAL rule proposes to).
 */
async function writeE2ePlugin(root: string): Promise<void> {
  const dir = path.join(root, "plugins", "pale2e");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify(
      {
        id: "pale2e",
        version: "1.0.0",
        kind: "generic",
        entry: "./index.mjs",
        permissions: ["events:publish", "network:skill:pale2e.onInvoice"],
      },
      null,
      2,
    ),
  );
  await fs.writeFile(
    path.join(dir, "index.mjs"),
    `export default function activate(ctx) {
      const hits = [];
      ctx.skills.register("emit", async (payload) => {
        await ctx.localEvents.publish("invoice:created", payload);
        return { ok: true };
      }, { localOnly: true });
      ctx.skills.register("onInvoice", async (payload, context) => {
        hits.push({ payload, context });
        return { hits: hits.length };
      }, {
        localOnly: false,
        remote: {
          gate: "access-pass",
          scope: "pal-e2e",
          agent: { level: "approved" },
        },
      });
      return { hits };
    }`,
  );
}

// ---------------------------------------------------------------------------
// Store-level: fail-safe hydration, fail-loud corrupt file
// ---------------------------------------------------------------------------

test("PAL store: a corrupt rule is skipped with the [PAL Store] log, valid ones load", async () => {
  const root = await makeTmpRoot();
  const filePath = palRulesFile(path.join(root, "data"));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      rules: [validRule(), { id: "bad id", trigger: {} }],
    }),
  );

  const captured: string[] = [];
  const originalWarn = logger.warn;
  logger.warn = ((msg: unknown) => {
    captured.push(typeof msg === "string" ? msg : String(msg));
  }) as typeof logger.warn;
  try {
    const store = new PALRuleStore({ filePath });
    await store.load();
    assert.deepEqual(
      store.list().map((r) => r.id),
      ["e2e.rule"],
    );
    assert.ok(
      captured.some(
        (line) =>
          line.includes("[PAL Store] Corrupt rule") &&
          line.includes("bad id") &&
          line.includes("skipped"),
      ),
      "the skip must be logged with the exact acceptance-criterion phrase",
    );
  } finally {
    logger.warn = originalWarn;
  }
});

test("PAL store: a duplicate rule id is skipped loudly, not activated twice", async () => {
  const root = await makeTmpRoot();
  const filePath = palRulesFile(path.join(root, "data"));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    JSON.stringify({ version: 1, rules: [validRule(), validRule()] }),
  );

  const captured: string[] = [];
  const originalWarn = logger.warn;
  logger.warn = ((msg: unknown) => {
    captured.push(typeof msg === "string" ? msg : String(msg));
  }) as typeof logger.warn;
  try {
    const store = new PALRuleStore({ filePath });
    await store.load();
    assert.deepEqual(
      store.list().map((r) => r.id),
      ["e2e.rule"],
    );
    assert.ok(captured.some((line) => line.includes("Duplicate rule e2e.rule")));
  } finally {
    logger.warn = originalWarn;
  }
});

test("PAL store: a corrupt rule FILE fails loudly (never silently empty)", async () => {
  const root = await makeTmpRoot();
  const filePath = palRulesFile(path.join(root, "data"));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "{ not json");
  const store = new PALRuleStore({ filePath });
  await assert.rejects(store.load(), /corrupt/i);
});

test("PAL store: add/remove persist atomically and reload", async () => {
  const root = await makeTmpRoot();
  const filePath = palRulesFile(path.join(root, "data"));
  const store = new PALRuleStore({ filePath });
  await store.load();
  assert.deepEqual(store.list(), []);

  await store.add(validRule());
  assert.deepEqual(store.list().map((r) => r.id), ["e2e.rule"]);

  const reloaded = new PALRuleStore({ filePath });
  await reloaded.load();
  assert.deepEqual(reloaded.list().map((r) => r.id), ["e2e.rule"]);

  await assert.rejects(reloaded.add(validRule()), /already exists/);
  await assert.rejects(reloaded.add(validRule({ id: "bad id" })), /"id"/);

  assert.equal(await reloaded.remove("e2e.rule"), true);
  assert.equal(await reloaded.remove("e2e.rule"), false);
  assert.deepEqual(reloaded.list(), []);
});

// ---------------------------------------------------------------------------
// Host-level E2E: plugin emit → rule → TaskBroker dispatch with agent tag
// ---------------------------------------------------------------------------

test("PAL e2e: a plugin's local event triggers a rule whose proposal reaches the skill as agent:pal.<id>", async () => {
  const root = await makeTmpRoot();
  await writeE2ePlugin(root);

  const bus = new CoreEventBus();
  const host = new PluginHost({
    pluginsDir: path.join(root, "plugins"),
    dataDir: path.join(root, "data"),
    // Tier-2 step-up approves every agent-initiated invocation for the test.
    taskApprovalGate: { approveAgentTask: async () => true },
    // The production wiring: plugins publish onto the host's local domain bus.
    localEvents: { publish: (topic, payload) => bus.emit(topic, payload) },
  });
  await host.boot();
  const broker = host.taskBroker();

  const manager = new PALManager({
    store: new PALRuleStore({
      filePath: palRulesFile(path.join(root, "data")),
    }),
    eventBus: bus,
    broker,
    identityManager: host.identityManager(),
  });
  await manager.start();

  // Pre-derive the rule's child identity and grant it the access pass so the
  // skill's remote gate lets the PAL agent caller through. `deriveChildIdentity`
  // is deterministic — the dispatch seam derives the identical peerId.
  const child = await host.identityManager().deriveChildIdentity("pal.e2e.rule");
  host.accessPassManager().issue(child.peerId, "pal-e2e", 60_000);

  await manager.add(validRule());
  const plugin = host.getActivated("pale2e") as { hits: Array<unknown> };
  assert.equal(plugin.hits.length, 0);

  // Matching event → the rule evaluates and proposes → the skill handler runs.
  const emitResult = await broker.handle({
    id: "t1",
    skill: "pale2e.emit",
    payload: { amount: 250, status: "open" },
  });
  assert.equal(emitResult.status, "ok");
  assert.equal(plugin.hits.length, 1, "the rule must have dispatched to the skill");

  const hit = plugin.hits[0] as {
    payload: { kind: string; event: { topic: string; fields: Record<string, unknown> } };
    context: { initiatedBy: string; agentLabel: string };
  };
  assert.equal(hit.context.initiatedBy, "agent");
  assert.equal(hit.context.agentLabel, "pal.e2e.rule");
  assert.equal(hit.payload.kind, "reminder");
  assert.equal(hit.payload.event.topic, "invoice:created");
  assert.deepEqual(hit.payload.event.fields, { amount: 250, status: "open" });

  // Non-matching event → the where-clause filters it; no second dispatch.
  await broker.handle({
    id: "t2",
    skill: "pale2e.emit",
    payload: { amount: 10 },
  });
  assert.equal(plugin.hits.length, 1, "the where-clause must filter non-matching events");

  manager.stop();
});

test("PAL management is local-only: remote peers get an explicit 403-style denial, the local bridge works", async () => {
  const root = await makeTmpRoot();
  await fs.mkdir(path.join(root, "plugins"), { recursive: true });
  const bus = new CoreEventBus();
  const host = new PluginHost({
    pluginsDir: path.join(root, "plugins"),
    dataDir: path.join(root, "data"),
  });
  await host.boot();
  const broker = host.taskBroker();

  const manager = new PALManager({
    store: new PALRuleStore({ filePath: palRulesFile(path.join(root, "data")) }),
    eventBus: bus,
    broker,
    identityManager: host.identityManager(),
  });
  await manager.start();
  registerPalSkills({ broker, getPal: () => manager });

  // The local operator bridge (boot-token gated at the HTTP layer) is the
  // only path that works.
  const local = await broker.handleHttp({
    id: "l1",
    skill: "pal-ui.listRules",
    payload: {},
  });
  assert.equal(local.status, "ok");

  // A network caller invoking the management surface is denied explicitly,
  // before any handler runs.
  const remote = await broker.handleRemote({
    id: "r1",
    skill: "pal-ui.addRule",
    payload: validRule(),
  });
  assert.equal(remote.status, "error");
  assert.match(remote.error ?? "", /local-only and not network-accessible/);
  assert.deepEqual(manager.list(), [], "the denied remote call must not mutate the rule set");

  manager.stop();
});

// ---------------------------------------------------------------------------
// CoreServer-level: HTTP routes, boot-token gate, hydration, fail-safe boot
// ---------------------------------------------------------------------------

async function bootPalServer(dataDir: string): Promise<{ server: CoreServer; port: number }> {
  const server = new CoreServer({
    pluginsDir: path.join(dataDir, "plugins"),
    dataDir,
    host: "127.0.0.1",
    port: 0,
    bootToken: BOOT_TOKEN,
    networking: false,
  });
  await server.start();
  const addr = server.address();
  assert.ok(addr, "server should report its bound address");
  return { server, port: addr.port };
}

const auth = (): Record<string, string> => ({
  Authorization: `Bearer ${BOOT_TOKEN}`,
  "Content-Type": "application/json",
});

const json = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>;

test("core-server: /api/pal/rules lifecycle, boot-token gate, and typed errors", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pal-server-"));
  await fs.mkdir(path.join(dataDir, "plugins"), { recursive: true });
  const { server, port } = await bootPalServer(dataDir);
  const base = `http://127.0.0.1:${port}`;
  try {
    // Boot-token gate: no token → 401 before any handler.
    const noAuth = await fetch(`${base}/api/pal/rules`);
    assert.equal(noAuth.status, 401);

    const empty = await fetch(`${base}/api/pal/rules`, { headers: auth() });
    assert.equal(empty.status, 200);
    assert.deepEqual((await json(empty)).rules, []);

    // Malformed rule → 422, nothing persisted.
    const invalid = await fetch(`${base}/api/pal/rules`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ id: "bad id", trigger: {} }),
    });
    assert.equal(invalid.status, 422);

    // Valid rule → 200 with the normalized rule.
    const created = await fetch(`${base}/api/pal/rules`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify(validRule()),
    });
    assert.equal(created.status, 200);
    const createdBody = await json(created);
    assert.equal(createdBody.ok, true);
    assert.equal((createdBody.rule as { id: string }).id, "e2e.rule");

    // Persisted under the reserved sys.pal.rules namespace.
    await assert.doesNotReject(fs.access(path.join(dataDir, "sys", "pal", "rules.json")));

    // Duplicate → 409.
    const dup = await fetch(`${base}/api/pal/rules`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify(validRule()),
    });
    assert.equal(dup.status, 409);

    const listed = await fetch(`${base}/api/pal/rules`, { headers: auth() });
    const listedBody = (await json(listed)).rules as Array<{ id: string }>;
    assert.deepEqual(listedBody.map((r) => r.id), ["e2e.rule"]);

    // Unknown id → removed:false; real id → removed:true.
    const gone = await fetch(`${base}/api/pal/rules/nope`, {
      method: "DELETE",
      headers: auth(),
    });
    assert.equal((await json(gone)).removed, false);

    const removed = await fetch(`${base}/api/pal/rules/e2e.rule`, {
      method: "DELETE",
      headers: auth(),
    });
    assert.equal((await json(removed)).removed, true);

    const finalList = await fetch(`${base}/api/pal/rules`, { headers: auth() });
    assert.deepEqual((await json(finalList)).rules, []);
  } finally {
    await server.stop();
  }
});

test("core-server: rules hydrate across restart and a corrupt rule never fails boot", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pal-restart-"));
  await fs.mkdir(path.join(dataDir, "plugins"), { recursive: true });

  // First boot: create two rules.
  const { server: server1, port: port1 } = await bootPalServer(dataDir);
  try {
    const post = await fetch(`http://127.0.0.1:${port1}/api/pal/rules`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify(validRule({ id: "keep.rule" })),
    });
    assert.equal(post.status, 200);
    await fetch(`http://127.0.0.1:${port1}/api/pal/rules`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify(validRule({ id: "drop.rule" })),
    });
  } finally {
    await server1.stop();
  }

  // Corrupt one rule on disk by hand (a fail-safe hydration scenario): the
  // file still parses, but one entry is malformed.
  const rulesPath = path.join(dataDir, "sys", "pal", "rules.json");
  const persisted = JSON.parse(await fs.readFile(rulesPath, "utf8")) as {
    version: number;
    rules: Array<Record<string, unknown>>;
  };
  persisted.rules = persisted.rules.filter((r) => r.id !== "drop.rule");
  persisted.rules.push({ id: "broken rule!", trigger: {} });
  await fs.writeFile(rulesPath, JSON.stringify(persisted));

  // Second boot must succeed — the corrupt rule is skipped, not fatal.
  const { server: server2, port: port2 } = await bootPalServer(dataDir);
  try {
    const res = await fetch(`http://127.0.0.1:${port2}/api/pal/rules`, {
      headers: auth(),
    });
    assert.equal(res.status, 200);
    const rules = (await json(res)).rules as Array<{ id: string }>;
    assert.deepEqual(rules.map((r) => r.id), ["keep.rule"]);
  } finally {
    await server2.stop();
  }
});
