import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import "./test-globals";
import { __tauri } from "./stubs/tauri-core";
import { CoreBridge, __resetBackendConfigCache, __resetBootTokenCache, initialLockHint } from "../src/services/core-bridge";
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
  let fetchResponse: Response | (() => Response);

  beforeEach(() => {
    bridge = new CoreBridge();
    fetchCalls = [];
    fetchResponse = { ok: true, json: async () => ({ ok: true }) } as Response;
    __resetBootTokenCache();
    __resetBackendConfigCache();
    __tauri.invoke = async () => {
      throw new Error("not stubbed");
    };
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      fetchCalls.push({ url, init });
      return typeof fetchResponse === "function" ? fetchResponse() : fetchResponse;
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
    assert.equal(fetchCalls[0].url, "http://127.0.0.1:8787/api/execute");
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

  it("uses the sidecar's OS-assigned port and token from get_backend_config", async () => {
    // The Rust shell spawns the core-server on an ephemeral port and reports
    // {port, token} via get_backend_config — the frontend must follow that
    // instead of assuming location.host.
    __tauri.invoke = async (command: string) =>
      command === "get_backend_config"
        ? { port: 44619, token: "boot-token-abc" }
        : undefined;

    bridge.connect();
    await tick();

    const instances = stubWebSocketInstances();
    assert.equal(instances.length, 1);
    assert.equal(instances[0].url, "ws://127.0.0.1:44619/ws?token=boot-token-abc");
  });

  it("targets API calls at the sidecar-provided port with its token", async () => {
    __tauri.invoke = async (command: string) =>
      command === "get_backend_config"
        ? { port: 44619, token: "boot-token-abc" }
        : undefined;
    const request: ExecuteRequest = {
      serviceId: "notes",
      method: "save",
      requestId: "req-1",
      arguments: { text: "hello" },
    };

    await bridge.execute(request);

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, "http://127.0.0.1:44619/api/execute");
    const headers = fetchCalls[0].init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer boot-token-abc");
  });

  it("rejects a malformed get_backend_config payload and falls back", async () => {
    // A broken sidecar handshake payload must fail closed to the same-origin
    // dev proxy, never produce a garbage URL.
    __tauri.invoke = async (command: string) =>
      command === "get_backend_config" ? { port: "not-a-port" } : undefined;

    bridge.connect();
    await tick();

    const instances = stubWebSocketInstances();
    assert.equal(instances.length, 1);
    assert.equal(instances[0].url, "ws://127.0.0.1:8787/ws");
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

  it("reads the lock-gate state from /api/health", async () => {
    fetchResponse = {
      ok: true,
      json: async () => ({
        ok: true,
        locked: true,
        vaultExists: true,
        networkPaused: false,
      }),
    } as Response;

    const gate = await bridge.getHealth();

    assert.equal(gate.locked, true);
    assert.equal(gate.vaultExists, true);
    assert.equal(gate.networkPaused, false);
  });

  it("returns ok on a successful unlock", async () => {
    fetchResponse = { ok: true, json: async () => ({ ok: true }) } as Response;

    const result = await bridge.unlockVault("the-master-key");

    assert.equal(result.ok, true);
    assert.equal(result.error, undefined);
    const headers = fetchCalls[0].init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, undefined);
    const body = JSON.parse(String(fetchCalls[0].init?.body));
    assert.equal(body.masterKey, "the-master-key");
  });

  it("surfaces a wrong-key 401 as a terse non-throwing failure", async () => {
    fetchResponse = {
      ok: false,
      json: async () => ({ ok: false, error: "invalid master key" }),
    } as Response;

    const result = await bridge.unlockVault("wrong");

    assert.equal(result.ok, false);
    assert.equal(result.error, "invalid master key");
  });

  it("posts lock/pause/resume to their operator routes", async () => {
    await bridge.lockVault();
    assert.equal(fetchCalls[0].url, "http://127.0.0.1:8787/api/vault/lock");

    await bridge.setNetworkPaused(true);
    assert.equal(fetchCalls[1].url, "http://127.0.0.1:8787/api/network/pause");

    await bridge.setNetworkPaused(false);
    assert.equal(fetchCalls[2].url, "http://127.0.0.1:8787/api/network/resume");
  });

  it("exposes the boot-handshake lock hint", async () => {
    __tauri.invoke = async (command: string) =>
      command === "get_backend_config"
        ? { port: 44619, token: "boot-token-abc", locked: true }
        : undefined;

    assert.equal(await initialLockHint(), true);
    __resetBackendConfigCache();

    __tauri.invoke = async (command: string) =>
      command === "get_backend_config"
        ? { port: 44619, token: "boot-token-abc", locked: false }
        : undefined;
    assert.equal(await initialLockHint(), false);
    __resetBackendConfigCache();
  });

  it("returns null for the lock hint without a Tauri config", async () => {
    assert.equal(await initialLockHint(), null);
  });
});
