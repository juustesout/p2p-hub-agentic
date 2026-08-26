import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import "./test-globals";
import { __tauri } from "./stubs/tauri-core";
import { CoreBridge, __resetBootTokenCache } from "../src/services/core-bridge";
import type { ExecuteRequest } from "../src/types";

interface CapturedRequest {
  url: string;
  init?: RequestInit;
}

type StubWebSocketCtor = {
  instances: { url: string; readyState: number; onmessage: ((e: unknown) => void) | null }[];
  CONNECTING: number;
};

const realFetch = globalThis.fetch;

function stubWebSocketInstances(): { url: string; readyState: number; onmessage: ((e: unknown) => void) | null }[] {
  return ((globalThis as unknown as { WebSocket: StubWebSocketCtor }).WebSocket as StubWebSocketCtor)
    .instances;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("core-bridge", () => {
  let bridge: CoreBridge;
  let fetchCalls: CapturedRequest[];

  beforeEach(() => {
    bridge = new CoreBridge();
    fetchCalls = [];
    __resetBootTokenCache();
    __tauri.invoke = async () => {
      throw new Error("not stubbed");
    };
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      fetchCalls.push({ url, init });
      return {
        ok: true,
        json: async () => ({ ok: true }),
      } as Response;
    };
    const ctor = (globalThis as unknown as { WebSocket: StubWebSocketCtor }).WebSocket as StubWebSocketCtor;
    ctor.instances = [];
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    bridge.disconnect();
  });

  it("presents the boot token as a Bearer header on API calls", async () => {
    __tauri.invoke = async (command: string) =>
      command === "get_boot_token" ? "boot-token-abc" : undefined;
    const request: ExecuteRequest = {
      serviceId: "notes",
      method: "save",
      requestId: "req-1",
      arguments: { text: "hello" },
    };

    await bridge.execute(request);

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, "/api/execute");
    assert.equal(fetchCalls[0].init?.method, "POST");
    const headers = fetchCalls[0].init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer boot-token-abc");
  });

  it("sends API calls without an Authorization header when no token is available", async () => {
    const request: ExecuteRequest = {
      serviceId: "notes",
      method: "save",
      requestId: "req-1",
      arguments: { text: "hello" },
    };

    await bridge.execute(request);

    assert.equal(fetchCalls.length, 1);
    const headers = fetchCalls[0].init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, undefined);
  });

  it("appends the token to the WebSocket query string when one is available", async () => {
    __tauri.invoke = async (command: string) =>
      command === "get_boot_token" ? "boot-token-abc" : undefined;

    bridge.connect();
    await tick();

    const instances = stubWebSocketInstances();
    assert.equal(instances.length, 1);
    assert.equal(instances[0].url, "ws://127.0.0.1:8787/ws?token=boot-token-abc");
  });

  it("opens the WebSocket without a token when none is available", async () => {
    bridge.connect();
    await tick();

    const instances = stubWebSocketInstances();
    assert.equal(instances.length, 1);
    assert.equal(instances[0].url, "ws://127.0.0.1:8787/ws");
  });

  it("fans out event frames to listeners and ignores ping/pong frames", async () => {
    bridge.connect();
    await tick();
    const instances = stubWebSocketInstances();
    assert.equal(instances.length, 1);

    const received: unknown[] = [];
    bridge.onEvent((event) => {
      received.push(event);
    });

    instances[0].onmessage?.({
      data: JSON.stringify({
        type: "event",
        event: "chat:messageReceived",
        payload: { text: "hi" },
        ts: 123,
      }),
    });
    await tick();
    assert.equal(received.length, 1);

    instances[0].onmessage?.({
      data: JSON.stringify({ type: "pong", ts: 124 }),
    });
    await tick();
    assert.equal(received.length, 1, "pong frames are never surfaced as events");

    instances[0].onmessage?.({ data: "not json" });
    await tick();
    assert.equal(received.length, 1, "malformed frames are ignored");
  });
});
