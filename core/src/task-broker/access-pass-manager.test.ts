import { test } from "node:test";
import assert from "node:assert/strict";
import { AccessPassManager } from "./access-pass-manager";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

test("issue/hasValidPass round-trip", () => {
  const manager = new AccessPassManager();
  const pass = manager.issue(ALICE, "site-read-only");
  assert.ok(pass.expiresAt > pass.issuedAt);
  assert.equal(manager.hasValidPass(ALICE, "site-read-only"), true);
});

test("passes are scoped: a pass for one scope does not lift another", () => {
  const manager = new AccessPassManager();
  manager.issue(ALICE, "site-read-only");
  assert.equal(manager.hasValidPass(ALICE, "site-read-only"), true);
  assert.equal(manager.hasValidPass(ALICE, "execute-skill"), false);
  assert.equal(manager.hasValidPass(BOB, "site-read-only"), false);
});

test("an expired pass is reported absent and dropped", () => {
  const manager = new AccessPassManager();
  manager.issue(ALICE, "site-read-only", 1);
  assert.equal(manager.hasValidPass(ALICE, "site-read-only"), true);
  // 1ms ttl + time to run the assertion above means it must be expired now.
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.equal(manager.hasValidPass(ALICE, "site-read-only"), false);
      assert.equal(manager.listPasses().length, 0);
      resolve();
    }, 5);
  });
});

test("revoke removes a pass; returns false when none existed", () => {
  const manager = new AccessPassManager();
  manager.issue(ALICE, "site-read-only");
  assert.equal(manager.revoke(ALICE, "site-read-only"), true);
  assert.equal(manager.hasValidPass(ALICE, "site-read-only"), false);
  assert.equal(manager.revoke(ALICE, "site-read-only"), false);
});

test("issue overwrites an existing pass for the same (peerId, scope)", () => {
  const manager = new AccessPassManager();
  manager.issue(ALICE, "site-read-only", 1000);
  const second = manager.issue(ALICE, "site-read-only", 5000);
  const passes = manager.listPasses();
  assert.equal(passes.length, 1);
  assert.equal(passes[0].expiresAt, second.expiresAt);
});

test("issue validates its input", () => {
  const manager = new AccessPassManager();
  assert.throws(() => manager.issue("", "scope"), /non-empty peerId/);
  assert.throws(() => manager.issue(ALICE, ""), /non-empty scope/);
  assert.throws(() => manager.issue(ALICE, "scope", 0), /positive integer/);
  assert.throws(() => manager.issue(ALICE, "scope", -5), /positive integer/);
});

test("listPasses never reports expired passes", () => {
  const manager = new AccessPassManager();
  manager.issue(ALICE, "site-read-only", 1);
  manager.issue(BOB, "site-read-only");
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      const passes = manager.listPasses();
      assert.equal(passes.length, 1);
      assert.equal(passes[0].peerId, BOB);
      resolve();
    }, 5);
  });
});

test("inspectPass distinguishes none, valid and expired without dropping", () => {
  const manager = new AccessPassManager();
  assert.equal(manager.inspectPass(ALICE, "site-read-only"), "none");
  manager.issue(ALICE, "site-read-only", 1);
  assert.equal(manager.inspectPass(ALICE, "site-read-only"), "valid");
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      // Expired still reports "expired" (inspect is report-only) ...
      assert.equal(manager.inspectPass(ALICE, "site-read-only"), "expired");
      // ... while hasValidPass sees the same slot as absent.
      assert.equal(manager.hasValidPass(ALICE, "site-read-only"), false);
      resolve();
    }, 5);
  });
});
