import { test } from "node:test";
import assert from "node:assert/strict";
import { NetworkRegistry } from "./network-registry";
import type { NetworkProvider } from "@p2p-hub/sdk";

interface FakeProvider extends NetworkProvider {
  setReady(ready: boolean): void;
}

function fakeProvider(id: string, priority: number): FakeProvider {
  let ready = false;
  return {
    id,
    priority,
    isReady: () => ready,
    setReady: (value) => {
      ready = value;
    },
    start: async () => {
      ready = true;
    },
    stop: async () => {
      ready = false;
    },
    discover: async () => [],
    sendTask: async () => ({ taskId: "", status: "error", error: "not implemented" }),
    onTask: () => undefined,
  };
}

test("selectActive returns null when no provider is ready", () => {
  const registry = new NetworkRegistry();
  registry.register(fakeProvider("network-light", 10));
  registry.register(fakeProvider("network-agentanycast", 100));

  assert.equal(registry.selectActive(), null);
});

test("selectActive returns network-light when only it is ready", () => {
  const registry = new NetworkRegistry();
  const light = fakeProvider("network-light", 10);
  const anycast = fakeProvider("network-agentanycast", 100);
  registry.register(light);
  registry.register(anycast);

  light.setReady(true);

  assert.equal(registry.selectActive()?.id, "network-light");
});

test("selectActive returns network-agentanycast when both are ready", () => {
  const registry = new NetworkRegistry();
  const light = fakeProvider("network-light", 10);
  const anycast = fakeProvider("network-agentanycast", 100);
  registry.register(light);
  registry.register(anycast);

  light.setReady(true);
  anycast.setReady(true);

  assert.equal(registry.selectActive()?.id, "network-agentanycast");
});

test("selectActive skips a higher-priority provider that cannot transport", () => {
  const registry = new NetworkRegistry();
  const light = fakeProvider("network-light", 10);
  const anycast: FakeProvider = {
    ...fakeProvider("network-agentanycast", 100),
    canTransportTasks: false,
  };
  registry.register(light);
  registry.register(anycast);

  light.setReady(true);
  anycast.setReady(true);

  assert.equal(registry.selectActive()?.id, "network-light");
});

test("selectActive returns null when the only ready provider cannot transport", () => {
  const registry = new NetworkRegistry();
  const anycast: FakeProvider = {
    ...fakeProvider("network-agentanycast", 100),
    canTransportTasks: false,
  };
  registry.register(anycast);

  anycast.setReady(true);

  assert.equal(registry.selectActive(), null);
});
