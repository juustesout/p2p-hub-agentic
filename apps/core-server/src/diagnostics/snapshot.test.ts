import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import {
  collectSnapshot,
  snapshotSummary,
  type SnapshotStateSource,
  type DiagnosticSnapshot,
} from "./snapshot";

const PEER_64HEX =
  "9f2ab1c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80";

function fakeState(overrides: Partial<SnapshotStateSource> = {}): SnapshotStateSource {
  return {
    bootState: "ready",
    networkingEnabled: true,
    wanEnabled: true,
    vault: {
      locked: false,
      vaultExists: true,
      networkPaused: false,
      masterKeyConfigured: true,
    },
    provider: {
      id: "network-light",
      ready: true,
      peerCount: 2,
      port: 48901,
    },
    wan: { id: "network-libp2p", ready: true },
    plugins: [
      {
        id: "calendar",
        name: "Calendar",
        version: "1.2.3",
        kind: "plugin",
        signature: "signed",
        certification: "certified",
        state: "ACTIVE",
      },
    ],
    ...overrides,
  };
}

/** Serialize a snapshot and assert no sensitive value survives. */
function assertNoSensitive(raw: unknown, note: string): void {
  const json = JSON.stringify(raw);
  assert.ok(!json.includes(PEER_64HEX), `${note}: 64-hex peerId leaked`);
  assert.ok(
    !/\b[0-9a-f]{64}\b/.test(json),
    `${note}: an unmasked 64-hex value is present`,
  );
  assert.ok(
    !json.toLowerCase().includes("p2p-hub-insecure-dev-key"),
    `${note}: dev fallback master key leaked`,
  );
}

test("collectSnapshot returns the full fixed shape with live OS/runtime data", async () => {
  const snapshot = await collectSnapshot(fakeState(), ["safe-mode"]);
  assert.equal(snapshot.takenAt, snapshot.takenAt); // number, finite
  assert.ok(Number.isFinite(snapshot.takenAt));

  const sys = snapshot.system;
  assert.equal(sys.platform, process.platform);
  assert.equal(sys.arch, process.arch);
  assert.equal(typeof sys.release, "string");
  assert.ok(sys.uptime >= 0);
  assert.ok(sys.totalmem > 0);
  assert.ok(sys.freemem >= 0);
  assert.ok(Array.isArray(sys.cpus));
  assert.equal(sys.cpus[0].model, os.cpus()[0].model);
  assert.equal(typeof sys.loadavg[0], "number");

  const rt = snapshot.runtime;
  assert.equal(rt.nodeVersion, process.version);
  assert.equal(rt.pid, process.pid);
  assert.equal(rt.coreVersion, "0.0.0-dev"); // dev tsc build has no esbuild define
  assert.ok(rt.memoryUsage.heapUsed > 0);
});

test("snapshot network section reflects provider + WAN state", async () => {
  const snapshot = await collectSnapshot(fakeState());
  assert.equal(snapshot.network.providerId, "network-light");
  assert.equal(snapshot.network.providerReady, true);
  assert.equal(snapshot.network.peerCount, 2);
  assert.equal(snapshot.network.boundPort, 48901);
  assert.equal(snapshot.network.wanEnabled, true);
  assert.equal(snapshot.network.wanReady, true);
  assert.equal(snapshot.network.transportMode, "wan");

  const noProvider = await collectSnapshot(fakeState({ provider: null, wan: null }));
  assert.equal(noProvider.network.transportMode, "none");
  assert.equal(noProvider.network.peerCount, 0);
  assert.equal(noProvider.network.providerId, null);
});

test("vault section is a locked/unlocked + boolean, never the key", async () => {
  const unlocked = await collectSnapshot(fakeState());
  assert.deepEqual(unlocked.vault, {
    locked: false,
    vaultExists: true,
    networkPaused: false,
    masterKeyConfigured: true,
  });

  const locked = await collectSnapshot(
    fakeState({
      bootState: "locked",
      vault: {
        locked: true,
        vaultExists: true,
        networkPaused: true,
        masterKeyConfigured: false,
      },
    }),
  );
  assert.deepEqual(locked.vault, {
    locked: true,
    vaultExists: true,
    networkPaused: true,
    masterKeyConfigured: false,
  });
  assert.equal(locked.boot.bootState, "locked");
});

test("plugin section carries provenance/certification, never manifest internals", async () => {
  const snapshot = await collectSnapshot(fakeState());
  const plugin = snapshot.plugins[0];
  assert.deepEqual(plugin, {
    id: "calendar",
    name: "Calendar",
    version: "1.2.3",
    kind: "plugin",
    signature: "signed",
    certification: "certified",
    state: "ACTIVE",
  });
  const json = JSON.stringify(snapshot.plugins);
  assert.ok(!json.includes("permissions"));
  assert.ok(!json.includes("entry"));
});

test("boot flags surface --safe-mode", async () => {
  const safe = await collectSnapshot(fakeState(), ["safe-mode"]);
  assert.deepEqual(safe.boot.bootFlags, ["safe-mode"]);
  const plain = await collectSnapshot(fakeState(), []);
  assert.deepEqual(plain.boot.bootFlags, []);
  assert.equal(plain.boot.networkingEnabled, true);
});

test("hardware section is best-effort and fail-closed (never crashes)", async () => {
  const snapshot = await collectSnapshot(fakeState());
  const hw = snapshot.hardware;
  assert.equal(hw.webglRenderer, null);
  assert.equal(hw.hardwareAcceleration, null);
  assert.equal(hw.windowScaleFactor, null);
  // lspci may or may not exist in CI; either is valid, but never a crash/throw.
  if (hw.gpu !== null) {
    assert.equal(hw.gpu.source, "lspci");
    assert.equal(typeof hw.gpu.renderer, "string");
  }
});

test("the whole snapshot never carries secrets or unmasked identifiers", async () => {
  const snapshot = await collectSnapshot(fakeState(), ["safe-mode"]);
  assertNoSensitive(snapshot, "full snapshot");
  assertNoSensitive(snapshot.system, "system");
  assertNoSensitive(snapshot.runtime, "runtime");
  assertNoSensitive(snapshot.plugins, "plugins");
});

test("snapshotSummary is a short redacted one-liner", async () => {
  const snapshot: DiagnosticSnapshot = await collectSnapshot(fakeState());
  const summary = snapshotSummary(snapshot);
  assert.match(summary, /wan \(2 peers\) via network-light/);
  assert.match(summary, /vault: unlocked/);
  assert.ok(summary.length < 300);
  assert.ok(!summary.includes(PEER_64HEX));
});
