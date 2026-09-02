/**
 * Diagnostic bundle builder (HelpCenter Pijler B.2 / Brief 7B).
 *
 * "Meld een probleem"-flow: a snapshot + user-chosen log sources + a free-text
 * note become a single bundle with a visible preview BEFORE anything is
 * copied/sent. There is no automatic upload in v1 (see "Uitgesteld").
 *
 * Redaction is mandatory and structural: every record is redacted at read time
 * by the engine (shared SDK filter) and the bundle is redacted *again* over
 * the whole payload (`redactStructured`/`redactLines`) so a future consumer
 * can never accidentally ship a masked value. The bundle is therefore always
 * `redacted: true` — there is no unredacted bundle path.
 */

import type { DiagnosticsRecordView } from "./engine";
import { DIAGNOSTICS_MAX_READ } from "./ring-buffer";
import { redactLines, redactStructured } from "@p2p-hub/sdk";
import type { DiagnosticSnapshot } from "./snapshot";

/** Per-source cap on bundled log records (mirrors the viewer cap). */
export const BUNDLE_MAX_RECORDS_PER_SOURCE = DIAGNOSTICS_MAX_READ;

/** Hard cap on the total number of bundled records across all sources. */
export const BUNDLE_MAX_TOTAL_RECORDS = 2_000;

export interface BundleLogSource {
  sourceId: string;
  level: string;
  limit: number;
  recordCount: number;
  records: Array<{ time: number; level: string; module: string; msg: string; fields?: unknown }>;
}

export interface DiagnosticBundlePreview {
  /** Snapshot sections included (subsets of the snapshot top-level keys). */
  sections: string[];
  /** Log sources bundled (id + record count each). */
  logSources: Array<{ sourceId: string; recordCount: number }>;
  /** Free-text note included? */
  hasNote: boolean;
  /** Always true — the bundle is always shipped redacted. */
  redacted: true;
}

export interface DiagnosticBundle {
  kind: "p2p-hub-diagnostic-bundle";
  version: 1;
  createdAt: number;
  snapshot: unknown;
  logs: BundleLogSource[];
  userNote: string;
  preview: DiagnosticBundlePreview;
  /** Always true: never an unredacted bundle. */
  redacted: true;
}

/** A snapshot reader injected by the caller so the bundler stays engine-free. */
export interface BundleSourceReader {
  readSource(
    id: string,
    options: { limit?: number; level?: string },
  ): { source: { level: string }; records: DiagnosticsRecordView[] } | null;
}

/** Valid snapshot section ids (subset of the snapshot top-level keys). */
export const BUNDLE_SNAPSHOT_SECTIONS = [
  "system",
  "runtime",
  "hardware",
  "network",
  "vault",
  "boot",
  "plugins",
] as const;

export type BundleSnapshotSection = (typeof BUNDLE_SNAPSHOT_SECTIONS)[number];

export interface BundleOptions {
  snapshot: DiagnosticSnapshot;
  /** Snapshot sections to include in the bundle (defaults to all). */
  sections?: BundleSnapshotSection[];
  /** Log source ids to include; unknown ids are skipped. */
  sources?: string[];
  userNote?: string;
  reader: BundleSourceReader;
}

/**
 * Build a redacted diagnostic bundle from a fresh snapshot + selected log
 * sources + an optional note. Never throws on missing/unknown sources: unknown
 * ids are silently dropped and the preview reports exactly what was bundled.
 */
export function buildBundle(options: BundleOptions): DiagnosticBundle {
  const sections = options.sections ?? [...BUNDLE_SNAPSHOT_SECTIONS];
  const included = new Set(
    sections.filter((s): s is BundleSnapshotSection =>
      (BUNDLE_SNAPSHOT_SECTIONS as readonly string[]).includes(s),
    ),
  );
  const sourceIds = options.sources ?? [];

  const snapshotSection = (key: BundleSnapshotSection): unknown => {
    const snapshot = options.snapshot as unknown as Record<string, unknown>;
    return included.has(key) ? snapshot[key] : undefined;
  };

  const snapshot: Record<string, unknown> = {};
  for (const section of BUNDLE_SNAPSHOT_SECTIONS) {
    if (included.has(section)) {
      snapshot[section] = snapshotSection(section);
    }
  }

  const logs: BundleLogSource[] = [];
  let totalRecords = 0;
  for (const id of sourceIds) {
    if (totalRecords >= BUNDLE_MAX_TOTAL_RECORDS) {
      break;
    }
    const read = options.reader.readSource(id, {
      limit: BUNDLE_MAX_RECORDS_PER_SOURCE,
    });
    if (!read) {
      continue;
    }
    const records = read.records.slice(0, BUNDLE_MAX_RECORDS_PER_SOURCE);
    logs.push({
      sourceId: id,
      level: read.source.level,
      limit: BUNDLE_MAX_RECORDS_PER_SOURCE,
      recordCount: records.length,
      records: records.map((r) => ({
        time: r.time,
        level: r.level,
        module: r.module,
        msg: r.msg,
        ...(r.fields ? { fields: r.fields } : {}),
      })),
    });
    totalRecords += records.length;
  }

  const userNote = (options.userNote ?? "").slice(0, 4_000);

  const bundle: DiagnosticBundle = {
    kind: "p2p-hub-diagnostic-bundle",
    version: 1,
    createdAt: Date.now(),
    snapshot,
    logs,
    userNote,
    preview: {
      sections: [...included],
      logSources: logs.map((l) => ({ sourceId: l.sourceId, recordCount: l.recordCount })),
      hasNote: userNote.length > 0,
      redacted: true,
    },
    redacted: true,
  };

  // Mandatory whole-payload redaction (defense-in-depth on top of the engine's
  // read-time redaction). The snapshot itself never contains secrets, but the
  // log records come from the ring buffer and this is the last gate before a
  // bundle can leave the process.
  return redactBundle(bundle);
}

/**
 * Redact a bundle in place (new object) with the shared SDK filter. Every
 * string field is masked (peerIds/boot tokens, IPs, MACs, token prefixes);
 * nested objects keep their shape. Depth is bounded by the SDK filter.
 */
export function redactBundle(bundle: DiagnosticBundle): DiagnosticBundle {
  const redactedSnapshot = redactStructured(bundle.snapshot);
  const redactedLogs = bundle.logs.map((l) => ({
    ...l,
    records: l.records.map((r) => ({
      time: r.time,
      level: r.level,
      module: r.module,
      msg: redactLines(r.msg),
      ...(r.fields ? { fields: redactStructured(r.fields) } : {}),
    })),
  }));
  return {
    ...bundle,
    snapshot: redactedSnapshot,
    logs: redactedLogs,
    userNote: redactLines(bundle.userNote),
  };
}

/**
 * Human-readable, copy-to-clipboard form of a bundle. Every line is redacted;
 * the top line is a short one-line summary (OS / core / network / plugins) so
 * a pasted bundle is recognizable even in a 1-line preview.
 */
export function bundleClipboardText(bundle: DiagnosticBundle): string {
  const sections = bundle.preview.sections as string[];
  const lines: string[] = [];
  lines.push("p2p-hub diagnostische bundel");
  lines.push(`datum: ${new Date(bundle.createdAt).toISOString()}`);

  const snapshot = bundle.snapshot as Record<string, unknown> | undefined;
  if (sections.includes("system") && snapshot?.system) {
    const s = snapshot.system as Record<string, unknown>;
    lines.push(
      `systeem: ${String(s.platform)} ${String(s.release)} ${String(s.arch)}`,
    );
  }
  if (sections.includes("runtime") && snapshot?.runtime) {
    const r = snapshot.runtime as Record<string, unknown>;
    lines.push(
      `runtime: node ${String(r.nodeVersion)} core ${String(r.coreVersion)}`,
    );
  }
  if (sections.includes("network") && snapshot?.network) {
    const n = snapshot.network as Record<string, unknown>;
    const mode = String(n.transportMode);
    const peers = Number(n.peerCount ?? 0);
    lines.push(`netwerk: ${mode}${mode === "none" ? "" : ` (${peers} peers)`}`);
  }
  if (sections.includes("vault") && snapshot?.vault) {
    const v = snapshot.vault as Record<string, unknown>;
    const state = v.locked ? "locked" : "unlocked";
    const dev = v.masterKeyConfigured ? "" : " (dev-key)";
    lines.push(`vault: ${state}${dev}`);
  }
  if (sections.includes("plugins") && snapshot?.plugins) {
    const plugins = snapshot.plugins as unknown[];
    lines.push(`plugins: ${plugins.length} geladen`);
  }

  for (const log of bundle.logs) {
    lines.push("");
    lines.push(`log ${log.sourceId} (${log.level}, ${log.recordCount} records):`);
    for (const r of log.records) {
      const time = new Date(r.time).toISOString();
      lines.push(`  ${time} [${r.level}] ${r.msg}`);
    }
  }

  if (bundle.userNote.trim().length > 0) {
    lines.push("");
    lines.push("notitie:");
    lines.push(bundle.userNote);
  }

  return redactLines(lines.join("\n"));
}
