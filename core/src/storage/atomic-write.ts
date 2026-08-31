import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withFileLock, isWindowsRetryableError } from "./file-lock";

/**
 * Thrown when an existing storage file is present on disk but could not be
 * parsed as JSON. This is deliberately a *different* failure from "the file
 * does not exist yet":
 *
 * - a missing file is the normal first-run case and yields an empty store;
 * - a parse failure means previously-persisted data is damaged and must fail
 *   loudly, with the path attached, so a human can find and inspect the file.
 *
 * Never turn a parse failure into "empty data" — that is silent data loss.
 */
export class StorageCorruptionError extends Error {
  constructor(
    public readonly filePath: string,
    cause: unknown,
  ) {
    super(`storage file is corrupt and could not be parsed: ${filePath}`);
    this.name = "StorageCorruptionError";
    this.cause = cause;
  }
}

/**
 * The fs surface `atomicWriteFile` needs. Kept as an interface (rather than
 * importing `node:fs/promises` everywhere) so a test can inject a fake that
 * throws mid-write to simulate a crash before the final `rename`.
 */
export interface AtomicWriteFs {
  open(
    filePath: string,
    flags: string,
    mode?: number,
  ): Promise<AtomicWriteFileHandle>;
  rename(from: string, to: string): Promise<void>;
}

export interface AtomicWriteFileHandle {
  writeFile(data: string | Uint8Array, encoding?: BufferEncoding): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Durably and atomically replace `filePath` with `data`. `data` may be a UTF-8
 * string or raw bytes (e.g. a mirrored site asset); the exact bytes are what
 * gets written, so a binary payload survives a mirror round-trip untouched.
 *
 * The destination is never written in place: the payload goes to a temp file
 * in the *same directory*, is flushed to disk with `fsync`, and only then
 * `rename`d over the target (POSIX-atomic within a filesystem). A crash at any
 * point leaves either the old file or the new file, never a torn one. The
 * temp file lives in `path.dirname(filePath)` so the `rename` stays on the
 * same filesystem — the property the atomicity guarantee depends on.
 *
 * `mode` defaults to `0o600`: vault and identity data are secrets, and there
 * is no reason plugin storage should be world-readable either.
 *
 * The write runs under the cross-process lock for `filePath`, so a direct
 * writer (e.g. the core-server settings file, which does not go through the
 * shared write queue) cannot interleave with another process's write to the
 * same file. Callers that already run inside the queue hold the same lock —
 * the reentrancy guard in {@link withFileLock} makes that a no-op.
 */
export async function atomicWriteFile(
  filePath: string,
  data: string | Uint8Array,
  mode: number = 0o600,
): Promise<void> {
  return withFileLock(filePath, () =>
    atomicWriteFileWith(filePath, data, mode, fs),
  );
}

/**
 * Raw engine behind {@link atomicWriteFile}, with the fs dependency explicit
 * so tests can inject a failing `sync`/`rename` to simulate a crash. Production
 * callers use {@link atomicWriteFile}.
 */
export async function atomicWriteFileWith(
  filePath: string,
  data: string | Uint8Array,
  mode: number,
  fsp: AtomicWriteFs,
): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const fd = await fsp.open(tmpPath, "w", mode);
  try {
    await fd.writeFile(data, typeof data === "string" ? "utf8" : undefined);
    await fd.sync(); // fsync before rename — otherwise "written" is a lie
  } finally {
    await fd.close();
  }
  await renameWithRetry(tmpPath, filePath, fsp);
}

const RENAME_MAX_ATTEMPTS = 8;
const RENAME_RETRY_MS = 25;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `rename` the temp file over the target, tolerating Windows-transient
 * failures.
 *
 * POSIX `rename` over an existing target is atomic, but Windows replaces the
 * target via an internal open-and-replace that fails with EPERM/EACCES when
 * the target is momentarily held open by another process (e.g. a peer's
 * `readJsonFile` between our rename and its close). That race resolves in
 * milliseconds, so retry briefly; a rename that still fails is real and is
 * thrown loudly — never silently "succeed" without the bytes on disk.
 */
async function renameWithRetry(
  from: string,
  to: string,
  fsp: AtomicWriteFs,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      if (!isWindowsRetryableError(err)) {
        throw err;
      }
      lastErr = err;
      await delay(RENAME_RETRY_MS);
    }
  }
  throw lastErr;
}

/**
 * Read `filePath` and parse it as JSON. Returns `null` when the file does not
 * exist (the normal first-run case), throws {@link StorageCorruptionError} when
 * it exists but cannot be parsed, and rethrows any other I/O error (permissions,
 * etc.) rather than swallowing it.
 *
 * This is the shared read primitive for `ScopedStorage` and `VaultManager`; a
 * stray `.{name}.tmp-*` file from a crashed write is never read here because
 * reads are always addressed by exact path, never by scanning the directory.
 */
export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null; // normal first run, no file yet
    }
    throw err; // other I/O error (permissions, …) — do not ignore
  }
  try {
    return JSON.parse(raw) as T;
  } catch (parseErr) {
    throw new StorageCorruptionError(filePath, parseErr);
  }
}
