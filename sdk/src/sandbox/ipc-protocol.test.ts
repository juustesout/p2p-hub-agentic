import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IPCErrorCodes,
  IPCParseError,
  isUUIDv4,
  makeIPCError,
  parseIPCMessageEnvelope,
  parseIPCMessageText,
  stringifyIPCMessage,
} from "./ipc-protocol";

const REQUEST_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

test("a valid request parses", () => {
  const msg = parseIPCMessageEnvelope({
    type: "request",
    jsonrpc: "2.0",
    id: REQUEST_ID,
    method: "initialize",
    params: { pluginId: "peersite" },
  });
  assert.deepEqual(msg, {
    type: "request",
    jsonrpc: "2.0",
    id: REQUEST_ID,
    method: "initialize",
    params: { pluginId: "peersite" },
  });
});

test("a valid response with a result parses (including null result)", () => {
  assert.deepEqual(parseIPCMessageEnvelope({
    type: "response",
    jsonrpc: "2.0",
    id: REQUEST_ID,
    result: { initialized: true },
  }), {
    type: "response",
    jsonrpc: "2.0",
    id: REQUEST_ID,
    result: { initialized: true },
  });
  assert.deepEqual(parseIPCMessageEnvelope({
    type: "response",
    jsonrpc: "2.0",
    id: REQUEST_ID,
    result: null,
  }), {
    type: "response",
    jsonrpc: "2.0",
    id: REQUEST_ID,
    result: null,
  });
});

test("a valid response with an error object parses", () => {
  assert.deepEqual(parseIPCMessageEnvelope({
    type: "response",
    jsonrpc: "2.0",
    id: REQUEST_ID,
    error: { code: -32601, message: "unknown method" },
  }), {
    type: "response",
    jsonrpc: "2.0",
    id: REQUEST_ID,
    error: { code: -32601, message: "unknown method" },
  });
});

test("a valid notification parses", () => {
  assert.deepEqual(parseIPCMessageEnvelope({
    type: "notification",
    jsonrpc: "2.0",
    method: "sandbox:crash",
    params: { label: "uncaughtException" },
  }), {
    type: "notification",
    jsonrpc: "2.0",
    method: "sandbox:crash",
    params: { label: "uncaughtException" },
  });
});

test("wrong jsonrpc version is rejected (fail-closed)", () => {
  assert.equal(parseIPCMessageEnvelope({
    type: "request",
    jsonrpc: "1.0",
    id: REQUEST_ID,
    method: "x",
  }), null);
});

test("a missing or unknown type discriminator is rejected", () => {
  assert.equal(parseIPCMessageEnvelope({ jsonrpc: "2.0", id: REQUEST_ID, method: "x" }), null);
  assert.equal(parseIPCMessageEnvelope({
    type: "rpc",
    jsonrpc: "2.0",
    id: REQUEST_ID,
    method: "x",
  }), null);
});

test("a non-UUID or non-string id is rejected", () => {
  assert.equal(parseIPCMessageEnvelope({
    type: "request",
    jsonrpc: "2.0",
    id: "not-a-uuid",
    method: "x",
  }), null);
  assert.equal(parseIPCMessageEnvelope({
    type: "request",
    jsonrpc: "2.0",
    id: 42,
    method: "x",
  }), null);
  assert.equal(parseIPCMessageEnvelope({
    type: "response",
    jsonrpc: "2.0",
    id: "not-a-uuid",
    result: null,
  }), null);
});

test("a request without a method is rejected", () => {
  assert.equal(parseIPCMessageEnvelope({
    type: "request",
    jsonrpc: "2.0",
    id: REQUEST_ID,
  }), null);
});

test("a response with both result and error is rejected (JSON-RPC rule)", () => {
  assert.equal(parseIPCMessageEnvelope({
    type: "response",
    jsonrpc: "2.0",
    id: REQUEST_ID,
    result: 1,
    error: { code: -32603, message: "boom" },
  }), null);
});

test("a response with neither result nor error is rejected", () => {
  assert.equal(parseIPCMessageEnvelope({
    type: "response",
    jsonrpc: "2.0",
    id: REQUEST_ID,
  }), null);
});

test("a malformed error object is rejected", () => {
  assert.equal(parseIPCMessageEnvelope({
    type: "response",
    jsonrpc: "2.0",
    id: REQUEST_ID,
    error: { code: 1.5, message: "x" },
  }), null);
  assert.equal(parseIPCMessageEnvelope({
    type: "response",
    jsonrpc: "2.0",
    id: REQUEST_ID,
    error: { code: -32603 },
  }), null);
});

test("params must be an object or array", () => {
  assert.equal(parseIPCMessageEnvelope({
    type: "request",
    jsonrpc: "2.0",
    id: REQUEST_ID,
    method: "x",
    params: "not-structured",
  }), null);
  assert.equal(parseIPCMessageEnvelope({
    type: "request",
    jsonrpc: "2.0",
    id: REQUEST_ID,
    method: "x",
    params: null,
  }), null);
  assert.ok(parseIPCMessageEnvelope({
    type: "request",
    jsonrpc: "2.0",
    id: REQUEST_ID,
    method: "x",
    params: ["a", 1],
  }) !== null);
});

test("parseIPCMessageText throws PARSE_ERROR for undecodable JSON", () => {
  assert.throws(
    () => parseIPCMessageText("{not json"),
    (err: unknown) =>
      err instanceof IPCParseError && err.code === IPCErrorCodes.PARSE_ERROR,
  );
});

test("parseIPCMessageText throws INVALID_REQUEST for a JSON value that is not a message", () => {
  assert.throws(
    () => parseIPCMessageText('{"type":"request","jsonrpc":"2.0"}'),
    (err: unknown) =>
      err instanceof IPCParseError &&
      err.code === IPCErrorCodes.INVALID_REQUEST,
  );
});

test("stringify + parse round-trips a message", () => {
  const message = {
    type: "notification",
    jsonrpc: "2.0",
    method: "sandbox:crash",
    params: { label: "x" },
  } as const;
  const text = stringifyIPCMessage(message);
  assert.deepEqual(parseIPCMessageText(text), message);
});

test("isUUIDv4 accepts a valid v4 uuid and rejects everything else", () => {
  assert.equal(isUUIDv4(REQUEST_ID), true);
  assert.equal(isUUIDv4("not-a-uuid"), false);
  assert.equal(isUUIDv4(42), false);
  assert.equal(isUUIDv4(undefined), false);
});

test("makeIPCError builds a JSON-RPC error object", () => {
  assert.deepEqual(makeIPCError(IPCErrorCodes.METHOD_NOT_FOUND, "nope"), {
    code: -32601,
    message: "nope",
  });
  assert.deepEqual(
    makeIPCError(IPCErrorCodes.INVALID_REQUEST, "bad", { detail: "x" }),
    { code: -32600, message: "bad", data: { detail: "x" } },
  );
});
