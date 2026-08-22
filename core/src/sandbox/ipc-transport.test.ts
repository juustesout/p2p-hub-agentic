import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import type { IPCMessageEnvelope } from "@p2p-hub/sdk";
import { IPCErrorCodes, IPCParseError } from "@p2p-hub/sdk";
import {
  IPC_FRAME_HEADER_BYTES,
  IPCSocketTransport,
} from "./ipc-transport";

const REQUEST_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

/** Build the exact wire bytes of a length-prefixed frame. */
function encodeFrame(message: IPCMessageEnvelope): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const frame = Buffer.alloc(IPC_FRAME_HEADER_BYTES + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, IPC_FRAME_HEADER_BYTES);
  return frame;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function request(): IPCMessageEnvelope {
  return {
    type: "request",
    jsonrpc: "2.0",
    id: REQUEST_ID,
    method: "initialize",
    params: { pluginId: "peersite" },
  };
}

test("round-trip: a request reaches the peer transport and a response comes back", async () => {
  const hostToWorker = new PassThrough();
  const workerToHost = new PassThrough();
  const host = new IPCSocketTransport(workerToHost, hostToWorker);
  const worker = new IPCSocketTransport(hostToWorker, workerToHost);

  const hostReceived: IPCMessageEnvelope[] = [];
  const workerReceived: IPCMessageEnvelope[] = [];
  host.onMessage((m) => hostReceived.push(m));
  worker.onMessage((m) => workerReceived.push(m));

  host.send(request());
  await waitFor(() => workerReceived.length === 1);
  assert.deepEqual(workerReceived[0], request());

  worker.send({
    type: "response",
    jsonrpc: "2.0",
    id: REQUEST_ID,
    result: { initialized: true },
  });
  await waitFor(() => hostReceived.length === 1);
  assert.deepEqual(hostReceived[0], {
    type: "response",
    jsonrpc: "2.0",
    id: REQUEST_ID,
    result: { initialized: true },
  });

  host.close();
  worker.close();
});

test("a single message split across many fragmented chunks is reassembled", async () => {
  const input = new PassThrough();
  const transport = new IPCSocketTransport(input, new PassThrough());
  const received: IPCMessageEnvelope[] = [];
  transport.onMessage((m) => received.push(m));

  const frame = encodeFrame(request());
  for (const byte of frame) {
    input.write(Buffer.from([byte]));
  }
  await waitFor(() => received.length === 1);
  assert.deepEqual(received[0], request());
});

test("multiple frames in a single chunk are each delivered", async () => {
  const input = new PassThrough();
  const transport = new IPCSocketTransport(input, new PassThrough());
  const received: IPCMessageEnvelope[] = [];
  transport.onMessage((m) => received.push(m));

  input.write(
    Buffer.concat([
      encodeFrame(request()),
      encodeFrame({ type: "notification", jsonrpc: "2.0", method: "ping" }),
    ]),
  );
  await waitFor(() => received.length === 2);
  assert.equal(received[0].type, "request");
  assert.equal(received[1].type, "notification");
});

test("malformed JSON fails closed with PARSE_ERROR, never reaches the handler", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = new IPCSocketTransport(input, output);
  const errors: Error[] = [];
  let closed = false;
  let messages = 0;
  transport.onMessage(() => {
    messages += 1;
  });
  transport.onError((err) => errors.push(err));
  transport.onClose(() => {
    closed = true;
  });

  const bad = Buffer.from("this is not json");
  const frame = Buffer.alloc(IPC_FRAME_HEADER_BYTES + bad.length);
  frame.writeUInt32BE(bad.length, 0);
  bad.copy(frame, IPC_FRAME_HEADER_BYTES);
  input.write(frame);

  await waitFor(() => errors.length === 1 && closed);
  assert.ok(errors[0] instanceof IPCParseError);
  assert.equal((errors[0] as IPCParseError).code, IPCErrorCodes.PARSE_ERROR);
  assert.equal(messages, 0, "a malformed frame must never dispatch a handler");
});

test("an invalid envelope fails closed with INVALID_REQUEST", async () => {
  const input = new PassThrough();
  const transport = new IPCSocketTransport(input, new PassThrough());
  const errors: Error[] = [];
  transport.onError((err) => errors.push(err));

  // Valid JSON, but the id is not a UUIDv4.
  input.write(encodeFrame({
    type: "request",
    jsonrpc: "2.0",
    id: "not-a-uuid",
    method: "x",
  }));

  await waitFor(() => errors.length === 1);
  assert.ok(errors[0] instanceof IPCParseError);
  assert.equal((errors[0] as IPCParseError).code, IPCErrorCodes.INVALID_REQUEST);
});

test("an oversized frame is rejected before allocation", async () => {
  const input = new PassThrough();
  const transport = new IPCSocketTransport(input, new PassThrough(), {
    maxFrameBytes: 16,
  });
  const errors: Error[] = [];
  transport.onError((err) => errors.push(err));

  // Header declares 100 bytes, well above the 16-byte cap.
  const header = Buffer.alloc(IPC_FRAME_HEADER_BYTES);
  header.writeUInt32BE(100, 0);
  input.write(header);

  await waitFor(() => errors.length === 1);
  assert.ok(errors[0] instanceof IPCParseError);
  assert.equal((errors[0] as IPCParseError).code, IPCErrorCodes.FRAME_TOO_LARGE);
});

test("sending on a closed channel throws CHANNEL_CLOSED", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = new IPCSocketTransport(input, output);
  transport.close();
  assert.throws(
    () => transport.send(request()),
    (err: unknown) =>
      err instanceof IPCParseError &&
      err.code === IPCErrorCodes.CHANNEL_CLOSED,
  );
});

test("close() is idempotent and fires the close handler once", async () => {
  const input = new PassThrough();
  const transport = new IPCSocketTransport(input, new PassThrough());
  let closes = 0;
  transport.onClose(() => {
    closes += 1;
  });
  transport.close();
  transport.close();
  assert.equal(transport.isClosed(), true);
  assert.equal(closes, 1);
});

test("backpressure: many writes are queued and all flush on drain", async () => {
  const hostToWorker = new PassThrough({ highWaterMark: 8 });
  const workerToHost = new PassThrough();
  const host = new IPCSocketTransport(workerToHost, hostToWorker);
  const worker = new IPCSocketTransport(hostToWorker, workerToHost);
  const received: IPCMessageEnvelope[] = [];
  worker.onMessage((m) => received.push(m));

  for (let i = 0; i < 100; i++) {
    host.send({
      type: "notification",
      jsonrpc: "2.0",
      method: "data",
      params: { i, blob: "x".repeat(256) },
    });
  }
  // The 8-byte highWaterMark forces writes to return false; the reader drains
  // them and 'drain' lets the queue flush. Every frame must arrive intact.
  await waitFor(() => received.length === 100);
  assert.equal(received.length, 100);
  assert.deepEqual(
    (received[99] as { params: { i: number; blob: string } }).params,
    { i: 99, blob: "x".repeat(256) },
  );

  host.close();
  worker.close();
});

test("a throwing writable fails the channel with the wrapped error", async () => {
  const input = new PassThrough();
  const output = new Writable({
    write(_chunk, _enc, cb) {
      cb(new Error("disk full"));
    },
  });
  const transport = new IPCSocketTransport(input, output);
  const errors: Error[] = [];
  transport.onError((err) => errors.push(err));

  transport.send(request());
  await waitFor(() => errors.length === 1);
  assert.equal(errors[0].message, "disk full");
  assert.equal(transport.isClosed(), true);
});
