import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { NetworkPeer, NetworkProvider, TaskRequest } from "@p2p-hub/sdk";
import { VaultManager } from "../storage/vault-manager";
import { IdentityManager } from "../identity/identity-manager";
import { TaskBroker } from "../task-broker/task-broker";
import type { ConfirmationRequest } from "../security/trust-gate";
import { AgentRuntime } from "./agent-runtime";

const PEER: NetworkPeer = {
  id: "peer-1",
  address: "127.0.0.1:9000",
  skills: ["mail.send"],
};

async function makeVault(): Promise<VaultManager> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-runtime-"));
  return new VaultManager({ dataDir, masterKey: "test-master" });
}

/** A child signer built from the vault's child PEM — the core-only path. */
async function childSignerFor(
  vault: VaultManager,
  label: string,
): Promise<(data: Buffer) => Promise<Buffer>> {
  const pem = await vault.getSecret(`identity.agent.${label}.privateKey`);
  assert.ok(pem, `child private key for "${label}" must exist in the vault`);
  const key = crypto.createPrivateKey(pem);
  return async (data: Buffer) => crypto.sign(null, data, key);
}

/** Minimal transport stub; the agent's signer lives here, nowhere else. */
function providerStub(
  partial: Partial<NetworkProvider> = {},
): NetworkProvider {
  return {
    id: "fake-agent-provider",
    priority: 0,
    canTransportTasks: true,
    start: async () => {},
    stop: async () => {},
    isReady: () => true,
    discover: async () => [],
    sendTask: async (_peer, task) => ({
      taskId: task.id,
      status: "ok",
      result: "sent",
    }),
    onTask: () => {},
    ...partial,
  };
}

test("AgentRuntime.peerId() returns the child peerId, not the operator's, stable across restarts", async () => {
  const vault = await makeVault();
  const manager = new IdentityManager({ vault });
  const operator = await manager.getOrCreateIdentity();
  const child = await manager.deriveChildIdentity("agent-restart");

  assert.notEqual(child.peerId, operator.peerId);
  assert.equal(child.peerId.length, 64);

  const make = async () => {
    // The child identity is deterministic (Slice 1 HKDF): a brand-new
    // IdentityManager on the same vault resolves the same child peerId, so a
    // "restarted" AgentRuntime reports the same identity with no registry.
    const fresh = new IdentityManager({ vault });
    const again = await fresh.deriveChildIdentity("agent-restart");
    const provider = providerStub();
    return new AgentRuntime({
      label: "agent-restart",
      identity: again,
      networkProvider: provider,
      confirmation: { confirmTier2: async () => true },
      broker: new TaskBroker(),
    });
  };

  const first = await make();
  const restarted = await make();

  assert.equal(first.peerId(), child.peerId);
  assert.equal(restarted.peerId(), first.peerId());
  assert.notEqual(first.peerId(), operator.peerId);
  // A different label is a different agent identity.
  const other = await manager.deriveChildIdentity("agent-other");
  assert.notEqual(other.peerId, first.peerId());
});

test("a task dispatched by an AgentRuntime carries initiator: agent:<label> into confirmTier2", async () => {
  const vault = await makeVault();
  const manager = new IdentityManager({ vault });
  const child = await manager.deriveChildIdentity("agent-a");

  const confirmations: ConfirmationRequest[] = [];
  const sent: TaskRequest[] = [];
  const broker = new TaskBroker();
  broker.registerSkill("mail.send", async () => "sent", {
    localOnly: false,
    remote: { gate: "verified-contact", agent: { level: "approved" } },
  });

  const runtime = new AgentRuntime({
    label: "agent-a",
    identity: child,
    networkProvider: providerStub({
      sendTask: async (_peer, task) => {
        sent.push(task);
        return { taskId: task.id, status: "ok", result: "sent" };
      },
    }),
    confirmation: {
      confirmTier2: async (request) => {
        confirmations.push(request);
        return true;
      },
    },
    broker,
  });

  const result = await runtime.sendTask(PEER, {
    skill: "mail.send",
    payload: { to: "bob" },
  });

  assert.equal(result.status, "ok");
  assert.equal(confirmations.length, 1);
  const request = confirmations[0];
  assert.equal(request.kind, "agent-task-approval");
  // The initiator tag on the dispatched task flows through to the confirm layer.
  assert.equal(request.initiator, "agent:agent-a");
  assert.equal(request.agentLabel, "agent-a");
  assert.equal(request.peerId, child.peerId);
  assert.equal(request.skill, "mail.send");
  assert.equal(request.taskId, sent[0].id);
});

test("agent dispatch respects the shared broker's agent policy matrix", async () => {
  const vault = await makeVault();
  const manager = new IdentityManager({ vault });
  const child = await manager.deriveChildIdentity("agent-matrix");

  const broker = new TaskBroker();
  broker.registerSkill("telemetry.vitals", async () => "ok", {
    localOnly: false,
    remote: { gate: "verified-contact", agent: { level: "telemetry" } },
  });
  broker.registerSkill("admin.nuke", async () => "boom", {
    localOnly: false,
    remote: { gate: "verified-contact", agent: { level: "never" } },
  });
  broker.registerSkill("local.note", async () => "noted", { localOnly: true });

  let confirms = 0;
  const runtime = new AgentRuntime({
    label: "agent-matrix",
    identity: child,
    networkProvider: providerStub(),
    confirmation: { confirmTier2: async () => { confirms += 1; return true; } },
    broker,
  });

  // telemetry → dispatched without a confirmation.
  const telemetry = await runtime.sendTask(PEER, {
    skill: "telemetry.vitals",
    payload: {},
  });
  assert.equal(telemetry.status, "ok");

  // never → refused, no confirmation, nothing dispatched.
  const never = await runtime.sendTask(PEER, { skill: "admin.nuke", payload: {} });
  assert.equal(never.status, "error");
  assert.match(never.error ?? "", /not allowed to dispatch/);

  // local skill with no agent policy → fail-closed default ("approved"):
  // requires a native confirmation before dispatch.
  const local = await runtime.sendTask(PEER, { skill: "local.note", payload: {} });
  assert.equal(local.status, "ok");
  assert.equal(confirms, 1);
});

test("a denied operator confirmation blocks the dispatch and nothing is sent", async () => {
  const vault = await makeVault();
  const manager = new IdentityManager({ vault });
  const child = await manager.deriveChildIdentity("agent-denied");

  let sent = 0;
  const broker = new TaskBroker();
  broker.registerSkill("mail.send", async () => "sent", {
    localOnly: false,
    remote: { gate: "verified-contact", agent: { level: "approved" } },
  });

  const runtime = new AgentRuntime({
    label: "agent-denied",
    identity: child,
    networkProvider: providerStub({
      sendTask: async () => {
        sent += 1;
        return { taskId: "t", status: "ok", result: "sent" };
      },
    }),
    confirmation: { confirmTier2: async () => false },
    broker,
  });

  const result = await runtime.sendTask(PEER, {
    skill: "mail.send",
    payload: {},
  });
  assert.equal(result.status, "error");
  assert.equal(sent, 0);

  // No confirmer at all → fail-closed denial, same shape.
  const noConfirmer = new AgentRuntime({
    label: "agent-denied",
    identity: child,
    networkProvider: providerStub({ sendTask: async () => { sent += 1; return { taskId: "t", status: "ok" }; } }),
    confirmation: {},
    broker,
  });
  assert.equal((await noConfirmer.sendTask(PEER, { skill: "mail.send", payload: {} })).status, "error");
  assert.equal(sent, 0);
});

test("AgentRuntime never holds the operator IdentityManager or signer — only the child signer in the provider", async () => {
  const vault = await makeVault();
  const manager = new IdentityManager({ vault });
  const operator = await manager.getOrCreateIdentity();
  const child = await manager.deriveChildIdentity("agent-c");

  // The child signer is built and handed to the PROVIDER — never to the runtime.
  const childSigner = await childSignerFor(vault, "agent-c");
  const provider = providerStub({
    identity: child,
    identitySigner: childSigner,
  } as unknown as Partial<NetworkProvider>);

  const runtime = new AgentRuntime({
    label: "agent-c",
    identity: child,
    networkProvider: provider,
    confirmation: {},
    broker: new TaskBroker(),
  });

  // Structural: the runtime exposes no signer and no IdentityManager.
  assert.equal("sign" in runtime, false);
  assert.equal("identityManager" in runtime, false);
  const options = (runtime as unknown as { options: Record<string, unknown> }).options;
  assert.equal("identityManager" in options, false);
  assert.equal("sign" in options, false);
  assert.equal(options.identity instanceof IdentityManager, false);
  assert.equal(options.identity, child);

  // The only signer in the picture is the child's: its output verifies as the
  // child, never as the operator.
  const data = Buffer.from("agent-hello");
  const signature = await childSigner(data);
  assert.equal(IdentityManager.verify(child.peerId, data, signature), true);
  assert.equal(IdentityManager.verify(operator.peerId, data, signature), false);
});

test("AgentRuntime rejects an invalid label at construction (never touches the vault)", async () => {
  const vault = await makeVault();
  const manager = new IdentityManager({ vault });
  const child = await manager.deriveChildIdentity("good-label");
  assert.throws(
    () =>
      new AgentRuntime({
        label: "../evil",
        identity: child,
        networkProvider: providerStub(),
        confirmation: {},
        broker: new TaskBroker(),
      }),
    /invalid agent label/,
  );
});

test("AgentRuntime start/stop drive the provider and are idempotent", async () => {
  const vault = await makeVault();
  const manager = new IdentityManager({ vault });
  const child = await manager.deriveChildIdentity("agent-lifecycle");

  let starts = 0;
  let stops = 0;
  const provider = providerStub({
    start: async () => {
      starts += 1;
    },
    stop: async () => {
      stops += 1;
    },
  });
  const runtime = new AgentRuntime({
    label: "agent-lifecycle",
    identity: child,
    networkProvider: provider,
    confirmation: {},
    broker: new TaskBroker(),
  });

  await runtime.start();
  await runtime.start();
  assert.equal(starts, 1);
  await runtime.stop();
  await runtime.stop();
  assert.equal(stops, 1);
});
