import { test } from "node:test";
import assert from "node:assert/strict";
import {
  requestMediaAccess,
  type RequestMediaAccessOptions,
} from "./media-gate";
import type { TrustConfirmation } from "./trust-gate";

const OPTS: RequestMediaAccessOptions = {
  initiator: "operator",
  reason: "camera access for the demo",
  peerId: "00".repeat(32),
  expiresInMs: 60_000,
  kind: "camera",
};

function baseOpts(overrides: Partial<RequestMediaAccessOptions> = {}): RequestMediaAccessOptions {
  return { ...OPTS, ...overrides };
}

test("requestMediaAccess forwards the media-access-request kind and returns true on approval", async () => {
  let seen: unknown = null;
  const confirmation: TrustConfirmation = {
    confirmTier2: async (request) => {
      seen = request;
      return true;
    },
  };
  const approved = await requestMediaAccess(confirmation, OPTS);
  assert.equal(approved, true);
  assert.deepEqual(seen, {
    kind: "media-access-request",
    peerId: OPTS.peerId,
    mediaKind: "camera",
    summary: OPTS.reason,
    expiresInMs: OPTS.expiresInMs,
    initiator: "operator",
  });
});

test("requestMediaAccess carries an agent initiator and a microphone kind", async () => {
  let seen: unknown = null;
  const confirmation: TrustConfirmation = {
    confirmTier2: async (request) => {
      seen = request;
      return true;
    },
  };
  await requestMediaAccess(
    confirmation,
    baseOpts({
      initiator: "agent:agent-alice",
      kind: "microphone",
      reason: "agent-alice is joining the call",
    }),
  );
  assert.deepEqual(seen, {
    kind: "media-access-request",
    peerId: OPTS.peerId,
    mediaKind: "microphone",
    summary: "agent-alice is joining the call",
    expiresInMs: OPTS.expiresInMs,
    initiator: "agent:agent-alice",
  });
});

test("requestMediaAccess fails closed with no confirmer", async () => {
  assert.equal(await requestMediaAccess({}, OPTS), false);
});

test("requestMediaAccess fails closed on a user denial", async () => {
  const confirmation: TrustConfirmation = { confirmTier2: async () => false };
  assert.equal(await requestMediaAccess(confirmation, OPTS), false);
});

test("requestMediaAccess fails closed when the confirmer throws", async () => {
  const confirmation: TrustConfirmation = {
    confirmTier2: async () => {
      throw new Error("boom");
    },
  };
  assert.equal(await requestMediaAccess(confirmation, OPTS), false);
});

test("requestMediaAccess never invents peerId or expiresInMs", async () => {
  // The built request must carry exactly the caller-supplied peerId/expiresInMs
  // — the audit trail has to name the peer/session, so the gate never fills
  // these in itself.
  const confirmation: TrustConfirmation = {
    confirmTier2: async (request) => {
      if (request.kind === "media-access-request") {
        return (
          request.peerId === "peer-42" &&
          request.expiresInMs === 12_345 &&
          request.mediaKind === "microphone"
        );
      }
      return false;
    },
  };
  assert.equal(
    await requestMediaAccess(
      confirmation,
      baseOpts({ peerId: "peer-42", expiresInMs: 12_345, kind: "microphone" }),
    ),
    true,
  );
});
