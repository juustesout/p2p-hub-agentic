import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TrustConfirmationDeniedError,
  TrustTierGate,
  type TrustConfirmation,
} from "./trust-gate";

function approvedConfirmation(result = true): TrustConfirmation {
  return { confirmTier2: async () => result };
}

test("safe severities are allowed without authentication", async () => {
  const gate = new TrustTierGate();
  for (const severity of ["none", "low", "medium"] as const) {
    assert.equal(await gate.authorize(severity, "x", { authenticated: false }), 0);
  }
});

test("high severity requires an authenticated session", async () => {
  const gate = new TrustTierGate();
  await assert.rejects(
    gate.authorize("high", "x", { authenticated: false }),
    TrustConfirmationDeniedError,
  );
  assert.equal(
    await gate.authorize("high", "x", { authenticated: true }),
    1,
  );
});

test("critical severity is denied by default (no native confirmer)", async () => {
  const gate = new TrustTierGate();
  await assert.rejects(
    gate.authorize("critical", "x", { authenticated: true }),
    (err: unknown) =>
      err instanceof TrustConfirmationDeniedError &&
      err.requiredTier === 2 &&
      err.reason === "no native confirmer",
  );
});

test("critical severity is denied when unauthenticated regardless of confirmer", async () => {
  const gate = new TrustTierGate(approvedConfirmation(true));
  await assert.rejects(
    gate.authorize("critical", "x", { authenticated: false }),
    TrustConfirmationDeniedError,
  );
});

test("critical severity is allowed only on an explicit native confirm", async () => {
  const gate = new TrustTierGate(approvedConfirmation(true));
  assert.equal(
    await gate.authorize("critical", "apply settings", { authenticated: true }),
    2,
  );
});

test("a user declining the native prompt denies the change", async () => {
  const gate = new TrustTierGate(approvedConfirmation(false));
  await assert.rejects(
    gate.authorize("critical", "apply settings", { authenticated: true }),
    (err: unknown) =>
      err instanceof TrustConfirmationDeniedError && err.reason === "denied by user",
  );
});

test("a confirmer that throws fails closed", async () => {
  const gate = new TrustTierGate({
    confirmTier2: async () => {
      throw new Error("boom");
    },
  });
  await assert.rejects(
    gate.authorize("critical", "apply settings", { authenticated: true }),
    (err: unknown) =>
      err instanceof TrustConfirmationDeniedError &&
      err.reason === "confirmation failed",
  );
});

test("the confirmer receives the critical-settings request", async () => {
  let seen: unknown = null;
  const gate = new TrustTierGate({
    confirmTier2: async (request) => {
      seen = request;
      return true;
    },
  });
  await gate.authorize("critical", "expose hub beyond loopback", {
    authenticated: true,
  });
  assert.deepEqual(seen, {
    kind: "critical-settings",
    summary: "expose hub beyond loopback",
  });
});

test("confirmPeerAccess forwards the peer-access-request kind and returns true on approval", async () => {
  let seen: unknown = null;
  const gate = new TrustTierGate({
    confirmTier2: async (request) => {
      seen = request;
      return true;
    },
  });
  const approved = await gate.confirmPeerAccess(
    "00".repeat(32),
    "read your site",
    3_600_000,
  );
  assert.equal(approved, true);
  assert.deepEqual(seen, {
    kind: "peer-access-request",
    peerId: "00".repeat(32),
    claim: "read your site",
    expiresInMs: 3_600_000,
  });
});

test("confirmPeerAccess fails closed with no confirmer, a denial, or a throw", async () => {
  const noConfirmer = new TrustTierGate();
  assert.equal(
    await noConfirmer.confirmPeerAccess("00".repeat(32), "c", 1_000),
    false,
  );

  const denied = new TrustTierGate({ confirmTier2: async () => false });
  assert.equal(
    await denied.confirmPeerAccess("00".repeat(32), "c", 1_000),
    false,
  );

  const throwing = new TrustTierGate({
    confirmTier2: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(
    await throwing.confirmPeerAccess("00".repeat(32), "c", 1_000),
    false,
  );
});
