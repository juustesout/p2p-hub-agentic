import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DIAGNOSTICS_DEFAULT_CAPACITY,
  DIAGNOSTICS_MAX_READ,
  RingBuffer,
} from "./ring-buffer";
import type { DiagnosticsRecord } from "./ring-buffer";

function rec(i: number, level = "info", module = "vault"): DiagnosticsRecord {
  return { time: 1000 + i, level, module, msg: `msg ${i}` };
}

test("push/read keeps newest records up to capacity", () => {
  const rb = new RingBuffer(3);
  rb.push(rec(1));
  rb.push(rec(2));
  rb.push(rec(3));
  rb.push(rec(4));
  assert.equal(rb.length, 3);
  assert.deepEqual(
    rb.read().map((r) => r.msg),
    ["msg 2", "msg 3", "msg 4"],
  );
});

test("read returns newest `limit` in order", () => {
  const rb = new RingBuffer(DIAGNOSTICS_DEFAULT_CAPACITY);
  for (let i = 1; i <= 10; i++) {
    rb.push(rec(i));
  }
  const got = rb.read({ limit: 3 });
  assert.deepEqual(
    got.map((r) => r.msg),
    ["msg 8", "msg 9", "msg 10"],
  );
});

test("read limit is clamped to [1, capacity, DIAGNOSTICS_MAX_READ]", () => {
  const rb = new RingBuffer(5);
  for (let i = 1; i <= 5; i++) {
    rb.push(rec(i));
  }
  assert.equal(rb.read({ limit: 0 }).length, 1);
  assert.equal(rb.read({ limit: 9999 }).length, 5);
  assert.equal(rb.read({ limit: 3.9 }).length, 3);
});

test("level filter keeps only records at or above the requested severity", () => {
  const rb = new RingBuffer(20);
  rb.push(rec(1, "debug"));
  rb.push(rec(2, "info"));
  rb.push(rec(3, "warn"));
  rb.push(rec(4, "error"));
  const got = rb.read({ level: "warn" });
  assert.deepEqual(
    got.map((r) => r.msg),
    ["msg 3", "msg 4"],
  );
});

test("unknown level filter is ignored (returns unfiltered tail)", () => {
  const rb = new RingBuffer(5);
  rb.push(rec(1, "debug"));
  rb.push(rec(2, "info"));
  assert.equal(rb.read({ level: "nope" }).length, 2);
});

test("push truncates over-long messages (memory-bound)", () => {
  const rb = new RingBuffer(2);
  rb.push({ time: 1, level: "info", module: "m", msg: "x".repeat(20_000) });
  const [only] = rb.read();
  assert.ok(only.msg.length <= 8_000);
});

test("clear empties the buffer without changing capacity", () => {
  const rb = new RingBuffer(2);
  rb.push(rec(1));
  rb.clear();
  assert.equal(rb.length, 0);
  assert.equal(rb.read().length, 0);
  rb.push(rec(2));
  assert.equal(rb.length, 1);
});

test("read does not mutate the stored buffer", () => {
  const rb = new RingBuffer(4);
  rb.push(rec(1));
  rb.push(rec(2));
  const got = rb.read({ limit: 1 });
  got[0].msg = "mutated";
  assert.deepEqual(
    rb.read().map((r) => r.msg),
    ["msg 1", "msg 2"],
  );
});

test("constructor rejects invalid capacities", () => {
  assert.throws(() => new RingBuffer(0), RangeError);
  assert.throws(() => new RingBuffer(-1), RangeError);
  assert.throws(() => new RingBuffer(2.5), RangeError);
});

test("DIAGNOSTICS_MAX_READ caps reads even for larger buffers", () => {
  const rb = new RingBuffer(DIAGNOSTICS_MAX_READ + 50);
  for (let i = 0; i < DIAGNOSTICS_MAX_READ + 50; i++) {
    rb.push(rec(i));
  }
  const got = rb.read({ limit: 10_000 });
  assert.ok(got.length <= DIAGNOSTICS_MAX_READ);
});
