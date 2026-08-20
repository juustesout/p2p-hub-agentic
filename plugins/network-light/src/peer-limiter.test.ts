import { test } from "node:test";
import assert from "node:assert/strict";
import { PeerLimiter } from "./peer-limiter";

test("connection slots are capped per IP and released", () => {
  const limiter = new PeerLimiter({ maxConnectionsPerIp: 2 });
  assert.equal(limiter.tryAcquireConnection("1.2.3.4"), true);
  assert.equal(limiter.tryAcquireConnection("1.2.3.4"), true);
  assert.equal(limiter.tryAcquireConnection("1.2.3.4"), false, "cap reached");
  assert.equal(limiter.tryAcquireConnection("5.6.7.8"), true, "other IP unaffected");

  limiter.releaseConnection("1.2.3.4");
  assert.equal(limiter.tryAcquireConnection("1.2.3.4"), true, "slot freed");
});

test("in-flight task slots are capped per IP and released", () => {
  const limiter = new PeerLimiter({ maxConcurrentTasksPerIp: 2 });
  assert.equal(limiter.tryAcquireTask("10.0.0.1"), true);
  assert.equal(limiter.tryAcquireTask("10.0.0.1"), true);
  assert.equal(limiter.tryAcquireTask("10.0.0.1"), false);
  limiter.releaseTask("10.0.0.1");
  assert.equal(limiter.tryAcquireTask("10.0.0.1"), true);
  // Releasing below zero must not corrupt the count.
  limiter.releaseTask("10.0.0.1");
  limiter.releaseTask("10.0.0.1");
  assert.equal(limiter.tryAcquireTask("10.0.0.1"), true);
});

test("request budget is a fixed window that resets", () => {
  let t = 0;
  const limiter = new PeerLimiter({ maxRequestsPerWindowPerIp: 3, requestWindowMs: 100 }, () => t);

  assert.equal(limiter.allowRequest("a"), true);
  assert.equal(limiter.allowRequest("a"), true);
  assert.equal(limiter.allowRequest("a"), true);
  assert.equal(limiter.allowRequest("a"), false, "budget exhausted");
  assert.equal(limiter.allowRequest("b"), true, "other IP has its own budget");

  t += 101;
  assert.equal(limiter.allowRequest("a"), true, "window reset after requestWindowMs");
  assert.equal(limiter.allowRequest("a"), true);
});

test("snapshot exposes per-IP counters and clear resets everything", () => {
  const limiter = new PeerLimiter({ maxConnectionsPerIp: 1, maxConcurrentTasksPerIp: 1 });
  limiter.tryAcquireConnection("10.0.0.9");
  limiter.tryAcquireTask("10.0.0.9");
  limiter.allowRequest("10.0.0.9");

  const snapshot = limiter.snapshot();
  assert.equal(snapshot.length, 1);
  assert.deepEqual(snapshot[0], { ip: "10.0.0.9", connections: 1, tasks: 1, requests: 1 });

  limiter.clear();
  assert.deepEqual(limiter.snapshot(), []);
  assert.equal(limiter.tryAcquireConnection("10.0.0.9"), true);
});
