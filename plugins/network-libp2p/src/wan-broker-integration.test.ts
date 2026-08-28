import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HookRegistry,
  IdentityManager,
  NetworkRegistry,
  StorageManager,
  TaskBroker,
  VaultManager,
  loadPlugin,
  wireNetworkToBroker,
  type PeerAccessContext,
} from "@p2p-hub/core";
import {
  resolveRef,
  rootObject,
  type PBXDocument,
  type PBXReference,
} from "@p2p-hub/sdk";
import type { TasksPlugin } from "@p2p-hub/tasks";
import { createLibp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { circuitRelayServer } from "@libp2p/circuit-relay-v2";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { NetworkLibp2pProvider } from "./network-libp2p-provider.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TASKS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../tasks",
);

/** A local circuit-relay v2 relay node bound to loopback (no public infra). */
async function startLocalRelay(): Promise<Awaited<ReturnType<typeof createLibp2p>>> {
  return createLibp2p({
    addresses: { listen: ["/ip4/127.0.0.1/tcp/0"] },
    transports: [tcp()],
    streamMuxers: [yamux()],
    connectionEncrypters: [noise()],
    services: { relay: circuitRelayServer() },
  });
}

/** First advertised multiaddr of the relay (loopback TCP + its peer id). */
function relayAddress(relay: Awaited<ReturnType<typeof createLibp2p>>): string {
  return relay.getMultiaddrs()[0].toString();
}

async function waitFor<T>(
  probe: () => T | null | undefined,
  timeoutMs = 15_000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function waitForRelayedAddress(provider: NetworkLibp2pProvider): Promise<string> {
  return waitFor(
    () =>
      provider
        .getListeningAddresses()
        .find((address) => address.includes("/p2p-circuit")) ?? null,
  );
}

/**
 * Boot an "owner" node: a real TaskBroker (with a host-style peer-access
 * context that recognizes exactly `verifiedClient` as a verified contact), the
 * real tasks plugin loaded from its compiled dir, and a WAN provider behind a
 * relay. The transport PeerId equals the p2p-hub identity (Optie B), exactly
 * like the core-server WAN wiring.
 */
async function bootOwnerNode(
  relayAddr: string,
  verifiedClient: string,
): Promise<{
  broker: TaskBroker;
  tasks: TasksPlugin;
  provider: NetworkLibp2pProvider;
  peerId: string;
  relayedAddress: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wan-broker-owner-"));
  const vault = new VaultManager({
    dataDir: path.join(root, "vault"),
    masterKey: "wan-broker-owner-master-key",
  });
  const identity = new IdentityManager({ vault });
  const peer = await identity.getOrCreateIdentity();

  const broker = new TaskBroker({
    peerAccessContext: {
      contacts: {
        isVerifiedContact: (peerId: string) => peerId === verifiedClient,
      },
    } satisfies PeerAccessContext,
  });
  const registry = new NetworkRegistry();
  const tasks = (await loadPlugin(
    TASKS_DIR,
    new StorageManager(path.join(root, "storage")),
    new HookRegistry(),
    broker,
    vault,
    identity,
    registry,
    undefined,
    () => ({
      getContact: async (peerId: string) =>
        peerId === verifiedClient ? { trustState: "verified" } : null,
    }),
  )) as TasksPlugin;

  const provider = new NetworkLibp2pProvider({
    listenAddresses: ["/ip4/127.0.0.1/tcp/0"],
    relayAddresses: [relayAddr],
    skills: ["tasks.requestMutation"],
    identity: peer,
    identitySigner: (data) => identity.sign(data),
    hasBrokerRateLimiting: () => broker.hasRateLimiting(),
    privateKeyRaw: await identity.exportLibp2pKeySeed(),
  });
  wireNetworkToBroker(provider, broker);
  await provider.start();

  const relayedAddress = await waitForRelayedAddress(provider);
  return { broker, tasks, provider, peerId: peer.peerId, relayedAddress };
}

/** Boot a bare "client" node: an identity + a WAN provider, no broker. */
async function bootClientNode(): Promise<{
  provider: NetworkLibp2pProvider;
  peerId: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wan-broker-client-"));
  const vault = new VaultManager({
    dataDir: path.join(root, "vault"),
    masterKey: "wan-broker-client-master-key",
  });
  const identity = new IdentityManager({ vault });
  const peer = await identity.getOrCreateIdentity();
  const provider = new NetworkLibp2pProvider({
    listenAddresses: ["/ip4/127.0.0.1/tcp/0"],
    identity: peer,
    identitySigner: (data) => identity.sign(data),
    hasBrokerRateLimiting: () => true,
    privateKeyRaw: await identity.exportLibp2pKeySeed(),
  });
  await provider.start();
  return { provider, peerId: peer.peerId };
}

function taskIds(doc: PBXDocument): string[] {
  const root = rootObject(doc)!;
  const refs = root.tasks as PBXReference[];
  return refs.map((ref) => resolveRef(doc, ref)!.$id);
}

function delegationStatus(doc: PBXDocument, taskId: string): string | undefined {
  const root = rootObject(doc)!;
  const refs = root.tasks as PBXReference[];
  const ref = refs.find((r) => resolveRef(doc, r)!.$id === taskId);
  assert.ok(ref, `task "${taskId}" should exist in the document`);
  const task = resolveRef(doc, ref) as { delegation?: { status?: string } };
  return task.delegation?.status;
}

// ---------------------------------------------------------------------------
// Full-stack: WAN relay → TaskBroker gate → tasks plugin skill
// ---------------------------------------------------------------------------

test("a verified member accepts a delegation over a WAN relay — the transport peerId wins over a forged payload senderPeerId", async () => {
  const relay = await startLocalRelay();
  try {
    const client = await bootClientNode();
    const owner = await bootOwnerNode(relayAddress(relay), client.peerId);
    try {
      // The owner builds a project and delegates a task to the client
      // (owner-side local skill surface; delegation also makes the client a
      // member).
      const project = await owner.tasks.createProject({ name: "WAN relay build" });
      const projectId = rootObject(project)!.$id;
      const doc = await owner.tasks.addTask({ projectId, name: "Ship v1" });
      const [taskId] = taskIds(doc);
      const delegated = await owner.tasks.delegateTask({
        projectId,
        taskId,
        peerId: client.peerId,
      });
      assert.equal(delegationStatus(delegated, taskId), "pending");

      // The client asks the owner to accept the delegation OVER THE RELAY and
      // smuggles a forged `senderPeerId` into the payload. The broker only
      // trusts the transport-verified identity, so the accept is applied to the
      // client — the forged field is dead weight (never a caller-supplied
      // identity).
      const result = await client.provider.sendTask(
        { id: owner.peerId, address: owner.relayedAddress, skills: [] },
        {
          id: "wan-accept-1",
          skill: "tasks.requestMutation",
          payload: {
            projectId,
            type: "ACCEPT_DELEGATION",
            taskId,
            payload: {},
            senderPeerId: "forged-not-the-assignee",
          },
        },
      );

      assert.equal(result.status, "ok");
      const mutation = result.result as { ok: boolean; action?: string };
      assert.equal(mutation.ok, true);
      assert.equal(mutation.action, "acceptDelegation");

      const afterAccept = await owner.tasks.getProject(projectId);
      assert.equal(delegationStatus(afterAccept!, taskId), "accepted");
    } finally {
      await client.provider.stop();
      await owner.provider.stop();
    }
  } finally {
    await relay.stop();
  }
});

test("a stranger (not a verified contact) is denied by the verified-contact gate before the handler runs", async () => {
  const relay = await startLocalRelay();
  try {
    const stranger = await bootClientNode();
    // The owner only recognizes some *other* peer as a verified contact — the
    // stranger must be denied at the broker gate, before any dispatch.
    const owner = await bootOwnerNode(relayAddress(relay), "verified-peer-elsewhere");
    try {
      const project = await owner.tasks.createProject({ name: "Gate test" });
      const projectId = rootObject(project)!.$id;
      const doc = await owner.tasks.addTask({ projectId, name: "Secret" });
      const [taskId] = taskIds(doc);
      await owner.tasks.delegateTask({
        projectId,
        taskId,
        peerId: "verified-peer-elsewhere",
      });

      const result = await stranger.provider.sendTask(
        { id: owner.peerId, address: owner.relayedAddress, skills: [] },
        {
          id: "wan-attempt-1",
          skill: "tasks.requestMutation",
          payload: {
            projectId,
            type: "ACCEPT_DELEGATION",
            taskId,
            payload: {},
          },
        },
      );

      assert.equal(result.status, "error");
      assert.match(result.error ?? "", /not authorized for this remote peer/);

      // Nothing changed on the owner: the delegation is still pending.
      const after = await owner.tasks.getProject(projectId);
      assert.equal(delegationStatus(after!, taskId), "pending");
    } finally {
      await stranger.provider.stop();
      await owner.provider.stop();
    }
  } finally {
    await relay.stop();
  }
});
