/**
 * Diagnostics engine (HelpCenter Pijler G / Brief 7A).
 *
 * One module in the core-server that owns:
 * - the **register** of log sources (~16, 1-to-1 with the architecture);
 * - a **ring buffer** per source (bounded, in-memory — the primary viewer
 *   source, see `ring-buffer.ts`);
 * - **child loggers** per module (`moduleLogger` in `logger.ts`), so records
 *   carry a `module` field that routes them to the right buffer;
 * - the **global level toggle** and per-source enable/disable (deny-by-default:
 *   security-relevant sources like `vault`/`identity` can never be disabled);
 * - the file source (`core-server.log`) read path, which only ever reads the
 *   one registered, resolved path — never a client-supplied path.
 *
 * Redaction is NOT applied here: records are stored raw (a local single-user
 * process; secrets are structurally never logged) and the redaction filter
 * from the SDK runs at read/display time, so every consumer (viewer, export,
 * webview feed) shares the same masking. See `readSource`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import pino from "pino";
import type { Logger } from "pino";
import { RingBuffer, DIAGNOSTICS_DEFAULT_CAPACITY, DIAGNOSTICS_MAX_READ } from "./ring-buffer";
import type { DiagnosticsRecord } from "./ring-buffer";
import { redact, redactStructured } from "@p2p-hub/sdk";

/** pino numeric level → name (pino uses 10..60, increasing verbosity). */
const PINO_LEVEL_NAMES: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

/** Valid levels for the global level toggle (pino set). */
export const DIAGNOSTICS_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent",
] as const;

export type DiagnosticsLevel = (typeof DIAGNOSTICS_LEVELS)[number];

/** Cap on the log-file tail read (memory-bound). */
const MAX_LOG_FILE_TAIL_BYTES = 256 * 1024;

/** Cap on a single file line length returned to the viewer. */
const MAX_FILE_LINE_LENGTH = 4_000;

export interface DiagnosticsSourceInfo {
  id: string;
  name: string;
  /** memory = ring buffer; webview = forwarded shell/plugin logs; file = on-disk. */
  kind: "memory" | "webview" | "file";
  /** Current effective level (root level unless a child overrides). */
  level: string;
  enabled: boolean;
  /** Security-relevant: cannot be disabled by the level/source toggle. */
  secure: boolean;
  capacity: number;
  length: number;
}

export interface SourceReadOptions {
  limit?: number;
  level?: string;
  /** When true, records are returned raw (power-user "ongeredacteerd" toggle). */
  unredacted?: boolean;
}

export interface DiagnosticsRecordView {
  time: number;
  level: string;
  module: string;
  msg: string;
  fields?: Record<string, unknown>;
}

interface SourceState {
  id: string;
  name: string;
  kind: "memory" | "webview" | "file";
  secure: boolean;
  enabled: boolean;
  buffer: RingBuffer;
  filePath: string | null;
  child: Logger | null;
}

const MODULE_SOURCES: Array<[string, string]> = [
  ["network-light", "Netwerk (LAN / mDNS)"],
  ["network-libp2p", "Netwerk (WAN / libp2p)"],
  ["task-broker", "TaskBroker"],
  ["plugin-loader", "Plugin-loader"],
  ["vault", "Vault"],
  ["identity", "Identity"],
  ["contacts", "Contacten"],
  ["chat", "Chat"],
  ["peersite", "PeerSite"],
  ["media-gate", "Media-gate"],
  ["telemetry-gate", "Telemetry-gate"],
  ["pal-bus", "PAL-bus (CoreEventBus)"],
  ["sandbox", "Sandbox"],
  ["storage", "Storage"],
  ["certification", "Certificering"],
];

/** Sources that carry security-relevant data and must never be switchable off. */
const SECURE_SOURCES = new Set(["vault", "identity"]);

export class DiagnosticsEngine {
  private readonly sources = new Map<string, SourceState>();
  private root: Logger | null = null;
  private globalLevel: string = "info";
  private dataDir: string | null = null;
  private safeMode = false;

  constructor() {
    // "core" is the fallback bucket for records without a recognised module.
    this.registerSource("core", "Core (overig)", "memory", false, false);
    this.registerSource("shell-ipc", "Shell / webview", "webview", false, false);
    for (const [id, name] of MODULE_SOURCES) {
      this.registerSource(id, name, "memory", SECURE_SOURCES.has(id), false);
    }
  }

  private registerSource(
    id: string,
    name: string,
    kind: "memory" | "webview" | "file",
    secure: boolean,
    isFile: boolean,
  ): void {
    this.sources.set(id, {
      id,
      name,
      kind,
      secure,
      enabled: true,
      buffer: new RingBuffer(DIAGNOSTICS_DEFAULT_CAPACITY),
      filePath: null,
      child: null,
    });
    void isFile; // file sources get their path via configure()
  }

  /**
   * Wire the root logger and the data directory. Called once at server boot.
   * `safeMode` records the `--safe-mode` boot flag (visible in the register).
   */
  configure(options: { root: Logger; dataDir: string; safeMode?: boolean }): void {
    this.root = options.root;
    this.dataDir = options.dataDir;
    this.safeMode = options.safeMode ?? false;
    this.globalLevel = String(options.root.level ?? "info");

    const filePath = this.logFilePath();
    if (filePath) {
      const existing = this.sources.get("core-server-log");
      if (existing) {
        existing.filePath = filePath;
      } else {
        this.sources.set("core-server-log", {
          id: "core-server-log",
          name: "core-server.log (schijf)",
          kind: "file",
          secure: false,
          enabled: true,
          buffer: new RingBuffer(DIAGNOSTICS_DEFAULT_CAPACITY),
          filePath,
          child: null,
        });
      }
    }
    // Create the per-source child loggers so `moduleLogger(id)` returns a
    // shared, already-registered child (records carry the `module` field).
    for (const state of this.sources.values()) {
      if (state.kind === "file") {
        continue;
      }
      state.child = this.root.child({ module: state.id });
    }
  }

  /** Resolve the core-server.log path, contained within the data dir. */
  private logFilePath(): string | null {
    if (!this.dataDir) {
      return null;
    }
    const root = path.resolve(this.dataDir);
    const candidate = path.resolve(root, "core-server.log");
    if (candidate !== root && !candidate.startsWith(root + path.sep)) {
      return null;
    }
    return candidate;
  }

  /** True once {@link configure} has wired the root logger. */
  get ready(): boolean {
    return this.root !== null;
  }

  /** Whether the `--safe-mode` boot flag is active. */
  get bootFlags(): string[] {
    const flags: string[] = [];
    if (this.safeMode) {
      flags.push("safe-mode");
    }
    return flags;
  }

  /**
   * The shared child logger for `module`. Creates one on demand when the
   * module was not pre-registered (lazy, so a surprise module still gets a
   * buffer). Never throws: standalone use (unit tests that construct a
   * `CoreEventBus`/`PALManager` without a server) falls back to a silent root
   * until {@link configure} wires the real one.
   */
  moduleLogger(module: string): Logger {
    const root = this.root ?? this.fallbackRoot();
    let state = this.sources.get(module);
    if (!state) {
      this.registerSource(module, module, "memory", false, false);
      state = this.sources.get(module)!;
    }
    if (!state.child) {
      state.child = root.child({ module });
    }
    return state.child as Logger;
  }

  /**
   * Lazy discard root used before {@link configure} runs. Logging through a
   * module logger must never throw, even if the diagnostics layer was not
   * assembled yet; records simply go nowhere until a real root is wired.
   */
  private fallbackRoot(): Logger {
    if (!this.root) {
      this.root = pino({ level: "info" }, { write(): void {} });
    }
    return this.root;
  }

  /**
   * Route one serialized pino line into the per-module ring buffers. Called by
   * the logger sink for every JSON record. Unparseable / empty lines are
   * ignored (the pretty TTY sink is human text and never parsed).
   */
  ingestLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    this.ingestRecord(parsed);
  }

  /** Route one parsed pino record (object) into the ring buffers. */
  ingestRecord(parsed: unknown): void {
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return;
    }
    const rec = parsed as Record<string, unknown>;
    const msg = typeof rec.msg === "string" ? rec.msg : "";
    if (msg.trim() === "") {
      return;
    }
    const levelNum = typeof rec.level === "number" ? rec.level : 30;
    const level = PINO_LEVEL_NAMES[levelNum] ?? "info";
    const time = typeof rec.time === "number" ? rec.time : Date.now();

    let module: string;
    if (typeof rec.module === "string" && this.sources.has(rec.module)) {
      module = rec.module;
    } else if (rec.source === "webview") {
      module = "shell-ipc";
    } else {
      module = "core";
    }

    const state = this.sources.get(module);
    if (!state || !state.enabled) {
      return;
    }

    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rec)) {
      if (
        key === "level" ||
        key === "time" ||
        key === "msg" ||
        key === "pid" ||
        key === "hostname" ||
        key === "v" ||
        key === "module" ||
        key === "source"
      ) {
        continue;
      }
      fields[key] = value;
    }

    const record: DiagnosticsRecord = {
      time,
      level,
      module,
      msg,
      fields: Object.keys(fields).length > 0 ? fields : undefined,
    };
    state.buffer.push(record);
  }

  /** The full register for the viewer (id/name/kind/enabled/secure + levels). */
  listSources(): DiagnosticsSourceInfo[] {
    const out: DiagnosticsSourceInfo[] = [];
    for (const state of this.sources.values()) {
      out.push({
        id: state.id,
        name: state.name,
        kind: state.kind,
        level: state.enabled ? this.globalLevel : "silent",
        enabled: state.enabled,
        secure: state.secure,
        capacity: state.buffer.size,
        length: state.buffer.length,
      });
    }
    return out;
  }

  /**
   * Tail one source. Memory/webview sources come from the ring buffer; the
   * file source is read from disk (registered path only). Records are redacted
   * by default; `unredacted: true` returns raw (power-user toggle only — the
   * value never leaves this process except to the caller that asked).
   */
  readSource(
    id: string,
    options: SourceReadOptions = {},
  ): { source: DiagnosticsSourceInfo; records: DiagnosticsRecordView[] } | null {
    const state = this.sources.get(id);
    if (!state) {
      return null;
    }
    const info = this.listSources().find((s) => s.id === id)!;
    let records: DiagnosticsRecordView[];
    if (state.kind === "file" && state.filePath) {
      const lines = readFileTail(state.filePath, MAX_LOG_FILE_TAIL_BYTES, options.limit);
      records = lines.map((line) => ({
        time: 0,
        level: "info",
        module: id,
        msg: line,
      }));
    } else {
      records = state.buffer.read({ limit: options.limit, level: options.level });
    }
    if (!options.unredacted) {
      records = records.map((r) => ({
        time: r.time,
        level: r.level,
        module: r.module,
        msg: redact(r.msg),
        fields: r.fields ? (redactStructured(r.fields) as Record<string, unknown>) : undefined,
      }));
    }
    return { source: info, records };
  }

  /**
   * Set the global level (mirrors `logger.level`). Validates against the pino
   * set; returns an error string (not thrown) so the route can 400.
   */
  setGlobalLevel(level: string): { ok: true } | { ok: false; error: string } {
    if (!DIAGNOSTICS_LEVELS.includes(level as DiagnosticsLevel)) {
      return {
        ok: false,
        error: `unknown level "${level}" (expected one of ${DIAGNOSTICS_LEVELS.join(", ")})`,
      };
    }
    this.globalLevel = level;
    return { ok: true };
  }

  /**
   * Enable/disable one source. Deny-by-default: security-relevant sources
   * (`vault`, `identity`) can never be disabled. Disabling freezes the ring
   * buffer and silences the module's child logger (never the root — fatal and
   * startup logging stays on).
   */
  setSourceEnabled(id: string, enabled: boolean): { ok: true } | { ok: false; error: string } {
    const state = this.sources.get(id);
    if (!state) {
      return { ok: false, error: `unknown source "${id}"` };
    }
    if (state.secure && !enabled) {
      return { ok: false, error: `source "${id}" is security-relevant and cannot be disabled` };
    }
    state.enabled = enabled;
    if (state.child) {
      state.child.level = enabled ? this.globalLevel : "silent";
    }
    return { ok: true };
  }

  /** Current effective global level. */
  currentLevel(): string {
    return this.globalLevel;
  }
}

/**
 * Read the tail of a registered log file. Bounded on both bytes and lines so
 * a huge/rotating log file cannot exhaust memory. Returns the newest `limit`
 * non-empty lines, each truncated to `MAX_FILE_LINE_LENGTH`.
 */
export function readFileTail(
  filePath: string,
  maxBytes: number,
  limit = DIAGNOSTICS_MAX_READ,
): string[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return [];
  }
  if (!stat.isFile() || stat.size <= 0) {
    return [];
  }
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(filePath, "r");
  try {
    let read = 0;
    while (read < length) {
      const n = fs.readSync(fd, buf, read, length - read, start + read);
      if (n <= 0) {
        break;
      }
      read += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  const text = buf.toString("utf8");
  const lines = text.split("\n");
  const bounded: string[] = [];
  for (let i = lines.length - 1; i >= 0 && bounded.length < limit; i--) {
    const line = lines[i].trim();
    if (line.length === 0) {
      continue;
    }
    bounded.push(
      line.length > MAX_FILE_LINE_LENGTH ? line.slice(0, MAX_FILE_LINE_LENGTH) : line,
    );
  }
  return bounded.reverse();
}

/** Singleton used by the logger sink and the diagnostics routes. */
export const diagnostics = new DiagnosticsEngine();
