import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CoreServer } from "./app";
import {
  MEDIA_GRANT_TTL_MS,
  createMediaSkillHandler,
} from "./media";
import {
  PluginHost,
  TrustTierGate,
  type ConfirmationRequest,
  type TrustConfirmation,
} from "@p2p-hub/core";
import {
  encodeMediaGrant,
  parseMediaResponse,
  serializeMediaEnvelope,
} from "@p2p-hub/sdk";

const BOOT_TOKEN = "media-test-token";

const PEER = "00".repeat(32);

function confirmer(approved: boolean): TrustConfirmation {
  return { confirmTier2: async () => approved };
}

async function bootServer(): Promise<{ server: CoreServer; port: number }> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-server-media-"));
  await fs.mkdir(path.join(dataDir, "plugins"), { recursive: true });
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

// ---------------------------------------------------------------------------
// Unit: the media skill handler factory
// ---------------------------------------------------------------------------

test("media handler grants a request approved by the native tier-2 confirm", async () => {
  const handler = createMediaSkillHandler({
    trustGate: new TrustTierGate(confirmer(true)),
  });
  const result = await handler(
    { protocol: "p2p-hub:media", version: 1, kind: "camera", requested: { width: 1280, height: 720 } },
    { peerId: PEER },
  );
  assert.equal(serializeMediaEnvelope(result as never), serializeMediaEnvelope(encodeMediaGrant(MEDIA_GRANT_TTL_MS)));
  assert.deepEqual(parseMediaResponse(result), {
    protocol: "p2p-hub:media",
    version: 1,
    status: "granted",
    expiresInMs: MEDIA_GRANT_TTL_MS,
  });
});

test("media handler denies when the native confirm is refused", async () => {
  const handler = createMediaSkillHandler({
    trustGate: new TrustTierGate(confirmer(false)),
  });
  const result = await handler(
    { protocol: "p2p-hub:media", version: 1, kind: "microphone" },
    { peerId: PEER },
  );
  assert.deepEqual(parseMediaResponse(result), {
    protocol: "p2p-hub:media",
    version: 1,
    status: "error",
    code: "denied",
  });
});

test("media handler fails closed with no native confirmer", async () => {
  const handler = createMediaSkillHandler({ trustGate: new TrustTierGate() });
  const result = await handler(
    { protocol: "p2p-hub:media", version: 1, kind: "camera" },
    { peerId: PEER },
  );
  assert.deepEqual(parseMediaResponse(result), {
    protocol: "p2p-hub:media",
    version: 1,
    status: "error",
    code: "denied",
  });
});

test("media handler rejects an anonymous caller (no transport-verified peerId)", async () => {
  const handler = createMediaSkillHandler({
    trustGate: new TrustTierGate(confirmer(true)),
  });
  // No context at all — the local/HTTP path never carries a verified identity.
  const noContext = await handler({
    protocol: "p2p-hub:media",
    version: 1,
    kind: "camera",
  });
  assert.deepEqual(parseMediaResponse(noContext), {
    protocol: "p2p-hub:media",
    version: 1,
    status: "error",
    code: "unauthorized",
  });
  // A caller-supplied peerId in the payload is rejected outright by the strict
  // contract (the envelope has no identity field) — never treated as identity.
  const smuggled = await handler(
    { protocol: "p2p-hub:media", version: 1, kind: "camera", peerId: "deadbeef" },
    undefined,
  );
  assert.deepEqual(parseMediaResponse(smuggled), {
    protocol: "p2p-hub:media",
    version: 1,
    status: "error",
    code: "malformed",
  });
});

test("media handler rejects malformed envelopes with a typed error", async () => {
  const handler = createMediaSkillHandler({
    trustGate: new TrustTierGate(confirmer(true)),
  });
  for (const payload of [
    null,
    "nope",
    { protocol: "p2p-hub:media", version: 2, kind: "camera" },
    { protocol: "p2p-hub:website", version: 1, kind: "camera" },
    { protocol: "p2p-hub:media", version: 1, kind: "geiger" },
    { protocol: "p2p-hub:media", version: 1, kind: "camera", requested: { width: 999999 } },
  ]) {
    const result = await handler(payload, { peerId: PEER });
    const parsed = parseMediaResponse(result);
    assert.ok(parsed, `expected a typed error response for ${JSON.stringify(payload)}`);
    assert.equal(parsed.status, "error");
    assert.ok(
      parsed.code === "malformed" || parsed.code === "unsupported-version",
      `unexpected code ${parsed.code}`,
    );
  }
});

test("media handler rate-limits a peer that spams requests", async () => {
  const handler = createMediaSkillHandler({
    trustGate: new TrustTierGate(confirmer(true)),
  });
  const request = { protocol: "p2p-hub:media", version: 1, kind: "camera" };
  const first = await handler(request, { peerId: PEER });
  assert.equal(parseMediaResponse(first)?.status, "granted");
  const second = await handler(request, { peerId: PEER });
  assert.deepEqual(parseMediaResponse(second), {
    protocol: "p2p-hub:media",
    version: 1,
    status: "error",
    code: "rate-limited",
  });
  // A different peer is unaffected.
  const other = await handler(request, { peerId: "11".repeat(32) });
  assert.equal(parseMediaResponse(other)?.status, "granted");
});

// ---------------------------------------------------------------------------
// Integration: registration over the local HTTP bridge
// ---------------------------------------------------------------------------

test("core.media.request is registered network-exposed but not HTTP-exposed", async () => {
  const { server, port } = await bootServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/capabilities`, {
      headers: { Authorization: `Bearer ${BOOT_TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      local: {
        skills: Array<{
          skill: string;
          localOnly: boolean;
          httpExposed: boolean;
          capabilityType?: string;
        }>;
      };
    };
    const media = body.local.skills.find((s) => s.skill === "core.media.request");
    assert.ok(media, "core.media.request should be registered");
    assert.equal(media.localOnly, false, "media must be reachable over the network");
    assert.equal(
      media.httpExposed,
      false,
      "media must not be reachable over the local HTTP bridge",
    );
    assert.equal(media.capabilityType, "action", "media is a discrete action capability");
  } finally {
    await server.stop();
  }
});

test("a media request over the HTTP bridge is rejected (no HTTP route skips the gate)", async () => {
  const { server, port } = await bootServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${BOOT_TOKEN}`,
      },
      body: JSON.stringify({
        serviceId: "core",
        method: "media.request",
        arguments: { protocol: "p2p-hub:media", version: 1, kind: "camera" },
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; error?: string };
    assert.equal(body.status, "error");
    assert.match(body.error ?? "", /not exposed over the HTTP bridge/);
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// Glue: `media:accessRequested` → raw TrustConfirmation → `resolveMediaAccess`
//
// The plugin-side contract (hook emitted, request resolved) is covered in the
// plugin's own two-sided harness. These tests close the seam the harness
// simulates: the real `registerMediaAccessHandler` listener must actually
// consult the raw `TrustConfirmation` (via `TrustTierGate.confirmMediaRequest`)
// with the plugin's payload and hand the decision back to the plugin.
// ---------------------------------------------------------------------------

/** Source of the compiled media plugin, copied into each temp pluginsDir. */
const MEDIA_SRC = path.resolve(__dirname, "../../../plugins/media");
/** Temp dirs that boot a real PluginHost — under node_modules/.cache so the
 * copied plugin's `require("@p2p-hub/*")` resolves (same trick as peersite). */
const TEST_TMP_ROOT = path.resolve(__dirname, "../../../node_modules/.cache/p2p-hub-test");
/** Scope the media plugin's signaling gate uses (`MEDIA_SIGNAL_SCOPE`). */
const MEDIA_SIGNAL_SCOPE = "media-signal";
/** Boot token the glue harness servers are started with. */
const MEDIA_GLUE_TOKEN = "media-glue-token";
/** The three Stap 4 session-lifecycle skills (local-operator privileges). */
const SESSION_SKILLS = [
  "media.requestSession",
  "media.closeSession",
  "media.getStreamStatus",
];

/** The activated media plugin, duck-typed (core-server has no dep on it). */
interface ActivatedMediaPlugin {
  initiateCall(input: {
    peerId: string;
    kind?: "camera" | "microphone";
  }): Promise<
    | { ok: true; callId: string; sdp: string }
    | { ok: false; error: string; reason?: string }
  >;
}

/** Reach the host through the one private seam — the only route to the real
 * hook registry and the real activated plugin instance the glue uses. */
function hostOf(server: CoreServer): PluginHost {
  return (server as unknown as { host: PluginHost }).host;
}

function recordingConfirmer(approved: boolean): {
  confirmation: TrustConfirmation;
  calls: ConfirmationRequest[];
} {
  const calls: ConfirmationRequest[] = [];
  return {
    calls,
    confirmation: {
      confirmTier2: async (req) => {
        calls.push(req);
        return approved;
      },
    },
  };
}

async function bootMediaServer(
  trustConfirmation?: TrustConfirmation,
): Promise<{
  server: CoreServer;
  host: PluginHost;
  plugin: ActivatedMediaPlugin;
  port: number;
}> {
  await fs.mkdir(TEST_TMP_ROOT, { recursive: true });
  const dataDir = await fs.mkdtemp(
    path.join(TEST_TMP_ROOT, "core-server-media-glue-"),
  );
  const pluginsDir = path.join(dataDir, "plugins");
  await fs.mkdir(pluginsDir, { recursive: true });
  await fs.cp(MEDIA_SRC, path.join(pluginsDir, "media"), { recursive: true });

  const server = new CoreServer({
    pluginsDir,
    dataDir,
    host: "127.0.0.1",
    port: 0,
    bootToken: MEDIA_GLUE_TOKEN,
    networking: false,
    ...(trustConfirmation ? { trustConfirmation } : {}),
  });
  await server.start();
  const addr = server.address();
  assert.ok(addr, "server should report its bound address");
  const host = hostOf(server);
  return {
    server,
    host,
    plugin: host.getActivated("media") as ActivatedMediaPlugin,
    port: addr.port,
  };
}

test("a media access request runs the raw native tier-2 confirm and grants the plugin", async () => {
  const { confirmation, calls } = recordingConfirmer(true);
  const { server, host, plugin } = await bootMediaServer(confirmation);
  try {
    // Give the caller a `media-signal` access pass so the plugin's outbound
    // gate passes. Networking is off, so a successful confirm is observable as
    // "no active network provider" (proceeded past the confirm gate) and a
    // refusal as "media-access-denied".
    host.accessPassManager().issue(PEER, MEDIA_SIGNAL_SCOPE, 60_000);

    const result = await plugin.initiateCall({ peerId: PEER, kind: "camera" });
    assert.deepEqual(result, { ok: false, error: "no active network provider" });

    assert.equal(calls.length, 1, "the raw tier-2 confirm must run exactly once");
    const req = calls[0];
    assert.equal(req.kind, "media-access-request");
    assert.equal(req.peerId, PEER);
    assert.equal(req.mediaKind, "camera");
    assert.equal(req.initiator, "operator");
    assert.ok(req.expiresInMs > 0, "the plugin's access-request TTL is forwarded");
    assert.ok(req.summary.length > 0, "a human-readable summary is built");
    assert.equal(req.requested, undefined);
  } finally {
    await server.stop();
  }
});

test("a refused native confirm denies the plugin's call", async () => {
  const { confirmation, calls } = recordingConfirmer(false);
  const { server, host, plugin } = await bootMediaServer(confirmation);
  try {
    host.accessPassManager().issue(PEER, MEDIA_SIGNAL_SCOPE, 60_000);
    const result = await plugin.initiateCall({ peerId: PEER, kind: "camera" });
    assert.deepEqual(result, { ok: false, error: "media-access-denied" });
    assert.equal(calls.length, 1);
  } finally {
    await server.stop();
  }
});

test("media access fails closed when no native confirmer is wired", async () => {
  const { server, host, plugin } = await bootMediaServer();
  try {
    host.accessPassManager().issue(PEER, MEDIA_SIGNAL_SCOPE, 60_000);
    const result = await plugin.initiateCall({ peerId: PEER, kind: "camera" });
    assert.deepEqual(result, { ok: false, error: "media-access-denied" });
  } finally {
    await server.stop();
  }
});

test("a well-formed accessRequested event always reaches the raw confirmer", async () => {
  const { confirmation, calls } = recordingConfirmer(true);
  const { server, host } = await bootMediaServer(confirmation);
  try {
    await host.hookRegistry().emit("media:accessRequested", {
      requestId: "req-1",
      peerId: PEER,
      kind: "microphone",
      direction: "inbound",
      expiresInMs: 1234,
    });
    // The listener is fire-and-forget (`void`); let its microtasks settle.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);
    const req = calls[0];
    assert.equal(req.kind, "media-access-request");
    assert.equal(req.peerId, PEER);
    assert.equal(req.mediaKind, "microphone");
    assert.equal(req.expiresInMs, 1234);
  } finally {
    await server.stop();
  }
});

test("a malformed accessRequested event is ignored (no confirm, no throw)", async () => {
  const { confirmation, calls } = recordingConfirmer(true);
  const { server, host } = await bootMediaServer(confirmation);
  try {
    for (const payload of [
      null,
      { requestId: 42 },
      { requestId: "req", peerId: 7, kind: "camera", expiresInMs: 1000 },
      { requestId: "req", peerId: PEER, kind: "geiger", expiresInMs: 1000 },
      { requestId: "req", peerId: PEER, kind: "camera", expiresInMs: "now" },
    ]) {
      await host.hookRegistry().emit("media:accessRequested", payload);
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 0, "malformed payloads must never reach the confirmer");
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// Stap 4 — the media session lifecycle is a local-operator (httpBridgeOnly)
// privilege, exercised over the local HTTP bridge
// ---------------------------------------------------------------------------

test("media session skills are registered httpBridgeOnly (never network-reachable)", async () => {
  const { server, port } = await bootMediaServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/capabilities`, {
      headers: { Authorization: `Bearer ${MEDIA_GLUE_TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      local: {
        skills: Array<{
          skill: string;
          localOnly: boolean;
          httpExposed: boolean;
          httpBridgeOnly?: boolean;
          capabilityType?: string;
        }>;
      };
    };
    for (const skill of SESSION_SKILLS) {
      const found = body.local.skills.find((s) => s.skill === skill);
      assert.ok(found, `${skill} should be registered`);
      assert.equal(found.localOnly, true, `${skill} must be local-only`);
      assert.equal(found.httpExposed, true, `${skill} must be reachable over the local HTTP bridge`);
      assert.equal(found.httpBridgeOnly, true, `${skill} must be httpBridgeOnly`);
      assert.equal(found.capabilityType, "action", `${skill} is a discrete action capability`);
    }
  } finally {
    await server.stop();
  }
});

test("media.requestSession over the HTTP bridge runs both gates and fails closed on a refusal", async () => {
  const { confirmation, calls } = recordingConfirmer(false);
  const { server, host, port } = await bootMediaServer(confirmation);
  try {
    // Give the target peer a `media-signal` access pass so Gate 1 passes and
    // the request reaches Gate 2 — the raw Tier-2 confirmation — which is
    // refused here, so the session must fail closed with no session opened.
    host.accessPassManager().issue(PEER, MEDIA_SIGNAL_SCOPE, 60_000);

    const res = await fetch(`http://127.0.0.1:${port}/api/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${MEDIA_GLUE_TOKEN}`,
      },
      body: JSON.stringify({
        serviceId: "media",
        method: "requestSession",
        arguments: { peerId: PEER, kind: "camera" },
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      status: string;
      result?: { ok?: boolean; error?: string };
      error?: string;
    };
    assert.equal(body.status, "ok", "the skill executed without a bridge-level error");
    assert.deepEqual(body.result, { ok: false, error: "media-access-denied" });
    assert.equal(calls.length, 1, "the raw tier-2 confirm must run exactly once");
    assert.equal(calls[0].kind, "media-access-request");
    assert.equal(calls[0].peerId, PEER);
  } finally {
    await server.stop();
  }
});

test("media session skills are unreachable over the network (httpBridgeOnly is structural)", async () => {
  const { server, host, port } = await bootMediaServer();
  try {
    // Simulate an inbound network task for a session-lifecycle skill: the
    // broker must deny it before dispatch, exactly like a LAN/WAN peer trying
    // to open or tear down a session.
    const result = await host.taskBroker().handleRemote({
      id: "net-task",
      skill: "media.requestSession",
      payload: { peerId: PEER, kind: "camera" },
      peerId: PEER,
    });
    assert.equal(result.status, "error");
    assert.match(result.error ?? "", /local-only and not network-accessible/);
    // The local HTTP bridge still works (control for the structural split).
    const res = await fetch(`http://127.0.0.1:${port}/api/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${MEDIA_GLUE_TOKEN}`,
      },
      body: JSON.stringify({ serviceId: "media", method: "getStreamStatus", arguments: {} }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; result?: { ok?: boolean; error?: string } };
    assert.equal(body.status, "ok");
    assert.deepEqual(body.result, { ok: false, error: "no such session" });
  } finally {
    await server.stop();
  }
});
