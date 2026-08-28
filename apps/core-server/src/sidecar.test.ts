import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SIDECAR_READY_ENV,
  SIDECAR_READY_PREFIX,
  parseSidecarReady,
  sidecarReadyLine,
} from "./sidecar";

test("sidecarReadyLine emits the exact delimiter-anchored line the host scans for", () => {
  const line = sidecarReadyLine({ port: 41823, token: "a1b2c3d4" });
  assert.equal(line, `[P2P_HUB_READY] {"port":41823,"token":"a1b2c3d4"}`);
  assert.ok(line.startsWith(SIDECAR_READY_PREFIX + " "));
});

test("parseSidecarReady round-trips its own output", () => {
  const ready = { port: 41823, token: "a1b2c3d4" };
  assert.deepEqual(parseSidecarReady(sidecarReadyLine(ready)), ready);
});

test("parseSidecarReady tolerates JSON whitespace after the delimiter", () => {
  // `JSON.parse` skips leading whitespace, so an extra space after the prefix
  // still yields the same config — the port range + non-empty token checks
  // below are what keep the handshake fail-closed, not whitespace pedantry.
  assert.deepEqual(
    parseSidecarReady(`[P2P_HUB_READY]   {"port":1,"token":"x"}`),
    { port: 1, token: "x" },
  );
});

test("parseSidecarReady is delimiter-anchored on the prefix + space", () => {
  // A bare prefix match must not leak: `[P2P_HUB_READYING]` and `[P2P_HUB_READY]`
  // without the trailing space are NOT the handshake (CLAUDE.md principle #2).
  assert.equal(
    parseSidecarReady(`[P2P_HUB_READYING] {"port":1,"token":"x"}`),
    null,
  );
  assert.equal(
    parseSidecarReady(`[P2P_HUB_READY]{"port":1,"token":"x"}`),
    null,
  );
});

test("parseSidecarReady rejects malformed payloads fail-closed", () => {
  assert.equal(parseSidecarReady(""), null);
  assert.equal(parseSidecarReady("[P2P_HUB_READY] not json"), null);
  assert.equal(parseSidecarReady("[P2P_HUB_READY] []"), null);
  assert.equal(parseSidecarReady("[P2P_HUB_READY] null"), null);
  assert.equal(parseSidecarReady("[P2P_HUB_READY] {\"port\":\"41823\",\"token\":\"x\"}"), null);
  assert.equal(parseSidecarReady("[P2P_HUB_READY] {\"port\":0,\"token\":\"x\"}"), null);
  assert.equal(parseSidecarReady("[P2P_HUB_READY] {\"port\":-1,\"token\":\"x\"}"), null);
  assert.equal(parseSidecarReady("[P2P_HUB_READY] {\"port\":65536,\"token\":\"x\"}"), null);
  assert.equal(parseSidecarReady("[P2P_HUB_READY] {\"port\":41823}"), null);
  assert.equal(parseSidecarReady("[P2P_HUB_READY] {\"port\":41823,\"token\":\"\"}"), null);
});

test("the gate env name is a single, documented flag", () => {
  assert.equal(SIDECAR_READY_ENV, "P2P_HUB_SIDECAR_READY");
});
