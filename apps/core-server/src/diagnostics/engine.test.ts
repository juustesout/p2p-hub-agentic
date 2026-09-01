import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pino from "pino";
import { DiagnosticsEngine, readFileTail } from "./engine";
import { DIAGNOSTICS_MAX_READ } from "./ring-buffer";

const PEER = "9f2ab1c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80";

function makeEngine(dir: string): DiagnosticsEngine {
  const engine = new DiagnosticsEngine();
  // Mirror production wiring (logger.ts syncDest): the root's destination
  // feeds every JSON record into the engine's ingest path.
  const root = pino(
    { level: "info" },
    { write(msg: string): void { engine.ingestLine(msg); } },
  );
  engine.configure({ root, dataDir: dir });
  return engine;
}

test("the register lists the architectural sources plus core/shell/file", () => {
  const engine = new DiagnosticsEngine();
  engine.configure({
    root: pino({ level: "info" }, { write(): void {} }),
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "diag-reg-")),
  });
  const ids = engine.listSources().map((s) => s.id);
  for (const expected of [
    "network-light",
    "network-libp2p",
    "task-broker",
    "plugin-loader",
    "vault",
    "identity",
    "contacts",
    "chat",
    "peersite",
    "media-gate",
    "telemetry-gate",
    "pal-bus",
    "sandbox",
    "storage",
    "certification",
    "shell-ipc",
    "core-server-log",
  ]) {
    assert.ok(ids.includes(expected), `missing source ${expected}`);
  }
});

test("vault and identity are flagged secure", () => {
  const engine = new DiagnosticsEngine();
  engine.configure({
    root: pino({ level: "info" }, { write(): void {} }),
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "diag-sec-")),
  });
  const secure = engine.listSources().filter((s) => s.secure).map((s) => s.id);
  assert.deepEqual(secure, ["vault", "identity"]);
});

test("ingestLine routes a pino record to its module buffer", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-ingest-"));
  const engine = makeEngine(dir);
  const line = JSON.stringify({ level: 30, time: 1234, msg: "hello vault", module: "vault" });
  engine.ingestLine(line);
  const vault = engine.readSource("vault");
  assert.ok(vault);
  assert.equal(vault.records.length, 1);
  assert.equal(vault.records[0].msg, "hello vault");
  assert.equal(vault.records[0].module, "vault");
  // "core" must not have absorbed a module-tagged record.
  assert.equal(engine.readSource("core")!.records.length, 0);
});

test("webview records (source field) route to shell-ipc", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-web-"));
  const engine = makeEngine(dir);
  const line = JSON.stringify({ level: 40, time: 1, msg: "webview error", source: "webview" });
  engine.ingestLine(line);
  const shell = engine.readSource("shell-ipc");
  assert.ok(shell);
  assert.equal(shell.records.length, 1);
  assert.equal(shell.records[0].module, "shell-ipc");
});

test("unknown modules fall back to the core buffer", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-core-"));
  const engine = makeEngine(dir);
  const line = JSON.stringify({ level: 30, time: 1, msg: "plain line" });
  engine.ingestLine(line);
  const core = engine.readSource("core");
  assert.ok(core);
  assert.equal(core.records.length, 1);
  assert.equal(core.records[0].msg, "plain line");
});

test("unparseable / empty lines are ignored", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-parse-"));
  const engine = makeEngine(dir);
  engine.ingestLine("this is not json");
  engine.ingestLine("");
  engine.ingestLine("null");
  assert.equal(engine.readSource("core")!.records.length, 0);
});

test("moduleLogger tags records and routes them (child logger path)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-child-"));
  const engine = makeEngine(dir);
  const chat = engine.moduleLogger("chat");
  chat.info("chat opened");
  const read = engine.readSource("chat");
  assert.ok(read);
  assert.equal(read.records.length, 1);
  assert.equal(read.records[0].msg, "chat opened");
  assert.equal(read.records[0].module, "chat");
});

test("readSource redacts sensitive patterns by default and raw with unredacted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-redact-"));
  const engine = makeEngine(dir);
  engine.ingestRecord({ level: 30, time: 1, msg: `peer connected ${PEER}`, module: "chat" });
  const redacted = engine.readSource("chat");
  assert.ok(redacted);
  assert.ok(!redacted.records[0].msg.includes(PEER));
  assert.match(redacted.records[0].msg, /peer_9f2a…7f80/);
  const raw = engine.readSource("chat", { unredacted: true });
  assert.ok(raw);
  assert.ok(raw.records[0].msg.includes(PEER));
});

test("readSource redacts structured fields (named secrets) by default", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-fields-"));
  const engine = makeEngine(dir);
  engine.ingestRecord({
    level: 30,
    time: 1,
    msg: "op",
    module: "vault",
    apiKey: "sk-super-secret",
  });
  const read = engine.readSource("vault");
  assert.ok(read);
  assert.equal((read.records[0].fields as Record<string, unknown>).apiKey, "[redacted:apiKey]");
});

test("setGlobalLevel validates against the pino set and records the level", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-level-"));
  const engine = makeEngine(dir);
  assert.ok(engine.setGlobalLevel("debug").ok);
  assert.equal(engine.currentLevel(), "debug");
  const bad = engine.setGlobalLevel("loud");
  assert.ok(!bad.ok);
  if (!bad.ok) {
    assert.match(bad.error, /unknown level "loud"/);
  }
});

test("setSourceEnabled cannot disable secure sources (deny-by-default)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-secure-"));
  const engine = makeEngine(dir);
  const denied = engine.setSourceEnabled("vault", false);
  assert.ok(!denied.ok);
  if (!denied.ok) {
    assert.match(denied.error, /security-relevant/);
  }
  // Disabled buffer freezes: no new records land.
  assert.ok(engine.setSourceEnabled("chat", false).ok);
  engine.ingestRecord({ level: 30, time: 1, msg: "after disable", module: "chat" });
  assert.equal(engine.readSource("chat")!.records.length, 0);
  // Re-enabling resumes.
  assert.ok(engine.setSourceEnabled("chat", true).ok);
  engine.ingestRecord({ level: 30, time: 2, msg: "after enable", module: "chat" });
  assert.equal(engine.readSource("chat")!.records.length, 1);
});

test("setSourceEnabled rejects unknown sources", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-unknown-"));
  const engine = makeEngine(dir);
  const res = engine.setSourceEnabled("nope", false);
  assert.ok(!res.ok);
  if (!res.ok) {
    assert.match(res.error, /unknown source "nope"/);
  }
});

test("readSource rejects unknown sources (route validation path)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-read-"));
  const engine = makeEngine(dir);
  assert.equal(engine.readSource("does-not-exist"), null);
});

test("ring buffer caps records per source (newest kept, bounded memory)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-cap-"));
  const engine = makeEngine(dir);
  for (let i = 0; i < 500; i++) {
    engine.ingestRecord({ level: 30, time: i, msg: `line ${i}`, module: "core" });
  }
  const read = engine.readSource("core");
  assert.ok(read);
  assert.ok(read.records.length <= 200, "capacity default is 200");
  assert.equal(read.records[read.records.length - 1].msg, "line 499");
  assert.equal(read.records[0].msg, "line 300");
});

test("read limit is clamped to DIAGNOSTICS_MAX_READ", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-limit-"));
  const engine = makeEngine(dir);
  for (let i = 0; i < 600; i++) {
    engine.ingestRecord({ level: 30, time: i, msg: `line ${i}`, module: "core" });
  }
  const read = engine.readSource("core", { limit: 10_000 });
  assert.ok(read);
  assert.ok(read.records.length <= DIAGNOSTICS_MAX_READ);
});

test("readSource level filter returns only records at or above the severity", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-lvl-"));
  const engine = makeEngine(dir);
  engine.ingestRecord({ level: 20, time: 1, msg: "debug", module: "core" });
  engine.ingestRecord({ level: 40, time: 2, msg: "warn", module: "core" });
  const read = engine.readSource("core", { level: "warn" });
  assert.ok(read);
  assert.deepEqual(read.records.map((r) => r.msg), ["warn"]);
});

test("bootFlags reflects the --safe-mode flag and stays empty otherwise", () => {
  const engine = new DiagnosticsEngine();
  engine.configure({
    root: pino({ level: "info" }, { write(): void {} }),
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "diag-boot-")),
  });
  assert.deepEqual(engine.bootFlags, []);
  engine.configure({
    root: pino({ level: "info" }, { write(): void {} }),
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "diag-boot-")),
    safeMode: true,
  });
  assert.deepEqual(engine.bootFlags, ["safe-mode"]);
});

test("file source reads the registered core-server.log tail (path-contained)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-file-"));
  const logFile = path.join(dir, "core-server.log");
  const lines = ["first", "second", "third"];
  fs.writeFileSync(logFile, lines.join("\n") + "\n");
  const engine = makeEngine(dir);
  const read = engine.readSource("core-server-log");
  assert.ok(read);
  assert.equal(read.source.kind, "file");
  assert.deepEqual(read.records.map((r) => r.msg), lines);
});

test("readFileTail bounds bytes, lines and line length", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-tail-"));
  const file = path.join(dir, "core-server.log");
  const bigLine = "y".repeat(10_000);
  fs.writeFileSync(file, `a\n${bigLine}\nb\nc`);
  const out = readFileTail(file, 8_000, 100);
  // The tail window starts inside the huge line: its fragment is kept (as the
  // last line before `b`), truncated to the per-line cap.
  assert.ok(out.length >= 3);
  assert.ok(out[0].startsWith("y"), "first returned line is the truncated fragment");
  assert.equal(out[0].length, 4_000, "lines are truncated to the per-line cap");
  assert.deepEqual(out.slice(-2), ["b", "c"]);
  // Missing file → empty (never a crash).
  assert.deepEqual(readFileTail(path.join(dir, "missing.log"), 1024, 10), []);
});

test("configure wires a child logger per registered module", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-wire-"));
  const engine = makeEngine(dir);
  const viaChild = engine.moduleLogger("peersite");
  assert.ok(viaChild);
  viaChild.warn("peersite refused");
  const read = engine.readSource("peersite");
  assert.ok(read);
  assert.equal(read.records[0].msg, "peersite refused");
});
