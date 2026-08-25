import type { EventEmitBody, SubAckBody, SubReqBody } from "./wire-contract";

import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import {
  CERT_FINGERPRINT_RE,
  IDENTITY_BINDING_CONTEXT,
  NETWORK_PROTOCOL_ID,
  NETWORK_PROTOCOL_VERSION,
  PEER_ID_RE,
  SIGNATURE_RE,
  buildIdentityBindingMessage,
  encodeAuth,
  encodeEventEmit,
  encodeHello,
  encodeHelloAck,
  encodeResult,
  encodeSubAck,
  encodeSubReq,
  encodeTask,
  normalizeFingerprint,
  parseEnvelope,
  parseIdentityBinding,
  randomNonce,
  supportedVersion,
  verifyIdentityBinding,
} from "./wire-contract";

// The canonical serializations below are pinned on purpose: they are the wire
// contract. If a canonical field order or the protocol id/version ever changes,
// these tests (and any independent implementation following the spec) must be
// reviewed. This is the "no shared TS constructor" guarantee — the bytes are
// the source of truth.
const nonce = "a".repeat(32);
const binding = {
  peerId: "b".repeat(64),
  certFingerprint: "c".repeat(64),
  signature: "d".repeat(128),
};

test("canonical serializations are pinned byte-for-byte", () => {
  assert.equal(
    encodeHello([1], ["echo"], nonce),
    '{"protocol":"p2p-hub:network","version":1,"type":"hello",' +
      `"body":{"versions":[1],"capabilities":["echo"],"nonce":"${nonce}"}}`,
  );
  assert.equal(
    encodeHelloAck(1, ["echo"], { maxPayloadBytes: 1000 }, nonce, binding),
    '{"protocol":"p2p-hub:network","version":1,"type":"hello_ack",' +
      `"body":{"version":1,"capabilities":["echo"],"limits":{"maxPayloadBytes":1000},"nonce":"${nonce}",` +
      `"identity":{"peerId":"${binding.peerId}","certFingerprint":"${binding.certFingerprint}","signature":"${binding.signature}"}}}`,
  );
  assert.equal(
    encodeTask({ id: "t", skill: "echo", payload: "hi" }),
    '{"protocol":"p2p-hub:network","version":1,"type":"task",' +
      '"body":{"id":"t","skill":"echo","payload":"hi"}}',
  );
  assert.equal(
    encodeResult({ taskId: "t", status: "ok", result: {} }),
    '{"protocol":"p2p-hub:network","version":1,"type":"result",' +
      '"body":{"taskId":"t","status":"ok","result":{}}}',
  );
  assert.equal(
    encodeResult({ taskId: "t", status: "error", error: "boom" }),
    '{"protocol":"p2p-hub:network","version":1,"type":"result",' +
      '"body":{"taskId":"t","status":"error","error":"boom"}}',
  );
  assert.equal(
    encodeResult({ taskId: "t", status: "error", result: { x: 1 }, error: "boom" }),
    '{"protocol":"p2p-hub:network","version":1,"type":"result",' +
      '"body":{"taskId":"t","status":"error","result":{"x":1},"error":"boom"}}',
  );
  // The 3-arg hello (no reverse-registration hints) is the canonical minimal
  // form; the hints form below is pinned too so the byte layout stays stable.
  assert.equal(
    encodeHello([1], ["echo"], nonce, { instanceId: "inst-1", listenPort: 43210 }),
    '{"protocol":"p2p-hub:network","version":1,"type":"hello",' +
      `"body":{"versions":[1],"capabilities":["echo"],"nonce":"${nonce}",` +
      '"instanceId":"inst-1","listenPort":43210}}',
  );
});

test("every encoded message round-trips through parseEnvelope", () => {
  const messages = [
    encodeHello([1], ["a", "b"], nonce),
    encodeHello([1], ["a"], nonce, { instanceId: "inst-x", listenPort: 4242 }),
    encodeHelloAck(1, ["a"], { maxPayloadBytes: 1000 }, nonce, binding),
    encodeHelloAck(1, [], undefined, nonce, binding),
    encodeTask({ id: "t1", skill: "s", payload: { deep: [1, 2, 3] } }),
    encodeResult({ taskId: "t1", status: "ok", result: 42 }),
    encodeResult({ taskId: "t1", status: "error", error: "no" }),
  ];
  for (const raw of messages) {
    const envelope = parseEnvelope(JSON.parse(raw));
    assert.ok(envelope, `must parse: ${raw}`);
    assert.equal(envelope.protocol, NETWORK_PROTOCOL_ID);
    assert.equal(envelope.version, NETWORK_PROTOCOL_VERSION);
  }
  // The hints survive a round-trip in canonical order.
  const parsed = parseEnvelope(
    JSON.parse(encodeHello([1], ["a"], nonce, { instanceId: "inst-x", listenPort: 4242 })),
  ) as { body: { instanceId?: string; listenPort?: number } };
  assert.equal(parsed.body.instanceId, "inst-x");
  assert.equal(parsed.body.listenPort, 4242);
  // Absent hints round-trip as absent.
  const plain = parseEnvelope(JSON.parse(encodeHello([1], ["a"], nonce))) as {
    body: { instanceId?: string; listenPort?: number };
  };
  assert.equal(plain.body.instanceId, undefined);
  assert.equal(plain.body.listenPort, undefined);
});

test("parseEnvelope default-denies malformed reverse-registration hints", () => {
  const base = {
    protocol: NETWORK_PROTOCOL_ID,
    version: 1,
    type: "hello",
  };
  const valid = { versions: [1], capabilities: [], nonce };
  // A valid hints pair parses.
  assert.ok(
    parseEnvelope({
      ...base,
      body: { ...valid, instanceId: "inst-1", listenPort: 43210 },
    }),
  );
  // Bad instanceId (spaces, too long, empty, leading dash).
  for (const bad of ["bad id", "a".repeat(65), "", "-lead"]) {
    assert.equal(
      parseEnvelope({ ...base, body: { ...valid, instanceId: bad, listenPort: 43210 } }),
      null,
      `instanceId ${JSON.stringify(bad)} must be denied`,
    );
  }
  // Bad listenPort (0, >65535, negative, non-integer, string).
  for (const bad of [0, 65536, -1, 1.5, "43210"]) {
    assert.equal(
      parseEnvelope({ ...base, body: { ...valid, instanceId: "inst-1", listenPort: bad } }),
      null,
      `listenPort ${JSON.stringify(bad)} must be denied`,
    );
  }
});

test("parseEnvelope default-denies unknown protocol, version and shape", () => {
  const validBody = { versions: [1], capabilities: [], nonce };
  // Unknown protocol id.
  assert.equal(
    parseEnvelope({ protocol: "p2p-hub:other", version: 1, type: "hello", body: validBody }),
    null,
  );
  // Unsupported version.
  assert.equal(
    parseEnvelope({ protocol: NETWORK_PROTOCOL_ID, version: 2, type: "hello", body: validBody }),
    null,
  );
  // Unknown message type.
  assert.equal(
    parseEnvelope({ protocol: NETWORK_PROTOCOL_ID, version: 1, type: "nope", body: {} }),
    null,
  );
  // Not an object.
  assert.equal(parseEnvelope("hello"), null);
  assert.equal(parseEnvelope(null), null);

  // hello: empty / string versions.
  assert.equal(
    parseEnvelope({ protocol: NETWORK_PROTOCOL_ID, version: 1, type: "hello", body: { versions: [], capabilities: [], nonce } }),
    null,
  );
  assert.equal(
    parseEnvelope({ protocol: NETWORK_PROTOCOL_ID, version: 1, type: "hello", body: { versions: ["1"], capabilities: [], nonce } }),
    null,
  );
  // hello: too many capabilities.
  assert.equal(
    parseEnvelope({
      protocol: NETWORK_PROTOCOL_ID,
      version: 1,
      type: "hello",
      body: { versions: [1], capabilities: new Array(257).fill("s"), nonce },
    }),
    null,
  );
  // hello: missing nonce (anonymous mode is gone — the nonce is mandatory).
  assert.equal(
    parseEnvelope({ protocol: NETWORK_PROTOCOL_ID, version: 1, type: "hello", body: { versions: [1], capabilities: [] } }),
    null,
  );

  // task: missing id / missing payload.
  assert.equal(
    parseEnvelope({ protocol: NETWORK_PROTOCOL_ID, version: 1, type: "task", body: { skill: "s", payload: 1 } }),
    null,
  );
  assert.equal(
    parseEnvelope({ protocol: NETWORK_PROTOCOL_ID, version: 1, type: "task", body: { id: "t", skill: "s" } }),
    null,
  );

  // result: bad status / non-string error.
  assert.equal(
    parseEnvelope({ protocol: NETWORK_PROTOCOL_ID, version: 1, type: "result", body: { taskId: "t", status: "maybe" } }),
    null,
  );
  assert.equal(
    parseEnvelope({ protocol: NETWORK_PROTOCOL_ID, version: 1, type: "result", body: { taskId: "t", status: "error", error: 5 } }),
    null,
  );

  // hello_ack: non-positive version / invalid limit.
  assert.equal(
    parseEnvelope({ protocol: NETWORK_PROTOCOL_ID, version: 1, type: "hello_ack", body: { version: 0, capabilities: [], nonce, identity: binding } }),
    null,
  );
  assert.equal(
    parseEnvelope({
      protocol: NETWORK_PROTOCOL_ID,
      version: 1,
      type: "hello_ack",
      body: { version: 1, capabilities: [], limits: { maxPayloadBytes: 0 }, nonce, identity: binding },
    }),
    null,
  );
  // hello_ack: missing nonce or missing identity is denied (no anonymous mode).
  assert.equal(
    parseEnvelope({ protocol: NETWORK_PROTOCOL_ID, version: 1, type: "hello_ack", body: { version: 1, capabilities: [], identity: binding } }),
    null,
  );
  assert.equal(
    parseEnvelope({ protocol: NETWORK_PROTOCOL_ID, version: 1, type: "hello_ack", body: { version: 1, capabilities: [], nonce } }),
    null,
  );
});

test("supportedVersion requires exact supported membership — no negotiation, no downgrade", () => {
  assert.equal(supportedVersion([1]), NETWORK_PROTOCOL_VERSION);
  assert.equal(supportedVersion([2, 1]), NETWORK_PROTOCOL_VERSION);
  // A hypothetical higher version next to the supported one must NOT win:
  // the server picks the exact version it supports, never "the highest".
  assert.equal(supportedVersion([999, 1]), NETWORK_PROTOCOL_VERSION);
  assert.equal(supportedVersion([999]), null);
  assert.equal(supportedVersion([2]), null);
  assert.equal(supportedVersion([]), null);
  assert.equal(supportedVersion(undefined), null);
  assert.equal(supportedVersion("1"), null);
  assert.equal(supportedVersion([1, "1"]), NETWORK_PROTOCOL_VERSION);
});

test("identity binding serialization is canonical and round-trips", () => {
  const nonce = "a".repeat(32);
  const binding = {
    peerId: "b".repeat(64),
    certFingerprint: "c".repeat(64),
    signature: "d".repeat(128),
  };

  assert.equal(
    encodeHello([1], ["echo"], nonce),
    '{"protocol":"p2p-hub:network","version":1,"type":"hello",' +
      `"body":{"versions":[1],"capabilities":["echo"],"nonce":"${nonce}"}}`,
  );
  assert.equal(
    encodeHelloAck(1, ["echo"], undefined, nonce, binding),
    '{"protocol":"p2p-hub:network","version":1,"type":"hello_ack",' +
      `"body":{"version":1,"capabilities":["echo"],"nonce":"${nonce}",` +
      `"identity":{"peerId":"${binding.peerId}","certFingerprint":"${binding.certFingerprint}","signature":"${binding.signature}"}}}`,
  );
  assert.equal(
    encodeAuth(binding),
    '{"protocol":"p2p-hub:network","version":1,"type":"auth",' +
      `"body":{"peerId":"${binding.peerId}","certFingerprint":"${binding.certFingerprint}","signature":"${binding.signature}"}}`,
  );

  for (const raw of [encodeAuth(binding), encodeHelloAck(1, [], undefined, nonce, binding)]) {
    const envelope = parseEnvelope(JSON.parse(raw));
    assert.ok(envelope, "auth/hello_ack with identity must parse");
    const body = envelope.body as {
      identity?: typeof binding;
      peerId?: string;
    };
    const parsed = ("identity" in body && body.identity ? body.identity : body) as typeof binding;
    assert.equal(parsed.peerId, binding.peerId);
    assert.equal(parsed.certFingerprint, binding.certFingerprint);
    assert.equal(parsed.signature, binding.signature);
  }
});

test("parseEnvelope default-denies malformed nonce, identity and auth", () => {
  const ackBase = { protocol: NETWORK_PROTOCOL_ID, version: 1, type: "hello_ack" };
  const validBody = { version: 1, capabilities: [], nonce, identity: binding };
  // Malformed nonces.
  assert.equal(
    parseEnvelope({ ...ackBase, body: { ...validBody, nonce: "xyz" } }),
    null,
  );
  assert.equal(
    parseEnvelope({ ...ackBase, body: { ...validBody, nonce: "0" } }),
    null,
  );
  assert.equal(
    parseEnvelope({
      ...ackBase,
      body: { ...validBody, nonce: "a".repeat(65) },
    }),
    null,
  );
  // Identity with wrong shapes.
  const badIdentity = (field: string) => ({
    ...ackBase,
    body: { ...validBody, identity: { peerId: "b".repeat(64), certFingerprint: "c".repeat(64), signature: "d".repeat(128), [field]: "z" } },
  });
  assert.equal(parseEnvelope(badIdentity("peerId")), null);
  assert.equal(parseEnvelope(badIdentity("certFingerprint")), null);
  assert.equal(parseEnvelope(badIdentity("signature")), null);
  assert.equal(
    parseEnvelope({ ...ackBase, body: { ...validBody, identity: { peerId: "x".repeat(63) } } }),
    null,
  );
  // auth with a structurally invalid body.
  assert.equal(
    parseEnvelope({ protocol: NETWORK_PROTOCOL_ID, version: 1, type: "auth", body: { peerId: "x" } }),
    null,
  );
  assert.equal(
    parseEnvelope({ protocol: NETWORK_PROTOCOL_ID, version: 1, type: "auth", body: "nope" }),
    null,
  );
});

test("verifyIdentityBinding accepts a real signature and denies tampering", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  const peerId = Buffer.from(jwk.x, "base64url").toString("hex");
  const certFingerprint = "ab".repeat(32);
  const clientNonce = randomNonce();
  const serverNonce = randomNonce();

  const signature = crypto.sign(
    null,
    buildIdentityBindingMessage(clientNonce, serverNonce, certFingerprint),
    privateKey,
  );

  assert.ok(
    verifyIdentityBinding(peerId, clientNonce, serverNonce, certFingerprint, signature.toString("hex")),
  );
  // Wrong nonce.
  assert.equal(
    verifyIdentityBinding(peerId, clientNonce, "0".repeat(32), certFingerprint, signature.toString("hex")),
    false,
  );
  // Wrong cert fingerprint.
  assert.equal(
    verifyIdentityBinding(peerId, clientNonce, serverNonce, "ff".repeat(32), signature.toString("hex")),
    false,
  );
  // Wrong peer id (different key).
  const other = crypto.generateKeyPairSync("ed25519");
  const otherJwk = other.publicKey.export({ format: "jwk" }) as { x: string };
  const otherPeerId = Buffer.from(otherJwk.x, "base64url").toString("hex");
  assert.equal(
    verifyIdentityBinding(otherPeerId, clientNonce, serverNonce, certFingerprint, signature.toString("hex")),
    false,
  );
  // Malformed inputs never throw, always false.
  assert.equal(verifyIdentityBinding("zz", clientNonce, serverNonce, certFingerprint, signature.toString("hex")), false);
  assert.equal(verifyIdentityBinding(peerId, clientNonce, serverNonce, "zz", signature.toString("hex")), false);
  assert.equal(verifyIdentityBinding(peerId, clientNonce, serverNonce, certFingerprint, "zz"), false);
});

test("identity binding message bytes are pinned and domain-separated", () => {
  const msg = buildIdentityBindingMessage("aa", "bb", "cc");
  assert.equal(
    msg.toString("utf8"),
    `${IDENTITY_BINDING_CONTEXT}aa:bb:cc`,
  );
  assert.equal(normalizeFingerprint("AB:CD:EF"), "abcdef");
  assert.equal(normalizeFingerprint(undefined), "");
  assert.equal(PEER_ID_RE.test("a".repeat(64)), true);
  assert.equal(PEER_ID_RE.test("A".repeat(64)), false);
  assert.equal(CERT_FINGERPRINT_RE.test("a".repeat(64)), true);
  assert.equal(SIGNATURE_RE.test("a".repeat(128)), true);
  assert.equal(parseIdentityBinding(null), null);
  assert.equal(parseIdentityBinding("nope"), null);
});

test("sub_req serialization is canonical and round-trips", () => {
  const body: SubReqBody = { subscriptionId: "sub-1", topic: "calendar:eventAdded", action: "subscribe", ttlMs: 300_000 };
  assert.equal(
    encodeSubReq(body),
    '{"protocol":"p2p-hub:network","version":1,"type":"sub_req",' +
      `"body":{"subscriptionId":"${body.subscriptionId}","topic":"${body.topic}",` +
      `"action":"subscribe","ttlMs":${body.ttlMs}}}`,
  );

  const envelope = parseEnvelope(JSON.parse(encodeSubReq(body)));
  assert.ok(envelope, "sub_req must parse");
  assert.equal(envelope.type, "sub_req");
  assert.deepEqual(envelope.body, body);

  // round-trips each action
  for (const action of ["subscribe", "unsubscribe"] as const) {
    const e = parseEnvelope(JSON.parse(encodeSubReq({ ...body, action })));
    assert.ok(e, `sub_req ${action} must parse`);
  }
});

test("sub_req default-denies malformed bodies", () => {
  const base = { protocol: NETWORK_PROTOCOL_ID, version: 1, type: "sub_req" };
  const valid: SubReqBody = { subscriptionId: "sub-1", topic: "calendar:eventAdded", action: "subscribe", ttlMs: 300_000 };

  // Bad subscriptionId: empty, spaces, over-long, wildcard chars.
  for (const bad of ["", "sub id", "s".repeat(129), "sub-*", "sub/+", "é"]) {
    assert.equal(
      parseEnvelope({ ...base, body: { ...valid, subscriptionId: bad } }),
      null,
      `subscriptionId ${JSON.stringify(bad)} must be denied`,
    );
  }
  // Bad topic: empty, over-long, bad chars, empty namespace, bare/mid-string
  // wildcards. The only valid wildcard is a terminal `:*`.
  for (const bad of ["", "e".repeat(513), "bad topic", "calendar:event Added", "calendar:", ":event", "calendar::event", "*", "calendar*", "calendar:e*v", "calendar/e", "calendar/e:v"]) {
    assert.equal(
      parseEnvelope({ ...base, body: { ...valid, topic: bad } }),
      null,
      `topic ${JSON.stringify(bad)} must be denied`,
    );
  }
  // A terminal `:*` wildcard and dotted segments ARE valid.
  assert.ok(parseEnvelope({ ...base, body: { ...valid, topic: "calendar:*" } }), "calendar:* must parse");
  assert.ok(parseEnvelope({ ...base, body: { ...valid, topic: "a.b:c.d" } }), "dotted segments must parse");
  // Bad action.
  for (const bad of ["sub", "", "renewal", "SUBSCRIBE", 5]) {
    assert.equal(
      parseEnvelope({ ...base, body: { ...valid, action: bad as never } }),
      null,
      `action ${JSON.stringify(bad)} must be denied`,
    );
  }
  // Bad ttlMs: zero, negative, fractional, non-number. (There is no upper
  // bound: the value is only a *request*; the publisher grants its own ttl.)
  for (const bad of [0, -1, 1.5, "300000"]) {
    assert.equal(
      parseEnvelope({ ...base, body: { ...valid, ttlMs: bad as never } }),
      null,
      `ttlMs ${JSON.stringify(bad)} must be denied`,
    );
  }
  // Missing required fields are denied.
  assert.equal(parseEnvelope({ ...base, body: { subscriptionId: "sub-1" } }), null);
});

test("sub_ack serialization is canonical and round-trips", () => {
  const accept: SubAckBody = { subscriptionId: "sub-1", topic: "calendar:eventAdded", accepted: true, ttlMs: 300_000 };
  assert.equal(
    encodeSubAck(accept),
    '{"protocol":"p2p-hub:network","version":1,"type":"sub_ack",' +
      `"body":{"subscriptionId":"${accept.subscriptionId}","topic":"${accept.topic}",` +
      `"accepted":true,"ttlMs":${accept.ttlMs}}}`,
  );

  const parsed = parseEnvelope(JSON.parse(encodeSubAck(accept)));
  assert.ok(parsed, "sub_ack must parse");
  assert.equal(parsed.type, "sub_ack");
  assert.deepEqual(parsed.body, accept);

  // accepted: false + a bounded reason round-trips.
  const reject: SubAckBody = { subscriptionId: "sub-1", topic: "calendar:eventAdded", accepted: false, reason: "denied by policy" };
  const rejected = parseEnvelope(JSON.parse(encodeSubAck(reject)));
  assert.ok(rejected);
  assert.deepEqual(rejected.body, reject);
});

test("sub_ack default-denies malformed bodies", () => {
  const base = { protocol: NETWORK_PROTOCOL_ID, version: 1, type: "sub_ack" };
  const valid: SubAckBody = { subscriptionId: "sub-1", topic: "calendar:eventAdded", accepted: true };
  assert.equal(parseEnvelope({ ...base, body: { ...valid, accepted: "yes" as never } }), null);
  // reason must be non-empty and bounded when present.
  assert.equal(parseEnvelope({ ...base, body: { ...valid, accepted: false, reason: "" } }), null);
  assert.equal(parseEnvelope({ ...base, body: { ...valid, accepted: false, reason: "r".repeat(513) } }), null);
  assert.equal(parseEnvelope({ ...base, body: { ...valid, topic: "calendar:*x" } }), null);
  assert.equal(parseEnvelope({ ...base, body: { ...valid, ttlMs: 1.5 } }), null);
});

test("event_emit serialization is canonical and round-trips", () => {
  const body: EventEmitBody = {
    subscriptionId: "sub-1",
    topic: "calendar:eventAdded",
    publisherPeerId: "b".repeat(64),
    timestamp: 1_700_000_000_000,
    sequenceNumber: 7,
    payload: { hello: "world" },
  };
  assert.equal(
    encodeEventEmit(body),
    '{"protocol":"p2p-hub:network","version":1,"type":"event_emit",' +
      `"body":{"subscriptionId":"${body.subscriptionId}","topic":"${body.topic}",` +
      `"publisherPeerId":"${body.publisherPeerId}",` +
      `"timestamp":${body.timestamp},"sequenceNumber":${body.sequenceNumber},` +
      `"payload":{"hello":"world"}}}`,
  );

  const parsed = parseEnvelope(JSON.parse(encodeEventEmit(body)));
  assert.ok(parsed, "event_emit must parse");
  assert.equal(parsed.type, "event_emit");
  assert.deepEqual(parsed.body, body);
});

test("event_emit default-denies malformed bodies", () => {
  const base = { protocol: NETWORK_PROTOCOL_ID, version: 1, type: "event_emit" };
  const valid: EventEmitBody = {
    subscriptionId: "sub-1",
    topic: "calendar:eventAdded",
    publisherPeerId: "b".repeat(64),
    timestamp: 1_700_000_000_000,
    sequenceNumber: 7,
    payload: 1,
  };
  // publisherPeerId must be a well-formed peer id — a caller-supplied spoofed
  // identity or malformed value is denied at the contract level.
  for (const bad of ["x".repeat(63), "0x", "b".repeat(65), ""]) {
    assert.equal(
      parseEnvelope({ ...base, body: { ...valid, publisherPeerId: bad } }),
      null,
      `publisherPeerId ${JSON.stringify(bad)} must be denied`,
    );
  }
  // timestamp must be a positive integer; sequenceNumber a non-negative integer.
  assert.equal(parseEnvelope({ ...base, body: { ...valid, timestamp: 0 } }), null);
  assert.equal(parseEnvelope({ ...base, body: { ...valid, timestamp: -5 } }), null);
  assert.equal(parseEnvelope({ ...base, body: { ...valid, timestamp: 1.5 } }), null);
  assert.equal(parseEnvelope({ ...base, body: { ...valid, sequenceNumber: -1 } }), null);
  assert.equal(parseEnvelope({ ...base, body: { ...valid, sequenceNumber: 1.5 } }), null);
  // Missing payload (event_emit is not a valid "no payload" notification).
  assert.equal(
    parseEnvelope({ ...base, body: { ...valid, payload: undefined } }),
    null,
  );
  // topic / subscriptionId still validated.
  assert.equal(parseEnvelope({ ...base, body: { ...valid, topic: "calendar:*x" } }), null);
  assert.equal(parseEnvelope({ ...base, body: { ...valid, subscriptionId: "sub-*" } }), null);
});
