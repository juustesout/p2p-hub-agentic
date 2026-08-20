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
  encodeHello,
  encodeHelloAck,
  encodeResult,
  encodeTask,
  negotiateVersion,
  normalizeFingerprint,
  parseEnvelope,
  parseIdentityBinding,
  randomNonce,
  verifyIdentityBinding,
} from "./wire-contract";

// The canonical serializations below are pinned on purpose: they are the wire
// contract. If a canonical field order or the protocol id/version ever changes,
// these tests (and any independent implementation following the spec) must be
// reviewed. This is the "no shared TS constructor" guarantee — the bytes are
// the source of truth.
test("canonical serializations are pinned byte-for-byte", () => {
  assert.equal(
    encodeHello([1], ["echo"]),
    '{"protocol":"p2p-hub:network","version":1,"type":"hello",' +
      '"body":{"versions":[1],"capabilities":["echo"]}}',
  );
  assert.equal(
    encodeHelloAck(1, ["echo"], { maxPayloadBytes: 1000 }),
    '{"protocol":"p2p-hub:network","version":1,"type":"hello_ack",' +
      '"body":{"version":1,"capabilities":["echo"],"limits":{"maxPayloadBytes":1000}}}',
  );
  assert.equal(
    encodeHelloAck(1, ["echo"]),
    '{"protocol":"p2p-hub:network","version":1,"type":"hello_ack",' +
      '"body":{"version":1,"capabilities":["echo"]}}',
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
});

test("every encoded message round-trips through parseEnvelope", () => {
  const messages = [
    encodeHello([1], ["a", "b"]),
    encodeHelloAck(1, ["a"], { maxPayloadBytes: 1000 }),
    encodeHelloAck(1, []),
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
});

test("parseEnvelope default-denies unknown protocol, version and shape", () => {
  const validBody = { versions: [1], capabilities: [] };
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
    parseEnvelope({ protocol: NETWORK_PROTOCOL_ID, version: 1, type: "hello", body: { versions: [], capabilities: [] } }),
    null,
  );
  assert.equal(
    parseEnvelope({ protocol: NETWORK_PROTOCOL_ID, version: 1, type: "hello", body: { versions: ["1"], capabilities: [] } }),
    null,
  );
  // hello: too many capabilities.
  assert.equal(
    parseEnvelope({
      protocol: NETWORK_PROTOCOL_ID,
      version: 1,
      type: "hello",
      body: { versions: [1], capabilities: new Array(257).fill("s") },
    }),
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
    parseEnvelope({ protocol: NETWORK_PROTOCOL_ID, version: 1, type: "hello_ack", body: { version: 0, capabilities: [] } }),
    null,
  );
  assert.equal(
    parseEnvelope({
      protocol: NETWORK_PROTOCOL_ID,
      version: 1,
      type: "hello_ack",
      body: { version: 1, capabilities: [], limits: { maxPayloadBytes: 0 } },
    }),
    null,
  );
});

test("negotiateVersion picks our version or denies", () => {
  assert.equal(negotiateVersion([1]), NETWORK_PROTOCOL_VERSION);
  assert.equal(negotiateVersion([2, 1]), NETWORK_PROTOCOL_VERSION);
  assert.equal(negotiateVersion([2]), null);
  assert.equal(negotiateVersion([]), null);
  assert.equal(negotiateVersion(undefined), null);
  assert.equal(negotiateVersion("1"), null);
  assert.equal(negotiateVersion([1, "1"]), NETWORK_PROTOCOL_VERSION);
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
  const validBody = { version: 1, capabilities: [] };
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
