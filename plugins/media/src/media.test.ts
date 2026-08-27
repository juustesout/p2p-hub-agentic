import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  DisposerBag,
  HookRegistry,
  NetworkRegistry,
  StorageManager,
  TaskBroker,
  VaultManager,
  loadPlugin,
} from "@p2p-hub/core";
import type { PeerAccessContext } from "@p2p-hub/core";
import type { ContactTrustState, NetworkPeer, NetworkProvider, TaskRequest, TaskResult } from "@p2p-hub/sdk";
import type { InitiateCallResult, MediaPlugin, RequestSessionResult } from "./index";

const pluginDir = path.resolve(__dirname, "..");

const SIGNALING_SKILLS = ["media.offer", "media.answer", "media.iceCandidate"];

function makePeer(): { peerId: string } {
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return {
    peerId: Buffer.from(jwk.x, "base64url").toString("hex"),
  };
}

interface AccessRequest {
  requestId: string;
  peerId: string;
  kind: string;
  direction: string;
  expiresInMs: number;
}

interface NodeOptions {
  trustEnabled?: boolean;
  trustState?: ContactTrustState | null;
  /** Host-side media-access resolver. Defaults to always granting. */
  approve?: (req: AccessRequest) => boolean;
  telemetryRateLimit?: { windowMs: number; maxCalls: number };
}

interface TestNode {
  plugin: MediaPlugin;
  broker: TaskBroker;
  hooks: HookRegistry;
  peerId: string;
  dataDir: string;
  /** The node this node's transport is "linked" to (routing target). */
  other: () => TestNode | null;
}

async function createNode(opts: NodeOptions = {}): Promise<TestNode> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "media-node-"));
  const storage = new StorageManager(dataDir);
  const vault = new VaultManager({
    dataDir: path.join(dataDir, "vault"),
    masterKey: "test-master",
  });
  const hooks = new HookRegistry();
  const peer = makePeer();

  const trustEnabled = opts.trustEnabled ?? true;
  const trustState = opts.trustState === undefined ? "verified" : opts.trustState;

  const node: TestNode = {
    plugin: undefined as unknown as MediaPlugin,
    broker: undefined as unknown as TaskBroker,
    hooks,
    peerId: peer.peerId,
    dataDir,
    other: () => null,
  };

  const registry = new NetworkRegistry();
  registry.register(makeRoutingProvider(node));

  node.broker = new TaskBroker({
    ...(opts.telemetryRateLimit
      ? { telemetryRateLimit: opts.telemetryRateLimit }
      : {}),
    // The host wires a peer-access context into the broker (Fase 2A); an
    // absent context makes the named gates fail closed, which would deny
    // everything here.
    peerAccessContext: makePeerAccessContext(node, trustState),
  });

  const plugin = (await loadPlugin(
    pluginDir,
    storage,
    hooks,
    node.broker,
    vault,
    undefined,
    registry,
    new DisposerBag(),
    trustEnabled ? () => makeTrustLookup(node, trustState) : null,
  )) as MediaPlugin;
  node.plugin = plugin;

  // The core-server glue, reproduced as a hook listener: the plugin emits
  // `media:accessRequested`, the host resolves it through its Tier-2
  // confirmation, and hands the decision back via `resolveMediaAccess`.
  const approve = opts.approve ?? (() => true);
  hooks.on("media:accessRequested", (payload) => {
    const req = (payload ?? {}) as Partial<AccessRequest>;
    if (typeof req.requestId !== "string" || req.requestId.length === 0) {
      return;
    }
    void node.plugin.resolveMediaAccess(req.requestId, approve(req as AccessRequest));
  });

  return node;
}

function makeTrustLookup(node: TestNode, trustState: ContactTrustState | null) {
  return {
    getContact: async (id: string) => {
      const other = node.other();
      if (trustState === null || !other || other.peerId !== id) {
        return null;
      }
      return { trustState };
    },
  };
}

/**
 * The broker-side peer-access context mirror, backed by the same trust state
 * as the lookup and a deny-all access-pass capability.
 */
function makePeerAccessContext(
  node: TestNode,
  trustState: ContactTrustState | null,
): PeerAccessContext {
  return {
    contacts: {
      isVerifiedContact: async (peerId: string): Promise<boolean> => {
        if (trustState !== "verified") {
          return false;
        }
        const other = node.other();
        return other !== null && other.peerId === peerId;
      },
    },
    accessPasses: {
      hasValidPass: async (): Promise<boolean> => false,
    },
  };
}

/** A fake transport whose `sendTask` routes to the linked node's broker. */
function makeRoutingProvider(node: TestNode): NetworkProvider {
  return {
    id: "fake-media",
    priority: 100,
    isReady: () => true,
    canTransportTasks: true,
    start: async () => {},
    stop: async () => {},
    discover: async () => [],
    listPeers: (): NetworkPeer[] => {
      const other = node.other();
      if (!other) {
        return [];
      }
      return [
        {
          id: "fake-instance",
          address: "127.0.0.1:1",
          skills: SIGNALING_SKILLS,
          name: "fake",
          peerId: other.peerId,
        },
      ];
    },
    sendTask: async (_peer: NetworkPeer, task: TaskRequest): Promise<TaskResult> => {
      const other = node.other();
      if (!other) {
        return { taskId: task.id, status: "error", error: "peer not reachable" };
      }
      // Fase 1B identity binding: the transport sets the caller's verified
      // peerId on the forwarded task — never a caller-supplied value.
      return other.broker.handleRemote({ ...task, peerId: node.peerId });
    },
    onTask: () => {},
  };
}

function link(a: TestNode, b: TestNode): void {
  a.other = () => b;
  b.other = () => a;
}

function assertCallRejected(
  result: InitiateCallResult,
  error: string,
): asserts result is { ok: false; error: string } {
  assert.equal(result.ok, false);
  assert.equal((result as { error: string }).error, error);
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test("two peers complete an offer/answer/candidate exchange", async () => {
  const a = await createNode();
  const b = await createNode();
  link(a, b);

  const result = await a.plugin.initiateCall({ peerId: b.peerId, kind: "camera" });
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.ok(result.callId.length > 0);
  assert.match(result.sdp, /^v=0/);

  // Both sides now have the call established.
  const statusA = await a.plugin.status();
  const statusB = await b.plugin.status();
  assert.equal(statusA.activeCalls, 1);
  assert.equal(statusB.activeCalls, 1);

  // A pushes an ICE candidate to B over the telemetry capability.
  const sent = await a.plugin.sendIceCandidate({
    callId: result.callId,
    candidate: { candidate: "candidate:1 1 UDP 1 192.168.0.1 50000 typ host", sdpMLineIndex: 0 },
  });
  assert.equal(sent.status, "ok");

  // hangup closes the call on the local side.
  const hung = await a.plugin.hangup({ peerId: b.peerId });
  assert.equal(hung.ok, true);
  assert.equal(hung.closed, 1);
  assert.equal((await a.plugin.status()).activeCalls, 0);
});

// ---------------------------------------------------------------------------
// checkPeerAccess — same gate in both directions
// ---------------------------------------------------------------------------

test("outbound call to an untrusted peer is denied before any offer", async () => {
  // The outbound path is NOT broker-mediated: `initiateCall` is a local call,
  // so its in-handler `checkPeerAccess` is the only gate before the offer.
  const a = await createNode({ trustState: "pending" });
  const b = await createNode();
  link(a, b);

  // A holds a pending (unverified) contact record for B and no access pass.
  const result = await a.plugin.initiateCall({ peerId: b.peerId });
  assertCallRejected(result, "unauthorized");
  assert.equal((result as { reason?: string }).reason, "not_a_contact");
  assert.equal((await b.plugin.status()).activeCalls, 0);
});

test("inbound offer from an untrusted peer is denied at the broker (no free head start)", async () => {
  const a = await createNode();
  const b = await createNode({ trustState: null });
  link(a, b);

  // A trusts B, so its own outbound gate passes and the offer is sent; B's
  // broker-level `verified-contact` gate rejects it before dispatch — an
  // inbound offer never gets a free head start over a locally initiated call.
  const result = await a.plugin.initiateCall({ peerId: b.peerId });
  assertCallRejected(
    result,
    'skill "media.offer" is not authorized for this remote peer',
  );
  assert.equal((await b.plugin.status()).activeCalls, 0);
});

test("calling a peerId that is not reachable fails cleanly", async () => {
  const a = await createNode();
  const stranger = makePeer();
  // No trust, no pass → rejected at the gate before the network is consulted.
  const result = await a.plugin.initiateCall({ peerId: stranger.peerId });
  assertCallRejected(result, "unauthorized");
});

// ---------------------------------------------------------------------------
// Media access confirmation — never skipped, denied cleanly, both directions
// ---------------------------------------------------------------------------

test("outbound call is denied when the host refuses the media access request", async () => {
  const a = await createNode({ approve: () => false });
  const b = await createNode();
  link(a, b);

  const result = await a.plugin.initiateCall({ peerId: b.peerId });
  assertCallRejected(result, "media-access-denied");
  assert.equal((await b.plugin.status()).activeCalls, 0);
});

test("inbound offer is denied when the callee's host refuses", async () => {
  const a = await createNode();
  const b = await createNode({ approve: () => false });
  link(a, b);

  const result = await a.plugin.initiateCall({ peerId: b.peerId });
  // The callee's refusal comes back on the offer ack.
  assertCallRejected(result, "media-access-denied");
  assert.equal((await b.plugin.status()).activeCalls, 0);
});

test("resolveMediaAccess with an unknown requestId is a no-op", async () => {
  const a = await createNode();
  assert.equal(await a.plugin.resolveMediaAccess("does-not-exist", true), false);
  assert.equal(await a.plugin.resolveMediaAccess("", true), false);
});

// ---------------------------------------------------------------------------
// Malformed and duplicate inbound offers
// ---------------------------------------------------------------------------

test("a malformed offer is acknowledged with a denial, never dispatched", async () => {
  const a = await createNode();
  const b = await createNode();
  link(a, b);

  const result = await b.broker.handleRemote({
    id: crypto.randomUUID(),
    skill: "media.offer",
    payload: { protocol: "p2p-hub:media-signaling", version: 1, callId: "x", peerId: "smuggled" },
    peerId: a.peerId,
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.result, { accepted: false, error: "malformed" });
  assert.equal((await b.plugin.status()).activeCalls, 0);
});

test("a second concurrent call to the same peer is rejected", async () => {
  const a = await createNode();
  const b = await createNode();
  link(a, b);

  const first = await a.plugin.initiateCall({ peerId: b.peerId });
  assert.equal(first.ok, true);

  const second = await a.plugin.initiateCall({ peerId: b.peerId });
  assertCallRejected(second, "already in call");
});

// ---------------------------------------------------------------------------
// ICE candidates flow through the telemetry rate limiter
// ---------------------------------------------------------------------------

test("an ICE burst over the telemetry budget fails with the telemetry error code", async () => {
  const a = await createNode();
  const b = await createNode({ telemetryRateLimit: { windowMs: 60_000, maxCalls: 2 } });
  link(a, b);

  const result = await a.plugin.initiateCall({ peerId: b.peerId });
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  const callId = result.callId;
  const candidate = { candidate: "candidate:1 1 UDP 1 192.168.0.1 50000 typ host" };

  assert.equal((await a.plugin.sendIceCandidate({ callId, candidate })).status, "ok");
  assert.equal((await a.plugin.sendIceCandidate({ callId, candidate })).status, "ok");

  const throttled = await a.plugin.sendIceCandidate({ callId, candidate });
  assert.equal(throttled.status, "error");
  assert.equal(throttled.code, "telemetry-rate-limit");
});

// ---------------------------------------------------------------------------
// Stap 4 — media sessions (requestSession/closeSession/getStreamStatus)
// ---------------------------------------------------------------------------

function assertSessionOk(
  result: RequestSessionResult,
): asserts result is Extract<RequestSessionResult, { ok: true }> {
  assert.equal(result.ok, true);
}

test("session skills are registered httpBridgeOnly (local operator privilege)", async () => {
  const a = await createNode();
  const skills = a.broker.listSkills();
  for (const name of ["media.requestSession", "media.closeSession", "media.getStreamStatus"]) {
    const skill = skills.find((s) => s.skill === name);
    assert.ok(skill, `${name} should be registered`);
    assert.equal(skill.localOnly, true, `${name} must be local-only`);
    assert.equal(skill.httpExposed, true, `${name} must be reachable over the local HTTP bridge`);
    assert.equal(skill.httpBridgeOnly, true, `${name} must be httpBridgeOnly`);
    assert.equal(skill.capabilityType, "action");
  }
});

test("a session opens for a verified peer and closes cleanly", async () => {
  const a = await createNode();
  const b = await createNode();
  link(a, b);

  const session = await a.plugin.requestSession({ peerId: b.peerId, kind: "microphone" });
  assertSessionOk(session);
  assert.ok(session.sessionId.length > 0);
  assert.equal(session.peerId, b.peerId);
  assert.equal(session.kind, "microphone");
  assert.ok(session.channelId.startsWith("media-session:"));

  const status = await a.plugin.getStreamStatus(session.sessionId);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.peerId, b.peerId);
    assert.equal(status.kind, "microphone");
    assert.equal(status.status, "active");
    assert.equal(status.frames, 0);
    assert.equal(status.dropped, 0);
    assert.equal(status.violations, 0);
    assert.equal(status.config.maxMessagesPerSecond, 60);
  }

  // A second session for the same peer is rejected.
  const duplicate = await a.plugin.requestSession({ peerId: b.peerId });
  assert.deepEqual(duplicate, { ok: false, error: "session already open" });

  assert.deepEqual(await a.plugin.closeSession(session.sessionId), { ok: true, closed: 1 });
  assert.deepEqual(await a.plugin.getStreamStatus(session.sessionId), {
    ok: false,
    error: "no such session",
  });
  assert.deepEqual(await a.plugin.closeSession(session.sessionId), {
    ok: false,
    error: "no such session",
  });
});

test("requestSession to an untrusted peer is denied by the peer-access gate", async () => {
  const a = await createNode({ trustState: "pending" });
  const b = await createNode();
  link(a, b);

  // A holds only a pending (unverified) contact record for B and no access
  // pass — the session must be denied before any Tier-2 prompt is raised.
  const result = await a.plugin.requestSession({ peerId: b.peerId, kind: "camera" });
  assert.equal(result.ok, false);
  assert.equal((result as { error: string }).error, "unauthorized");
  assert.equal((result as { reason?: string }).reason, "not_a_contact");
  assert.equal((await a.plugin.getStreamStatus("any")).ok, false);
});

test("requestSession is denied when the host refuses the media confirmation", async () => {
  const a = await createNode({ approve: () => false });
  const b = await createNode();
  link(a, b);

  // Gate 1 passes (B is a verified contact), but Gate 2 — the Tier-2 native
  // media confirmation — is refused, so no session may open.
  const result = await a.plugin.requestSession({ peerId: b.peerId, kind: "camera" });
  assert.equal(result.ok, false);
  assert.equal((result as { error: string }).error, "media-access-denied");
});

test("a malformed requestSession input fails closed", async () => {
  const a = await createNode();
  const empty = await a.plugin.requestSession({ peerId: "" });
  assert.equal(empty.ok, false);
  assert.equal((empty as { error: string }).error, "unauthorized");
  const bogus = await a.plugin.requestSession({ peerId: "not-a-peer-id" });
  assert.equal(bogus.ok, false);
});

// ---------------------------------------------------------------------------
// Stap 4 — the TelemetryGate fast-path: drop, never queue
// ---------------------------------------------------------------------------

test("telemetry frames over a session's budget are dropped, never queued", async () => {
  const a = await createNode();
  const b = await createNode();
  link(a, b);

  const session = await a.plugin.requestSession({
    peerId: b.peerId,
    telemetry: { maxMessagesPerSecond: 2 },
  });
  assertSessionOk(session);

  assert.deepEqual(await a.plugin.consumeStreamFrame(session.sessionId, 32), {
    allowed: true,
  });
  assert.deepEqual(await a.plugin.consumeStreamFrame(session.sessionId, 32), {
    allowed: true,
  });
  // Third frame in the same window: dropped at the cap, no error thrown, no
  // queue — and the session stays open.
  assert.deepEqual(await a.plugin.consumeStreamFrame(session.sessionId, 32), {
    allowed: false,
    reason: "message-cap",
  });

  const status = await a.plugin.getStreamStatus(session.sessionId);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.frames, 2);
    assert.equal(status.dropped, 1);
    assert.equal(status.violations, 0);
    assert.equal(status.config.maxMessagesPerSecond, 2);
  }

  // Unknown session / invalid sizes fail closed without throwing.
  assert.deepEqual(await a.plugin.consumeStreamFrame("nope", 32), {
    allowed: false,
    reason: "no-session",
  });
  assert.deepEqual(await a.plugin.consumeStreamFrame(session.sessionId, -1), {
    allowed: false,
    reason: "invalid",
  });
  assert.deepEqual(await a.plugin.consumeStreamFrame(session.sessionId, 1.5), {
    allowed: false,
    reason: "invalid",
  });
});

test("the byte cap is enforced independently of the message cap", async () => {
  const a = await createNode();
  const b = await createNode();
  link(a, b);

  const session = await a.plugin.requestSession({
    peerId: b.peerId,
    telemetry: { maxBytesPerSecond: 1024 },
  });
  assertSessionOk(session);

  // A single frame over the per-window byte cap is dropped outright.
  assert.deepEqual(await a.plugin.consumeStreamFrame(session.sessionId, 4096), {
    allowed: false,
    reason: "byte-cap",
  });
  const status = await a.plugin.getStreamStatus(session.sessionId);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.frames, 0);
    assert.equal(status.dropped, 1);
  }
});

test("an open session gates ICE telemetry with its own frequency cap", async () => {
  const a = await createNode();
  const b = await createNode();
  link(a, b);

  const session = await a.plugin.requestSession({
    peerId: b.peerId,
    telemetry: { maxMessagesPerSecond: 2 },
  });
  assertSessionOk(session);

  const call = await a.plugin.initiateCall({ peerId: b.peerId, kind: "camera" });
  assert.equal(call.ok, true);
  if (!call.ok) {
    return;
  }
  const candidate = { candidate: "candidate:1 1 UDP 1 192.168.0.1 50000 typ host" };

  // The first two candidates ride the session channel; the third is dropped
  // locally by the session's TelemetryGate before it is ever sent.
  assert.equal((await a.plugin.sendIceCandidate({ callId: call.callId, candidate })).status, "ok");
  assert.equal((await a.plugin.sendIceCandidate({ callId: call.callId, candidate })).status, "ok");
  const dropped = await a.plugin.sendIceCandidate({ callId: call.callId, candidate });
  assert.equal(dropped.status, "error");
  assert.equal(dropped.code, "telemetry-drop");

  const status = await a.plugin.getStreamStatus(session.sessionId);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.frames, 2);
    assert.equal(status.dropped, 1);
  }
});
