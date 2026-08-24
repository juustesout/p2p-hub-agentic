import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TelemetryGate,
  PeerStreamViolationError,
  DEFAULT_STREAM_RATE_CONFIG,
} from "./telemetry-gate";

function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("allows up to maxMessagesPerSecond within one window", () => {
  const clock = fakeClock();
  const gate = new TelemetryGate(
    { windowMs: 1000, maxMessagesPerSecond: 3 },
    clock.now,
  );

  assert.deepEqual(gate.checkAndConsume("peer-a", "cam", 100), { allowed: true });
  assert.deepEqual(gate.checkAndConsume("peer-a", "cam", 100), { allowed: true });
  assert.deepEqual(gate.checkAndConsume("peer-a", "cam", 100), { allowed: true });
});

test("drops the frame that overflows the window (never queues)", () => {
  const clock = fakeClock();
  const gate = new TelemetryGate(
    { windowMs: 1000, maxMessagesPerSecond: 3 },
    clock.now,
  );

  for (let i = 0; i < 3; i++) {
    assert.deepEqual(gate.checkAndConsume("peer-a", "cam", 100), { allowed: true });
  }
  assert.deepEqual(gate.checkAndConsume("peer-a", "cam", 100), {
    allowed: false,
    reason: "message-cap",
  });
});

test("burst of 100 messages: first max allowed, rest dropped until the window slides", () => {
  const clock = fakeClock();
  const gate = new TelemetryGate(
    { windowMs: 1000, maxMessagesPerSecond: 60 },
    clock.now,
  );

  let allowed = 0;
  let dropped = 0;
  for (let i = 0; i < 100; i++) {
    if (gate.checkAndConsume("peer-a", "cam", 10).allowed) {
      allowed += 1;
    } else {
      dropped += 1;
    }
  }
  assert.equal(allowed, 60);
  assert.equal(dropped, 40);

  clock.advance(1001);
  assert.deepEqual(gate.checkAndConsume("peer-a", "cam", 10), { allowed: true });
});

test("giant frame exceeding maxBytesPerSecond is dropped immediately", () => {
  const clock = fakeClock();
  const gate = new TelemetryGate(
    { windowMs: 1000, maxMessagesPerSecond: 60, maxBytesPerSecond: 1000 },
    clock.now,
  );

  assert.deepEqual(gate.checkAndConsume("peer-a", "cam", 500), { allowed: true });
  assert.deepEqual(gate.checkAndConsume("peer-a", "cam", 2000), {
    allowed: false,
    reason: "byte-cap",
  });
});

test("accumulated bytes are capped across frames within the window", () => {
  const clock = fakeClock();
  const gate = new TelemetryGate(
    { windowMs: 1000, maxMessagesPerSecond: 60, maxBytesPerSecond: 1000 },
    clock.now,
  );

  assert.deepEqual(gate.checkAndConsume("peer-a", "cam", 400), { allowed: true });
  assert.deepEqual(gate.checkAndConsume("peer-a", "cam", 400), { allowed: true });
  assert.deepEqual(gate.checkAndConsume("peer-a", "cam", 300), {
    allowed: false,
    reason: "byte-cap",
  });

  clock.advance(1001);
  assert.deepEqual(gate.checkAndConsume("peer-a", "cam", 300), { allowed: true });
});

test("peers have fully independent budgets", () => {
  const clock = fakeClock();
  const gate = new TelemetryGate(
    { windowMs: 1000, maxMessagesPerSecond: 1, maxBytesPerSecond: 100 },
    clock.now,
  );

  // Peer A floods its channel and even trips the violation pinch.
  gate.checkAndConsume("peer-a", "cam", 10);
  gate.checkAndConsume("peer-a", "cam", 10);
  gate.checkAndConsume("peer-a", "cam", 10);
  assert.throws(() => gate.checkAndConsume("peer-a", "cam", 10));

  // Peer B's telemetry is untouched by A's overload.
  assert.deepEqual(gate.checkAndConsume("peer-b", "cam", 10), { allowed: true });
  assert.deepEqual(gate.checkAndConsume("peer-b", "cam", 10), {
    allowed: false,
    reason: "message-cap",
  });
});

test("channels of the same peer are isolated from each other", () => {
  const clock = fakeClock();
  const gate = new TelemetryGate(
    { windowMs: 1000, maxMessagesPerSecond: 1 },
    clock.now,
  );

  assert.deepEqual(gate.checkAndConsume("peer-a", "cam", 10), { allowed: true });
  assert.deepEqual(gate.checkAndConsume("peer-a", "cam", 10), {
    allowed: false,
    reason: "message-cap",
  });
  assert.deepEqual(gate.checkAndConsume("peer-a", "mic", 10), { allowed: true });
});

test("unregistered channels fail closed on the default budget", () => {
  const clock = fakeClock();
  const gate = new TelemetryGate({}, clock.now);

  for (let i = 0; i < DEFAULT_STREAM_RATE_CONFIG.maxMessagesPerSecond; i++) {
    assert.deepEqual(gate.checkAndConsume("peer-a", "any-channel", 1), {
      allowed: true,
    });
  }
  assert.deepEqual(gate.checkAndConsume("peer-a", "any-channel", 1), {
    allowed: false,
    reason: "message-cap",
  });
});

test("sustained >2x the message cap raises PeerStreamViolationError and pinches the channel", () => {
  const clock = fakeClock();
  const gate = new TelemetryGate(
    { windowMs: 1000, maxMessagesPerSecond: 2, maxBytesPerSecond: 10_000 },
    clock.now,
  );

  gate.checkAndConsume("peer-a", "cam", 10);
  gate.checkAndConsume("peer-a", "cam", 10);
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(gate.checkAndConsume("peer-a", "cam", 10), {
      allowed: false,
      reason: "message-cap",
    });
  }
  // The 5th consecutive denial exceeds 2x (4) — this is the escalation.
  assert.throws(
    () => gate.checkAndConsume("peer-a", "cam", 10),
    (err: unknown) =>
      err instanceof PeerStreamViolationError &&
      err.peerId === "peer-a" &&
      err.channelId === "cam",
  );

  // While pinched, every frame is dropped as a violation, without throwing.
  assert.deepEqual(gate.checkAndConsume("peer-a", "cam", 10), {
    allowed: false,
    reason: "stream-violation",
  });

  // The pinch is temporary: after the cooldown the channel reopens.
  clock.advance(3000);
  assert.deepEqual(gate.checkAndConsume("peer-a", "cam", 10), { allowed: true });
});

test("a peer that respects the cap never trips the violation", () => {
  const clock = fakeClock();
  const gate = new TelemetryGate(
    { windowMs: 1000, maxMessagesPerSecond: 2 },
    clock.now,
  );

  gate.checkAndConsume("peer-a", "cam", 10);
  gate.checkAndConsume("peer-a", "cam", 10);
  clock.advance(1001);
  gate.checkAndConsume("peer-a", "cam", 10);
  clock.advance(1001);
  assert.deepEqual(gate.checkAndConsume("peer-a", "cam", 10), { allowed: true });
});

test("registerStream allows per-channel tuning and resets the window", () => {
  const clock = fakeClock();
  const gate = new TelemetryGate(
    { windowMs: 1000, maxMessagesPerSecond: 1 },
    clock.now,
  );

  gate.registerStream("peer-a", "slow", {
    maxMessagesPerSecond: 10,
    maxBytesPerSecond: 5000,
  });
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(gate.checkAndConsume("peer-a", "slow", 10), { allowed: true });
  }
  assert.deepEqual(gate.checkAndConsume("peer-a", "slow", 10), {
    allowed: false,
    reason: "message-cap",
  });
});

test("closeStream tears the channel state down", () => {
  const clock = fakeClock();
  const gate = new TelemetryGate(
    { windowMs: 1000, maxMessagesPerSecond: 1 },
    clock.now,
  );

  gate.registerStream("peer-a", "cam", { maxMessagesPerSecond: 1 });
  gate.checkAndConsume("peer-a", "cam", 10);
  gate.checkAndConsume("peer-a", "cam", 10);

  gate.closeStream("peer-a", "cam");
  assert.deepEqual(gate.checkAndConsume("peer-a", "cam", 10), { allowed: true });
});

test("reset clears all state", () => {
  const clock = fakeClock();
  const gate = new TelemetryGate(
    { windowMs: 1000, maxMessagesPerSecond: 1 },
    clock.now,
  );

  gate.checkAndConsume("peer-a", "cam", 10);
  gate.checkAndConsume("peer-a", "cam", 10);

  gate.reset();
  assert.deepEqual(gate.checkAndConsume("peer-a", "cam", 10), { allowed: true });
});

test("invalid byteSize is rejected", () => {
  const gate = new TelemetryGate({}, fakeClock().now);
  assert.throws(() => gate.checkAndConsume("peer-a", "cam", -1));
  assert.throws(() => gate.checkAndConsume("peer-a", "cam", 1.5));
});

test("invalid config is rejected at construction and at registerStream", () => {
  assert.throws(() => new TelemetryGate({ maxMessagesPerSecond: 0 }));
  assert.throws(() => new TelemetryGate({ windowMs: -5 }));

  const gate = new TelemetryGate({});
  assert.throws(() => gate.registerStream("peer-a", "cam", { maxBytesPerSecond: 0 }));
  assert.throws(() => gate.registerStream("peer-a", "cam", { maxBytesPerSecond: 1.5 }));
});
