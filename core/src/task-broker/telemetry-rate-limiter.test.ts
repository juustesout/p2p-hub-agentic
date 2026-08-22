import { test } from "node:test";
import assert from "node:assert/strict";
import { TelemetryRateLimiter } from "./telemetry-rate-limiter";

function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("allows up to maxCalls within one window", () => {
  const clock = fakeClock();
  const limiter = new TelemetryRateLimiter({ windowMs: 1000, maxCalls: 3 }, clock.now);

  assert.equal(limiter.allow("peer-a", "p.status"), true);
  assert.equal(limiter.allow("peer-a", "p.status"), true);
  assert.equal(limiter.allow("peer-a", "p.status"), true);
});

test("rejects the call that overflows the window", () => {
  const clock = fakeClock();
  const limiter = new TelemetryRateLimiter({ windowMs: 1000, maxCalls: 3 }, clock.now);

  limiter.allow("peer-a", "p.status");
  limiter.allow("peer-a", "p.status");
  limiter.allow("peer-a", "p.status");

  assert.equal(limiter.allow("peer-a", "p.status"), false);
});

test("the window slides: calls older than windowMs stop counting", () => {
  const clock = fakeClock();
  const limiter = new TelemetryRateLimiter({ windowMs: 1000, maxCalls: 3 }, clock.now);

  limiter.allow("peer-a", "p.status");
  limiter.allow("peer-a", "p.status");
  limiter.allow("peer-a", "p.status");
  assert.equal(limiter.allow("peer-a", "p.status"), false);

  clock.advance(1001);
  assert.equal(limiter.allow("peer-a", "p.status"), true);
});

test("peers have independent budgets", () => {
  const clock = fakeClock();
  const limiter = new TelemetryRateLimiter({ windowMs: 1000, maxCalls: 1 }, clock.now);

  assert.equal(limiter.allow("peer-a", "p.status"), true);
  assert.equal(limiter.allow("peer-a", "p.status"), false);
  assert.equal(limiter.allow("peer-b", "p.status"), true);
});

test("skills have independent budgets for the same peer", () => {
  const clock = fakeClock();
  const limiter = new TelemetryRateLimiter({ windowMs: 1000, maxCalls: 1 }, clock.now);

  assert.equal(limiter.allow("peer-a", "p.status"), true);
  assert.equal(limiter.allow("peer-a", "p.metrics"), true);
  assert.equal(limiter.allow("peer-a", "p.status"), false);
});

test("reset clears all state", () => {
  const clock = fakeClock();
  const limiter = new TelemetryRateLimiter({ windowMs: 1000, maxCalls: 1 }, clock.now);

  limiter.allow("peer-a", "p.status");
  assert.equal(limiter.allow("peer-a", "p.status"), false);

  limiter.reset();
  assert.equal(limiter.allow("peer-a", "p.status"), true);
});
