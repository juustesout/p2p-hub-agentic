import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import "./test-globals";
import { coreBridge } from "../src/services/core-bridge";
import { CORE_ORIGIN, PluginBridge, pluginUiUrl } from "../src/services/plugin-bridge";
import type { ExecuteRequest } from "../src/types";

interface FakeSourceWindow {
  postMessage: (message: unknown, targetOrigin: string) => void;
  [key: string]: unknown;
}

function fakeSourceWindow(records: { message: unknown; targetOrigin: string }[]): FakeSourceWindow {
  return {
    postMessage(message: unknown, targetOrigin: string): void {
      records.push({ message, targetOrigin });
    },
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const originalExecute = coreBridge.execute;

describe("plugin-bridge", () => {
  afterEach(() => {
    coreBridge.execute = originalExecute;
  });

  describe("pluginUiUrl", () => {
    it("carries no query string and no boot token", () => {
      const url = pluginUiUrl("notes");
      assert.equal(url, `${CORE_ORIGIN}/ui/notes/`);
      assert.ok(!url.includes("?"));
      assert.ok(!url.includes("token"));
    });

    it("encodes hostile plugin ids so they cannot alter the path", () => {
      const url = pluginUiUrl("a b/../../etc");
      assert.equal(url, `${CORE_ORIGIN}/ui/${encodeURIComponent("a b/../../etc")}/`);
      assert.ok(!url.includes(" "));
      assert.ok(!url.includes("/.."));
    });
  });

  describe("message authentication", () => {
    it("accepts an allowlisted call only from the exact core origin", async () => {
      const bridge = new PluginBridge();
      bridge.registerCapability("notes", ["notes.save"]);
      const sent: { message: unknown; targetOrigin: string }[] = [];
      const source = fakeSourceWindow(sent);
      bridge.bindSource("notes", source as unknown as MessageEventSource);
      bridge.attach();
      const executeCalls: ExecuteRequest[] = [];
      coreBridge.execute = async (req: ExecuteRequest) => {
        executeCalls.push(req);
        return { taskId: req.requestId ?? "", status: "ok", result: { ok: true } };
      };

      (globalThis as unknown as { window: { __emitMessage: (e: unknown) => void } }).window.__emitMessage({
        origin: CORE_ORIGIN,
        source,
        data: {
          source: "p2p-hub-plugin",
          pluginId: "notes",
          requestId: "req-1",
          serviceId: "notes",
          method: "save",
          arguments: { text: "hello" },
        },
      });
      await tick();

      assert.equal(executeCalls.length, 1);
      assert.deepEqual(executeCalls[0], {
        serviceId: "notes",
        method: "save",
        requestId: "req-1",
        arguments: { text: "hello" },
      });
      assert.equal(sent.length, 1);
      assert.equal(sent[0].targetOrigin, CORE_ORIGIN);
      const result = sent[0].message as Record<string, unknown>;
      assert.equal(result.source, "p2p-hub-shell");
      assert.equal(result.requestId, "req-1");
      assert.equal(result.status, "ok");
    });

    it("drops calls from a foreign origin", async () => {
      const bridge = new PluginBridge();
      bridge.registerCapability("notes", ["notes.save"]);
      const sent: { message: unknown; targetOrigin: string }[] = [];
      const source = fakeSourceWindow(sent);
      bridge.bindSource("notes", source as unknown as MessageEventSource);
      bridge.attach();
      const executeCalls: ExecuteRequest[] = [];
      coreBridge.execute = async (req: ExecuteRequest) => {
        executeCalls.push(req);
        return { taskId: req.requestId ?? "", status: "ok", result: {} };
      };

      (globalThis as unknown as { window: { __emitMessage: (e: unknown) => void } }).window.__emitMessage({
        origin: "https://evil.example",
        source,
        data: {
          source: "p2p-hub-plugin",
          pluginId: "notes",
          requestId: "req-1",
          serviceId: "notes",
          method: "save",
        },
      });
      await tick();

      assert.equal(executeCalls.length, 0);
      assert.equal(sent.length, 0);
    });

    it("drops calls from an unbound window that shares the core origin", async () => {
      const bridge = new PluginBridge();
      bridge.registerCapability("notes", ["notes.save"]);
      const sent: { message: unknown; targetOrigin: string }[] = [];
      const unboundSource = fakeSourceWindow(sent);
      bridge.attach();
      const executeCalls: ExecuteRequest[] = [];
      coreBridge.execute = async (req: ExecuteRequest) => {
        executeCalls.push(req);
        return { taskId: req.requestId ?? "", status: "ok", result: {} };
      };

      // Mirrors the /remote-site/<peerId> surface: same core-server origin,
      // never bound to a plugin, so it must not reach the bridge.
      (globalThis as unknown as { window: { __emitMessage: (e: unknown) => void } }).window.__emitMessage({
        origin: CORE_ORIGIN,
        source: unboundSource,
        data: {
          source: "p2p-hub-plugin",
          pluginId: "notes",
          requestId: "req-1",
          serviceId: "notes",
          method: "save",
        },
      });
      await tick();

      assert.equal(executeCalls.length, 0);
      assert.equal(sent.length, 0);
    });

    it("rejects a call whose skill is not on the plugin allowlist", async () => {
      const bridge = new PluginBridge();
      bridge.registerCapability("notes", ["notes.save"]);
      const sent: { message: unknown; targetOrigin: string }[] = [];
      const source = fakeSourceWindow(sent);
      bridge.bindSource("notes", source as unknown as MessageEventSource);
      bridge.attach();
      const executeCalls: ExecuteRequest[] = [];
      coreBridge.execute = async (req: ExecuteRequest) => {
        executeCalls.push(req);
        return { taskId: req.requestId ?? "", status: "ok", result: {} };
      };

      (globalThis as unknown as { window: { __emitMessage: (e: unknown) => void } }).window.__emitMessage({
        origin: CORE_ORIGIN,
        source,
        data: {
          source: "p2p-hub-plugin",
          pluginId: "notes",
          requestId: "req-1",
          serviceId: "notes",
          method: "delete",
        },
      });
      await tick();

      assert.equal(executeCalls.length, 0);
      assert.equal(sent.length, 1);
      const result = sent[0].message as Record<string, unknown>;
      assert.equal(result.status, "error");
      assert.match(String(result.error), /not permitted to call/);
    });

    it("a spoofed pluginId grants nothing beyond the bound window's own capabilities", async () => {
      const bridge = new PluginBridge();
      bridge.registerCapability("notes", ["notes.save"]);
      bridge.registerCapability("vault", ["vault.readSecret"]);
      const sent: { message: unknown; targetOrigin: string }[] = [];
      const source = fakeSourceWindow(sent);
      bridge.bindSource("notes", source as unknown as MessageEventSource);
      bridge.attach();
      const executeCalls: ExecuteRequest[] = [];
      coreBridge.execute = async (req: ExecuteRequest) => {
        executeCalls.push(req);
        return { taskId: req.requestId ?? "", status: "ok", result: {} };
      };

      (globalThis as unknown as { window: { __emitMessage: (e: unknown) => void } }).window.__emitMessage({
        origin: CORE_ORIGIN,
        source,
        data: {
          source: "p2p-hub-plugin",
          pluginId: "vault",
          requestId: "req-1",
          serviceId: "vault",
          method: "readSecret",
        },
      });
      await tick();

      assert.equal(executeCalls.length, 0);
      assert.equal(sent.length, 1);
      const result = sent[0].message as Record<string, unknown>;
      assert.equal(result.status, "error");
      assert.match(String(result.error), /not permitted to call/);
    });

    it("answers malformed payloads with an error and never dispatches", async () => {
      const bridge = new PluginBridge();
      bridge.registerCapability("notes", ["notes.save"]);
      const sent: { message: unknown; targetOrigin: string }[] = [];
      const source = fakeSourceWindow(sent);
      bridge.bindSource("notes", source as unknown as MessageEventSource);
      bridge.attach();
      const executeCalls: ExecuteRequest[] = [];
      coreBridge.execute = async (req: ExecuteRequest) => {
        executeCalls.push(req);
        return { taskId: req.requestId ?? "", status: "ok", result: {} };
      };

      (globalThis as unknown as { window: { __emitMessage: (e: unknown) => void } }).window.__emitMessage({
        origin: CORE_ORIGIN,
        source,
        data: { source: "p2p-hub-plugin", pluginId: "notes" },
      });
      await tick();

      assert.equal(executeCalls.length, 0);
      assert.equal(sent.length, 1);
      const result = sent[0].message as Record<string, unknown>;
      assert.equal(result.status, "error");
      assert.match(String(result.error), /malformed/);
    });

    it("a smuggled token field in a call is never forwarded to core", async () => {
      const bridge = new PluginBridge();
      bridge.registerCapability("notes", ["notes.save"]);
      const sent: { message: unknown; targetOrigin: string }[] = [];
      const source = fakeSourceWindow(sent);
      bridge.bindSource("notes", source as unknown as MessageEventSource);
      bridge.attach();
      const executeCalls: ExecuteRequest[] = [];
      coreBridge.execute = async (req: ExecuteRequest) => {
        executeCalls.push(req);
        return { taskId: req.requestId ?? "", status: "ok", result: {} };
      };

      (globalThis as unknown as { window: { __emitMessage: (e: unknown) => void } }).window.__emitMessage({
        origin: CORE_ORIGIN,
        source,
        data: {
          source: "p2p-hub-plugin",
          pluginId: "notes",
          requestId: "req-1",
          serviceId: "notes",
          method: "save",
          arguments: { text: "hello" },
          token: "boot-token-abc",
        },
      });
      await tick();

      assert.equal(executeCalls.length, 1);
      assert.deepEqual(executeCalls[0], {
        serviceId: "notes",
        method: "save",
        requestId: "req-1",
        arguments: { text: "hello" },
      });
      const result = sent[0].message as Record<string, unknown>;
      assert.ok(!("token" in result));
      assert.ok(!JSON.stringify(result).includes("boot-token-abc"));
    });

    it("clearing capabilities revokes an existing binding's access", async () => {
      const bridge = new PluginBridge();
      bridge.registerCapability("notes", ["notes.save"]);
      const sent: { message: unknown; targetOrigin: string }[] = [];
      const source = fakeSourceWindow(sent);
      bridge.bindSource("notes", source as unknown as MessageEventSource);
      bridge.attach();
      const executeCalls: ExecuteRequest[] = [];
      coreBridge.execute = async (req: ExecuteRequest) => {
        executeCalls.push(req);
        return { taskId: req.requestId ?? "", status: "ok", result: {} };
      };
      bridge.clearCapabilities();

      (globalThis as unknown as { window: { __emitMessage: (e: unknown) => void } }).window.__emitMessage({
        origin: CORE_ORIGIN,
        source,
        data: {
          source: "p2p-hub-plugin",
          pluginId: "notes",
          requestId: "req-1",
          serviceId: "notes",
          method: "save",
        },
      });
      await tick();

      assert.equal(executeCalls.length, 0);
      assert.equal(sent.length, 1);
      const result = sent[0].message as Record<string, unknown>;
      assert.equal(result.status, "error");
    });
  });
});
