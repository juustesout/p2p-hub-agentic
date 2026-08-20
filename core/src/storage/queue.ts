import * as path from "node:path";
import { withFileLock } from "./file-lock";

/**
 * Serializes asynchronous tasks per filesystem path.
 *
 * Tasks enqueued for the *same* path run strictly one-at-a-time in FIFO order;
 * tasks for *different* paths are independent and may run concurrently. This is
 * the in-memory mutex that prevents lost updates and interleaved writes when
 * several callers hit the same storage file at once.
 *
 * Every task additionally runs under the cross-process lock for its path (see
 * {@link withFileLock}), so the whole read-modify-write is also atomic against
 * a *second process* writing the same file — the in-memory chain alone cannot
 * serialize two separate app instances.
 *
 * A failing task rejects its own caller but never blocks the chain: the next
 * task for that path still runs.
 */
export class FileWriteQueue {
  private readonly queues = new Map<string, Promise<unknown>>();

  /**
   * Run `task` after every previously enqueued task for `filePath` has settled.
   * Returns a promise that resolves with `task`'s result (or rejects with its
   * error), while the internal per-path tail always stays fulfilled so the
   * chain survives individual failures.
   */
  enqueue<T>(filePath: string, task: () => Promise<T>): Promise<T> {
    const key = path.resolve(filePath);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const run = previous.then(
      () => withFileLock(key, task),
      () => withFileLock(key, task),
    );
    this.queues.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
}

/**
 * Process-wide shared queue. Storage paths are absolute, so this single
 * instance serializes writes to the same file even across otherwise-unrelated
 * callers (e.g. two {@link VaultManager} instances pointed at the same dir).
 */
export const sharedWriteQueue = new FileWriteQueue();
