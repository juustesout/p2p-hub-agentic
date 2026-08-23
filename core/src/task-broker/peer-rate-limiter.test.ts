import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PEER_RATE_LIMIT,
  PeerRateLimiter,
} from "./peer-rate-limiter";

test("allows calls under the per-window budget", () => {
  let now = 0;
  const limiter = new PeerRateLimiter(
    { windowMs: 60_000, maxTasks: 3 },
    () => now,
  );

  assert.equal(limiter.allow("peer-a"), true);
  assert.equal(limiter.allow("peer-a"), true);
  assert.equal(limiter.allow("peer-a"), true);
});

test("rejects once the budget is exhausted inside one window", () => {
  let now = 0;
  const limiter = new PeerRateLimiter(
    { windowMs: 60_000, maxTasks: 2 },
    () => now,
  );

  assert.equal(limiter.allow("peer-a"), true);
  assert.equal(limiter.allow("peer-a"), true);
  assert.equal(limiter.allow("peer-a"), false);
  assert.equal(limiter.allow("peer-a"), false);
});

test("budgets are independent per peer", () => {
  let now = 0;
  const limiter = new PeerRateLimiter(
    { windowMs: 60_000, maxTasks: 1 },
    () => now,
  );

  assert.equal(limiter.allow("peer-a"), true);
  assert.equal(limiter.allow("peer-a"), false);
  assert.equal(limiter.allow("peer-b"), true);
});

test("the window slides: old calls expire and free the budget again", () => {
  let now = 0;
  const limiter = new PeerRateLimiter(
    { windowMs: 1_000, maxTasks: 1 },
    () => now,
  );

  assert.equal(limiter.allow("peer-a"), true);
  assert.equal(limiter.allow("peer-a"), false);

  now = 1_000;
  // Exactly one window later the earlier call has expired.
  assert.equal(limiter.allow("peer-a"), true);
  assert.equal(limiter.allow("peer-a"), false);

  now = 999;
  // A sliding window: only the call older than the full window frees up.
  assert.equal(limiter.allow("peer-a"), false);
});

test("denied attempts do not extend the active window", () => {
  let now = 0;
  const limiter = new PeerRateLimiter(
    { windowMs: 1_000, maxTasks: 1 },
    () => now,
  );

  assert.equal(limiter.allow("peer-a"), true);
  for (let i = 0; i < 5; i++) {
    assert.equal(limiter.allow("peer-a"), false);
  }

  now = 1_000;
  // A flood of denials between 0 and 1000 must not push the expiry out.
  assert.equal(limiter.allow("peer-a"), true);
});

test("isActive is true for the fail-closed default", () => {
  const limiter = new PeerRateLimiter(DEFAULT_PEER_RATE_LIMIT);
  assert.equal(limiter.isActive(), true);
});

test("rejects a non-positive configuration loudly (fail-closed, never unlimited)", () => {
  assert.throws(() => new PeerRateLimiter({ windowMs: 0, maxTasks: 1 }), /positive/);
  assert.throws(
    () => new PeerRateLimiter({ windowMs: 1_000, maxTasks: 0 }),
    /positive/,
  );
});

test("reset clears all budgets", () => {
  let now = 0;
  const limiter = new PeerRateLimiter(
    { windowMs: 60_000, maxTasks: 1 },
    () => now,
  );

  assert.equal(limiter.allow("peer-a"), true);
  assert.equal(limiter.allow("peer-a"), false);
  limiter.reset();
  assert.equal(limiter.allow("peer-a"), true);
});
