import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CoreServer } from "./app";
import { PluginHost } from "@p2p-hub/core";
import type { WanProviderHandle } from "./wan-provider";

// The pinned libp2p v3 stack (it-queue/mortice use Promise.withResolvers, a
// Node >= 22 API) cannot start on older Nodes. The opt-in WAN test below skips
// there with a visible reason; the "stays off by default" test runs everywhere
// because it never constructs a libp2p node.
const WAN_SKIP =
  Number(process.versions.node.split(".")[0]) < 22 &&
  "the pinned libp2p v3 stack requires Node >= 22 (it uses Promise.withResolvers via it-queue/mortice)";

const BOOT_TOKEN = "wan-glue-token";

/**
 * Temp dirs that boot a real PluginHost — under node_modules/.cache so the
 * copied contacts plugin's `require("@p2p-hub/*")` resolves (same trick as the
 * contacts glue tests).
 */
const TEST_TMP_ROOT = path.resolve(__dirname, "../../../node_modules/.cache/p2p-hub-test");

/** Source of the compiled contacts plugin, copied into each temp pluginsDir. */
const CONTACTS_SRC = path.resolve(__dirname, "../../../plugins/contacts");

interface Booted {
  server: CoreServer;
  port: number;
  host: PluginHost;
}

async function bootWanServer(wanEnabled: boolean): Promise<Booted> {
  await fs.mkdir(TEST_TMP_ROOT, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(TEST_TMP_ROOT, "core-server-wan-glue-"));
  const pluginsDir = path.join(dataDir, "plugins");
  await fs.mkdir(pluginsDir, { recursive: true });
  await fs.cp(CONTACTS_SRC, path.join(pluginsDir, "contacts"), { recursive: true });

  const server = new CoreServer({
    pluginsDir,
    dataDir,
    host: "127.0.0.1",
    port: 0,
    bootToken: BOOT_TOKEN,
    networking: true,
    wanEnabled,
  });
  await server.start();
  const addr = server.address();
  assert.ok(addr, "server should report its bound address");
  const host = (server as unknown as { host: PluginHost }).host;
  return { server, port: addr.port, host };
}

async function waitFor<T>(
  probe: () => T | null | undefined,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function wanProviderOf(server: CoreServer): WanProviderHandle | null {
  return (server as unknown as { wanProvider: WanProviderHandle | null }).wanProvider;
}

test("WAN transport: opt-in via wanEnabled, transport PeerId equals the p2p-hub identity", { skip: WAN_SKIP }, async () => {
  const { server, host } = await bootWanServer(true);
  try {
    // The WAN transport comes up alongside the LAN transport, sharing the
    // operator identity (Optie B unification).
    const wan = await waitFor(() => wanProviderOf(server));
    assert.equal(wan.isReady(), true);

    // Acceptance property: the libp2p transport public key is the SAME raw
    // Ed25519 public key as the p2p-hub identity — one identity over LAN and
    // WAN, no dual-identity split.
    const identity = await host.identityManager().getOrCreateIdentity();
    await waitFor(() => wan.transportPublicKeyHex);
    assert.equal(wan.transportPublicKeyHex, identity.peerId);
  } finally {
    await server.stop();
  }
});

test("WAN transport stays off by default: no provider, no libp2p node", async () => {
  const { server } = await bootWanServer(false);
  try {
    // Without wanEnabled the WAN transport is never constructed — zero WAN
    // surface on a default boot.
    assert.equal(wanProviderOf(server), null);
  } finally {
    await server.stop();
  }
});
