import { test } from "node:test";
import assert from "node:assert/strict";
import { FixedWindowLimiter } from "./fixed-window";

test("allows up to the limit within a window, then refuses", () => {
  const limiter = new FixedWindowLimiter(3, 60_000);
  assert.equal(limiter.allow(), true);
  assert.equal(limiter.allow(), true);
  assert.equal(limiter.allow(), true);
  assert.equal(limiter.allow(), false, "the 4th call in the window is refused");
  assert.equal(limiter.allow(), false);
});

test("refused calls do not occupy a slot", async () => {
  const limiter = new FixedWindowLimiter(2, 30);
  assert.equal(limiter.allow(), true);
  assert.equal(limiter.allow(), true);
  assert.equal(limiter.allow(), false);
  // The refusals were not recorded: once the two accepted calls expire, the
  // budget is fully available again — two more calls succeed.
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(limiter.allow(), true);
  assert.equal(limiter.allow(), true);
  assert.equal(limiter.allow(), false);
});

test("the window slides: old entries expire", async () => {
  const limiter = new FixedWindowLimiter(1, 30);
  assert.equal(limiter.allow(), true);
  assert.equal(limiter.allow(), false);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(limiter.allow(), true, "the slot frees once the entry expires");
});
