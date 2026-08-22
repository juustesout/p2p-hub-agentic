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
import { TrustTierGate, type TrustConfirmation } from "@p2p-hub/core";
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
