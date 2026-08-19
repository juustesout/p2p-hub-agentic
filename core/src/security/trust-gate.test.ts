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

test("the confirmer receives the human-readable summary", async () => {
  let seen = "";
  const gate = new TrustTierGate({
    confirmTier2: async (summary) => {
      seen = summary;
      return true;
    },
  });
  await gate.authorize("critical", "expose hub beyond loopback", {
    authenticated: true,
  });
  assert.equal(seen, "expose hub beyond loopback");
});
