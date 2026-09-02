import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import "./test-globals";
import { __tauri } from "./stubs/tauri-core";
import { CoreBridge, __resetBackendConfigCache, __resetBootTokenCache } from "../src/services/core-bridge";

interface CapturedRequest {
  url: string;
  init?: RequestInit;
}

const realFetch = globalThis.fetch;

describe("core-bridge diagnostics API", () => {
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
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    bridge.disconnect();
  });

  it("tails one source with query params and returns the register", async () => {
    fetchResponse = {
      ok: true,
      json: async () => ({
        ok: true,
        sources: [{ id: "chat", enabled: true }],
        records: { chat: [{ time: 1, level: "info", module: "chat", msg: "peer_9f2a…7f80 hi" }] },
      }),
    } as Response;

    const res = await bridge.diagnosticsLogs({ source: "chat", limit: 200, level: "debug" });

    assert.equal(fetchCalls.length, 1);
    assert.equal(
      fetchCalls[0].url,
      "http://127.0.0.1:8787/api/diagnostics/logs?source=chat&limit=200&level=debug",
    );
    assert.equal(res.ok, true);
    assert.equal(res.sources[0].id, "chat");
  });

  it("sends unredacted=1 only for the explicit power-user opt-in", async () => {
    fetchResponse = { ok: true, json: async () => ({ ok: true, sources: [], records: {} }) } as Response;

    await bridge.diagnosticsLogs({ source: "vault", unredacted: true });

    assert.equal(
      fetchCalls[0].url,
      "http://127.0.0.1:8787/api/diagnostics/logs?source=vault&unredacted=1",
    );
  });

  it("omits the unredacted flag by default", async () => {
    fetchResponse = { ok: true, json: async () => ({ ok: true, sources: [], records: {} }) } as Response;

    await bridge.diagnosticsLogs({ source: "chat" });

    assert.ok(!fetchCalls[0].url.includes("unredacted"));
  });

  it("PATCHes the global level", async () => {
    await bridge.diagnosticsSetLevel("debug");

    assert.equal(fetchCalls[0].url, "http://127.0.0.1:8787/api/diagnostics/level");
    assert.equal(fetchCalls[0].init?.method, "PATCH");
    const body = JSON.parse(String(fetchCalls[0].init?.body));
    assert.equal(body.level, "debug");
  });

  it("PATCHes source enable/disable", async () => {
    await bridge.diagnosticsSetSourceEnabled("chat", false);

    assert.equal(fetchCalls[0].url, "http://127.0.0.1:8787/api/diagnostics/source");
    assert.equal(fetchCalls[0].init?.method, "PATCH");
    const body = JSON.parse(String(fetchCalls[0].init?.body));
    assert.deepEqual(body, { id: "chat", enabled: false });
  });

  it("fetches a server-only snapshot with GET when no GPU probe is passed", async () => {
    fetchResponse = { ok: true, json: async () => ({ ok: true, snapshot: {}, summary: "s" }) } as Response;

    await bridge.diagnosticsSnapshot();

    assert.equal(fetchCalls[0].url, "http://127.0.0.1:8787/api/diagnostics/snapshot");
    assert.equal(fetchCalls[0].init?.method, undefined); // GET
  });

  it("POSTs the webview GPU probe with the snapshot when one is available", async () => {
    fetchResponse = { ok: true, json: async () => ({ ok: true, snapshot: {}, summary: "s" }) } as Response;

    await bridge.diagnosticsSnapshot({
      vendor: "Google Inc.",
      renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11)",
      hardwareAcceleration: true,
      windowScaleFactor: 1.5,
    });

    assert.equal(fetchCalls[0].url, "http://127.0.0.1:8787/api/diagnostics/snapshot");
    assert.equal(fetchCalls[0].init?.method, "POST");
    const body = JSON.parse(String(fetchCalls[0].init?.body));
    assert.equal(body.clientGpu.renderer, "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11)");
    assert.equal(body.clientGpu.hardwareAcceleration, true);
  });

  it("does not attach a null clientGpu to the snapshot POST", async () => {
    fetchResponse = { ok: true, json: async () => ({ ok: true, snapshot: {}, summary: "s" }) } as Response;

    await bridge.diagnosticsSnapshot(null);

    assert.equal(fetchCalls[0].init?.method, undefined);
    assert.ok(!fetchCalls[0].url.includes("?"));
  });

  it("builds a bundle with sections, sources and an optional note", async () => {
    fetchResponse = {
      ok: true,
      json: async () => ({
        ok: true,
        bundle: { kind: "p2p-hub-diagnostic-bundle", redacted: true },
        clipboardText: "p2p-hub diagnostische bundel",
        preview: { sections: ["system"], logSources: [], hasNote: true, redacted: true },
      }),
    } as Response;

    const res = await bridge.createDiagnosticsBundle({
      sections: ["system", "runtime"],
      sources: ["chat", "vault"],
      userNote: "second display black",
    });

    assert.equal(fetchCalls[0].url, "http://127.0.0.1:8787/api/diagnostics/bundle");
    assert.equal(fetchCalls[0].init?.method, "POST");
    const body = JSON.parse(String(fetchCalls[0].init?.body));
    assert.deepEqual(body.sections, ["system", "runtime"]);
    assert.deepEqual(body.sources, ["chat", "vault"]);
    assert.equal(body.userNote, "second display black");
    assert.equal(res.clipboardText, "p2p-hub diagnostische bundel");
  });

  it("omits the userNote from the bundle request when empty", async () => {
    fetchResponse = {
      ok: true,
      json: async () => ({
        ok: true,
        bundle: { redacted: true },
        clipboardText: "",
        preview: { sections: [], logSources: [], hasNote: false, redacted: true },
      }),
    } as Response;

    await bridge.createDiagnosticsBundle({ sections: ["system"], sources: [] });

    const body = JSON.parse(String(fetchCalls[0].init?.body));
    assert.equal(body.userNote, undefined);
  });

  it("attaches the boot token as a Bearer header to diagnostics calls", async () => {
    __tauri.invoke = async (command: string) =>
      command === "get_boot_token" ? "boot-token-abc" : undefined;
    fetchResponse = { ok: true, json: async () => ({ ok: true, sources: [], records: {} }) } as Response;

    await bridge.diagnosticsLogs({ source: "chat" });

    const headers = fetchCalls[0].init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer boot-token-abc");
  });

  it("throws a surfaced server error on a failed diagnostics call", async () => {
    fetchResponse = {
      ok: false,
      json: async () => ({ ok: false, error: "source is security-relevant and cannot be disabled" }),
    } as Response;

    await assert.rejects(
      () => bridge.diagnosticsSetSourceEnabled("vault", false),
      /security-relevant/,
    );
  });
});
