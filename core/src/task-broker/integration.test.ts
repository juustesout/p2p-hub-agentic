import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NetworkLightProvider } from "@p2p-hub/network-light";
import type { NetworkPeer, TaskResult } from "@p2p-hub/sdk";
import { PluginHost } from "../plugin-host/plugin-host";
import { wireNetworkToBroker } from "./wire-network";

async function waitFor<T>(
  check: () => Promise<T | null | undefined>,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null | undefined;
  while (Date.now() < deadline) {
    last = await check();
    if (last) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

async function setupCalendarHost(): Promise<PluginHost> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "broker-integration-"));
  const pluginsDir = path.join(root, "plugins");
  const dataDir = path.join(root, "data");
  const calDir = path.join(pluginsDir, "calendar");
  await fs.mkdir(path.join(calDir, "dist"), { recursive: true });

  await fs.writeFile(
    path.join(calDir, "manifest.json"),
    JSON.stringify({
      id: "calendar",
      version: "0.0.1",
      kind: "generic",
      permissions: [
        "network:skill:calendar.listEvents",
        "network:public:calendar.listEvents",
      ],
      entry: "./dist/index.js",
    }),
  );
  await fs.copyFile(
    path.resolve(__dirname, "../../../plugins/calendar/dist/index.js"),
    path.join(calDir, "dist/index.js"),
  );

  const host = new PluginHost({ pluginsDir, dataDir });
  await host.boot();
  return host;
}

test("a remote task is routed through the broker to the calendar plugin", async () => {
  const host = await setupCalendarHost();

  const calendar = host.getActivated("calendar") as {
    addEvent(event: { title: string; date: string }): Promise<unknown>;
  };
  await calendar.addEvent({ title: "Lunch", date: "2026-08-20" });

  const alice = new NetworkLightProvider({
    port: 0,
    skills: ["calendar.listEvents"],
  });
  const bob = new NetworkLightProvider({ port: 0, skills: [] });

  wireNetworkToBroker(alice, host.taskBroker());

  await alice.start();
  await bob.start();

  try {
    const peers = await waitFor<NetworkPeer[]>(async () => {
      const found = await bob.discover("calendar.listEvents");
      return found.length > 0 ? found : null;
    });

    const result: TaskResult = await bob.sendTask(peers[0], {
      id: "task-1",
      skill: "calendar.listEvents",
      payload: null,
    });

    assert.equal(result.status, "ok");
    const events = result.result as Array<{
      id: string;
      title: string;
      date: string;
    }>;
    assert.equal(events.length, 1);
    assert.equal(events[0].title, "Lunch");
  } finally {
    await alice.stop();
    await bob.stop();
  }
});
