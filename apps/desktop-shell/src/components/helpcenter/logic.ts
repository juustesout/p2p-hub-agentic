import { redact, redactLines } from "@p2p-hub/sdk";
import type {
  DiagnosticsLevelName,
  DiagnosticsRecordView,
  DiagnosticSnapshot,
} from "../../types";

/**
 * Pure view-model helpers for the HelpCenter UI (Pijler C / Brief 7C).
 *
 * Redaction-before-display invariant: whatever the server already redacted,
 * the viewer masks *again* through the shared SDK filter before a line is
 * rendered, so the on-screen output can never diverge from the SDK mask even
 * if a future source/field slips through the server-side gate. The power-user
 * "toon ongeredacteerd" toggle is the deliberate exception (Pijler C) and is
 * only ever armed by an explicit user action, never the default.
 *
 * Everything here is a pure function of its inputs — no DOM, no fetch — so the
 * node:test suites can cover the exact strings a user sees.
 */

export interface LogLevelMeta {
  /** Tailwind text color class for this level. */
  color: string;
  /** Short uppercase badge label (INFO/WARN/ERROR…). */
  label: string;
  /** Chip background for the level pill. */
  chip: string;
}

const LEVEL_META: Record<string, LogLevelMeta> = {
  trace: { color: "text-slate-500", label: "TRC", chip: "bg-slate-700/40 text-slate-400" },
  debug: { color: "text-slate-400", label: "DBG", chip: "bg-slate-600/40 text-slate-300" },
  info: { color: "text-sky-300", label: "INF", chip: "bg-sky-500/15 text-sky-300" },
  warn: { color: "text-amber-300", label: "WRN", chip: "bg-amber-500/15 text-amber-300" },
  error: { color: "text-red-300", label: "ERR", chip: "bg-red-500/15 text-red-300" },
  fatal: { color: "text-red-400", label: "FTL", chip: "bg-red-500/25 text-red-200" },
};

/** Meta for a record level, falling back to a neutral pill for unknowns. */
export function levelMeta(level: string): LogLevelMeta {
  return (
    LEVEL_META[level] ?? {
      color: "text-slate-300",
      label: level.slice(0, 3).toUpperCase(),
      chip: "bg-slate-600/40 text-slate-300",
    }
  );
}

/** Human clock time `HH:MM:SS` for a record timestamp. */
export function formatLogTime(time: number): string {
  if (!Number.isFinite(time) || time <= 0) {
    return "--:--:--";
  }
  const d = new Date(time);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Structured `fields` rendered as one masked JSON-ish string (or null). */
function renderFields(fields: Record<string, unknown> | undefined, masked: boolean): string | null {
  if (!fields || Object.keys(fields).length === 0) {
    return null;
  }
  try {
    const json = JSON.stringify(fields, null, 2);
    // JSON.stringify is the last recursion risk on untrusted data; bounds are
    // enforced server-side, this is defense-in-depth.
    if (json.length > 4_000) {
      return masked ? "[velden afgekapt]" : "[fields truncated]";
    }
    return masked ? redactLines(json) : json;
  } catch {
    return masked ? "[velden niet toonbaar]" : "[fields unrenderable]";
  }
}

/**
 * One record prepared for rendering. When `masked` is true (the default) the
 * msg + fields are passed through the shared SDK filter a second time. When
 * false the record is shown raw — only reachable via the explicit power-user
 * toggle.
 */
export function displayRecord(
  record: DiagnosticsRecordView,
  opts: { masked: boolean } = { masked: true },
): {
  time: string;
  level: string;
  module: string;
  msg: string;
  fields: string | null;
  masked: boolean;
} {
  const masked = opts.masked;
  const msg = masked ? redact(record.msg) : record.msg;
  return {
    time: formatLogTime(record.time),
    level: record.level,
    module: record.module,
    msg,
    fields: renderFields(record.fields, masked),
    masked,
  };
}

/** The five levels a user may choose as the minimum visible level. */
export const VIEW_LEVEL_OPTIONS: DiagnosticsLevelName[] = [
  "debug",
  "info",
  "warn",
  "error",
];

/** pino severity ordering, higher = more severe. */
const SEVERITY: Record<string, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

/**
 * Filter already-fetched records to `minLevel` and an optional free-text
 * substring over msg/module. Records are kept when their severity is at or
 * above `minLevel`; a text query narrows by lowercase substring. Pure.
 */
export function filterRecords(
  records: DiagnosticsRecordView[],
  opts: { minLevel?: string; query?: string },
): DiagnosticsRecordView[] {
  const min = opts.minLevel ? SEVERITY[opts.minLevel] ?? 0 : 0;
  const q = (opts.query ?? "").trim().toLowerCase();
  return records.filter((r) => {
    const sev = SEVERITY[r.level] ?? 1;
    if (sev < min) {
      return false;
    }
    if (q && !r.msg.toLowerCase().includes(q) && !r.module.toLowerCase().includes(q)) {
      return false;
    }
    return true;
  });
}

/** Human label for a snapshot's transport mode. */
export function transportLabel(mode: string): string {
  switch (mode) {
    case "wan":
      return "WAN (relay / libp2p)";
    case "lan":
      return "LAN (mDNS / lokaal)";
    case "none":
      return "geen netwerk";
    default:
      return mode;
  }
}

/** Pretty GB rendering for a memory byte count. */
export function mb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "–";
  }
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

/** Sort plugins/rows safely; snapshot.plugins is already redaction-safe. */
export function snapshotPlugins(snapshot: DiagnosticSnapshot) {
  return [...snapshot.plugins].sort((a, b) => a.id.localeCompare(b.id));
}

/** Whether a snapshot carries the `--safe-mode` boot flag. */
export function isSafeMode(snapshot: DiagnosticSnapshot): boolean {
  return snapshot.boot.bootFlags.includes("safe-mode");
}
