import { test } from "node:test";
import assert from "node:assert/strict";
import {
  levelMeta,
  formatLogTime,
  displayRecord,
  filterRecords,
  transportLabel,
  mb,
  snapshotPlugins,
  isSafeMode,
  VIEW_LEVEL_OPTIONS,
} from "../src/components/helpcenter/logic";
import type {
  DiagnosticSnapshot,
  DiagnosticsRecordView,
} from "../src/types";

const PEER_HEX = "9f2a".repeat(16); // 64-hex peerId shape

function record(partial: Partial<DiagnosticsRecordView>): DiagnosticsRecordView {
  return {
    time: 1_700_000_000_000,
    level: "info",
    module: "core",
    msg: "bericht ontvangen",
    ...partial,
  };
}

test("levelMeta maps known levels and falls back for unknown", () => {
  assert.equal(levelMeta("error").label, "ERR");
  assert.equal(levelMeta("error").color, "text-red-300");
  assert.equal(levelMeta("trace").label, "TRC");
  assert.equal(levelMeta("weird").label, "WEI");
  assert.ok(levelMeta("weird").chip);
});

test("formatLogTime renders HH:MM:SS for finite positive timestamps only", () => {
  assert.equal(formatLogTime(0), "--:--:--");
  assert.equal(formatLogTime(-5), "--:--:--");
  assert.equal(formatLogTime(Number.NaN), "--:--:--");
  assert.match(formatLogTime(1_700_000_000_000), /^\d{2}:\d{2}:\d{2}$/);
});

test("displayRecord masks msg + fields again by default", () => {
  const view = displayRecord(
    record({
      msg: `verbonden met ${PEER_HEX} op 192.168.1.5`,
      fields: { peerId: PEER_HEX },
    }),
    { masked: true },
  );
  assert.ok(!view.msg.includes(PEER_HEX), "full peerId must not appear");
  assert.ok(!view.msg.includes("192.168.1.5"), "ip must not appear");
  assert.ok(view.msg.includes("peer_9f2a"), "partial peerId hint expected");
  assert.ok(!(view.fields ?? "").includes(PEER_HEX));
  assert.equal(view.masked, true);
});

test("displayRecord unmasked shows raw values (power-user exception)", () => {
  const view = displayRecord(
    record({
      msg: `verbonden met ${PEER_HEX}`,
      fields: { peerId: PEER_HEX, count: 3 },
    }),
    { masked: false },
  );
  assert.ok(view.msg.includes(PEER_HEX));
  assert.ok(view.fields?.includes(PEER_HEX));
  assert.equal(view.masked, false);
});

test("displayRecord truncates huge structured fields defensively", () => {
  const fields: Record<string, unknown> = {};
  fields.big = "x".repeat(5_000);
  const masked = displayRecord(record({ fields }), { masked: true });
  assert.equal(masked.fields, "[velden afgekapt]");
  const raw = displayRecord(record({ fields }), { masked: false });
  assert.equal(raw.fields, "[fields truncated]");
});

test("VIEW_LEVEL_OPTIONS has the four usable minimum levels", () => {
  assert.deepEqual(VIEW_LEVEL_OPTIONS, ["debug", "info", "warn", "error"]);
});

test("filterRecords filters by minimum severity and free-text query", () => {
  const rows = [
    record({ time: 1, level: "debug", module: "core", msg: "detail a" }),
    record({ time: 2, level: "info", module: "core", msg: "routine b" }),
    record({ time: 3, level: "warn", module: "net", msg: "timeout b" }),
    record({ time: 4, level: "error", module: "net", msg: "failed c" }),
  ];
  const warnAndUp = filterRecords(rows, { minLevel: "warn" });
  assert.deepEqual(warnAndUp.map((r) => r.level), ["warn", "error"]);
  const queryNet = filterRecords(rows, { query: "timeout" });
  assert.equal(queryNet.length, 1);
  assert.equal(queryNet[0].level, "warn");
  // severity + text both apply
  const none = filterRecords(rows, { minLevel: "error", query: "b" });
  assert.equal(none.length, 0);
});

test("transportLabel localizes the three transport modes", () => {
  assert.equal(transportLabel("wan"), "WAN (relay / libp2p)");
  assert.equal(transportLabel("lan"), "LAN (mDNS / lokaal)");
  assert.equal(transportLabel("none"), "geen netwerk");
  assert.equal(transportLabel("other"), "other");
});

test("mb renders megabytes or a dash", () => {
  assert.equal(mb(2 * 1024 * 1024), "2 MB");
  assert.equal(mb(-1), "–");
  assert.equal(mb(Number.NaN), "–");
});

test("snapshotPlugins returns a sorted copy without mutating input", () => {
  const snapshot = {
    plugins: [{ id: "zeta" }, { id: "alpha" }, { id: "bravo" }],
  } as unknown as DiagnosticSnapshot;
  const sorted = snapshotPlugins(snapshot);
  assert.deepEqual(sorted.map((p) => p.id), ["alpha", "bravo", "zeta"]);
  assert.deepEqual(snapshot.plugins.map((p) => p.id), ["zeta", "alpha", "bravo"]);
});

test("isSafeMode reads the boot flag", () => {
  const base = { boot: { bootFlags: [] } } as unknown as DiagnosticSnapshot;
  assert.equal(isSafeMode(base), false);
  assert.equal(isSafeMode({ ...base, boot: { bootFlags: ["safe-mode"] } } as unknown as DiagnosticSnapshot), true);
});
