import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Cross-process instance guard (Slice 3).
 *
 * The core-server persists state into its data directory (boot token, vault,
 * governance matrix, settings) with atomic write-file semantics. Those writes
 * are atomic *within* one process, but two processes writing the same files
 * can still race each other's `rename` at the "who wrote last" level (see
 * CLAUDE.md "Cross-process file-locking"). This guard makes the second
 * instance on the same data directory fail *hard at boot* — with a clear
 * error — instead of silently corrupting shared state.
 *
 * Design:
 *   - On acquire, a `<dataDir>/core-server.pid` file (0600) records this
 *     process's PID. If a live foreign PID is already recorded, boot is
 *     refused (fail-closed). A stale PID (dead process) is overwritten.
 *   - A corrupt/unparseable lock file is refused loudly (CLAUDE.md principle
 *     #9 — a human decides, the code only fails loudly, never guesses).
 *   - `release()` removes the file on clean shutdown. As a safety net for
 *     paths that bypass `stop()` (fatal errors, `process.exit`), an `exit`
 *     handler removes the file only while it still records *our* PID — it
 *     never deletes a newer instance's lock.
 *   - A module-level set of held lock paths makes a second `CoreServer` in
 *     the *same* process fail the same way (two in-process instances on one
 *     data dir are exactly the same hazard as two processes).
 *
 * Known limitation (accepted for a lightweight guard): a `SIGKILL` (or a hard
 * crash) leaves the lock file behind. The next boot then fails with a clear
 * "remove the stale file" message instead of auto-cleaning — that is the
 * fail-closed choice, same spirit as "no automatic quarantine".
 */

export const INSTANCE_LOCK_FILE = "core-server.pid";

/** Boot refused because another instance already holds the data directory. */
export class InstanceLockError extends Error {}

/** A held instance lock; `release()` is idempotent. */
export interface InstanceLock {
  /** Path of the lock file (for diagnostics/error messages). */
  readonly file: string;
  /** Remove the lock file. Safe to call more than once. */
  release(): void;
}

/** Lock paths held by this process (resolved data dir → guard). */
const heldInProcess = new Set<string>();

/** True when `pid` belongs to a live process (ESRCH = gone). */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user — still live.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Try to take the instance lock for `dataDir`. Throws {@link InstanceLockError}
 * (loud, fail-closed) when another instance — in this process or another live
 * process — already holds it, or when the existing lock file is unreadable/
 * corrupt and liveness cannot be determined.
 */
export function acquireInstanceLock(dataDir: string): InstanceLock {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, INSTANCE_LOCK_FILE);
  const resolved = path.resolve(dataDir);

  if (heldInProcess.has(resolved)) {
    throw new InstanceLockError(
      `[core-server] this process already runs a core-server instance on ` +
        `"${dataDir}" (lock ${file}). Refusing to start a second instance on ` +
        `the same data directory.`,
    );
  }

  let raw: string | null = null;
  try {
    raw = fs.readFileSync(file, "utf8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new InstanceLockError(
        `[core-server] cannot read the instance lock file "${file}": ` +
          `${(err as Error).message}`,
      );
    }
    raw = null;
  }

  if (raw !== null) {
    // A valid pid is a positive integer within the OS pid range (<= 2^31-1).
    // Anything else — including a huge number that parses as a float — is
    // corrupt and refused (fail-closed, never guessed).
    const parsed = Number(raw);
    const existingPid =
      raw.length > 0 &&
      Number.isInteger(parsed) &&
      parsed > 0 &&
      parsed <= 0x7fffffff
        ? parsed
        : null;
    if (existingPid === null) {
      throw new InstanceLockError(
        `[core-server] the instance lock file "${file}" is corrupt or empty ` +
          `(contents: ${JSON.stringify(raw.slice(0, 64))}). Cannot determine ` +
          `whether another instance is running. If no other core-server is ` +
          `active, delete the file and start again.`,
      );
    }
    if (existingPid !== process.pid && processIsAlive(existingPid)) {
      throw new InstanceLockError(
        `[core-server] another core-server instance is already running on ` +
          `"${dataDir}" (pid ${existingPid}, lock file "${file}"). Refusing to ` +
          `start a second instance: two processes would race each other's ` +
          `storage writes. If that process is dead, delete the lock file and ` +
          `start again.`,
      );
    }
  }

  fs.writeFileSync(file, `${process.pid}\n`, { mode: 0o600 });
  heldInProcess.add(resolved);

  const removeIfOwn = (): void => {
    if (!heldInProcess.has(resolved)) {
      return;
    }
    try {
      if (fs.readFileSync(file, "utf8").trim() === String(process.pid)) {
        fs.unlinkSync(file);
      }
    } catch {
      // File already gone or unreadable — nothing to clean up.
    }
    heldInProcess.delete(resolved);
  };

  const onExit = (): void => removeIfOwn();
  process.once("exit", onExit);

  return {
    file,
    release: () => {
      removeIfOwn();
      process.removeListener("exit", onExit);
    },
  };
}
