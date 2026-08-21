import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_WEBSITE_PATH_LENGTH,
  WEBSITE_PROTOCOL_ID,
  WEBSITE_PROTOCOL_VERSION,
  buildWebsiteRequest,
  encodeWebsiteError,
  encodeWebsiteSuccess,
  parseWebsiteRequest,
  parseWebsiteResponse,
  serializeWebsiteEnvelope,
} from "./website-contract";

test("the request envelope serializes to pinned canonical bytes", () => {
  const bytes = serializeWebsiteEnvelope(buildWebsiteRequest("index.html"));
  assert.equal(
    bytes,
    '{"protocol":"p2p-hub:website","version":1,"path":"index.html"}',
  );
});

test("the success response serializes to pinned canonical bytes", () => {
  const bytes = serializeWebsiteEnvelope(
    encodeWebsiteSuccess({
      contentType: "text/html; charset=utf-8",
      data: "PGgxPmhvbGxvPC9oMT4=",
      name: "index.html",
    }),
  );
  assert.equal(
    bytes,
    '{"protocol":"p2p-hub:website","version":1,"status":"ok","contentType":"text/html; charset=utf-8","data":"PGgxPmhvbGxvPC9oMT4=","name":"index.html"}',
  );
});

test("the error response serializes to pinned canonical bytes", () => {
  const bytes = serializeWebsiteEnvelope(encodeWebsiteError("not-found"));
  assert.equal(
    bytes,
    '{"protocol":"p2p-hub:website","version":1,"status":"error","code":"not-found"}',
  );
});

test("buildWebsiteRequest and serialize are round-trip stable", () => {
  const req = buildWebsiteRequest("sub/about.html");
  assert.deepEqual(parseWebsiteRequest(req), {
    ok: true,
    path: "sub/about.html",
  });
  assert.equal(
    serializeWebsiteEnvelope(req),
    '{"protocol":"p2p-hub:website","version":1,"path":"sub/about.html"}',
  );
});

test("parseWebsiteRequest accepts a canonical request", () => {
  const parsed = parseWebsiteRequest({
    protocol: "p2p-hub:website",
    version: 1,
    path: "a/b.css",
  });
  assert.deepEqual(parsed, { ok: true, path: "a/b.css" });
});

test("parseWebsiteRequest rejects an unknown protocol as unsupported-version", () => {
  const parsed = parseWebsiteRequest({
    protocol: "p2p-hub:world",
    version: 1,
    path: "index.html",
  });
  assert.deepEqual(parsed, { ok: false, code: "unsupported-version" });
});

test("parseWebsiteRequest rejects an unknown version as unsupported-version", () => {
  const parsed = parseWebsiteRequest({
    protocol: "p2p-hub:website",
    version: 2,
    path: "index.html",
  });
  assert.deepEqual(parsed, { ok: false, code: "unsupported-version" });
});

test("parseWebsiteRequest rejects malformed shapes", () => {
  assert.deepEqual(parseWebsiteRequest(null), { ok: false, code: "malformed" });
  assert.deepEqual(parseWebsiteRequest("nope"), { ok: false, code: "malformed" });
  assert.deepEqual(parseWebsiteRequest([]), { ok: false, code: "malformed" });
  assert.deepEqual(parseWebsiteRequest({ protocol: "p2p-hub:website", version: 1 }), {
    ok: false,
    code: "malformed",
  });
  // Unknown fields (e.g. a smuggled peerId) are rejected — the envelope never
  // carries an identity; authorization is the platform's job.
  const smuggled = buildWebsiteRequest("index.html") as unknown as Record<string, unknown>;
  smuggled.peerId = "deadbeef";
  assert.deepEqual(parseWebsiteRequest(smuggled), {
    ok: false,
    code: "malformed",
  });
  assert.deepEqual(
    parseWebsiteRequest({ protocol: "p2p-hub:website", version: 1, path: "" }),
    { ok: false, code: "malformed" },
  );
  assert.deepEqual(
    parseWebsiteRequest({
      protocol: "p2p-hub:website",
      version: 1,
      path: "x".repeat(MAX_WEBSITE_PATH_LENGTH + 1),
    }),
    { ok: false, code: "malformed" },
  );
  assert.deepEqual(
    parseWebsiteRequest({ protocol: "p2p-hub:website", version: 1, path: 42 }),
    { ok: false, code: "malformed" },
  );
});

test("parseWebsiteResponse accepts a canonical success response", () => {
  const ok = encodeWebsiteSuccess({
    contentType: "image/png",
    data: "aGVsbG8=",
    name: "logo.png",
  });
  const parsed = parseWebsiteResponse(ok);
  assert.ok(parsed);
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.contentType, "image/png");
  assert.equal(parsed.data, "aGVsbG8=");
  assert.equal(parsed.name, "logo.png");
});

test("parseWebsiteResponse accepts a canonical error response", () => {
  const err = encodeWebsiteError("unauthorized");
  const parsed = parseWebsiteResponse(err);
  assert.ok(parsed);
  assert.equal(parsed.status, "error");
  assert.equal(parsed.code, "unauthorized");
});

test("parseWebsiteResponse rejects non-compliant responses", () => {
  assert.equal(parseWebsiteResponse(null), null);
  assert.equal(parseWebsiteResponse("nope"), null);
  assert.equal(
    parseWebsiteResponse({ protocol: "p2p-hub:website", version: 1, status: "ok" }),
    null,
  );
  assert.equal(
    parseWebsiteResponse({
      protocol: "p2p-hub:website",
      version: 1,
      status: "ok",
      contentType: "text/html",
      data: "aGk=",
      name: "i.html",
      extra: true,
    }),
    null,
  );
  assert.equal(
    parseWebsiteResponse({
      protocol: "p2p-hub:website",
      version: 9,
      status: "ok",
      contentType: "text/html",
      data: "aGk=",
      name: "i.html",
    }),
    null,
  );
  assert.equal(
    parseWebsiteResponse({
      protocol: "p2p-hub:website",
      version: 1,
      status: "error",
      code: "something-else",
    }),
    null,
  );
});

test("the protocol id/version constants are stable identifiers", () => {
  assert.equal(WEBSITE_PROTOCOL_ID, "p2p-hub:website");
  assert.equal(WEBSITE_PROTOCOL_VERSION, 1);
});
