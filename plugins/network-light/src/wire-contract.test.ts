import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NETWORK_PROTOCOL_ID,
  NETWORK_PROTOCOL_VERSION,
  encodeHello,
  encodeHelloAck,
  encodeResult,
  encodeTask,
  negotiateVersion,
  parseEnvelope,
} from "./wire-contract";

// The canonical serializations below are pinned on purpose: they are the wire
// contract. If a canonical field order or the protocol id/version ever changes,
// these tests (and any independent implementation following the spec) must be
// reviewed. This is the "no shared TS constructor" guarantee — the bytes are
// the source of truth.
test("canonical serializations are pinned byte-for-byte", () => {
  assert.equal(
    encodeHello([1], ["echo"]),
    '{"protocol":"p2p-hub:network","version":1,"type":"hello",' +
      '"body":{"versions":[1],"capabilities":["echo"]}}',
  );
  assert.equal(
    encodeHelloAck(1, ["echo"], { maxPayloadBytes: 1000 }),
    '{"protocol":"p2p-hub:network","version":1,"type":"hello_ack",' +
      '"body":{"version":1,"capabilities":["echo"],"limits":{"maxPayloadBytes":1000}}}',
  );
  assert.equal(
    encodeHelloAck(1, ["echo"]),
    '{"protocol":"p2p-hub:network","version":1,"type":"hello_ack",' +
      '"body":{"version":1,"capabilities":["echo"]}}',
  );
  assert.equal(
    encodeTask({ id: "t", skill: "echo", payload: "hi" }),
    '{"protocol":"p2p-hub:network","version":1,"type":"task",' +
      '"body":{"id":"t","skill":"echo","payload":"hi"}}',
  );
  assert.equal(
    encodeResult({ taskId: "t", status: "ok", result: {} }),
    '{"protocol":"p2p-hub:network","version":1,"type":"result",' +
      '"body":{"taskId":"t","status":"ok","result":{}}}',
  );
  assert.equal(
    encodeResult({ taskId: "t", status: "error", error: "boom" }),
    '{"protocol":"p2p-hub:network","version":1,"type":"result",' +
      '"body":{"taskId":"t","status":"error","error":"boom"}}',
  );
  assert.equal(
    encodeResult({ taskId: "t", status: "error", result: { x: 1 }, error: "boom" }),
    '{"protocol":"p2p-hub:network","version":1,"type":"result",' +
      '"body":{"taskId":"t","status":"error","result":{"x":1},"error":"boom"}}',
  );
});

test("every encoded message round-trips through parseEnvelope", () => {
  const messages = [
    encodeHello([1], ["a", "b"]),
    encodeHelloAck(1, ["a"], { maxPayloadBytes: 1000 }),
    encodeHelloAck(1, []),
    encodeTask({ id: "t1", skill: "s", payload: { deep: [1, 2, 3] } }),
    encodeResult({ taskId: "t1", status: "ok", result: 42 }),
    encodeResult({ taskId: "t1", status: "error", error: "no" }),
  ];
  for (const raw of messages) {
    const envelope = parseEnvelope(JSON.parse(raw));
    assert.ok(envelope, `must parse: ${raw}`);
    assert.equal(envelope.protocol, NETWORK_PROTOCOL_ID);
    assert.equal(envelope.version, NETWORK_PROTOCOL_VERSION);
  }
});

test("parseEnvelope default-denies unknown protocol, version and shape", () => {
  const validBody = { versions: [1], capabilities: [] };
  // Unknown protocol id.
  assert.equal(
    parseEnvelope({ protocol: "p2p-hub:other", version: 1, type: "hello", body: validBody }),
    null,
  );
  // Unsupported version.
  assert.equal(
    parseEnvelope({ protocol: NETWORK_PROTOCOL_ID, version: 2, type: "hello", body: validBody }),
    null,
  );
  // Unknown message type.
  assert.equal(
    parseEnvelope({ protocol: NETWORK_PROTOCOL_ID, version: 1, type: "nope", body: {} }),
    null,
  );
  // Not an object.
  assert.equal(parseEnvelope("hello"), null);
  assert.equal(parseEnvelope(null), null);

  // hello: empty / string versions.
  assert.equal(
    parseEnvelope({ protocol: NETWORK_PROTOCOL_ID, version: 1, type: "hello", body: { versions: [], capabilities: [] } }),
    null,
  );
  assert.equal(
    parseEnvelope({ protocol: NETWORK_PROTOCOL_ID, version: 1, type: "hello", body: { versions: ["1"], capabilities: [] } }),
    null,
  );
  // hello: too many capabilities.
  assert.equal(
    parseEnvelope({
      protocol: NETWORK_PROTOCOL_ID,
      version: 1,
      type: "hello",
      body: { versions: [1], capabilities: new Array(257).fill("s") },
    }),
    null,
  );

  // task: missing id / missing payload.
  assert.equal(
    parseEnvelope({ protocol: NETWORK_PROTOCOL_ID, version: 1, type: "task", body: { skill: "s", payload: 1 } }),
    null,
  );
  assert.equal(
    parseEnvelope({ protocol: NETWORK_PROTOCOL_ID, version: 1, type: "task", body: { id: "t", skill: "s" } }),
    null,
  );

  // result: bad status / non-string error.
  assert.equal(
    parseEnvelope({ protocol: NETWORK_PROTOCOL_ID, version: 1, type: "result", body: { taskId: "t", status: "maybe" } }),
    null,
  );
  assert.equal(
    parseEnvelope({ protocol: NETWORK_PROTOCOL_ID, version: 1, type: "result", body: { taskId: "t", status: "error", error: 5 } }),
    null,
  );

  // hello_ack: non-positive version / invalid limit.
  assert.equal(
    parseEnvelope({ protocol: NETWORK_PROTOCOL_ID, version: 1, type: "hello_ack", body: { version: 0, capabilities: [] } }),
    null,
  );
  assert.equal(
    parseEnvelope({
      protocol: NETWORK_PROTOCOL_ID,
      version: 1,
      type: "hello_ack",
      body: { version: 1, capabilities: [], limits: { maxPayloadBytes: 0 } },
    }),
    null,
  );
});

test("negotiateVersion picks our version or denies", () => {
  assert.equal(negotiateVersion([1]), NETWORK_PROTOCOL_VERSION);
  assert.equal(negotiateVersion([2, 1]), NETWORK_PROTOCOL_VERSION);
  assert.equal(negotiateVersion([2]), null);
  assert.equal(negotiateVersion([]), null);
  assert.equal(negotiateVersion(undefined), null);
  assert.equal(negotiateVersion("1"), null);
  assert.equal(negotiateVersion([1, "1"]), NETWORK_PROTOCOL_VERSION);
});
