import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MEDIA_FRAME_RATE,
  MAX_MEDIA_RESOLUTION,
  MEDIA_PROTOCOL_ID,
  MEDIA_PROTOCOL_VERSION,
  buildMediaRequest,
  buildMediaRequestSummary,
  encodeMediaError,
  encodeMediaGrant,
  parseMediaRequest,
  parseMediaResponse,
  serializeMediaEnvelope,
} from "./media-contract";

test("the request envelope serializes to pinned canonical bytes", () => {
  const bytes = serializeMediaEnvelope(buildMediaRequest("camera"));
  assert.equal(
    bytes,
    '{"protocol":"p2p-hub:media","version":1,"kind":"camera"}',
  );
});

test("the request with params serializes in fixed key order", () => {
  const bytes = serializeMediaEnvelope(
    buildMediaRequest("microphone", { frameRate: 30, width: 640, height: 480 }),
  );
  assert.equal(
    bytes,
    '{"protocol":"p2p-hub:media","version":1,"kind":"microphone","requested":{"width":640,"height":480,"frameRate":30}}',
  );
});

test("the grant response serializes to pinned canonical bytes", () => {
  const bytes = serializeMediaEnvelope(encodeMediaGrant(60_000));
  assert.equal(
    bytes,
    '{"protocol":"p2p-hub:media","version":1,"status":"granted","expiresInMs":60000}',
  );
});

test("the error response serializes to pinned canonical bytes", () => {
  const bytes = serializeMediaEnvelope(encodeMediaError("denied"));
  assert.equal(
    bytes,
    '{"protocol":"p2p-hub:media","version":1,"status":"error","code":"denied"}',
  );
});

test("buildMediaRequest and serialize are round-trip stable", () => {
  const req = buildMediaRequest("camera", { width: 1280, height: 720 });
  assert.deepEqual(parseMediaRequest(req), {
    ok: true,
    request: {
      protocol: "p2p-hub:media",
      version: 1,
      kind: "camera",
      requested: { width: 1280, height: 720 },
    },
  });
  assert.equal(
    serializeMediaEnvelope(req),
    '{"protocol":"p2p-hub:media","version":1,"kind":"camera","requested":{"width":1280,"height":720}}',
  );
});

test("parseMediaRequest accepts a canonical request with and without params", () => {
  assert.deepEqual(
    parseMediaRequest({ protocol: "p2p-hub:media", version: 1, kind: "microphone" }),
    {
      ok: true,
      request: { protocol: "p2p-hub:media", version: 1, kind: "microphone" },
    },
  );
  const parsed = parseMediaRequest({
    protocol: "p2p-hub:media",
    version: 1,
    kind: "camera",
    requested: { width: 1920, height: 1080, frameRate: 60 },
  });
  assert.deepEqual(parsed, {
    ok: true,
    request: {
      protocol: "p2p-hub:media",
      version: 1,
      kind: "camera",
      requested: { width: 1920, height: 1080, frameRate: 60 },
    },
  });
});

test("parseMediaRequest rejects an unknown protocol as unsupported-version", () => {
  assert.deepEqual(
    parseMediaRequest({ protocol: "p2p-hub:website", version: 1, kind: "camera" }),
    { ok: false, code: "unsupported-version" },
  );
});

test("parseMediaRequest rejects an unknown version as unsupported-version", () => {
  assert.deepEqual(
    parseMediaRequest({ protocol: "p2p-hub:media", version: 2, kind: "camera" }),
    { ok: false, code: "unsupported-version" },
  );
});

test("parseMediaRequest rejects malformed shapes", () => {
  assert.deepEqual(parseMediaRequest(null), { ok: false, code: "malformed" });
  assert.deepEqual(parseMediaRequest("nope"), { ok: false, code: "malformed" });
  assert.deepEqual(parseMediaRequest([]), { ok: false, code: "malformed" });
  // Unknown fields (e.g. a smuggled peerId) are rejected — the envelope never
  // carries an identity; authorization is the platform's job.
  const smuggled = buildMediaRequest("camera") as unknown as Record<string, unknown>;
  smuggled.peerId = "deadbeef";
  assert.deepEqual(parseMediaRequest(smuggled), {
    ok: false,
    code: "malformed",
  });
  // Missing required fields.
  assert.deepEqual(
    parseMediaRequest({ protocol: "p2p-hub:media", version: 1 }),
    { ok: false, code: "malformed" },
  );
  // Unknown kind.
  assert.deepEqual(
    parseMediaRequest({ protocol: "p2p-hub:media", version: 1, kind: "geiger" }),
    { ok: false, code: "malformed" },
  );
});

test("parseMediaRequest rejects out-of-bounds stream params", () => {
  const withParams = (requested: Record<string, unknown>) =>
    parseMediaRequest({
      protocol: "p2p-hub:media",
      version: 1,
      kind: "camera",
      requested,
    });
  assert.deepEqual(withParams({ width: MAX_MEDIA_RESOLUTION + 1 }), {
    ok: false,
    code: "malformed",
  });
  assert.deepEqual(withParams({ height: 8 }), {
    ok: false,
    code: "malformed",
  });
  assert.deepEqual(withParams({ frameRate: MAX_MEDIA_FRAME_RATE + 1 }), {
    ok: false,
    code: "malformed",
  });
  assert.deepEqual(withParams({ width: 640.5 }), {
    ok: false,
    code: "malformed",
  });
  assert.deepEqual(withParams({ foo: 1 }), {
    ok: false,
    code: "malformed",
  });
  // Boundary values are accepted.
  assert.deepEqual(withParams({ width: 16, height: 8192, frameRate: 1 }), {
    ok: true,
    request: {
      protocol: "p2p-hub:media",
      version: 1,
      kind: "camera",
      requested: { width: 16, height: 8192, frameRate: 1 },
    },
  });
});

test("buildMediaRequestSummary renders a safe prompt string", () => {
  assert.equal(
    buildMediaRequestSummary(buildMediaRequest("camera")),
    "camera access with default settings",
  );
  assert.equal(
    buildMediaRequestSummary(buildMediaRequest("microphone", { width: 640, height: 480 })),
    "microphone access (640x480)",
  );
  assert.equal(
    buildMediaRequestSummary(
      buildMediaRequest("camera", { width: 1280, height: 720, frameRate: 60 }),
    ),
    "camera access (1280x720, 60 fps)",
  );
});

test("parseMediaResponse accepts a canonical grant", () => {
  const ok = encodeMediaGrant(120_000);
  const parsed = parseMediaResponse(ok);
  assert.ok(parsed);
  assert.equal(parsed.status, "granted");
  assert.equal(parsed.expiresInMs, 120_000);
});

test("parseMediaResponse accepts a canonical error", () => {
  const err = encodeMediaError("unauthorized");
  const parsed = parseMediaResponse(err);
  assert.ok(parsed);
  assert.equal(parsed.status, "error");
  assert.equal(parsed.code, "unauthorized");
});

test("parseMediaResponse rejects non-compliant responses", () => {
  assert.equal(parseMediaResponse(null), null);
  assert.equal(parseMediaResponse("nope"), null);
  assert.equal(
    parseMediaResponse({ protocol: "p2p-hub:media", version: 1, status: "granted" }),
    null,
  );
  assert.equal(
    parseMediaResponse({
      protocol: "p2p-hub:media",
      version: 1,
      status: "granted",
      expiresInMs: 0,
    }),
    null,
  );
  assert.equal(
    parseMediaResponse({
      protocol: "p2p-hub:media",
      version: 1,
      status: "granted",
      expiresInMs: 1000,
      extra: true,
    }),
    null,
  );
  assert.equal(
    parseMediaResponse({
      protocol: "p2p-hub:media",
      version: 9,
      status: "granted",
      expiresInMs: 1000,
    }),
    null,
  );
  assert.equal(
    parseMediaResponse({
      protocol: "p2p-hub:media",
      version: 1,
      status: "error",
      code: "something-else",
    }),
    null,
  );
});

test("the protocol id/version constants are stable identifiers", () => {
  assert.equal(MEDIA_PROTOCOL_ID, "p2p-hub:media");
  assert.equal(MEDIA_PROTOCOL_VERSION, 1);
});
