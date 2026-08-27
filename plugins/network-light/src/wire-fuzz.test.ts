import { test } from "node:test";
import assert from "node:assert/strict";
import * as tls from "node:tls";
import * as crypto from "node:crypto";
import * as forge from "node-forge";
import { NetworkLightProvider, tryDecodeFrame } from "./network-light-provider";
import type { NetworkLightOptions } from "./network-light-provider";
import type { PeerIdentity } from "@p2p-hub/sdk";
import { MAX_PAYLOAD_BYTES, parseEnvelope } from "./wire-contract";
import { buildIdentityBindingMessage, normalizeFingerprint, randomNonce } from "./wire-contract";

/**
 * Slice 3 — wire-contract fuzzing.
 *
 * The network-light port is a raw TLS socket fed a 4-byte length + JSON frame
 * grammar. Every inbound socket funnels its bytes through `tryDecodeFrame`
 * (byte parser) and `parseEnvelope` (shape parser). These tests pin the
 * fail-closed invariants:
 *
 *   - `tryDecodeFrame` either returns a complete frame, returns `null` (needs
 *     more bytes), or throws a bounded, catchable Error — it never hangs, never
 *     corrupts its input, and never lets a declared length beyond the cap wait
 *     for bytes that can never be valid.
 *   - `parseEnvelope` never throws and returns `null` for any shape that is
 *     not the exact wire contract (unknown types, missing required fields,
 *     wrong types).
 *   - At the socket level, a malformed frame closes the *specific* connection
 *     and the provider keeps serving fresh handshakes afterwards (the socket
 *     loop never hangs and no exception escapes).
 */

// --- deterministic PRNG (xorshift32) so the fuzz corpus is reproducible -----

function prng(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) {
    state = 0x9e3779b9;
  }
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

/** Deterministic pseudo-random bytes. */
function randomBytes(next: () => number, n: number): Buffer {
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    out[i] = next() & 0xff;
  }
  return out;
}

/** A frame whose declared length prefix is biased toward extreme values. */
function randomFrameBuffer(next: () => number): Buffer {
  const roll = next() % 100;
  const declared =
    roll < 15
      ? 0 // empty / weird
      : roll < 30
        ? next() % 8 // tiny
        : roll < 45
          ? (next() % MAX_PAYLOAD_BYTES) + 1 // normal-ish
          : roll < 60
            ? MAX_PAYLOAD_BYTES + (next() % 1_000_000) // beyond the cap
            : 0xffffffff - (next() % 0xffffffff); // huge (up to 4 GiB)
  const header = Buffer.alloc(4);
  header.writeUInt32BE(declared >>> 0, 0);
  const body = randomBytes(next, Math.min(declared, 64));
  return Buffer.concat([header, body]);
}

type SafeDecodeResult =
  | { kind: "complete"; value: unknown; rest: Buffer; declared: number }
  | { kind: "more" }
  | { kind: "rejected"; message: string };

function safeDecode(buffer: Buffer): SafeDecodeResult {
  try {
    const frame = tryDecodeFrame(buffer);
    if (frame === null) {
      return { kind: "more" };
    }
    return {
      kind: "complete",
      value: frame.value,
      rest: frame.rest,
      declared: buffer.length >= 4 ? buffer.readUInt32BE(0) : 0,
    };
  } catch (err) {
    return {
      kind: "rejected",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

test("property: tryDecodeFrame never hangs or corrupts on arbitrary bytes", () => {
  const next = prng(0xc0ffee);
  for (let i = 0; i < 500; i++) {
    const buffer = randomFrameBuffer(next);
    const before = buffer.length;
    const result = safeDecode(buffer);

    if (result.kind === "complete") {
      // A returned frame consumed exactly the declared length plus the header,
      // and `rest` is precisely what followed — never more, never less.
      assert.equal(result.declared, buffer.readUInt32BE(0));
      assert.ok(4 + result.declared <= buffer.length);
      assert.equal(
        result.rest.length,
        buffer.length - 4 - result.declared,
        `rest must be exactly the trailing bytes (case ${i})`,
      );
      assert.ok(
        typeof result.value === "object" ||
          typeof result.value === "string" ||
          typeof result.value === "number" ||
          result.value === null,
        "decoded value must be a parsed JSON value",
      );
    } else if (result.kind === "rejected") {
      assert.ok(result.message.length > 0, "rejection must carry a message");
    }
    assert.equal(buffer.length, before, "decode must not mutate its input");
  }
});

test("property: random full-frame JSON bodies parse or are rejected, never throw", () => {
  const next = prng(0xbeef);
  for (let i = 0; i < 400; i++) {
    const body = randomBytes(next, (next() % 256) + 1);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    const result = safeDecode(Buffer.concat([header, body]));
    if (result.kind === "rejected" || result.kind === "more") {
      // Invalid UTF-8 / invalid JSON / over-long must be rejected or stay
      // pending, never ignored. (`more` is unreachable here — the frame is
      // complete by construction — but keeping it explicit pins the contract.)
      continue;
    }
    // Valid JSON: the next layer (parseEnvelope) must decide, never throw.
    let parsed;
    try {
      parsed = parseEnvelope(result.value);
    } catch (err) {
      assert.fail(`parseEnvelope threw on case ${i}: ${(err as Error).message}`);
    }
    // Unknown protocols/versions/types are the dominant outcome — that's
    // fine; the invariant is: decided (null) or valid, never a crash.
    assert.ok(parsed === null || typeof parsed === "object");
  }
});

test("malformed frames are rejected deterministically", () => {
  // Length prefix far beyond the cap → rejected even before the bytes arrive.
  const huge = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00]);
  assert.equal(safeDecode(huge).kind, "rejected");
  const hugeBare = Buffer.from([0xff, 0xff, 0xff, 0xff]);
  assert.equal(safeDecode(hugeBare).kind, "rejected");

  // Declared length == 0 with an empty body → JSON.parse("") throws.
  assert.equal(safeDecode(Buffer.from([0, 0, 0, 0])).kind, "rejected");

  // Corrupt JSON bodies.
  for (const raw of ["{", "}", "{{{{", "[]]", '"unterminated', "nul", "tru", '{"a":}']) {
    const body = Buffer.from(raw, "utf8");
    const frame = Buffer.concat([header(body.length), body]);
    assert.equal(safeDecode(frame).kind, "rejected", `raw=${JSON.stringify(raw)}`);
  }

  // Invalid UTF-8 bytes inside the body (0xff 0xfe 0xfd are never valid in a
  // UTF-8 JSON stream, so decoding must reject, not silently substitute).
  const badUtf8 = Buffer.concat([header(3), Buffer.from([0xff, 0xfe, 0xfd])]);
  assert.equal(safeDecode(badUtf8).kind, "rejected");

  // A body whose *actual* size exceeds the cap is rejected (validatePayloadSize).
  const oversized = Buffer.concat([header(MAX_PAYLOAD_BYTES + 1), Buffer.alloc(MAX_PAYLOAD_BYTES + 1, 0x20)]);
  assert.equal(safeDecode(oversized).kind, "rejected");

  // Deeply nested JSON is rejected by the pre-parse nesting-depth guard.
  const deep = `{"a":${"[".repeat(64)}"x"${"]".repeat(64)}}`;
  assert.equal(safeDecode(Buffer.concat([header(deep.length), Buffer.from(deep)])).kind, "rejected");
});

function header(length: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(length, 0);
  return b;
}

test("partial frames stay in a pending state until complete", () => {
  const body = JSON.stringify({
    protocol: "p2p-hub:network",
    version: 1,
    type: "hello",
    body: { versions: [1], capabilities: [], nonce: "a".repeat(32) },
  });
  const frame = Buffer.concat([header(body.length), Buffer.from(body)]);
  let buffer = Buffer.alloc(0);
  // Feed the frame one byte at a time: the decoder must return `null` (more
  // bytes needed) until the very last byte, then a complete frame.
  for (let i = 0; i < frame.length; i++) {
    buffer = Buffer.concat([buffer, frame.subarray(i, i + 1)]);
    const result = safeDecode(buffer);
    if (i < frame.length - 1) {
      assert.equal(result.kind, "more", `byte ${i} must still be pending`);
    } else {
      assert.equal(result.kind, "complete", "last byte completes the frame");
    }
  }
});

test("parseEnvelope is total over mutated valid envelopes (never throws)", () => {
  const base = {
    protocol: "p2p-hub:network",
    version: 1,
    type: "hello",
    body: { versions: [1], capabilities: ["echo"], nonce: "a".repeat(32) },
  };
  const mutations: Array<() => unknown> = [
    () => ({ ...base, protocol: "p2p-hub:evil" }),
    () => ({ ...base, version: 0 }),
    () => ({ ...base, version: 2 }),
    () => ({ ...base, type: "unknown_type" }),
    () => ({ ...base, type: "hello_ack" }), // wrong phase
    () => ({ ...base, body: undefined }),
    () => ({ ...base, body: null }),
    () => ({ ...base, body: "hello" }),
    () => ({ ...base, body: {} }),
    () => ({ ...base, body: { versions: [1] } }), // missing capabilities + nonce
    () => ({ ...base, body: { capabilities: [], nonce: "a".repeat(32) } }), // missing versions
    () => ({ ...base, body: { versions: "1", capabilities: [], nonce: "a".repeat(32) } }),
    () => ({ ...base, body: { versions: [1], capabilities: [], nonce: "z".repeat(32) } }), // bad nonce
    () => null,
    () => 42,
    () => "hello",
    () => [{ protocol: "p2p-hub:network", version: 1, type: "hello", body: {} }],
  ];
  for (const mutate of mutations) {
    const candidate = mutate();
    let result;
    try {
      result = parseEnvelope(candidate);
    } catch (err) {
      assert.fail(`parseEnvelope threw on ${JSON.stringify(candidate)}: ${(err as Error).message}`);
    }
    assert.equal(
      result,
      null,
      `mutation must be denied: ${JSON.stringify(candidate)?.slice(0, 80)}`,
    );
  }

  // Extra fields on a well-formed envelope are tolerated (nothing reads them)
  // — the contract is about required fields, not key-set strictness. This pins
  // the decision so it changes deliberately, not by accident.
  const withExtra = parseEnvelope({ ...base, extraField: "smuggled" });
  assert.ok(withExtra !== null, "extra envelope fields are tolerated");
  assert.equal(
    (withExtra as { type?: string } | null)?.type,
    "hello",
    "the type still decides the phase",
  );

  // Missing required fields on sub_req / event_emit / task (explicitly named
  // by the Slice brief: subscriptionId, topic, payload, publisherPeerId...).
  const subBase = { protocol: "p2p-hub:network", version: 1, type: "sub_req" };
  assert.equal(parseEnvelope({ ...subBase, body: { topic: "calendar:*", action: "subscribe" } }), null); // no subscriptionId
  assert.equal(parseEnvelope({ ...subBase, body: { subscriptionId: "s-1", action: "subscribe" } }), null); // no topic
  assert.equal(parseEnvelope({ ...subBase, body: { subscriptionId: "s-1", topic: "calendar:*" } }), null); // no action
  const emitBase = { protocol: "p2p-hub:network", version: 1, type: "event_emit" };
  assert.equal(
    parseEnvelope({
      ...emitBase,
      body: { topic: "calendar:*", publisherPeerId: "b".repeat(64), timestamp: 1, sequenceNumber: 0, payload: 1 },
    }),
    null, // no subscriptionId
  );
  assert.equal(
    parseEnvelope({
      ...emitBase,
      body: { subscriptionId: "s-1", publisherPeerId: "b".repeat(64), timestamp: 1, sequenceNumber: 0, payload: 1 },
    }),
    null, // no topic
  );
  assert.equal(
    parseEnvelope({
      ...emitBase,
      body: { subscriptionId: "s-1", topic: "calendar:*", timestamp: 1, sequenceNumber: 0, payload: 1 },
    }),
    null, // no publisherPeerId
  );
  const taskBase = { protocol: "p2p-hub:network", version: 1, type: "task" };
  assert.equal(parseEnvelope({ ...taskBase, body: { skill: "s", payload: 1 } }), null); // no id
  assert.equal(parseEnvelope({ ...taskBase, body: { id: "t", payload: 1 } }), null); // no skill
  assert.equal(parseEnvelope({ ...taskBase, body: { id: "t", skill: "s" } }), null); // no payload
});

// ---------------------------------------------------------------------------
// Socket level: malformed frames close the specific connection; the provider
// keeps serving fresh handshakes afterwards (the socket loop never hangs).
// ---------------------------------------------------------------------------

function makeIdentity(): { identity: PeerIdentity; signer: (data: Buffer) => Promise<Buffer> } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  const peerId = Buffer.from(jwk.x, "base64url").toString("hex");
  return {
    identity: { peerId, publicKeyHex: peerId },
    signer: async (data: Buffer) => crypto.sign(null, data, privateKey),
  };
}

function makeProvider(options: Omit<NetworkLightOptions, "identity" | "identitySigner"> = {}): NetworkLightProvider {
  const keyPair = makeIdentity();
  return new NetworkLightProvider({
    ...options,
    identity: keyPair.identity,
    identitySigner: keyPair.signer,
  });
}

function generateSelfSignedCert(): { key: string; cert: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01" + forge.util.bytesToHex(forge.random.getBytesSync(16));
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  cert.setSubject([{ name: "commonName", value: "p2p-hub" }]);
  cert.setIssuer([{ name: "commonName", value: "p2p-hub" }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) };
}

function frame(body: Buffer): Buffer {
  const h = Buffer.alloc(4);
  h.writeUInt32BE(body.length, 0);
  return Buffer.concat([h, body]);
}

/** A raw TLS connection to the provider's listening port (no protocol frames). */
function openRaw(
  port: number,
  clientCert?: { key: string; cert: string },
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const raw = tls.connect(
      {
        host: "127.0.0.1",
        port,
        rejectUnauthorized: false,
        ...clientCert,
      },
      () => resolve(raw),
    );
    raw.once("error", reject);
  });
}

function onClose(socket: tls.TLSSocket): Promise<void> {
  return new Promise((resolve) => socket.once("close", () => resolve()));
}

test("malformed frame variants close only their own connection and the provider stays alive", async () => {
  const provider = makeProvider({ port: 0, skills: ["echo"] });
  let handled = false;
  provider.onTask(async (task) => {
    handled = true;
    return { taskId: task.id, status: "ok", result: "pong" };
  });
  await provider.start();

  const malformedFrames: Buffer[] = [
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00]), // huge declared length
    Buffer.from([0x00, 0x00, 0x00, 0x04, 0x7b, 0x7b, 0x7b, 0x7b]), // "{{{{"
    Buffer.concat([frame(Buffer.from("nope", "utf8")), Buffer.from("garbage-after-frame")]), // valid frame + junk rest
    Buffer.from([0x00, 0x00, 0x00, 0x03, 0xff, 0xfe, 0xfd]), // invalid UTF-8 body
    Buffer.from([0x00, 0x00, 0x00, 0x00]), // empty body
    Buffer.from([0x7f, 0xff, 0xff, 0xff]), // half a huge-length header only
    // Valid JSON, but a frame-type the server phase forbids (task before hello).
    frame(Buffer.from(JSON.stringify({
      protocol: "p2p-hub:network",
      version: 1,
      type: "task",
      body: { id: "t", skill: "echo", payload: 1 },
    }), "utf8")),
  ];

  try {
    for (let i = 0; i < malformedFrames.length; i++) {
      const socket = await openRaw(provider.port);
      const closed = onClose(socket);
      socket.write(malformedFrames[i]);
      await Promise.race([
        closed,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`connection ${i} was not closed by the server`)), 3000),
        ),
      ]);
      socket.destroy();
    }
    assert.equal(handled, false, "malformed frames must never be dispatched");

    // Liveness: a legitimate, fully-authenticated handshake + task still works
    // after all the malformed traffic — the socket loop never hung.
    const client = makeIdentity();
    const { key, cert } = generateSelfSignedCert();
    const certFingerprint = normalizeFingerprint(new crypto.X509Certificate(cert).fingerprint256);
    const clientNonce = randomNonce();

    const raw = await openRaw(provider.port, { key, cert });
    const helloAck = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no hello_ack after fuzz")), 3000);
      const onData = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (text.includes("hello_ack")) {
          const parsed = JSON.parse(text.slice(text.indexOf("{"))) as { body: { nonce?: string } };
          clearTimeout(timer);
          raw.off("data", onData);
          resolve(parsed.body.nonce ?? "");
        }
      };
      raw.on("data", onData);
    });
    raw.write(
      frame(Buffer.from(JSON.stringify({
        protocol: "p2p-hub:network",
        version: 1,
        type: "hello",
        body: { versions: [1], capabilities: ["echo"], nonce: clientNonce },
      }), "utf8")),
    );
    const serverNonce = await helloAck;
    const signature = await client.signer(
      buildIdentityBindingMessage(clientNonce, serverNonce, certFingerprint),
    );
    raw.write(
      frame(Buffer.from(JSON.stringify({
        protocol: "p2p-hub:network",
        version: 1,
        type: "auth",
        body: {
          peerId: client.identity.peerId,
          certFingerprint,
          signature: signature.toString("hex"),
        },
      }), "utf8")),
    );
    raw.write(
      frame(Buffer.from(JSON.stringify({
        protocol: "p2p-hub:network",
        version: 1,
        type: "task",
        body: { id: "fuzz-live", skill: "echo", payload: "hi" },
      }), "utf8")),
    );

    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no task result after fuzz")), 3000);
      const onData = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (text.includes('"result"')) {
          const parsed = JSON.parse(text.slice(text.indexOf("{"))) as { body: { result?: unknown } };
          clearTimeout(timer);
          raw.off("data", onData);
          resolve(parsed.body.result);
        }
      };
      raw.on("data", onData);
    });
    raw.destroy();
    assert.equal(result, "pong", "provider must serve a fresh handshake after the fuzz batch");
  } finally {
    await provider.stop();
  }
});
