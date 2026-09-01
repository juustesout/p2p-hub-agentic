import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Cross-process file lock.
 *
 * The in-memory {@link FileWriteQueue} only serializes writes *within* one
 * process. Two instances of the app pointed at the same storage directory can
 * still race each other at the "who wrote last" level: both load the same
 * snapshot, both modify it, and the second rename silently drops the first
 * process's change. This module closes that gap with a lock file per target
 * path.
 *
 * The lock file lives next to the target (`.<name>.lock`) and is created
 * atomically with `O_EXCL`. Acquiring it therefore cannot clobber a holder.
 * A lock is released by removing the file. If the holder crashes, its lock
 * file survives; staleness is detected via the owning PID (a dead process is
 * freed immediately) and, for locks whose payload could not be read, via age.
 * A lock whose owning process is still alive is never stolen — waiters poll
 * until the timeout and then fail loudly with {@link StorageLockTimeoutError}
 * (the same "fail loudly, let a human decide" policy as a corrupt vault).
 *
 * Lock acquisition is reentrant *within* a process: if the same path is locked
 * again from inside the protected section (e.g. the write queue holds the lock
 * while {@link atomicWriteFile} re-locks the same file), the inner call runs
 * directly instead of deadlocking on its own lock file. This only composes
 * correctly when the inner call is genuinely nested under the outer one, which
 * is the only shape the storage layer uses.
 */

const LOCK_EXT = ".lock";
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_INTERVAL_MS = 25;
const DEFAULT_STALE_AFTER_MS = 30_000;
/** Bounded Windows-transient retries for releasing a lock file. */
const RELEASE_MAX_ATTEMPTS = 8;
const RELEASE_RETRY_MS = 25;

/** Lock file path for a storage file: `<dir>/.<name>.lock`. */
export function lockPathFor(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  return path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}${LOCK_EXT}`,
  );
}

export interface FileLockOptions {
  /** How long to wait for a held lock before throwing. Default 10s. */
  lockTimeoutMs?: number;
  /** Poll interval while another process holds the lock. Default 25ms. */
  retryIntervalMs?: number;
  /**
   * A lock file older than this whose owner cannot be established (unreadable
   * or unparseable payload) is treated as stale and stolen. Default 30s.
   */
  staleAfterMs?: number;
}

/** Thrown when a lock stays held past {@link FileLockOptions.lockTimeoutMs}. */
export class StorageLockTimeoutError extends Error {
  constructor(public readonly lockPath: string) {
    super(`timed out waiting for cross-process storage lock: ${lockPath}`);
    this.name = "StorageLockTimeoutError";
  }
}

interface LockOwner {
  pid: number;
  host: string;
  createdAt: number;
}

/** Lock paths held by *this* process. Keys are already-resolved lock paths. */
const heldLocks = new Set<string>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Transient filesystem errors that are worth retrying on Windows.
 *
 * On POSIX, EPERM/EACCES mean a genuine permission problem and should fail
 * immediately. On Windows they also surface *momentary* sharing violations: a
 * second process concurrently creating or removing the same lock file (or a
 * rename over a target the peer briefly holds open) is reported as
 * `EPERM`/`EBUSY`/`EACCES` by libuv, not `EEXIST`. Those races resolve in
 * milliseconds and are retryable. Gated on `win32` so POSIX semantics stay
 * unchanged.
 */
export function isWindowsRetryableError(err: unknown): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but we may not signal it — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Run `fn` while holding the cross-process lock for `targetPath`.
 *
 * The lock spans the entire callback so callers can perform a safe
 * read-modify-write: no other process can interleave between the read and the
 * write. Reentrant (same-process, nested) acquisitions run `fn` directly.
 */
export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const lockPath = lockPathFor(targetPath);
  if (heldLocks.has(lockPath)) {
    // Reentrant acquisition from the same process: the outer caller already
    // holds the cross-process lock, so there is nothing left to arbitrate.
    return fn();
  }

  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const deadline = Date.now() + lockTimeoutMs;

  let acquired = false;
  try {
    while (!acquired) {
      if ((await tryAcquire(lockPath, staleAfterMs)) === "held") {
        if (Date.now() >= deadline) {
          throw new StorageLockTimeoutError(lockPath);
        }
        await delay(retryIntervalMs);
      } else {
        acquired = true;
      }
    }
    heldLocks.add(lockPath);
    return await fn();
  } finally {
    if (acquired) {
      heldLocks.delete(lockPath);
      await releaseLock(lockPath);
    }
  }
}

/**
 * Best-effort removal of the lock file.
 *
 * On Windows the unlink can transiently fail with EPERM/EACCES when another
 * process is simultaneously trying to open the same lock file (a momentary
 * sharing violation). Retry briefly, then fail loudly — a lock file that
 * really cannot be removed must not be silently left behind as a live lock,
 * because the next acquisition by *this* process would time out on its own
 * lock.
 */
async function releaseLock(lockPath: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < RELEASE_MAX_ATTEMPTS; attempt++) {
    try {
      await fs.unlink(lockPath);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return; // already gone (e.g. stolen after staleness) — nothing to do
      }
      if (!isWindowsRetryableError(err)) {
        throw err;
      }
      lastErr = err;
      await delay(RELEASE_RETRY_MS);
    }
  }
  throw lastErr;
}

type AcquireResult = "acquired" | "held";

async function tryAcquire(
  lockPath: string,
  staleAfterMs: number,
): Promise<AcquireResult> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(lockPath, "wx", 0o600);
  } catch (err) {
    if (isWindowsRetryableError(err)) {
      // Windows momentarily refuses CREATE_NEW while the peer is creating or
      // removing the same lock file. That is the same "somebody else is
      // touching it" situation as EEXIST, but there is nothing to read yet, so
      // report it as held and let the poll loop retry.
      return "held";
    }
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
    // Somebody else holds it — unless it is stale, in which case we steal it
    // by unlinking and letting the next retry win the `O_EXCL` race.
    if (await isStale(lockPath, staleAfterMs)) {
      await fs.unlink(lockPath).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
      });
    }
    return "held";
  }

  const owner: LockOwner = {
    pid: process.pid,
    host: os.hostname(),
    createdAt: Date.now(),
  };
  try {
    await handle.writeFile(JSON.stringify(owner), "utf8");
    await handle.close();
  } catch (err) {
    // The lock file exists but was never fully initialized (crash between
    // `O_EXCL` and the payload write) — remove it so it is not mistaken for
    // a live lock, then fail loudly.
    await handle.close().catch(() => undefined);
    await fs.unlink(lockPath).catch(() => undefined);
    throw err;
  }
  return "acquired";
}

async function isStale(lockPath: string, staleAfterMs: number): Promise<boolean> {
  let raw: string | undefined;
  try {
    raw = await fs.readFile(lockPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false; // released between the EEXIST and now — a retry will win
    }
    if (!isWindowsRetryableError(err)) {
      throw err;
    }
    // Windows transient sharing violation: the payload is momentarily
    // unreadable. Fall through to the age-based staleness check below, which
    // is the existing fallback for unreadable lock payloads.
  }

  let owner: LockOwner | null = null;
  if (raw !== undefined) {
    try {
      const parsed = JSON.parse(raw) as Partial<LockOwner>;
      if (Number.isInteger(parsed.pid)) {
        owner = parsed as LockOwner;
      }
    } catch {
      owner = null;
    }
  }

  if (owner) {
    // A live owner is never stolen, even if the lock looks old: stealing a
    // live lock would let two processes write at once.
    return !isPidAlive(owner.pid);
  }

  // Payload unreadable (e.g. the creator crashed mid-acquire). Fall back to
  // age so a young, possibly-in-flight lock is given time to finish writing
  // its payload.
  return lockFileAgeExceeds(lockPath, staleAfterMs);
}

/**
 * True when the lock file is older than `staleAfterMs`.
 *
 * A lock that no longer exists, or that cannot be stat'ed due to a transient
 * Windows sharing violation, is reported as *not* stale (`false`) instead of
 * throwing: it was released between the `EEXIST` and this call — a retry will
 * win the `O_EXCL` race. This is the benign "vanished under us" race that must
 * never surface as a crash (observed on Windows CI: peer unlinked between the
 * transient readFile failure and this stat).
 */
export async function lockFileAgeExceeds(
  lockPath: string,
  staleAfterMs: number,
): Promise<boolean> {
  try {
    const stat = await fs.stat(lockPath);
    return Date.now() - stat.mtimeMs > staleAfterMs;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || isWindowsRetryableError(err)) {
      return false;
    }
    throw err;
  }
}
