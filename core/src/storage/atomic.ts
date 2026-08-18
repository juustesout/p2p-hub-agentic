import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sharedWriteQueue } from "./queue";

/**
 * Options for {@link writeAtomicFile} / {@link writeAtomicJson}.
 */
export interface WriteAtomicOptions {
  /**
   * Rotate the current file to `${path}.bak` before replacing it. Disabled when
   * restoring a file *from* its backup, so recovery never overwrites the good
   * backup with the corrupt bytes it is trying to recover from. Defaults true.
   */
  backup?: boolean;
}

/** Error codes that usually mean "the file is busy" on Windows. */
const RETRYABLE_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Maximum rename attempts before giving up (spec: up to 5). */
const MAX_RENAME_ATTEMPTS = 5;

/**
 * Durably and atomically replace `filePath` with `JSON.stringify(data)`.
 *
 * The destination is never written in place: the payload goes to a temp file in
 * the same directory, is flushed to disk with `fsync`, and only then `rename`d
 * over the target (POSIX-atomic). A crash at any point leaves either the old
 * file or the new file, never a torn one.
 *
 * This is the *raw* engine — it performs no queueing of its own. Most callers
 * want {@link writeAtomicJson}, which serializes per path; read-modify-write
 * callers (e.g. `ScopedStorage`/`VaultManager`) enqueue their whole cycle on
 * {@link sharedWriteQueue} and call this raw function inside it.
 */
export async function writeAtomicFile(
  filePath: string,
  data: unknown,
  options: WriteAtomicOptions = {},
): Promise<void> {
  const target = path.resolve(filePath);
  await fs.mkdir(path.dirname(target), { recursive: true });

  if (options.backup !== false) {
    await backupExisting(target);
  }

  const tempPath = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeAndSync(tempPath, JSON.stringify(data, null, 2));
    await renameWithRetry(tempPath, target);
  } finally {
    // Best-effort cleanup: after a successful rename the temp no longer exists;
    // after a failure this removes the leftover temp file.
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

/**
 * Queue-safe wrapper around {@link writeAtomicFile}: concurrent writes to the
 * same path run sequentially (via {@link sharedWriteQueue}) while writes to
 * distinct paths proceed in parallel.
 */
export async function writeAtomicJson(
  filePath: string,
  data: unknown,
  options: WriteAtomicOptions = {},
): Promise<void> {
  await sharedWriteQueue.enqueue(filePath, () =>
    writeAtomicFile(filePath, data, options),
  );
}

/**
 * Copy the current file to `${target}.bak` before it is replaced, so a later
 * corruption of the primary can be recovered. Best-effort: a failed backup
 * (unreadable source, full disk, …) must never block the write it is guarding.
 */
async function backupExisting(target: string): Promise<void> {
  try {
    await fs.copyFile(target, `${target}.bak`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return; // no existing file to back up — first write
    }
    console.warn(
      `[storage] could not back up "${target}": ${(err as Error).message}`,
    );
  }
}

/** Write `content` to `filePath` and flush it to physical disk before returning. */
async function writeAndSync(filePath: string, content: string): Promise<void> {
  const handle = await fs.open(filePath, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Rename `from` to `to`, retrying with exponential backoff when the OS reports
 * a transient "busy" error (Windows antivirus/lazy writers surface these as
 * `EPERM`/`EACCES`/`EBUSY`).
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (RETRYABLE_CODES.has(code) && attempt < MAX_RENAME_ATTEMPTS) {
        const delay = Math.min(100, 10 * 2 ** (attempt - 1));
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
}
