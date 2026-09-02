import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBundle,
  bundleClipboardText,
  BUNDLE_MAX_RECORDS_PER_SOURCE,
  redactBundle,
  type BundleSourceReader,
} from "./bundler";
import { collectSnapshot, type SnapshotStateSource } from "./snapshot";

const PEER_64HEX =
  "9f2ab1c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80";

function fakeState(): SnapshotStateSource {
  return {
    bootState: "ready",
    networkingEnabled: true,
    wanEnabled: false,
    vault: {
      locked: false,
      vaultExists: true,
      networkPaused: false,
      masterKeyConfigured: true,
    },
    provider: { id: "network-light", ready: true, peerCount: 1, port: 48000 },
    wan: null,
    plugins: [
      {
        id: "calendar",
        version: "1.0.0",
        kind: "plugin",
        signature: "signed",
        certification: "certified",
        state: "ACTIVE",
      },
    ],
  };
}

/** Reader that returns a fixed set of records per source. */
function fakeReader(
  sources: Record<string, Array<{ msg: string; time?: number }>>,
): BundleSourceReader {
  return {
    readSource(id, options) {
      const entries = sources[id];
      if (!entries) {
        return null;
      }
      const limit = options.limit ?? entries.length;
      return {
        source: { level: "info" },
        records: entries.slice(0, limit).map((e) => ({
          time: e.time ?? 1_700_000_000_000,
          level: "info",
          module: id,
          msg: e.msg,
        })),
      };
    },
  };
}

async function makeSnapshot(): Promise<ReturnType<typeof collectSnapshot>> {
  return collectSnapshot(fakeState(), []);
}

test("buildBundle combines snapshot + selected sources + note with a preview", async () => {
  const snapshot = await makeSnapshot();
  const reader = fakeReader({
    chat: [{ msg: "incoming message" }],
    "task-broker": [{ msg: "task delegated" }],
  });
  const bundle = buildBundle({
    snapshot,
    sources: ["chat", "task-broker"],
    userNote: "chat is broken since this morning",
    reader,
  });

  assert.equal(bundle.kind, "p2p-hub-diagnostic-bundle");
  assert.equal(bundle.version, 1);
  assert.equal(bundle.redacted, true);
  assert.equal(bundle.preview.redacted, true);
  assert.equal(bundle.preview.hasNote, true);
  assert.deepEqual(bundle.preview.sections, [
    "system",
    "runtime",
    "hardware",
    "network",
    "vault",
    "boot",
    "plugins",
  ]);
  assert.deepEqual(bundle.preview.logSources, [
    { sourceId: "chat", recordCount: 1 },
    { sourceId: "task-broker", recordCount: 1 },
  ]);
  assert.equal(bundle.logs.length, 2);
  assert.equal(bundle.logs[0].records[0].msg, "incoming message");
  assert.equal(bundle.userNote, "chat is broken since this morning");
});

test("a bundle is always redacted, even when the sources hold secrets", async () => {
  const snapshot = await makeSnapshot();
  const reader = fakeReader({
    chat: [
      { msg: `peer ${PEER_64HEX} sent a message to 192.168.1.23` },
      { msg: `token sk-abcdefghijklmnopqrstuvwx in payload` },
    ],
  });
  const bundle = buildBundle({
    snapshot,
    sources: ["chat"],
    userNote: `reproducer peer ${PEER_64HEX}`,
    reader,
  });

  assert.equal(bundle.redacted, true);
  const json = JSON.stringify(bundle);
  assert.ok(!json.includes(PEER_64HEX), "full peerId must be masked");
  assert.ok(!json.includes("192.168.1.23"), "IPv4 must be masked");
  assert.ok(!json.includes("sk-abcdefghijklmnopqrstuvwx"), "token must be masked");
});

test("unknown source ids are silently dropped, preview reports only bundled ones", async () => {
  const snapshot = await makeSnapshot();
  const reader = fakeReader({ chat: [{ msg: "hello" }] });
  const bundle = buildBundle({
    snapshot,
    sources: ["chat", "does-not-exist", "also-not"],
    reader,
  });
  assert.equal(bundle.logs.length, 1);
  assert.equal(bundle.logs[0].sourceId, "chat");
  assert.deepEqual(bundle.preview.logSources, [{ sourceId: "chat", recordCount: 1 }]);
});

test("section selection restricts the snapshot payload", async () => {
  const snapshot = await makeSnapshot();
  const bundle = buildBundle({
    snapshot,
    sections: ["system", "vault"],
    reader: fakeReader({}),
  });
  assert.deepEqual(bundle.preview.sections, ["system", "vault"]);
  const snapshotObj = bundle.snapshot as Record<string, unknown>;
  assert.ok("system" in snapshotObj);
  assert.ok("vault" in snapshotObj);
  assert.ok(!("plugins" in snapshotObj));
  assert.ok(!("hardware" in snapshotObj));
});

test("record caps bound a single source", async () => {
  const snapshot = await makeSnapshot();
  const many = Array.from({ length: 10_000 }, (_, i) => ({ msg: `line ${i}` }));
  const reader = fakeReader({ chat: many });
  const bundle = buildBundle({ snapshot, sources: ["chat"], reader });
  assert.equal(bundle.logs[0].recordCount, BUNDLE_MAX_RECORDS_PER_SOURCE);
});

test("redactBundle is a deep redaction pass over the whole payload", async () => {
  const snapshot = await makeSnapshot();
  const bundle = buildBundle({
    snapshot,
    reader: fakeReader({ chat: [{ msg: `peer ${PEER_64HEX}` }] }),
  });
  const again = redactBundle(bundle);
  assert.equal(again.redacted, true);
  const json = JSON.stringify(again);
  assert.ok(!json.includes(PEER_64HEX));
});

test("bundleClipboardText is a readable, redacted multi-line text", async () => {
  const snapshot = await makeSnapshot();
  const reader = fakeReader({
    chat: [{ msg: `message from peer ${PEER_64HEX}`, time: 1_700_000_000_000 }],
  });
  const bundle = buildBundle({
    snapshot,
    sources: ["chat"],
    userNote: "the note",
    reader,
  });
  const text = bundleClipboardText(bundle);
  assert.match(text, /p2p-hub diagnostische bundel/);
  assert.match(text, /systeem:/);
  assert.match(text, /log chat/);
  assert.match(text, /notitie:\nthe note/);
  assert.match(text, /2023-11-14T/); // ISO timestamp of the fixed record
  assert.ok(!text.includes(PEER_64HEX), "clipboard text must be redacted");
});
