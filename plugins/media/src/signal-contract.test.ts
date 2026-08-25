import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CALL_ID_LENGTH,
  MAX_CANDIDATE_LENGTH,
  MAX_SDP_LENGTH,
  MEDIA_SIGNAL_SCOPE,
  SIGNAL_PROTOCOL,
  SIGNAL_VERSION,
  encodeSignalMessage,
  guardSignalPayload,
  parseSignalMessage,
} from "./signal-contract";
import type { IceCandidate, SignalAnswer, SignalCandidate, SignalOffer } from "./signal-contract";

function validOffer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: SIGNAL_PROTOCOL,
    version: SIGNAL_VERSION,
    callId: "abc123",
    kind: "camera",
    sdp: "v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n",
    ...overrides,
  };
}

function validAnswer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: SIGNAL_PROTOCOL,
    version: SIGNAL_VERSION,
    callId: "abc123",
    sdp: "v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n",
    ...overrides,
  };
}

function validCandidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: SIGNAL_PROTOCOL,
    version: SIGNAL_VERSION,
    callId: "abc123",
    candidate: { candidate: "candidate:1 1 UDP 1 192.168.0.1 50000 typ host" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// protocol / scope constants
// ---------------------------------------------------------------------------

test("signaling capability has a fixed protocol id and version", () => {
  assert.equal(SIGNAL_PROTOCOL, "p2p-hub:media-signaling");
  assert.equal(SIGNAL_VERSION, 1);
  assert.equal(MEDIA_SIGNAL_SCOPE, "media-signal");
});

// ---------------------------------------------------------------------------
// parseSignalMessage — accept paths
// ---------------------------------------------------------------------------

test("parses a valid offer", () => {
  const msg = parseSignalMessage(validOffer(), "offer");
  assert.ok(msg);
  const offer = msg as SignalOffer;
  assert.equal(offer.kind, "offer");
  assert.equal(offer.callId, "abc123");
  assert.equal(offer.mediaKind, "camera");
  assert.ok(offer.sdp.length > 0);
});

test("parses a valid microphone offer", () => {
  const msg = parseSignalMessage(validOffer({ kind: "microphone" }), "offer");
  assert.ok(msg);
  assert.equal((msg as SignalOffer).mediaKind, "microphone");
});

test("parses a valid answer", () => {
  const msg = parseSignalMessage(validAnswer(), "answer");
  assert.ok(msg);
  assert.equal((msg as SignalAnswer).kind, "answer");
  assert.equal((msg as SignalAnswer).callId, "abc123");
});

test("parses a valid candidate with optional sdpMid and sdpMLineIndex", () => {
  const msg = parseSignalMessage(
    validCandidate({ candidate: { candidate: "candidate:2 1 UDP 1 10.0.0.1 60000 typ srflx raddr 0.0.0.0 rport 50000", sdpMid: "0", sdpMLineIndex: 0 } }),
    "candidate",
  );
  assert.ok(msg);
  const cand = (msg as SignalCandidate).candidate;
  assert.equal(cand.candidate.startsWith("candidate:2"), true);
  assert.equal(cand.sdpMid, "0");
  assert.equal(cand.sdpMLineIndex, 0);
});

// ---------------------------------------------------------------------------
// parseSignalMessage — fail-closed paths
// ---------------------------------------------------------------------------

test("rejects a non-object payload", () => {
  assert.equal(parseSignalMessage("nope", "offer"), null);
  assert.equal(parseSignalMessage(null, "offer"), null);
  assert.equal(parseSignalMessage([], "offer"), null);
});

test("rejects a payload with a smuggled extra key (e.g. peerId)", () => {
  const smuggled = validOffer({ peerId: "deadbeef".repeat(8) });
  assert.equal(parseSignalMessage(smuggled, "offer"), null);
});

test("rejects a payload missing a required key", () => {
  const { sdp: _sdp, ...missing } = validOffer();
  assert.equal(parseSignalMessage(missing, "offer"), null);
});

test("rejects a wrong protocol or version", () => {
  assert.equal(parseSignalMessage(validOffer({ protocol: "other" }), "offer"), null);
  assert.equal(parseSignalMessage(validOffer({ version: 99 }), "offer"), null);
});

test("rejects an unknown media kind", () => {
  assert.equal(parseSignalMessage(validOffer({ kind: "screen" }), "offer"), null);
});

test("rejects an over-long sdp and over-long callId", () => {
  assert.equal(parseSignalMessage(validOffer({ sdp: "x".repeat(MAX_SDP_LENGTH + 1) }), "offer"), null);
  assert.equal(
    parseSignalMessage(validOffer({ callId: "c".repeat(MAX_CALL_ID_LENGTH + 1) }), "offer"),
    null,
  );
});

test("rejects an over-long candidate and non-string candidate", () => {
  const tooLong = validCandidate({
    candidate: { candidate: "x".repeat(MAX_CANDIDATE_LENGTH + 1) },
  });
  assert.equal(parseSignalMessage(tooLong, "candidate"), null);
  assert.equal(
    parseSignalMessage(validCandidate({ candidate: { candidate: 42 } }), "candidate"),
    null,
  );
});

test("rejects a candidate object with an unknown key", () => {
  assert.equal(
    parseSignalMessage(
      validCandidate({ candidate: { candidate: "candidate:1 1 UDP 1 1.1.1.1 1 typ host", evil: true } }),
      "candidate",
    ),
    null,
  );
});

test("rejects a negative sdpMLineIndex", () => {
  assert.equal(
    parseSignalMessage(
      validCandidate({ candidate: { candidate: "candidate:1 1 UDP 1 1.1.1.1 1 typ host", sdpMLineIndex: -1 } }),
      "candidate",
    ),
    null,
  );
});

test("a kind-specific parse rejects the wrong envelope shape", () => {
  // An offer parsed as an answer must fail (answer has no `kind` field).
  assert.equal(parseSignalMessage(validOffer(), "answer"), null);
  assert.equal(parseSignalMessage(validAnswer(), "offer"), null);
  assert.equal(parseSignalMessage(validCandidate(), "offer"), null);
});

// ---------------------------------------------------------------------------
// guardSignalPayload — boundary-guard discipline
// ---------------------------------------------------------------------------

test("guardSignalPayload accepts a valid payload", () => {
  assert.doesNotThrow(() => guardSignalPayload(validOffer()));
});

test("guardSignalPayload throws on an over-deep payload", () => {
  let deep: unknown = { candidate: "candidate:1 1 UDP 1 1.1.1.1 1 typ host" };
  for (let i = 0; i < 16; i++) {
    deep = { nested: deep };
  }
  assert.throws(() => guardSignalPayload(validCandidate({ candidate: deep })));
});

// ---------------------------------------------------------------------------
// encodeSignalMessage — canonical wire form
// ---------------------------------------------------------------------------

test("encode/parse round-trips an offer, answer and candidate", () => {
  const offer = encodeSignalMessage({
    kind: "offer",
    callId: "abc123",
    mediaKind: "camera",
    sdp: "v=0",
  });
  const parsedOffer = parseSignalMessage(offer, "offer");
  assert.ok(parsedOffer);
  assert.equal((parsedOffer as SignalOffer).sdp, "v=0");

  const answer = encodeSignalMessage({ kind: "answer", callId: "abc123", sdp: "v=0" });
  const parsedAnswer = parseSignalMessage(answer, "answer");
  assert.ok(parsedAnswer);

  const candidate: IceCandidate = { candidate: "candidate:1 1 UDP 1 1.1.1.1 1 typ host", sdpMLineIndex: 0 };
  const encoded = encodeSignalMessage({ kind: "candidate", callId: "abc123", candidate });
  const parsedCandidate = parseSignalMessage(encoded, "candidate");
  assert.ok(parsedCandidate);
  assert.deepEqual((parsedCandidate as SignalCandidate).candidate, candidate);
});

test("encodeSignalMessage produces canonical key order", () => {
  const offer = encodeSignalMessage({
    kind: "offer",
    callId: "abc123",
    mediaKind: "camera",
    sdp: "v=0",
  });
  assert.deepEqual(Object.keys(offer), ["protocol", "version", "callId", "kind", "sdp"]);
});
