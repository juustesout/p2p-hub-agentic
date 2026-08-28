import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SIDECAR_READY_ENV,
  SIDECAR_READY_PREFIX,
  parseSidecarReady,
  sidecarReadyLine,
} from "./sidecar";

test("sidecarReadyLine emits the exact delimiter-anchored line the host scans for", () => {
  const line = sidecarReadyLine({ port: 41823, token: "a1b2c3d4", state: "ready" });
  assert.equal(
    line,
    `[P2P_HUB_READY] {"port":41823,"token":"a1b2c3d4","state":"ready"}`,
  );
  assert.ok(line.startsWith(SIDECAR_READY_PREFIX + " "));
});

test("sidecarReadyLine can report the locked boot state", () => {
  const line = sidecarReadyLine({ port: 41823, token: "a1b2c3d4", state: "locked" });
  assert.ok(line.includes('"state":"locked"'));
});

test("parseSidecarReady round-trips its own output", () => {
  const ready = { port: 41823, token: "a1b2c3d4", state: "ready" as const };
  assert.deepEqual(parseSidecarReady(sidecarReadyLine(ready)), ready);
});

test("parseSidecarReady parses the locked state and keeps it distinct from ready", () => {
  const locked = parseSidecarReady(
    `[P2P_HUB_READY] {"port":41823,"token":"x","state":"locked"}`,
  );
  assert.deepEqual(locked, { port: 41823, token: "x", state: "locked" });
  const ready = parseSidecarReady(
    `[P2P_HUB_READY] {"port":41823,"token":"x","state":"ready"}`,
  );
  assert.deepEqual(ready, { port: 41823, token: "x", state: "ready" });
  assert.notDeepEqual(locked, ready);
});

test("parseSidecarReady tolerates JSON whitespace after the delimiter", () => {
  // `JSON.parse` skips leading whitespace, so an extra space after the prefix
  // still yields the same config — the port range + non-empty token + known
  // state checks below are what keep the handshake fail-closed, not whitespace
  // pedantry.
  assert.deepEqual(
    parseSidecarReady(`[P2P_HUB_READY]   {"port":1,"token":"x","state":"ready"}`),
    { port: 1, token: "x", state: "ready" },
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

test("parseSidecarReady rejects an unknown or missing boot state", () => {
  // The `state` field is the vault lock gate; an unrecognised value must never
  // be half-accepted as if the host knew what it meant (CLAUDE.md #2/#7).
  assert.equal(
    parseSidecarReady(`[P2P_HUB_READY] {"port":1,"token":"x"}`),
    null,
  );
  assert.equal(
    parseSidecarReady(`[P2P_HUB_READY] {"port":1,"token":"x","state":"unlocking"}`),
    null,
  );
  assert.equal(
    parseSidecarReady(`[P2P_HUB_READY] {"port":1,"token":"x","state":true}`),
    null,
  );
});

test("the gate env name is a single, documented flag", () => {
  assert.equal(SIDECAR_READY_ENV, "P2P_HUB_SIDECAR_READY");
});
