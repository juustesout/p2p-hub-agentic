import { test } from "node:test";
import assert from "node:assert/strict";
import { AccessPassManager } from "../task-broker/access-pass-manager";
import {
  checkPeerAccess,
  type PeerAccessContext,
} from "./peer-access-gate";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const HOST = "h".repeat(64);
const SCOPE = "site-read-only";

function contacts(opts: { verified?: boolean; blocked?: boolean } = {}): NonNullable<
  PeerAccessContext["contacts"]
> {
  const verified = opts.verified ?? true;
  const blocked = opts.blocked ?? false;
  return {
    isVerifiedContact: async (id: string) => id === ALICE && verified,
    isBlockedContact: async (id: string) => id === BOB && blocked,
  };
}

// ---------------------------------------------------------------------------
// verified-contact mode
// ---------------------------------------------------------------------------

test("a verified contact passes verified-contact mode", async () => {
  const decision = await checkPeerAccess(
    ALICE,
    { modes: ["verified-contact"] },
    { contacts: contacts() },
  );
  assert.deepEqual(decision, { granted: true, reason: "verified_contact" });
});

test("an unknown peer is denied under verified-contact mode", async () => {
  const decision = await checkPeerAccess(
    BOB,
    { modes: ["verified-contact"] },
    { contacts: contacts() },
  );
  assert.deepEqual(decision, { granted: false, reason: "not_a_contact" });
});

test("verified-contact mode without a contacts capability is denied (cannot prove)", async () => {
  const decision = await checkPeerAccess(
    ALICE,
    { modes: ["verified-contact"] },
    {},
  );
  assert.deepEqual(decision, { granted: false, reason: "denied_by_policy" });
});

test("a throwing contacts lookup is a denial, never an open door", async () => {
  const throwing: PeerAccessContext["contacts"] = {
    isVerifiedContact: async () => {
      throw new Error("boom");
    },
  };
  const decision = await checkPeerAccess(
    ALICE,
    { modes: ["verified-contact"] },
    { contacts: throwing },
  );
  assert.deepEqual(decision, { granted: false, reason: "not_a_contact" });
});

// ---------------------------------------------------------------------------
// access-pass mode
// ---------------------------------------------------------------------------

test("a valid access pass passes access-pass mode", async () => {
  const manager = new AccessPassManager();
  manager.issue(ALICE, SCOPE);
  const decision = await checkPeerAccess(
    ALICE,
    { modes: ["access-pass"], accessPassScope: SCOPE },
    { accessPasses: manager },
  );
  assert.deepEqual(decision, { granted: true, reason: "valid_access_pass" });
});

test("a peer without a pass is denied with invalid_access_pass", async () => {
  const manager = new AccessPassManager();
  manager.issue(BOB, "other-scope");
  const decision = await checkPeerAccess(
    ALICE,
    { modes: ["access-pass"], accessPassScope: SCOPE },
    { accessPasses: manager },
  );
  assert.deepEqual(decision, { granted: false, reason: "invalid_access_pass" });
});

test("an expired access pass is denied with expired_access_pass", async () => {
  const manager = new AccessPassManager();
  manager.issue(ALICE, SCOPE, 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const decision = await checkPeerAccess(
    ALICE,
    { modes: ["access-pass"], accessPassScope: SCOPE },
    { accessPasses: manager },
  );
  assert.deepEqual(decision, { granted: false, reason: "expired_access_pass" });
});

test("access-pass falls back to hasValidPass when inspectPass is absent", async () => {
  const passes: PeerAccessContext["accessPasses"] = {
    hasValidPass: async (id: string, scope: string) =>
      id === ALICE && scope === SCOPE,
  };
  const ok = await checkPeerAccess(
    ALICE,
    { modes: ["access-pass"], accessPassScope: SCOPE },
    { accessPasses: passes },
  );
  assert.deepEqual(ok, { granted: true, reason: "valid_access_pass" });
  const denied = await checkPeerAccess(
    BOB,
    { modes: ["access-pass"], accessPassScope: SCOPE },
    { accessPasses: passes },
  );
  assert.deepEqual(denied, { granted: false, reason: "invalid_access_pass" });
});

test("a throwing pass lookup is a denial", async () => {
  const throwing: PeerAccessContext["accessPasses"] = {
    hasValidPass: async () => {
      throw new Error("boom");
    },
  };
  const decision = await checkPeerAccess(
    ALICE,
    { modes: ["access-pass"], accessPassScope: SCOPE },
    { accessPasses: throwing },
  );
  assert.deepEqual(decision, { granted: false, reason: "invalid_access_pass" });
});

test("access-pass mode without a scope is denied_by_policy", async () => {
  const manager = new AccessPassManager();
  manager.issue(ALICE, SCOPE);
  const decision = await checkPeerAccess(
    ALICE,
    { modes: ["access-pass"] },
    { accessPasses: manager },
  );
  assert.deepEqual(decision, { granted: false, reason: "denied_by_policy" });
});

test("access-pass mode without a pass capability is denied_by_policy", async () => {
  const decision = await checkPeerAccess(
    ALICE,
    { modes: ["access-pass"], accessPassScope: SCOPE },
    {},
  );
  assert.deepEqual(decision, { granted: false, reason: "denied_by_policy" });
});

// ---------------------------------------------------------------------------
// open-lan / public modes
// ---------------------------------------------------------------------------

test("public mode grants any transport-verified peer", async () => {
  const decision = await checkPeerAccess(BOB, { modes: ["public"] }, {});
  assert.deepEqual(decision, { granted: true, reason: "public_policy" });
});

test("open-lan mode grants any transport-verified peer", async () => {
  const decision = await checkPeerAccess(BOB, { modes: ["open-lan"] }, {});
  assert.deepEqual(decision, { granted: true, reason: "public_policy" });
});

test("a blocked contact is denied even under public mode", async () => {
  const decision = await checkPeerAccess(
    BOB,
    { modes: ["public"] },
    { contacts: contacts({ blocked: true }) },
  );
  assert.deepEqual(decision, { granted: false, reason: "denied_by_policy" });
});

// ---------------------------------------------------------------------------
// OR-semantics (the peersite fetchAsset shape)
// ---------------------------------------------------------------------------

test("OR modes: a non-contact with a valid pass is granted (valid_access_pass)", async () => {
  const manager = new AccessPassManager();
  manager.issue(BOB, SCOPE);
  const decision = await checkPeerAccess(
    BOB,
    { modes: ["verified-contact", "access-pass"], accessPassScope: SCOPE },
    { contacts: contacts(), accessPasses: manager },
  );
  assert.deepEqual(decision, { granted: true, reason: "valid_access_pass" });
});

test("OR modes: a non-contact without a pass is denied with the first proven reason", async () => {
  const decision = await checkPeerAccess(
    BOB,
    { modes: ["verified-contact", "access-pass"], accessPassScope: SCOPE },
    { contacts: contacts(), accessPasses: new AccessPassManager() },
  );
  assert.deepEqual(decision, { granted: false, reason: "not_a_contact" });
});

// ---------------------------------------------------------------------------
// allowSelf
// ---------------------------------------------------------------------------

test("allowSelf grants the host's own peerId only when explicitly allowed", async () => {
  const withSelf = await checkPeerAccess(
    HOST,
    { modes: ["verified-contact"], allowSelf: true },
    { selfPeerId: HOST },
  );
  assert.deepEqual(withSelf, { granted: true, reason: "self" });

  const withoutFlag = await checkPeerAccess(
    HOST,
    { modes: ["verified-contact"] },
    { contacts: contacts(), selfPeerId: HOST },
  );
  assert.deepEqual(withoutFlag, { granted: false, reason: "not_a_contact" });

  const wrongSelf = await checkPeerAccess(
    HOST,
    { modes: ["verified-contact"], allowSelf: true },
    { contacts: contacts(), selfPeerId: ALICE },
  );
  assert.deepEqual(wrongSelf, { granted: false, reason: "not_a_contact" });
});

// ---------------------------------------------------------------------------
// fail-closed configuration defaults
// ---------------------------------------------------------------------------

test("missing options are denied_by_policy", async () => {
  const decision = await checkPeerAccess(ALICE, undefined, {});
  assert.deepEqual(decision, { granted: false, reason: "denied_by_policy" });
});

test("an empty modes list is denied_by_policy", async () => {
  const decision = await checkPeerAccess(ALICE, { modes: [] }, {});
  assert.deepEqual(decision, { granted: false, reason: "denied_by_policy" });
});

test("an unknown mode is denied_by_policy", async () => {
  const decision = await checkPeerAccess(
    ALICE,
    { modes: ["weird"] as never },
    {},
  );
  assert.deepEqual(decision, { granted: false, reason: "denied_by_policy" });
});

test("an empty peerId is denied under every mode", async () => {
  const decision = await checkPeerAccess("", { modes: ["public"] }, {});
  assert.deepEqual(decision, { granted: false, reason: "denied_by_policy" });
});
