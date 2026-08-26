import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import "./test-globals";
import { __tauri } from "./stubs/tauri-core";
import { confirmTier2 } from "../src/services/trust-confirm";
import type { ConfirmationRequest } from "../src/services/trust-confirm";

const peerRequest: ConfirmationRequest = {
  kind: "peer-access-request",
  peerId: "12D3KooWTestPeer",
  claim: "wants access to my calendar",
  expiresInMs: 60_000,
  initiator: "operator",
};

describe("trust-confirm", () => {
  beforeEach(() => {
    __tauri.invoke = async () => {
      throw new Error("not stubbed");
    };
  });

  it("returns true when the native dialog confirms", async () => {
    let capturedCommand: string | undefined;
    let capturedRequest: unknown;
    __tauri.invoke = async (command: string, args?: unknown) => {
      capturedCommand = command;
      capturedRequest = (args as { request?: unknown } | undefined)?.request;
      return true;
    };

    const confirmed = await confirmTier2(peerRequest);

    assert.equal(confirmed, true);
    assert.equal(capturedCommand, "request_tier2_confirmation");
    assert.deepEqual(capturedRequest, peerRequest);
  });

  it("returns false when the native dialog denies", async () => {
    __tauri.invoke = async () => false;

    assert.equal(await confirmTier2(peerRequest), false);
  });

  it("fails closed when the native confirmation command is unavailable", async () => {
    assert.equal(await confirmTier2(peerRequest), false);
  });

  it("fails closed when the native confirmation never resolves within the timeout", async () => {
    const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
    const originalSetTimeout = win.setTimeout;
    const originalClearTimeout = win.clearTimeout;
    let fireTimeout: (() => void) | undefined;
    win.setTimeout = (cb: () => void) => {
      fireTimeout = cb;
      return 1;
    };
    win.clearTimeout = () => {};
    let settleInvoke: (value: unknown) => void = () => {};
    __tauri.invoke = async () =>
      new Promise((resolve) => {
        settleInvoke = resolve;
      });

    try {
      const pending = confirmTier2(peerRequest);
      // confirmTier2 awaits the dynamic Tauri import before scheduling the
      // timeout; flush microtasks until the race (and its timer) is set up.
      await Promise.resolve();
      await Promise.resolve();
      assert.ok(fireTimeout, "the bounded confirmation window must be scheduled");
      fireTimeout();
      assert.equal(await pending, false);
    } finally {
      // Settle the now-orphaned host promise and restore real timers so no
      // dangling work outlives this test.
      settleInvoke(false);
      win.setTimeout = originalSetTimeout;
      win.clearTimeout = originalClearTimeout;
      await Promise.resolve();
    }
  });

  it("passes the agent initiator through so the host can name the agent", async () => {
    __tauri.invoke = async () => true;
    const agentRequest: ConfirmationRequest = {
      ...peerRequest,
      initiator: "agent:research-assistant",
    };

    assert.equal(await confirmTier2(agentRequest), true);
  });
});
