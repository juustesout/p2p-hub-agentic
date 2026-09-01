/**
 * Bounded in-memory ring buffer for one diagnostics log source.
 *
 * The HelpCenter viewer reads primarily from memory (not disk): each module's
 * records are pushed here as they are logged, kept newest-`capacity`, so a
 * verbose session never grows without bound and the viewer still works when
 * `core-server.log` is missing or rotated. Records are stored raw in memory
 * (a local single-user process; the boot token etc. are structurally never
 * logged) and redacted at read/display time — redaction-before-display is the
 * enforcement point, see `sdk` `redact`.
 */

/** Hard cap on records served per read (the viewer's 500-line ceiling). */
export const DIAGNOSTICS_MAX_READ = 500;

/** Default per-source capacity. */
export const DIAGNOSTICS_DEFAULT_CAPACITY = 200;

/** pino level ordering, higher = more severe (fatal highest). */
export const LEVEL_ORDER: Record<string, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

/** Cap on a single stored `msg` length (memory-bound per record). */
export const MAX_RECORD_MSG_LENGTH = 8_000;

/** One stored log record (module-scoped). */
export interface DiagnosticsRecord {
  time: number;
  level: string;
  module: string;
  msg: string;
  fields?: Record<string, unknown>;
}

export interface RingReadOptions {
  /** Maximum number of records to return (newest kept). Clamped to `[1, DIAGNOSTICS_MAX_READ]`. */
  limit?: number;
  /** Only records at or above this pino level (e.g. "warn"). */
  level?: string;
}

function clampLimit(limit: number | undefined, capacity: number): number {
  const raw = limit ?? capacity;
  if (!Number.isFinite(raw) || raw < 1) {
    return 1;
  }
  return Math.min(Math.floor(raw), capacity, DIAGNOSTICS_MAX_READ);
}

export class RingBuffer {
  private readonly entries: DiagnosticsRecord[] = [];

  /**
   * @param capacity Fixed maximum number of kept records.
   * @throws RangeError when capacity is not a positive integer.
   */
  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`ring buffer capacity must be a positive integer, got ${capacity}`);
    }
  }

  /** Number of currently stored records. */
  get length(): number {
    return this.entries.length;
  }

  /** Total capacity. */
  get size(): number {
    return this.capacity;
  }

  /** Append a record, evicting the oldest when at capacity. */
  push(record: DiagnosticsRecord): void {
    const msg =
      record.msg.length > MAX_RECORD_MSG_LENGTH
        ? record.msg.slice(0, MAX_RECORD_MSG_LENGTH)
        : record.msg;
    if (this.entries.length >= this.capacity) {
      this.entries.shift();
    }
    this.entries.push({ ...record, msg });
  }

  /**
   * Newest `limit` records, optionally filtered by level. Returns fresh copies
   * (including a shallow copy of `fields`) so a caller can never mutate the
   * stored buffer through a read result. Never mutates the store.
   */
  read(options: RingReadOptions = {}): DiagnosticsRecord[] {
    const limit = clampLimit(options.limit, this.capacity);
    let out = this.entries;
    if (options.level !== undefined && options.level in LEVEL_ORDER) {
      const min = LEVEL_ORDER[options.level];
      out = out.filter((r) => (LEVEL_ORDER[r.level] ?? 0) >= min);
    }
    return out.slice(-limit).map((r) => ({
      time: r.time,
      level: r.level,
      module: r.module,
      msg: r.msg,
      fields: r.fields ? { ...r.fields } : undefined,
    }));
  }

  /** Drop all stored records. */
  clear(): void {
    this.entries.length = 0;
  }
}
