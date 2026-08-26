import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskBroker } from "./task-broker";
import { ACCESS_DENIED_ERROR_CODE, type RemoteGate } from "./remote-access";
import type { TaskRequest } from "@p2p-hub/sdk";

function task(overrides: Partial<TaskRequest> = {}): TaskRequest {
  return {
    id: "task-1",
    skill: "demo.echo",
    payload: "hello",
    ...overrides,
  };
}

test("handle routes a task to the registered skill", async () => {
  const broker = new TaskBroker();
  broker.registerSkill("demo.echo", async (payload) => `pong:${String(payload)}`);

  const result = await broker.handle(task());

  assert.equal(result.status, "ok");
  assert.equal(result.result, "pong:hello");
});

test("an unknown skill returns an error result without throwing", async () => {
  const broker = new TaskBroker();

  const result = await broker.handle(task({ skill: "demo.missing" }));

  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /no skill registered for "demo.missing"/);
});

test("a throwing handler is caught and returned as an error result", async () => {
  const broker = new TaskBroker();
  broker.registerSkill("demo.broken", async () => {
    throw new Error("kaboom");
  });

  const result = await broker.handle(task({ skill: "demo.broken" }));

  assert.equal(result.status, "error");
  assert.equal(result.error, "kaboom");
});

test("skills are local-only by default and rejected over the network", async () => {
  const broker = new TaskBroker();
  broker.registerSkill("vault.setSecret", async () => ({ ok: true }));

  const result = await broker.handleRemote(task({ skill: "vault.setSecret" }));

  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /local-only/);
});

test("handleRemote allows skills explicitly opted in to the network", async () => {
  const broker = new TaskBroker();
  broker.registerSkill("calendar.listEvents", async () => [], {
    localOnly: false,
    remote: { gate: "any" },
  });

  const result = await broker.handleRemote(
    task({ skill: "calendar.listEvents" }),
  );

  assert.equal(result.status, "ok");
  assert.deepEqual(result.result, []);
});

test("a local-only skill is still reachable via handle (local callers)", async () => {
  const broker = new TaskBroker();
  broker.registerSkill("vault.setSecret", async (payload) => payload);

  const result = await broker.handle(
    task({ skill: "vault.setSecret", payload: "x" }),
  );

  assert.equal(result.status, "ok");
  assert.equal(result.result, "x");
});

test("skills are NOT HTTP-exposed by default and rejected by handleHttp", async () => {
  const broker = new TaskBroker();
  broker.registerSkill("vault.setSecret", async () => ({ ok: true }));

  const result = await broker.handleHttp(task({ skill: "vault.setSecret" }));

  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /not exposed over the HTTP bridge/);
});

test("handleHttp allows skills explicitly opted in to HTTP exposure", async () => {
  const broker = new TaskBroker();
  broker.registerSkill("calc.recalc", async () => ({ ok: true }), {
    localOnly: true,
    httpExposed: true,
  });

  const result = await broker.handleHttp(task({ skill: "calc.recalc" }));

  assert.equal(result.status, "ok");
  assert.deepEqual(result.result, { ok: true });
});

// ---------------------------------------------------------------------------
// httpBridgeOnly — the local-operator privilege: reachable over the local HTTP
// bridge, structurally never over the network.
// ---------------------------------------------------------------------------

test("httpBridgeOnly skills are reachable over the local HTTP bridge", async () => {
  const broker = new TaskBroker();
  broker.registerSkill("contacts.listContacts", async () => [], {
    httpBridgeOnly: true,
  });

  const result = await broker.handleHttp(task({ skill: "contacts.listContacts" }));

  assert.equal(result.status, "ok");
  assert.deepEqual(result.result, []);
});

test("httpBridgeOnly skills are denied over the network even without an explicit localOnly flag", async () => {
  const broker = new TaskBroker();
  broker.registerSkill("contacts.addContact", async () => ({}), {
    httpBridgeOnly: true,
  });

  const result = await broker.handleRemote(task({ skill: "contacts.addContact" }));

  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /local-only/);
});

test("httpBridgeOnly forces localOnly and httpExposed and drops any remote policy", async () => {
  const broker = new TaskBroker();
  broker.registerSkill("contacts.blockContact", async () => ({}), {
    httpBridgeOnly: true,
  });

  const [listed] = broker.listSkills().filter((s) => s.skill === "contacts.blockContact");
  assert.equal(listed.httpBridgeOnly, true);
  assert.equal(listed.localOnly, true, "httpBridgeOnly must force local-only");
  assert.equal(listed.httpExposed, true, "httpBridgeOnly must imply HTTP exposure");
  assert.equal(listed.remote, undefined, "httpBridgeOnly must drop any remote policy");
});

test("httpBridgeOnly still allows in-process handle (local callers)", async () => {
  const broker = new TaskBroker();
  broker.registerSkill("contacts.removeContact", async (payload) => payload, {
    httpBridgeOnly: true,
  });

  const result = await broker.handle(task({ skill: "contacts.removeContact", payload: { peerId: "x" } }));

  assert.equal(result.status, "ok");
  assert.deepEqual(result.result, { peerId: "x" });
});

test("httpBridgeOnly rejects a contradictory localOnly: false loudly at registration", async () => {
  const broker = new TaskBroker();
  assert.throws(
    () =>
      broker.registerSkill("contacts.bad", async () => ({}), {
        httpBridgeOnly: true,
        localOnly: false,
      }),
    /httpBridgeOnly: true and cannot also set localOnly: false/,
  );
  assert.equal(broker.hasSkill("contacts.bad"), false);
});

test("httpBridgeOnly rejects a contradictory remote policy loudly at registration", async () => {
  const broker = new TaskBroker();
  assert.throws(
    () =>
      broker.registerSkill("contacts.bad", async () => ({}), {
        httpBridgeOnly: true,
        remote: { gate: "any" },
      }),
    /httpBridgeOnly: true and cannot declare a remote access policy/,
  );
  assert.equal(broker.hasSkill("contacts.bad"), false);
});

test("a payload nested deeper than MAX_OBJECT_DEPTH is rejected, not thrown", async () => {
  const broker = new TaskBroker();
  broker.registerSkill("demo.echo", async (payload) => payload);

  let deep: unknown = "leaf";
  for (let i = 0; i < 11; i++) {
    deep = { child: deep };
  }

  const result = await broker.handle(task({ skill: "demo.echo", payload: deep }));

  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /nesting depth/);
});

test("a payload exceeding MAX_PAYLOAD_BYTES is rejected, not thrown", async () => {
  const broker = new TaskBroker();
  broker.registerSkill("demo.echo", async (payload) => payload);

  const oversized = "x".repeat(256 * 1024 + 1);
  const result = await broker.handle(
    task({ skill: "demo.echo", payload: oversized }),
  );

  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /exceeding/);
});

test("a task arriving while the broker is at capacity is rejected, not queued", async () => {
  const broker = new TaskBroker({ maxConcurrentTasks: 1 });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  broker.registerSkill("demo.slow", async () => {
    await gate;
    return "done";
  });

  const first = broker.handle(task({ id: "first", skill: "demo.slow" }));
  const second = await broker.handle(task({ id: "second", skill: "demo.slow" }));

  assert.equal(second.status, "error");
  assert.match(second.error ?? "", /at capacity/);

  release();
  const firstResult = await first;
  assert.equal(firstResult.status, "ok");
  assert.equal(firstResult.result, "done");
});

// ---------------------------------------------------------------------------
// Fase 2A — platform-enforced remote access policy
// ---------------------------------------------------------------------------

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

function gate(overrides: Partial<RemoteGate> = {}): RemoteGate {
  return {
    isVerifiedContact: async () => false,
    hasValidAccessPass: async () => false,
    ...overrides,
  };
}

test("2A: a network-exposed skill WITHOUT a remote policy is denied (fail-closed)", async () => {
  const broker = new TaskBroker();
  broker.registerSkill("sloppy.read", async () => "data", {
    localOnly: false,
  });

  const result = await broker.handleRemote(
    task({ skill: "sloppy.read", peerId: ALICE }),
  );

  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /not authorized/);
});

test("2A: localOnly:false + remote policy is required; an empty gate list is rejected at registration", async () => {
  const broker = new TaskBroker();
  assert.throws(
    () =>
      broker.registerSkill("demo.deny", async () => "data", {
        localOnly: false,
        remote: { gate: [] },
      }),
    /must name at least one gate/,
  );
});

test("2A: verified-contact gate allows a verified peer and denies an unknown one", async () => {
  const broker = new TaskBroker({
    remoteGate: gate({
      isVerifiedContact: async (peerId) => peerId === ALICE,
    }),
  });
  broker.registerSkill("peersite.read", async () => "data", {
    localOnly: false,
    remote: { gate: "verified-contact" },
  });

  const allowed = await broker.handleRemote(
    task({ skill: "peersite.read", peerId: ALICE }),
  );
  const denied = await broker.handleRemote(
    task({ skill: "peersite.read", peerId: BOB }),
  );

  assert.equal(allowed.status, "ok");
  assert.equal(allowed.result, "data");
  assert.equal(denied.status, "error");
  assert.match(denied.error ?? "", /not authorized/);
});

test("2A: verified-contact gate denies an anonymous (no peerId) caller", async () => {
  const broker = new TaskBroker({
    remoteGate: gate({ isVerifiedContact: async () => true }),
  });
  broker.registerSkill("peersite.read", async () => "data", {
    localOnly: false,
    remote: { gate: "verified-contact" },
  });

  const result = await broker.handleRemote(task({ skill: "peersite.read" }));

  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /not authorized/);
});

test("2A: verified-contact gate denies when no RemoteGate is injected (can't prove)", async () => {
  const broker = new TaskBroker();
  broker.registerSkill("peersite.read", async () => "data", {
    localOnly: false,
    remote: { gate: "verified-contact" },
  });

  const result = await broker.handleRemote(
    task({ skill: "peersite.read", peerId: ALICE }),
  );

  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /not authorized/);
});

test("2A: access-pass gate allows a pass holder in the required scope", async () => {
  const broker = new TaskBroker({
    remoteGate: gate({
      hasValidAccessPass: async (peerId, scope) =>
        peerId === ALICE && scope === "site-read-only",
    }),
  });
  broker.registerSkill("peersite.fetchAsset", async () => "asset", {
    localOnly: false,
    remote: { gate: "access-pass", scope: "site-read-only" },
  });

  const allowed = await broker.handleRemote(
    task({ skill: "peersite.fetchAsset", peerId: ALICE }),
  );
  const wrongScope = await broker.handleRemote(
    task({ skill: "peersite.fetchAsset", peerId: BOB }),
  );

  assert.equal(allowed.status, "ok");
  assert.equal(allowed.result, "asset");
  assert.equal(wrongScope.status, "error");
  assert.match(wrongScope.error ?? "", /not authorized/);
});

test("2A: access-pass gate without a scope is rejected at registration", async () => {
  const broker = new TaskBroker();
  assert.throws(
    () =>
      broker.registerSkill("peersite.fetchAsset", async () => "asset", {
        localOnly: false,
        remote: { gate: "access-pass" },
      }),
    /requires a "scope"/,
  );
});

test("2A: multiple gates are OR-ed (contact or pass holder both allowed)", async () => {
  const broker = new TaskBroker({
    remoteGate: gate({
      isVerifiedContact: async (peerId) => peerId === ALICE,
      hasValidAccessPass: async (peerId, scope) =>
        peerId === BOB && scope === "site-read-only",
    }),
  });
  broker.registerSkill("peersite.fetchAsset", async () => "asset", {
    localOnly: false,
    remote: { gate: ["verified-contact", "access-pass"], scope: "site-read-only" },
  });

  const asContact = await broker.handleRemote(
    task({ skill: "peersite.fetchAsset", peerId: ALICE }),
  );
  const asPassHolder = await broker.handleRemote(
    task({ skill: "peersite.fetchAsset", peerId: BOB }),
  );
  const stranger = await broker.handleRemote(
    task({ skill: "peersite.fetchAsset", peerId: "c".repeat(64) }),
  );

  assert.equal(asContact.status, "ok");
  assert.equal(asPassHolder.status, "ok");
  assert.equal(stranger.status, "error");
});

test("2A: any gate allows any remote caller, even without a RemoteGate", async () => {
  const broker = new TaskBroker();
  broker.registerSkill("contacts.signChallenge", async () => "sig", {
    localOnly: false,
    remote: { gate: "any" },
  });

  const result = await broker.handleRemote(task({ skill: "contacts.signChallenge" }));

  assert.equal(result.status, "ok");
  assert.equal(result.result, "sig");
});

test("2A: the handler receives the transport-verified peerId in its context", async () => {
  const broker = new TaskBroker({ remoteGate: gate() });
  broker.registerSkill("demo.whoami", async (_payload, ctx) => {
    return { seen: ctx?.peerId };
  }, { localOnly: false, remote: { gate: "any" } });

  const remote = await broker.handleRemote(
    task({ skill: "demo.whoami", peerId: ALICE }),
  );
  const local = await broker.handle(task({ skill: "demo.whoami" }));

  assert.equal(remote.status, "ok");
  assert.deepEqual(remote.result, { seen: ALICE });
  assert.equal(local.status, "ok");
  assert.deepEqual(local.result, { seen: undefined });
});

test("2A: a throwing RemoteGate denies rather than opening the door", async () => {
  const broker = new TaskBroker({
    remoteGate: gate({
      isVerifiedContact: async () => {
        throw new Error("gate exploded");
      },
    }),
  });
  broker.registerSkill("peersite.read", async () => "data", {
    localOnly: false,
    remote: { gate: "verified-contact" },
  });

  const result = await broker.handleRemote(
    task({ skill: "peersite.read", peerId: ALICE }),
  );

  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /not authorized/);
});

// ---------------------------------------------------------------------------
// A1/Slice 2 — agent escalation matrix (plan.md: gelaagde agent policy)
// ---------------------------------------------------------------------------

const OPERATOR = "f".repeat(64);
const AGENT_LABEL = "alice";
const AGENT = "e".repeat(64);
const AGENT2 = "d".repeat(64);

function agentGate(labelFor: string): import("./remote-access").AgentGate {
  return {
    resolveAgentLabel: async (peerId) =>
      peerId === AGENT || peerId === AGENT2 ? labelFor : null,
  };
}

function approvalGate(decision: boolean): import("./remote-access").TaskApprovalGate {
  return { approveAgentTask: async () => decision };
}

test("A1: an agent caller can never pass the 'any' gate (public path closed)", async () => {
  const broker = new TaskBroker({ agentGate: agentGate(AGENT_LABEL) });
  broker.registerSkill("contacts.signChallenge", async () => "sig", {
    localOnly: false,
    remote: { gate: "any" },
  });

  const agent = await broker.handleRemote(
    task({ skill: "contacts.signChallenge", peerId: AGENT }),
  );
  const operator = await broker.handleRemote(
    task({ skill: "contacts.signChallenge", peerId: OPERATOR }),
  );

  assert.equal(agent.status, "error");
  assert.match(agent.error ?? "", /not authorized/);
  assert.equal(operator.status, "ok");
});

test("A1: 'any' is skipped for agents but an OR-ed stricter gate still applies", async () => {
  const broker = new TaskBroker({
    agentGate: agentGate(AGENT_LABEL),
    remoteGate: gate({ isVerifiedContact: async (peerId) => peerId === AGENT }),
  });
  broker.registerSkill("peersite.read", async () => "data", {
    localOnly: false,
    remote: {
      gate: ["any", "verified-contact"],
      agent: { level: "telemetry" },
    },
  });

  const asContact = await broker.handleRemote(
    task({ skill: "peersite.read", peerId: AGENT }),
  );
  const agentNotAContact = await broker.handleRemote(
    task({ skill: "peersite.read", peerId: AGENT2 }),
  );

  assert.equal(asContact.status, "ok");
  assert.equal(agentNotAContact.status, "error");
});

test("A1: telemetry level (Tier 1) lets an agent through on the normal gate", async () => {
  const seen: unknown[] = [];
  const broker = new TaskBroker({
    agentGate: agentGate(AGENT_LABEL),
    remoteGate: gate({ isVerifiedContact: async (peerId) => peerId === AGENT }),
  });
  broker.registerSkill("telemetry.vitals", async (_p, ctx) => {
    seen.push(ctx);
    return "ok";
  }, {
    localOnly: false,
    remote: {
      gate: "verified-contact",
      agent: { level: "telemetry" },
    },
  });

  const result = await broker.handleRemote(
    task({ skill: "telemetry.vitals", peerId: AGENT }),
  );

  assert.equal(result.status, "ok");
  assert.deepEqual(seen[0], {
    peerId: AGENT,
    initiatedBy: "agent",
    agentLabel: AGENT_LABEL,
  });
});

test("A1: approved level (Tier 2, default) without a confirmer fails closed", async () => {
  const broker = new TaskBroker({
    agentGate: agentGate(AGENT_LABEL),
    remoteGate: gate({ isVerifiedContact: async (peerId) => peerId === AGENT }),
  });
  broker.registerSkill("mail.send", async () => "sent", {
    localOnly: false,
    remote: { gate: "verified-contact" },
  });

  const result = await broker.handleRemote(
    task({ skill: "mail.send", peerId: AGENT }),
  );

  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /not authorized/);
});

test("A1: approved level approves the task when the operator confirms", async () => {
  const requests: unknown[] = [];
  const broker = new TaskBroker({
    agentGate: agentGate(AGENT_LABEL),
    remoteGate: gate({ isVerifiedContact: async (peerId) => peerId === AGENT }),
    taskApprovalGate: {
      approveAgentTask: async (request) => {
        requests.push(request);
        return true;
      },
    },
  });
  broker.registerSkill("mail.send", async () => "sent", {
    localOnly: false,
    remote: { gate: "verified-contact", agent: { level: "approved" } },
  });

  const result = await broker.handleRemote(
    task({ id: "task-9", skill: "mail.send", peerId: AGENT }),
  );

  assert.equal(result.status, "ok");
  assert.equal(result.result, "sent");
  assert.deepEqual(requests[0], {
    taskId: "task-9",
    skill: "mail.send",
    agentLabel: AGENT_LABEL,
    peerId: AGENT,
  });
});

test("A1: approved level refuses when the operator denies the task", async () => {
  const broker = new TaskBroker({
    agentGate: agentGate(AGENT_LABEL),
    remoteGate: gate({ isVerifiedContact: async (peerId) => peerId === AGENT }),
    taskApprovalGate: approvalGate(false),
  });
  broker.registerSkill("mail.send", async () => "sent", {
    localOnly: false,
    remote: { gate: "verified-contact" },
  });

  const result = await broker.handleRemote(
    task({ skill: "mail.send", peerId: AGENT }),
  );

  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /not authorized/);
});

test("A1: a throwing approval gate denies (fail-closed)", async () => {
  const broker = new TaskBroker({
    agentGate: agentGate(AGENT_LABEL),
    remoteGate: gate({ isVerifiedContact: async (peerId) => peerId === AGENT }),
    taskApprovalGate: {
      approveAgentTask: async () => {
        throw new Error("prompt exploded");
      },
    },
  });
  broker.registerSkill("mail.send", async () => "sent", {
    localOnly: false,
    remote: { gate: "verified-contact" },
  });

  const result = await broker.handleRemote(
    task({ skill: "mail.send", peerId: AGENT }),
  );

  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /not authorized/);
});

test("A1: never level (Tier 3) hard-refuses an agent even with a passing gate", async () => {
  const broker = new TaskBroker({
    agentGate: agentGate(AGENT_LABEL),
    remoteGate: gate({ isVerifiedContact: async (peerId) => peerId === AGENT }),
  });
  broker.registerSkill("vault.read", async () => "secret", {
    localOnly: false,
    remote: { gate: "verified-contact", agent: { level: "never" } },
  });

  const result = await broker.handleRemote(
    task({ skill: "vault.read", peerId: AGENT }),
  );

  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /not authorized/);
});

test("A1: the agent level never escalates a non-agent remote caller", async () => {
  const broker = new TaskBroker({
    agentGate: agentGate(AGENT_LABEL),
    remoteGate: gate({ isVerifiedContact: async (peerId) => peerId === OPERATOR }),
  });
  broker.registerSkill("vault.read", async () => "secret", {
    localOnly: false,
    remote: { gate: "verified-contact", agent: { level: "never" } },
  });

  const result = await broker.handleRemote(
    task({ skill: "vault.read", peerId: OPERATOR }),
  );

  assert.equal(result.status, "ok");
  assert.equal(result.result, "secret");
});

test("A1: a non-agent remote caller gets initiatedBy 'operator'", async () => {
  const seen: unknown[] = [];
  const broker = new TaskBroker({
    agentGate: agentGate(AGENT_LABEL),
    remoteGate: gate({ isVerifiedContact: async (peerId) => peerId === OPERATOR }),
  });
  broker.registerSkill("demo.whoami", async (_p, ctx) => {
    seen.push(ctx);
    return "ok";
  }, { localOnly: false, remote: { gate: "verified-contact" } });

  const result = await broker.handleRemote(
    task({ skill: "demo.whoami", peerId: OPERATOR }),
  );

  assert.equal(result.status, "ok");
  assert.deepEqual(seen[0], { peerId: OPERATOR, initiatedBy: "operator" });
});

test("A1: a remote policy with an unknown agent level is rejected at registration", async () => {
  const broker = new TaskBroker();
  assert.throws(
    () =>
      broker.registerSkill("demo.x", async () => "x", {
        localOnly: false,
        remote: {
          gate: "verified-contact",
          agent: { level: "root" as "telemetry" },
        },
      }),
    /agent" level must be one of "telemetry", "approved", "never"/,
  );
});

test("A1: a throwing AgentGate reads as 'not an agent' (base gate still applies)", async () => {
  const broker = new TaskBroker({
    agentGate: {
      resolveAgentLabel: async () => {
        throw new Error("registry exploded");
      },
    },
    remoteGate: gate({ isVerifiedContact: async (peerId) => peerId === OPERATOR }),
  });
  broker.registerSkill("peersite.read", async () => "data", {
    localOnly: false,
    remote: { gate: "verified-contact" },
  });

  const operator = await broker.handleRemote(
    task({ skill: "peersite.read", peerId: OPERATOR }),
  );
  const stranger = await broker.handleRemote(
    task({ skill: "peersite.read", peerId: AGENT }),
  );

  assert.equal(operator.status, "ok");
  assert.equal(stranger.status, "error");
});

// ---------------------------------------------------------------------------
// A1/Slice 4 — capability type split + per-peer telemetry frequency caps
// ---------------------------------------------------------------------------

const TELEMETRY_CONFIG = { windowMs: 1000, maxCalls: 2 };

test("A1/Slice 4: a telemetry capability is rate-limited per peer with a typed error", async () => {
  const broker = new TaskBroker({ telemetryRateLimit: TELEMETRY_CONFIG });
  broker.registerSkill("telemetry.status", async () => ({ ok: true }), {
    localOnly: false,
    remote: { gate: "any" },
    capabilityType: "telemetry",
  });

  const first = await broker.handleRemote(task({ skill: "telemetry.status", peerId: ALICE }));
  const second = await broker.handleRemote(task({ skill: "telemetry.status", peerId: ALICE }));
  const third = await broker.handleRemote(task({ skill: "telemetry.status", peerId: ALICE }));

  assert.equal(first.status, "ok");
  assert.equal(second.status, "ok");
  assert.equal(third.status, "error");
  assert.equal(third.code, "telemetry-rate-limit");
  assert.match(third.error ?? "", /telemetry rate limit exceeded/);
});

test("A1/Slice 4: telemetry budgets are independent per peer", async () => {
  const broker = new TaskBroker({ telemetryRateLimit: TELEMETRY_CONFIG });
  broker.registerSkill("telemetry.status", async () => ({ ok: true }), {
    localOnly: false,
    remote: { gate: "any" },
    capabilityType: "telemetry",
  });

  await broker.handleRemote(task({ skill: "telemetry.status", peerId: ALICE }));
  await broker.handleRemote(task({ skill: "telemetry.status", peerId: ALICE }));
  const aliceBlocked = await broker.handleRemote(
    task({ skill: "telemetry.status", peerId: ALICE }),
  );
  const bobFirst = await broker.handleRemote(task({ skill: "telemetry.status", peerId: BOB }));

  assert.equal(aliceBlocked.status, "error");
  assert.equal(aliceBlocked.code, "telemetry-rate-limit");
  assert.equal(bobFirst.status, "ok");
});

test("A1/Slice 4: an action capability is never rate-limited", async () => {
  const broker = new TaskBroker({ telemetryRateLimit: { windowMs: 1000, maxCalls: 1 } });
  broker.registerSkill("action.write", async () => "ok", {
    localOnly: false,
    remote: { gate: "any" },
    capabilityType: "action",
  });

  for (let i = 0; i < 10; i++) {
    const result = await broker.handleRemote(task({ skill: "action.write", peerId: ALICE }));
    assert.equal(result.status, "ok");
  }
});

test("A1/Slice 4: an undeclared capability type defaults to action (fail-closed, not rate-limited)", async () => {
  const broker = new TaskBroker({ telemetryRateLimit: { windowMs: 1000, maxCalls: 1 } });
  broker.registerSkill("sloppy.noType", async () => "ok", {
    localOnly: false,
    remote: { gate: "any" },
  });

  for (let i = 0; i < 5; i++) {
    const result = await broker.handleRemote(task({ skill: "sloppy.noType", peerId: ALICE }));
    assert.equal(result.status, "ok");
  }
});

test("A1/Slice 4: an invalid capabilityType value is treated as action (fail-closed)", async () => {
  const broker = new TaskBroker({ telemetryRateLimit: { windowMs: 1000, maxCalls: 1 } });
  broker.registerSkill("sloppy.wrongType", async () => "ok", {
    localOnly: false,
    remote: { gate: "any" },
    capabilityType: "stream" as "telemetry",
  });

  for (let i = 0; i < 5; i++) {
    const result = await broker.handleRemote(task({ skill: "sloppy.wrongType", peerId: ALICE }));
    assert.equal(result.status, "ok");
  }
});

test("A1/Slice 4: a denied telemetry caller never consumes the peer's budget", async () => {
  const broker = new TaskBroker({
    telemetryRateLimit: { windowMs: 1000, maxCalls: 1 },
    remoteGate: gate({ isVerifiedContact: async (peerId) => peerId === ALICE }),
  });
  broker.registerSkill("telemetry.vitals", async () => "vitals", {
    localOnly: false,
    remote: { gate: "verified-contact" },
    capabilityType: "telemetry",
  });

  // BOB is denied by the gate — this must NOT consume ALICE's budget.
  const denied = await broker.handleRemote(task({ skill: "telemetry.vitals", peerId: BOB }));
  assert.equal(denied.status, "error");
  assert.equal(denied.code, undefined);
  assert.match(denied.error ?? "", /not authorized/);

  const allowed = await broker.handleRemote(task({ skill: "telemetry.vitals", peerId: ALICE }));
  const blocked = await broker.handleRemote(task({ skill: "telemetry.vitals", peerId: ALICE }));

  assert.equal(allowed.status, "ok");
  assert.equal(blocked.status, "error");
  assert.equal(blocked.code, "telemetry-rate-limit");
});

test("A1/Slice 4: telemetry without a remote policy is still denied (gate beats rate limit)", async () => {
  const broker = new TaskBroker({ telemetryRateLimit: TELEMETRY_CONFIG });
  broker.registerSkill("telemetry.noPolicy", async () => "data", {
    localOnly: false,
    capabilityType: "telemetry",
  });

  const result = await broker.handleRemote(task({ skill: "telemetry.noPolicy", peerId: ALICE }));

  assert.equal(result.status, "error");
  assert.equal(result.code, undefined);
  assert.match(result.error ?? "", /not authorized/);
});

test("A1/Slice 4: anonymous remote callers share one telemetry budget", async () => {
  const broker = new TaskBroker({ telemetryRateLimit: { windowMs: 1000, maxCalls: 1 } });
  broker.registerSkill("telemetry.ping", async () => "pong", {
    localOnly: false,
    remote: { gate: "any" },
    capabilityType: "telemetry",
  });

  const first = await broker.handleRemote(task({ skill: "telemetry.ping" }));
  const second = await broker.handleRemote(task({ skill: "telemetry.ping" }));

  assert.equal(first.status, "ok");
  assert.equal(second.status, "error");
  assert.equal(second.code, "telemetry-rate-limit");
});

test("A1/Slice 4: listSkills exposes the capability type", async () => {
  const broker = new TaskBroker();
  broker.registerSkill("telemetry.status", async () => ({}), {
    localOnly: false,
    remote: { gate: "any" },
    capabilityType: "telemetry",
  });
  broker.registerSkill("action.write", async () => ({}));

  const listed = broker.listSkills().sort((a, b) => a.skill.localeCompare(b.skill));
  assert.deepEqual(
    listed.map((s) => ({ skill: s.skill, capabilityType: s.capabilityType })),
    [
      { skill: "action.write", capabilityType: "action" },
      { skill: "telemetry.status", capabilityType: "telemetry" },
    ],
  );
});

// ---------------------------------------------------------------------------
// Deel 1 — broker-wide per-peer rate limiting on the network path
// ---------------------------------------------------------------------------

const PEER_RATE_CONFIG = { windowMs: 1000, maxTasks: 2 };

test("Deel 1: a peer over its per-minute task budget gets a typed error result", async () => {
  const broker = new TaskBroker({ peerRateLimit: PEER_RATE_CONFIG });
  broker.registerSkill("demo.echo", async () => "ok", {
    localOnly: false,
    remote: { gate: "any" },
  });

  const first = await broker.handleRemote(task({ skill: "demo.echo", peerId: ALICE }));
  const second = await broker.handleRemote(task({ skill: "demo.echo", peerId: ALICE }));
  const third = await broker.handleRemote(task({ skill: "demo.echo", peerId: ALICE }));

  assert.equal(first.status, "ok");
  assert.equal(second.status, "ok");
  assert.equal(third.status, "error");
  assert.equal(third.code, "peer-rate-limit");
  assert.match(third.error ?? "", /per-minute network task budget/);
});

test("Deel 1: budgets are independent per peer", async () => {
  const broker = new TaskBroker({ peerRateLimit: PEER_RATE_CONFIG });
  broker.registerSkill("demo.echo", async () => "ok", {
    localOnly: false,
    remote: { gate: "any" },
  });

  await broker.handleRemote(task({ skill: "demo.echo", peerId: ALICE }));
  await broker.handleRemote(task({ skill: "demo.echo", peerId: ALICE }));
  const aliceBlocked = await broker.handleRemote(
    task({ skill: "demo.echo", peerId: ALICE }),
  );
  const bobFirst = await broker.handleRemote(task({ skill: "demo.echo", peerId: BOB }));

  assert.equal(aliceBlocked.status, "error");
  assert.equal(aliceBlocked.code, "peer-rate-limit");
  assert.equal(bobFirst.status, "ok");
});

test("Deel 1: all skills share one per-peer budget", async () => {
  const broker = new TaskBroker({ peerRateLimit: PEER_RATE_CONFIG });
  broker.registerSkill("demo.one", async () => "ok", {
    localOnly: false,
    remote: { gate: "any" },
  });
  broker.registerSkill("demo.two", async () => "ok", {
    localOnly: false,
    remote: { gate: "any" },
  });

  const one = await broker.handleRemote(task({ skill: "demo.one", peerId: ALICE }));
  const two = await broker.handleRemote(task({ skill: "demo.two", peerId: ALICE }));
  const blocked = await broker.handleRemote(task({ skill: "demo.one", peerId: ALICE }));

  assert.equal(one.status, "ok");
  assert.equal(two.status, "ok");
  assert.equal(blocked.status, "error");
  assert.equal(blocked.code, "peer-rate-limit");
});

test("Deel 1: local handle() calls are never rate-limited", async () => {
  const broker = new TaskBroker({ peerRateLimit: PEER_RATE_CONFIG });
  broker.registerSkill("vault.write", async () => "ok");

  for (let i = 0; i < 20; i++) {
    const result = await broker.handle(task({ skill: "vault.write" }));
    assert.equal(result.status, "ok");
  }
});

test("Deel 1: HTTP-bridge calls are never rate-limited", async () => {
  const broker = new TaskBroker({ peerRateLimit: PEER_RATE_CONFIG });
  broker.registerSkill("calc.add", async () => "ok", {
    localOnly: true,
    httpExposed: true,
  });

  for (let i = 0; i < 20; i++) {
    const result = await broker.handleHttp(task({ skill: "calc.add" }));
    assert.equal(result.status, "ok");
  }
});

test("Deel 1: a denied caller never consumes the peer's budget", async () => {
  const broker = new TaskBroker({
    peerRateLimit: PEER_RATE_CONFIG,
    remoteGate: gate({ isVerifiedContact: async (peerId) => peerId === ALICE }),
  });
  broker.registerSkill("demo.read", async () => "data", {
    localOnly: false,
    remote: { gate: "verified-contact" },
  });

  const denied = await broker.handleRemote(task({ skill: "demo.read", peerId: BOB }));
  assert.equal(denied.status, "error");
  assert.equal(denied.code, undefined);
  assert.match(denied.error ?? "", /not authorized/);

  const first = await broker.handleRemote(task({ skill: "demo.read", peerId: ALICE }));
  const second = await broker.handleRemote(task({ skill: "demo.read", peerId: ALICE }));
  const blocked = await broker.handleRemote(task({ skill: "demo.read", peerId: ALICE }));

  assert.equal(first.status, "ok");
  assert.equal(second.status, "ok");
  assert.equal(blocked.status, "error");
  assert.equal(blocked.code, "peer-rate-limit");
});

test("Deel 1: anonymous remote callers share one budget", async () => {
  const broker = new TaskBroker({ peerRateLimit: PEER_RATE_CONFIG });
  broker.registerSkill("demo.ping", async () => "pong", {
    localOnly: false,
    remote: { gate: "any" },
  });

  const first = await broker.handleRemote(task({ skill: "demo.ping" }));
  const second = await broker.handleRemote(task({ skill: "demo.ping" }));
  const blocked = await broker.handleRemote(task({ skill: "demo.ping" }));

  assert.equal(first.status, "ok");
  assert.equal(second.status, "ok");
  assert.equal(blocked.status, "error");
  assert.equal(blocked.code, "peer-rate-limit");
});

test("Deel 1: the window slides and frees the budget again", async () => {
  const broker = new TaskBroker({ peerRateLimit: PEER_RATE_CONFIG });
  broker.registerSkill("demo.echo", async () => "ok", {
    localOnly: false,
    remote: { gate: "any" },
  });

  await broker.handleRemote(task({ skill: "demo.echo", peerId: ALICE }));
  await broker.handleRemote(task({ skill: "demo.echo", peerId: ALICE }));
  const blocked = await broker.handleRemote(task({ skill: "demo.echo", peerId: ALICE }));
  assert.equal(blocked.code, "peer-rate-limit");
});

test("Deel 1: hasRateLimiting is true by default (network tasks always budgeted)", () => {
  const broker = new TaskBroker();
  assert.equal(broker.hasRateLimiting(), true);
});

test("Stap 6: the permission matrix narrows a peer to its listed skills (and never widens)", async () => {
  const broker = new TaskBroker();
  // An allowlist matrix: ALICE may only call calendar.listEvents.
  broker.setPeerSkillGate({
    isAllowed: async (peerId, skill) =>
      peerId === ALICE ? skill === "calendar.listEvents" : true,
  });
  broker.registerSkill("calendar.listEvents", async () => [], {
    localOnly: false,
    remote: { gate: "any" },
  });
  broker.registerSkill("calendar.addEvent", async () => ({ ok: true }), {
    localOnly: false,
    remote: { gate: "any" },
  });

  // ALICE's listed skill is allowed.
  const allowed = await broker.handleRemote(
    task({ skill: "calendar.listEvents", peerId: ALICE }),
  );
  assert.equal(allowed.status, "ok");

  // A skill the matrix does not list is denied with the typed code — even
  // though the manifest/remote policy would allow it (this is the narrowing).
  const denied = await broker.handleRemote(
    task({ skill: "calendar.addEvent", peerId: ALICE }),
  );
  assert.equal(denied.status, "error");
  assert.equal(denied.code, ACCESS_DENIED_ERROR_CODE);
  assert.match(denied.error ?? "", /permission matrix/);

  // A peer WITHOUT a matrix entry keeps the manifest default.
  const bobAllowed = await broker.handleRemote(
    task({ skill: "calendar.addEvent", peerId: BOB }),
  );
  assert.equal(bobAllowed.status, "ok");
});

test("Stap 6: the matrix cannot widen a skill the manifest does not expose", async () => {
  const broker = new TaskBroker();
  // Even if a matrix entry (mis)listed a local-only skill, the broker's own
  // exposure check still denies — the intersection invariant.
  broker.setPeerSkillGate({
    isAllowed: async (peerId) => peerId === ALICE,
  });
  broker.registerSkill("vault.setSecret", async () => ({ ok: true }));

  const result = await broker.handleRemote(
    task({ skill: "vault.setSecret", peerId: ALICE }),
  );

  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /local-only/);
});

test("Stap 6: a throwing matrix gate denies (fail-closed), never opens the door", async () => {
  const broker = new TaskBroker();
  broker.setPeerSkillGate({
    isAllowed: async () => {
      throw new Error("matrix unreadable");
    },
  });
  broker.registerSkill("calendar.listEvents", async () => [], {
    localOnly: false,
    remote: { gate: "any" },
  });

  const result = await broker.handleRemote(
    task({ skill: "calendar.listEvents", peerId: ALICE }),
  );

  assert.equal(result.status, "error");
  assert.equal(result.code, ACCESS_DENIED_ERROR_CODE);
});

test("Stap 6: an anonymous caller is never narrowed by the matrix (no peerId)", async () => {
  const broker = new TaskBroker();
  broker.setPeerSkillGate({
    isAllowed: async () => {
      throw new Error("should not be consulted");
    },
  });
  broker.registerSkill("contacts.signChallenge", async () => ({ ok: true }), {
    localOnly: false,
    remote: { gate: "any" },
  });

  // No transport-verified peerId → the matrix is not consulted; the public
  // path stays reachable (a peer must be able to prove possession before it
  // can be granted contact/pass status).
  const result = await broker.handleRemote(
    task({ skill: "contacts.signChallenge" }),
  );
  assert.equal(result.status, "ok");
});
