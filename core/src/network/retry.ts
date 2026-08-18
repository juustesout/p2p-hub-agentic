/**
 * Network resilience primitives: bounded request timeouts and idempotent-call
 * retries with exponential backoff. Every remote skill invocation is expected
 * to flow through these so a silent peer can never hang a caller indefinitely.
 */

/** Raised when a remote request does not complete within its timeout window. */
export class NetworkTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`network request timed out after ${timeoutMs}ms`);
    this.name = "NetworkTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Default ceiling for a single remote request. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Resolve with `promise`'s result, or reject with `makeError()` if it has not
 * settled within `timeoutMs`. The timer is always cleared on settlement, so a
 * fast call leaves no dangling handle behind. Defaults to a
 * {@link NetworkTimeoutError}.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  makeError: () => Error = () => new NetworkTimeoutError(timeoutMs),
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(makeError()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** True when an error represents a transient connection drop worth retrying. */
export function isTransientError(err: unknown): boolean {
  if (err instanceof NetworkTimeoutError) {
    return true;
  }
  const code =
    err && typeof err === "object" && "code" in err
      ? (err as { code?: unknown }).code
      : undefined;
  return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNREFUSED";
}

export interface RetryOptions {
  /** Maximum number of retries after the first attempt. Defaults to 3. */
  maxRetries?: number;
  /** Delay before the first retry, in ms. Defaults to 200. */
  initialDelayMs?: number;
  /** Backoff multiplier applied between retries. Defaults to 2. */
  factor?: number;
  /** Override transient-error detection. Defaults to {@link isTransientError}. */
  isTransient?: (err: unknown) => boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` and retry it (with exponential backoff) when it rejects with a
 * transient connection error. Non-transient failures propagate immediately;
 * after `maxRetries` transient failures the last error is rethrown.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 200;
  const factor = options.factor ?? 2;
  const isTransient = options.isTransient ?? isTransientError;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransient(err) || attempt === maxRetries) {
        throw err;
      }
      await sleep(initialDelayMs * Math.pow(factor, attempt));
    }
  }
  throw lastError;
}
